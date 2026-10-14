import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { promoteFromDraft } from './promote-from-draft.js';
import type { CLIFlags } from './args.js';

function baseFlags(overrides: Partial<CLIFlags> = {}): CLIFlags {
  return {
    format: 'text',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    host: null,
    chart: '',
    domain: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    force: false,
    http: false,
    ...overrides,
  };
}

function writeDraft(
  root: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  writeDraftAt(root, join(root, 'blocks', '_drafts'), slug, body);
}

function writeDomainDraft(
  root: string,
  domain: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  writeDraftAt(root, join(root, 'domains', domain, 'blocks', '_drafts'), slug, { ...body, domain: body?.domain ?? domain });
}

function writeDraftAt(
  root: string,
  draftDir: string,
  slug: string,
  body?: { domain?: string; proposedContractId?: string; status?: string },
) {
  mkdirSync(draftDir, { recursive: true });
  const domain = body?.domain ?? 'customer';
  const id = body?.proposedContractId ?? 'commerce.Customer.monthly_active_customers';
  const status = body?.status ?? 'draft';
  writeFileSync(
    join(draftDir, `${slug}.dql`),
    `block "${slug}" {
    domain = "${domain}"
    type = "custom"
    status = "${status}"
    description = """How many active customers each month?"""
    datalex_contract = ""

    _proposed {
        asked_times = 3
        first_asked = "2026-04-01T00:00:00Z"
        last_asked = "2026-05-01T12:00:00Z"
        proposed_contract_id = "${id}"
        proposed_domain = "${domain}"
        proposed_entity = "Customer"
    }

    query = """SELECT 1"""
}
`,
  );
}

