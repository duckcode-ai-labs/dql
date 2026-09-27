import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_AFTER_MS,
  hashWithoutServerToken,
  isBackgroundNow,
  reportServerAuthRejected,
  serverTokenFromAccessInput,
  serverTokenFromHash,
  viewerLink,
  wasServerAuthRejected,
  withServerAuthorization,
} from './server-auth';

describe('LAN server authentication', () => {
  it('reads the bearer token from a URL fragment and never requires a query parameter', () => {
    expect(serverTokenFromHash('#dql_token=secret-123')).toBe('secret-123');
    expect(serverTokenFromHash('#view=apps')).toBeUndefined();
  });

  it('scrubs only the token from the fragment', () => {
    expect(hashWithoutServerToken('#dql_token=secret-123')).toBe('');
    expect(hashWithoutServerToken('#view=apps&dql_token=secret-123')).toBe('#view=apps');
  });

  it('finds the token in a pasted access link or a bare token, and none in a link without it', () => {
    expect(serverTokenFromAccessInput(' http://10.0.0.31:3630/#dql_token=036129c2d922328b0bc423948fbc5413 ')).toBe('036129c2d922328b0bc423948fbc5413');
    expect(serverTokenFromAccessInput('10.0.0.31:3630/#view=apps&dql_token=secret-123')).toBe('secret-123');
    expect(serverTokenFromAccessInput('036129c2d922328b0bc423948fbc5413')).toBe('036129c2d922328b0bc423948fbc5413');
    expect(serverTokenFromAccessInput('http://10.0.0.31:3630/')).toBeUndefined();
    expect(serverTokenFromAccessInput('short')).toBeUndefined();
  });

  it('only a refused token (401) asks for the access link', () => {
    expect(reportServerAuthRejected(403)).toBe(false);
    expect(reportServerAuthRejected(500)).toBe(false);
    expect(wasServerAuthRejected()).toBe(false);
    expect(reportServerAuthRejected(401)).toBe(true);
    expect(wasServerAuthRejected()).toBe(true);
  });

  it('preserves caller headers when no browser token was initialized', () => {
    const headers = withServerAuthorization({ 'Content-Type': 'application/json' });
    expect(headers.get('Content-Type')).toBe('application/json');
  });
});

describe('background requests (RFC 0010)', () => {
  it('marks requests made after the person stopped touching the page, so they don\'t keep an idle session alive', () => {
    const now = 1_000_000;
    expect(isBackgroundNow(now, now - 1_000)).toBe(false);
    expect(isBackgroundNow(now, now - BACKGROUND_AFTER_MS - 1)).toBe(true);
    // Just loaded: the person is there.
    expect(withServerAuthorization().get('x-dql-background')).toBeNull();
  });
});

describe('read-only page links (RFC 0010)', () => {
  it('name the App a viewer token opens, and nothing for the server token', () => {
    const body = btoa(JSON.stringify({ a: 'commerce-pilot', e: 1791585530 })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(viewerLink(`dqlv1.${body}.signature`)).toEqual({ appId: 'commerce-pilot', expiresAt: '2026-10-09T22:38:50.000Z' });
    expect(viewerLink('server-token-abc')).toBeNull();
    expect(viewerLink('dqlv1.not-json.sig')).toBeNull();
    expect(viewerLink(undefined)).toBeNull();
  });
});
