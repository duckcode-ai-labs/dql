import type { AgentSchemaTable } from '@zlens/agent';

/** Prompt budget for one relation's columns. Never a claim about the table. */
export const AGENT_SCHEMA_CONTEXT_COLUMN_LIMIT = 80;

/**
 * Bound a relation's columns for the prompt WITHOUT claiming the result is the
 * whole table.
 *
 * The cap is a context budget. The SQL closure gate reads a schema entry with
 * no `columnCompleteness` as authoritative, so on any relation wider than the
 * cap — which is every enterprise mart; GitLab's `mart_crm_opportunity` carries
 * 436 columns — a real column past position 80 was rejected as "outside the
 * inspected columns", and the same correct query came back refused until the
 * run died. Truncating is fine; truncating silently is the bug.
 */
export function boundAgentSchemaColumns(
  columns: AgentSchemaTable['columns'],
  declared: AgentSchemaTable['columnCompleteness'],
  dedupe: (columns: AgentSchemaTable['columns']) => AgentSchemaTable['columns'],
): Pick<AgentSchemaTable, 'columns' | 'columnCompleteness'> {
  const deduped = dedupe(columns);
  const completeness: AgentSchemaTable['columnCompleteness'] = deduped.length > AGENT_SCHEMA_CONTEXT_COLUMN_LIMIT ? 'partial' : declared;
  return {
    columns: deduped.slice(0, AGENT_SCHEMA_CONTEXT_COLUMN_LIMIT),
    columnCompleteness: completeness,
  };
}

/** Two partial views of one relation do not add up to a complete one. */
export function mergeAgentSchemaCompleteness(
  left: AgentSchemaTable['columnCompleteness'],
  right: AgentSchemaTable['columnCompleteness'],
): AgentSchemaTable['columnCompleteness'] {
  if (left === 'partial' || right === 'partial') return 'partial';
  return left ?? right;
}
