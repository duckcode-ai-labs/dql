import { describe, expect, it } from 'vitest';
import { withoutAskTraceLocationHref } from './ask-location';

describe('leaving the Ask observability pages', () => {
  it('turns the trace catalog and a trace detail address into `/`', () => {
    expect(withoutAskTraceLocationHref('http://localhost/ask/traces')).toBe('/');
    expect(withoutAskTraceLocationHref('http://localhost/ask/traces/run-1')).toBe('/');
  });

  it('keeps the query and hash, and every other address', () => {
    expect(withoutAskTraceLocationHref('http://localhost/ask/traces?x=1#h')).toBe('/?x=1#h');
    expect(withoutAskTraceLocationHref('http://localhost/')).toBe('/');
    expect(withoutAskTraceLocationHref('http://localhost/ask?thread=t1')).toBe('/ask?thread=t1');
    expect(withoutAskTraceLocationHref('http://localhost/ask/tracesx')).toBe('/ask/tracesx');
  });
});