describe('promoteFromDraft (zlens certify --from-draft)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'promote-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns ok=false when the draft path does not exist', () => {
    const out = promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/nope.dql' }));
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/not found/i);
  });

  it('refuses to promote a file whose status is not draft', () => {
    writeDraft(tmp, 'mau', { status: 'certified' });
    const out = promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql' }));
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/status="draft"/);
  });

  it('promotes a draft to blocks/<domain>/<slug>.dql, flips status, sets contract, drops _proposed', () => {
    writeDraft(tmp, 'mau');
    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
        owner: 'growth@example.com',
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('blocks/customer/mau.dql');

    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('status = "certified"');
    expect(certified).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
    expect(certified).toContain('owner = "growth@example.com"');
    expect(certified).not.toContain('_proposed');
    expect(certified).not.toContain('asked_times');

    expect(existsSync(join(tmp, 'blocks/_drafts/mau.dql'))).toBe(false);
  });

  it('preserves Dataset tile review-draft provenance as derived_from on later certification', () => {
    const provenance = JSON.stringify({
      version: 1,
      kind: 'dataset_tile_provenance',
      appId: 'app.commerce', pageId: 'overview', tileId: 'revenue',
      datasetId: 'dataset:commerce:orders', sourceRevision: 'sha256:source', contractFingerprint: 'sha256:contract',
      query: { dimensions: [], measures: [{ measure: 'revenue' }] }, queryFingerprint: 'sha256:query',
      filterFingerprint: 'sha256:filters', parameterFingerprint: 'sha256:params', interactionFingerprint: 'sha256:interactions',
      snapshotFingerprint: 'sha256:snapshot', targetFingerprint: 'sha256:target', personaPolicyFingerprint: 'sha256:policy',
      receiptId: 'app_run_1', sqlFingerprint: 'sha256:sql', schemaFingerprint: 'sha256:schema', resultFingerprint: 'sha256:result',
      createdAt: '2026-09-11T00:00:00.000Z',
    });
    const draftDir = join(tmp, 'blocks', '_drafts');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'revenue.dql'), `block "Revenue" {
  domain = "commerce"
  type = "custom"
  status = "draft"
  dataset_tile_provenance = ${JSON.stringify(provenance)}
  query = """SELECT SUM(net_amount) AS revenue FROM order_lines"""
}\n`);

    const out = promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/revenue.dql', domain: 'commerce' }));

    expect(out.ok).toBe(true);
    const certified = readFileSync(join(tmp, 'blocks', 'commerce', 'revenue.dql'), 'utf-8');
    expect(certified).toContain('derived_from = ');
    expect(certified).not.toContain('dataset_tile_provenance = ');
  });

  it('promotes a domain-first draft into domains/<domain>/blocks/<slug>.dql', () => {
    writeDomainDraft(tmp, 'customer', 'mau');
    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'domains/customer/blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('domains/customer/blocks/mau.dql');
    expect(existsSync(join(tmp, 'domains/customer/blocks/_drafts/mau.dql'))).toBe(false);
    expect(readFileSync(join(tmp, 'domains/customer/blocks/mau.dql'), 'utf-8')).toContain('status = "certified"');
    expect(existsSync(join(tmp, 'blocks/customer/mau.dql'))).toBe(false);
  });

  it('promotes a legacy draft into the domain-first folder when the domain exists', () => {
    mkdirSync(join(tmp, 'domains', 'customer'), { recursive: true });
    writeDraft(tmp, 'mau');
    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );

    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('domains/customer/blocks/mau.dql');
    expect(readFileSync(join(tmp, 'domains/customer/blocks/mau.dql'), 'utf-8')).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
  });

  it('falls back to the proposed contract id with @1 when --contract is omitted', () => {
    writeDraft(tmp, 'mau', {
      proposedContractId: 'commerce.Customer.monthly_active_customers',
    });
    const out = promoteFromDraft(
      tmp,
      baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer' }),
    );
    expect(out.ok).toBe(true);
    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('datalex_contract = "commerce.Customer.monthly_active_customers@1"');
  });

  it('promotes an OSS draft without requiring a DataLex contract', () => {
    writeDraft(tmp, 'mau', { proposedContractId: '' });
    const out = promoteFromDraft(tmp, baseFlags({ fromDraft: 'blocks/_drafts/mau.dql', domain: 'customer' }));
    expect(out.ok).toBe(true);
    expect(out.certifiedPath).toBe('blocks/customer/mau.dql');
    expect(out.datalexManifestDiff).toBeUndefined();

    const certified = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(certified).toContain('status = "certified"');
    expect(certified).not.toContain('datalex_contract = ""');
  });

  it('refuses to overwrite an existing certified file unless --force', () => {
    writeDraft(tmp, 'mau');
    mkdirSync(join(tmp, 'blocks', 'customer'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'customer', 'mau.dql'), 'already here');

    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/already exists/);
  });

  it('overwrites with --force', () => {
    writeDraft(tmp, 'mau');
    mkdirSync(join(tmp, 'blocks', 'customer'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'customer', 'mau.dql'), 'old content');

    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
        force: true,
      }),
    );
    expect(out.ok).toBe(true);
    const content = readFileSync(join(tmp, 'blocks/customer/mau.dql'), 'utf-8');
    expect(content).not.toBe('old content');
    expect(content).toContain('status = "certified"');
  });

  it('surfaces a datalex-manifest.json patch with the contract entry to add', () => {
    writeDraft(tmp, 'mau');
    const out = promoteFromDraft(
      tmp,
      baseFlags({
        fromDraft: 'blocks/_drafts/mau.dql',
        domain: 'customer',
        contract: 'commerce.Customer.monthly_active_customers@1',
      }),
    );
    expect(out.datalexManifestDiff).toBeDefined();
    expect(out.datalexManifestDiff!).toContain('commerce.Customer.monthly_active_customers');
    expect(out.datalexManifestDiff!).toContain('"version": 1');
    expect(out.datalexManifestDiff!).toContain('domains[name=commerce]');
    expect(out.datalexManifestDiff!).toContain('entities[name=Customer]');
  });
});
