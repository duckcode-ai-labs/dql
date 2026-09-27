import type { SemanticDimension, SemanticMetric } from '../../store/types';

export interface ProjectPrompt { label: string; prompt: string }

const plain = (value: string) => value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameOf = (item: { label?: string; name: string }) => plain(item.label || item.name);
const lower = (value: string) => (value.length > 1 && value[1] === value[1].toLowerCase() ? value[0].toLowerCase() + value.slice(1) : value);

/**
 * Example questions from this project's own metrics, so an empty Ask shows
 * what the project can answer ("What is claims paid?", "Claims paid by
 * region", "How has claims paid changed over time?"). Empty when the project
 * has no metrics; callers fall back to general examples.
 */
export function projectExamplePrompts(metrics: SemanticMetric[], dimensions: SemanticDimension[], timeDimensions: SemanticDimension[], limit = 4): ProjectPrompt[] {
  const usable = metrics.filter((metric) => metric.name && !/^_/.test(metric.name));
  if (!usable.length) return [];
  const out: ProjectPrompt[] = [];
  const add = (text: string) => { if (out.length < limit && !out.some((item) => item.prompt === text)) out.push({ label: text, prompt: text }); };
  const [first, second] = usable;
  add(`What is ${lower(nameOf(first))}?`);
  const dimension = dimensions.find((item) => !timeDimensions.some((time) => time.name === item.name));
  if (dimension) add(`${nameOf(first)} by ${lower(nameOf(dimension))}`);
  if (timeDimensions.length) add(`How has ${lower(nameOf(second ?? first))} changed over time?`);
  if (second) add(`What is ${lower(nameOf(second))}?`);
  for (const metric of usable.slice(2)) add(`What is ${lower(nameOf(metric))}?`);
  return out;
}
