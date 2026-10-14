/**
 * Domain skill packs (W4.5).
 *
 * Anthropic's 21%→95% accuracy jump came from curated per-domain reference docs
 * ("skills") that tell the agent the preferred metrics, canonical joins, and
 * gotchas for each domain. This auto-drafts one reference skill per domain from
 * the governed manifest — preferred certified metrics, certified blocks, glossary
 * terms + their caveats — as an editable STARTER. A human curates it (the file is
 * never clobbered on re-seed); it is injected only when retrieval routes to that
 * domain. Distills what the manifest already knows into the shape the agent reads.
 */
import type { DQLManifest } from '@zlens/core';
import { existsSync } from 'node:fs';
import { skillPath, writeSkill, type Skill, type WriteSkillInput } from './loader.js';

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'domain';
}

/** Build one editable reference skill per domain from the governed manifest. Pure. */
export function buildDomainReferenceSkills(manifest: DQLManifest): WriteSkillInput[] {
  const domains = Object.values(manifest.domains ?? {});
  const blocks = Object.values(manifest.blocks ?? {});
  const allMetrics = Object.values(manifest.metrics ?? {});
  const allTerms = Object.values(manifest.terms ?? {});
  const skills: WriteSkillInput[] = [];

  for (const domain of domains) {
    const name = domain.name;
    if (!name) continue;
    const metrics = allMetrics.filter((metric) => metric.domain === name);
    const certifiedBlocks = blocks.filter((block) => block.domain === name && String(block.status ?? '').toLowerCase() === 'certified');
    const terms = allTerms.filter((term) => term.domain === name);

    const body: string[] = [
      `# ${name} domain reference`,
      '',
      `Curated guidance for answering questions in the **${name}** domain. Prefer the`,
      'certified metrics and blocks below over ad-hoc SQL, and heed the caveats.',
      '',
    ];
    body.push('## Preferred metrics');
    body.push(metrics.length
      ? metrics.map((m) => `- **${(m.label && m.label.trim()) || m.name}** (\`${m.name}\`)${m.description ? ` — ${m.description}` : ''}`).join('\n')
      : '_No certified metrics in this domain yet._');
    body.push('', '## Certified blocks');
    body.push(certifiedBlocks.length
      ? certifiedBlocks.map((b) => `- \`${b.name}\`${b.description ? ` — ${b.description}` : ''}`).join('\n')
      : '_No certified blocks in this domain yet._');
    const caveats = terms.flatMap((term) => (term.caveats ?? []).map((caveat) => `- ${term.name}: ${caveat}`));
    if (caveats.length) {
      body.push('', '## Gotchas', 'Domain caveats a senior analyst would warn about:', ...caveats);
    }
    body.push('', '_Auto-drafted from the manifest (W4.5). Edit to curate; it will not be overwritten on re-seed._');

    const vocabulary: Record<string, string> = {};
    for (const term of terms) {
      vocabulary[term.name] = `term:${term.name}`;
      for (const synonym of term.synonyms ?? []) vocabulary[synonym] = `term:${term.name}`;
    }

    skills.push({
      id: `domain-${slug(name)}`,
      scope: 'project',
      domain: name,
      description: `Reference for the ${name} domain: preferred metrics, certified blocks, and gotchas.`,
      preferredMetrics: metrics.map((m) => m.name),
      preferredBlocks: certifiedBlocks.map((b) => b.name),
      vocabulary,
      body: body.join('\n'),
      isStarter: true,
    });
  }
  return skills;
}

/**
 * Seed per-domain reference skills into `skills/`. Idempotent: a domain skill
 * is written only when its file does not already exist, so curator edits are kept.
 */
export function seedDomainSkills(projectRoot: string, manifest: DQLManifest): { created: Skill[]; skipped: string[] } {
  const created: Skill[] = [];
  const skipped: string[] = [];
  for (const skill of buildDomainReferenceSkills(manifest)) {
    if (existsSync(skillPath(projectRoot, skill.id))) {
      skipped.push(skill.id);
      continue;
    }
    created.push(writeSkill(projectRoot, skill));
  }
  return { created, skipped };
}
