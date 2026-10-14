export interface DomainStudioUnavailableState {
  title: string;
  detail: string;
  status: string;
  /** Offer to model the warehouse's own tables, without dbt (RFC 0007). */
  action?: 'enable_warehouse';
}

interface StructuredApiError extends Error {
  code?: string;
  details?: unknown;
}

function structuredApiError(error: unknown): StructuredApiError | undefined {
  return error instanceof Error ? error as StructuredApiError : undefined;
}

function errorDetails(error: StructuredApiError): Record<string, unknown> | undefined {
  return error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
}

/**
 * Translate the runtime's distinct readiness failures into factual UI copy.
 * Acceptance: CFG-003, UI-007, E2E-003.
 */
export function domainStudioUnavailableState(error: unknown): DomainStudioUnavailableState {
  const apiError = structuredApiError(error);
  if (apiError?.code === 'DBT_FIRST_NOT_ENABLED') {
    // A project that already imports dbt is never offered "without dbt":
    // switching it to warehouse-first replaces its dbt models.
    if (errorDetails(apiError)?.dbtDetected === true) {
      return {
        title: 'Set up modeling',
        detail: 'This project already reads a dbt project. Open Settings → Project & dbt and apply it to model its dbt models here.',
        status: 'Modeling mode · Not enabled',
      };
    }
    return {
      title: 'Set up modeling',
      detail: 'Model a dbt project: open Settings → Project & dbt to connect and apply it. No dbt? Model your warehouse\'s own tables instead — ZLens reads their columns, keys and comments, and drafts the joins for you to review.',
      status: 'Modeling mode · Not enabled',
      action: 'enable_warehouse',
    };
  }

  if (apiError?.code === 'DBT_MANIFEST_NOT_FOUND') {
    const details = errorDetails(apiError);
    const configuredPath = typeof details?.manifestPath === 'string' && details.manifestPath.trim()
      ? details.manifestPath
      : 'target/manifest.json';
    return {
      title: 'dbt manifest is not ready',
      detail: `The dbt project is connected, but ${configuredPath} was not found. Run dbt parse, dbt compile, or dbt build in the configured dbt project, then refresh Modeling.`,
      status: `dbt manifest · Missing (${configuredPath})`,
    };
  }

  if (apiError?.code === 'DBT_MANIFEST_COMPILE_FAILED') {
    return {
      title: 'dbt manifest could not be loaded',
      detail: `${apiError.message} Rebuild the dbt manifest, then refresh Modeling.`,
      status: 'dbt manifest · Load failed',
    };
  }

  const message = error instanceof Error && error.message
    ? error.message
    : 'The local ZLens notebook server did not return Modeling data.';
  return {
    title: 'Modeling could not load',
    detail: message,
    status: 'Modeling · Unavailable',
  };
}
