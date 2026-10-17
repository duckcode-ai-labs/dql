import type { DQLContext } from '../context.js';
import {
  KGStore,
  askScopeFromWorkspace,
  defaultKgPath,
  ensureMetadataCatalogFresh,
  generateAppFromPlan,
  planAgentAnswer,
  planAppFromPrompt,
  reindexProject,
  resolveDomainContextEnvelope,
  validateAppPlan,
  type DomainContextEnvelope,
  type MetadataAllowedSqlContext,
  type MetadataObject,
  type ReindexProjectResult,
} from '@zlens/agent';
import { resolveTrustLabel, trustLabelIdForRoute } from '@zlens/core';
import { suggestBlock } from './suggest-block.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const askDqlInput = zodInputShapeForTool('ask_dql');

export async function askDql(
  ctx: DQLContext,
  args: { question: string; focusObjectKey?: string; limit?: number; domain?: string; purpose?: string; modelAreaId?: string; skillRefs?: string[] },
) {
  // The plan-only path reads the same envelope the executing path does
  // (CTX-001): a pinned domain admits its descendants and certified imports
  // and excludes its siblings, here as everywhere.
  const scope = askScopeFromWorkspace(args);
  let domainContext: DomainContextEnvelope | undefined;
  if (scope.domain || scope.purpose || scope.modelAreaId || scope.skillRefs) {
    try {
      domainContext = resolveDomainContextEnvelope({ manifest: ctx.manifest, activeDomain: scope.domain ?? null, purpose: scope.purpose, modelAreaId: scope.modelAreaId, skillRefs: scope.skillRefs, source: 'explicit_api' });
    } catch (error) {
      return { ok: false as const, error: `The requested scope could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const catalog = await ensureMetadataCatalogFresh(ctx.projectRoot).catch((error) => ({
    path: '',
    refreshed: false,
    objectCount: 0,
    edgeCount: 0,
    diagnostics: [{
      kind: 'metadata',
      severity: 'error' as const,
      message: error instanceof Error ? error.message : String(error),
    }],
    fingerprint: '',
  }));
  const planned = await planAgentAnswer(ctx.projectRoot, {
    question: args.question,
    focusObjectKey: args.focusObjectKey,
    limit: args.limit ?? 100,
    surface: 'mcp',
    ...(domainContext ? { domainContext, selectedContext: { domain: scope.domain, purpose: scope.purpose, modelAreaId: scope.modelAreaId } } : {}),
  });
  const route = planned.routeDecision;
  const exact = route.exactObjectKey
    ? planned.contextPack.objects.find((object) => object.objectKey === route.exactObjectKey)
    : undefined;
  const certifiedCandidates = planned.contextPack.objects
    .filter((object) => object.objectType === 'dql_block' && isCertified(object))
    .slice(0, 8)
    .map(summarizeObject);

  // Canonical trust label (base + optional qualifier) — one vocabulary shared
  // with the agent answer-loop and the UI badge. Derived from the route so MCP
  // clients always see the same label set.
  const trustLabel = resolveTrustLabel(trustLabelIdForRoute(route.route));

  return {
    question: args.question,
    contextPackId: planned.contextPackId,
    knowledgeLens: planned.contextPack.knowledgeLens,
    route: route.route,
    intent: route.intent,
    /** Legacy field retained for backward compatibility. */
    trustStatus: route.trustLabel,
    /** Canonical trust label: { id, base, qualifier?, severity, color, display }. */
    trustLabel,
    reviewStatus: route.reviewStatus,
    reason: route.reason,
    routeReason: route.routeReason,
    grainGate: route.grainGate,
    recommendedAction: recommendedAction(route.route),
    ...(nextTool(route.route) ? { nextTool: nextTool(route.route) } : {}),
    exactCertifiedBlock: exact && exact.objectType === 'dql_block' ? summarizeObject(exact) : undefined,
    certifiedCandidates,
    // Conflict route: surface BOTH sides + owners + the disambiguation prompt.
    conflict: route.routeConflict,
    selectedEvidence: route.selectedEvidence,
    allowedSqlContext: summarizeAllowedSqlContext(planned.allowedSqlContext),
    missingContext: planned.missingContext,
    followUps: route.followUps,
    warnings: [
      ...planned.warnings,
      ...catalog.diagnostics.map((diagnostic) => diagnostic.message),
    ],
    answerContract: {
      requiredFields: [
        'answer',
        'tableOrResultSummary',
        'sqlWhenGenerated',
        'trustStatus',
        'citations',
        'draftPathWhenGenerated',
        'nextReviewAction',
      ],
      // Canonical vocabulary the answer must report under `trustStatus`.
      trustLabels: ['Certified', 'Reviewed', 'AI-Generated', 'Insufficient-Context', 'Conflict'],
      rule: 'Never present generated SQL or Tier-2 preview rows as certified. On a Conflict route, present BOTH conflicting definitions with their owners and ask the user to choose — never silently pick one.',
    },
  };
}

export const buildDqlAppInput = zodInputShapeForTool('build_dql_app');

export async function buildDqlApp(
  ctx: DQLContext,
  args: {
    prompt: string;
    name?: string;
    blocks?: string[];
    domain?: string;
    owner?: string;
    aiLayout?: boolean;
    saveDraft?: boolean;
    overwrite?: boolean;
  },
) {
  try {
    return await buildDqlAppOnce(ctx, args);
  } catch (error) {
    // The workbench and this server share the index; a rebuild in the other
    // process can leave this connection read-only or locked for a moment.
    if (!isTransientIndexError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      return await buildDqlAppOnce(ctx, args);
    } catch (retryError) {
      if (!isTransientIndexError(retryError)) throw retryError;
      return {
        ok: false as const,
        error: 'The ZLens index was being rebuilt by another process (usually the workbench), so the App could not be planned. Retry in a moment.',
      };
    }
  }
}

function isTransientIndexError(error: unknown): boolean {
  return /readonly database|database is locked|SQLITE_BUSY|SQLITE_READONLY/i.test(error instanceof Error ? error.message : String(error));
}

async function buildDqlAppOnce(
  ctx: DQLContext,
  args: Parameters<typeof buildDqlApp>[1],
) {
  const kgPath = defaultKgPath(ctx.projectRoot);
  await reindexProject(ctx.projectRoot, { kgPath });
  const kg = new KGStore(kgPath);
  try {
    const unknownBlocks = (args.blocks ?? []).filter((name) => ctx.manifest.blocks[name]?.status !== 'certified');
    if (unknownBlocks.length > 0) {
      return {
        ok: false as const,
        error: `Only certified blocks can be App tiles; not certified or not found: ${unknownBlocks.join(', ')}. Use search_blocks with status "certified".`,
      };
    }
    const planned = planAppFromPrompt({
      prompt: args.prompt,
      kg,
      domain: cleanOptional(args.domain),
      owner: cleanOptional(args.owner),
      plannerMode: args.aiLayout ? 'ai_assisted' : 'deterministic',
      ...(args.blocks?.length ? { preferredBlockIds: args.blocks.map((name) => `block:${name}`), maxCertifiedTiles: args.blocks.length } : {}),
    });
    const name = cleanOptional(args.name);
    const plan = name ? { ...planned, name, appId: appIdFor(name) } : planned;
    const validation = validateAppPlan(plan, kg);
    const generated = args.saveDraft === false
      ? undefined
      : generateAppFromPlan(ctx.projectRoot, plan, kg, { overwrite: args.overwrite === true });
    if (generated) {
      ctx.refresh();
      await ensureMetadataCatalogFresh(ctx.projectRoot, { force: true }).catch(() => undefined);
    }
    return {
      ok: true,
      appId: plan.appId,
      name: plan.name,
      domain: plan.domain,
      audience: plan.audience,
      lifecycle: plan.lifecycle,
      certifiedTiles: validation.certifiedTiles,
      draftTiles: validation.draftTiles,
      validation,
      plan,
      generated,
      nextActions: generated
        ? [
          'Open the generated app draft in DQL.',
          'Review draft/research tiles before stakeholder use.',
          'Run zlens app build after review.',
        ]
        : [
          'Review the returned plan.',
          'Call build_dql_app again with saveDraft=true to write files.',
        ],
    };
  } finally {
    kg.close();
  }
}

export const inspectDqlProjectInput = zodInputShapeForTool('inspect_dql_project');

export async function inspectDqlProject(
  ctx: DQLContext,
  args: { refresh?: boolean },
) {
  let index: ReindexProjectResult | undefined;
  let catalog: { path: string; refreshed: boolean; objectCount: number; edgeCount: number; diagnostics: unknown[] } | undefined;
  if (args.refresh !== false) {
    index = await reindexProject(ctx.projectRoot, { kgPath: defaultKgPath(ctx.projectRoot) });
    catalog = await ensureMetadataCatalogFresh(ctx.projectRoot);
    ctx.refresh();
  }
  const manifest = ctx.manifest;
  const blocks = Object.values(manifest.blocks ?? {});
  const dashboards = Object.values(manifest.dashboards ?? {});
  const apps = Object.values(manifest.apps ?? {});
  const knowledgeGraph = manifest.knowledgeGraph;
  return {
    projectRoot: ctx.projectRoot,
    blocks: {
      total: blocks.length,
      certified: blocks.filter((block) => block.status === 'certified').length,
      draft: blocks.filter((block) => block.status !== 'certified').length,
    },
    apps: apps.length,
    dashboards: dashboards.length,
    semantic: {
      metrics: ctx.semanticLayer.listMetrics().length,
      dimensions: ctx.semanticLayer.listDimensions().length,
    },
    knowledge: knowledgeGraph ? {
      schemaVersion: knowledgeGraph.schemaVersion,
      sourceFingerprint: knowledgeGraph.sourceFingerprint,
      objects: knowledgeGraph.counts?.objects ?? Object.keys(knowledgeGraph.objects ?? {}).length,
      edges: knowledgeGraph.counts?.edges ?? knowledgeGraph.edges?.length ?? 0,
      domainCapsules: Object.values(knowledgeGraph.domainCapsules).map((capsule) => ({
        id: capsule.id,
        domainId: capsule.domainId,
        modelAreaId: capsule.modelAreaId,
        fingerprint: capsule.fingerprint,
        skills: capsule.skillRefs.length,
      })),
      routeStates: knowledgeGraph.crossDomainRoutes.reduce<Record<string, number>>((counts, route) => {
        counts[route.state] = (counts[route.state] ?? 0) + 1;
        return counts;
      }, {}),
    } : undefined,
    index,
    catalog,
    recommendedNextStep: 'Use ask_dql before writing SQL, then query_via_block or query_via_metadata based on the returned route.',
  };
}

export const buildDqlBlockInput = zodInputShapeForTool('build_dql_block');

export function buildDqlBlock(
  ctx: DQLContext,
  args: Parameters<typeof suggestBlock>[1],
) {
  return suggestBlock(ctx, args);
}

function recommendedAction(route: string): string {
  if (route === 'certified') return 'Use query_via_block only if the certified grain exactly answers the question.';
  if (route === 'generated_sql') return 'Generate one read-only SELECT/WITH query from the allowed SQL context, then call query_via_metadata.';
  if (route === 'research') return 'Use lineage, proposals, and metadata evidence before creating or promoting any app tile.';
  if (route === 'conflict') return 'Do not answer. Present both conflicting definitions with their owners and ask the user which one is authoritative.';
  return 'Ask for the missing business object, metric, table, filter, or grain before writing SQL.';
}

/**
 * Advisory next REGISTERED tool for the route. Conflict/missing-context routes
 * have no tool to call — the agent must ask the USER — so this returns
 * undefined instead of a phantom tool name a model would try to invoke.
 */
function nextTool(route: string): string | undefined {
  if (route === 'certified') return 'query_via_block';
  if (route === 'generated_sql') return 'query_via_metadata';
  if (route === 'research') return 'inspect_metadata_context';
  return undefined;
}

function summarizeAllowedSqlContext(context: MetadataAllowedSqlContext): MetadataAllowedSqlContext {
  return {
    relations: context.relations.slice(0, 12).map((relation) => ({
      ...relation,
      columns: relation.columns.slice(0, 40),
    })),
    sourceBlockSql: context.sourceBlockSql.slice(0, 8),
  };
}

function summarizeObject(object: MetadataObject) {
  return {
    objectKey: object.objectKey,
    objectType: object.objectType,
    name: object.name,
    fullName: object.fullName,
    domain: object.domain,
    owner: object.owner,
    status: object.status,
    description: object.description,
    sourcePath: object.sourcePath,
  };
}

function isCertified(object: MetadataObject): boolean {
  return object.status === 'certified' || object.payload?.certification === 'certified';
}

function appIdFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
