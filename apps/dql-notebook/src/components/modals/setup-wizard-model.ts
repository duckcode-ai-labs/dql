import type {
  DbtOnboardingJob,
  DbtOnboardingJobResponse,
  DbtOnboardingStatusResponse,
  DqlApiError,
} from '../../api/client';

/** Locked onboarding stages from CFG-001, AGT-002, AGT-003, and API-001. */
export type DbtOnboardingStage =
  | 'connect'
  | 'inspect'
  | 'building'
  | 'domains'
  | 'domain-model'
  | 'knowledge'
  | 'ready';

export interface OnboardingErrorView {
  code?: string;
  title: string;
  message: string;
  command?: string;
  nextActions: string[];
  optional: boolean;
}

export function resolveDbtResumeStage(status?: DbtOnboardingStatusResponse | null): DbtOnboardingStage {
  if (!status) return 'connect';
  const artifactState = status.dbt?.artifactState;
  const snapshotState = status.modeling?.snapshotState;
  const domainCount = status.domains?.count ?? 0;
  if (domainCount > 0) return 'domain-model';
  if (snapshotState === 'ready' || snapshotState === 'stale') return 'domains';
  if (snapshotState === 'building' || artifactState === 'building') return 'building';
  if (status.modeling?.enabled && status.dbt?.manifestFound) return 'domains';
  if (status.dbt?.manifestFound || artifactState === 'ready' || artifactState === 'stale') return 'inspect';
  return 'connect';
}

export function normalizeOnboardingJob(response: DbtOnboardingJobResponse): DbtOnboardingJob {
  if (response.job) return response.job;
  return {
    id: response.id ?? 'onboarding-job',
    kind: response.kind,
    status: response.status ?? 'running',
    stage: response.stage,
    progress: response.progress,
    message: response.message,
    diagnostics: response.diagnostics,
    result: response.result,
    error: response.error,
  };
}

function errorFields(error: unknown): {
  code?: string;
  message: string;
  nextActions: string[];
} {
  const candidate = error as Partial<DqlApiError> | undefined;
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : undefined,
    message: error instanceof Error ? error.message : String(error ?? 'Onboarding failed.'),
    nextActions: Array.isArray(candidate?.nextActions) ? candidate.nextActions : [],
  };
}

export function onboardingErrorView(
  error: unknown,
  projectDir: string,
  manifestPath = 'target/manifest.json',
): OnboardingErrorView {
  const fields = errorFields(error);
  const location = projectDir.trim() || '.';
  switch (fields.code) {
    case 'DBT_PROJECT_NOT_FOUND':
      return {
        code: fields.code,
        title: 'dbt project not found',
        message: 'Choose the folder that contains dbt_project.yml. ZLens will read that project; it will not copy its schema.',
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Check the project path and retry.'],
        optional: false,
      };
    case 'DBT_MANIFEST_MISSING':
      return {
        code: fields.code,
        title: 'dbt manifest.json is missing',
        message: `ZLens needs ${manifestPath || 'target/manifest.json'} to inspect dbt-owned models. Build the artifact, then retry without importing or copying dbt semantics.`,
        command: `cd ${JSON.stringify(location)} && dbt parse`,
        nextActions: fields.nextActions.length > 0
          ? fields.nextActions
          : ['Run the command locally, or ask ZLens to build artifacts when dbt is available.', 'Retry inspection.'],
        optional: false,
      };
    case 'DBT_ARTIFACT_INVALID':
      return {
        code: fields.code,
        title: 'dbt artifact is invalid',
        message: 'The manifest could not be read safely. Rebuild it with the project’s installed dbt version, then inspect again.',
        command: `cd ${JSON.stringify(location)} && dbt parse`,
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Rebuild manifest.json and retry.'],
        optional: false,
      };
    case 'DBT_PARSE_FAILED':
      return {
        code: fields.code,
        title: 'dbt parse failed',
        message: fields.message,
        command: `cd ${JSON.stringify(location)} && dbt parse`,
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Review the redacted dbt output, repair the project, and retry.'],
        optional: false,
      };
    case 'SOURCE_CHANGED':
      return {
        code: fields.code,
        title: 'dbt source changed during review',
        message: 'The reviewed artifact fingerprint is no longer current. Inspect the latest source before applying.',
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Refresh the preview and review the new diff.'],
        optional: false,
      };
    case 'AI_PROVIDER_UNAVAILABLE':
      return {
        code: fields.code,
        title: 'AI assistance is unavailable',
        message: 'AI summaries are optional. Continue with deterministic, evidence-based domain discovery and review every draft manually.',
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Continue without AI.'],
        optional: true,
      };
    case 'WAREHOUSE_UNAVAILABLE':
      return {
        code: fields.code,
        title: 'Warehouse validation is unavailable',
        message: 'You can finish metadata setup now. Relationship validation and certification will remain incomplete until a warehouse is connected.',
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Continue metadata setup.', 'Connect a warehouse before certification.'],
        optional: true,
      };
    default:
      return {
        code: fields.code,
        title: 'Onboarding needs attention',
        message: fields.message,
        nextActions: fields.nextActions.length > 0 ? fields.nextActions : ['Retry, or close and resume later.'],
        optional: false,
      };
  }
}
