import { describe, expect, it } from 'vitest';
import { routeAction } from './route-actions.js';

const TRACE_ID = '0123456789abcdef0123456789abcdef';

/** Ask observability is the steward's screen: reading its list and a trace's detail is `hint.review`. */
describe('routeAction for Ask observability', () => {
  it.each([
    ['/api/ask-traces'],
    ['/api/ask-traces/by-run/run-1'],
    [`/api/ask-traces/${TRACE_ID}`],
  ])('reads %s as hint.review', (path) => {
    expect(routeAction('GET', path)).toEqual({ action: 'hint.review', resource: { type: 'project' } });
  });

  it('leaves the status, the CLI probe and the export where they were', () => {
    expect(routeAction('GET', '/api/ask-traces/status').action).toBe('project.read');
    expect(routeAction('GET', '/api/ask-traces/cli-capability').action).toBe('project.read');
    expect(routeAction('GET', `/api/ask-traces/${TRACE_ID}/export`).action).toBe('export');
  });
});
