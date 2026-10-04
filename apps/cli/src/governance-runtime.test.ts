import { afterEach, describe, expect, it } from 'vitest';
import { defaultPersonaRegistry } from '@duckcodeailabs/dql-project';
import { activePersonaPolicyFingerprint, assertAppAccess, DQLAccessDeniedError, runtimeVariables } from './governance-runtime.js';
import { installHostPersonaSlots, PERSONA_SLOT_LIMIT, personaSlotCount, withRequestContext, type DqlPrincipal } from './host/request-context.js';

const persona = (overrides: Record<string, unknown> = {}) => ({
  userId: 'ana@example.test', roles: ['analyst'], attributes: {}, rlsContext: { region: 'EU' }, appId: 'sales', ...overrides,
});

afterEach(() => defaultPersonaRegistry.set(null));

describe('active persona policy fingerprint', () => {
  it('separates personas of one App whose RLS context differs, so they never share a cached result', () => {
    defaultPersonaRegistry.set(persona() as never);
    const eu = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ rlsContext: { region: 'US' } }) as never);
    const us = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ userId: 'bo@example.test' }) as never);
    const otherUser = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ roles: ['admin'] }) as never);
    const otherRole = activePersonaPolicyFingerprint();
    expect(new Set([eu, us, otherUser, otherRole]).size).toBe(4);
    expect(eu).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for the same persona regardless of key order and distinct from no persona', () => {
    defaultPersonaRegistry.set(persona({ rlsContext: { region: 'EU', team: 'north' }, roles: ['b', 'a'] }) as never);
    const first = activePersonaPolicyFingerprint();
    defaultPersonaRegistry.set(persona({ rlsContext: { team: 'north', region: 'EU' }, roles: ['a', 'b'] }) as never);
    expect(activePersonaPolicyFingerprint()).toBe(first);
    defaultPersonaRegistry.set(null);
    expect(activePersonaPolicyFingerprint()).not.toBe(first);
  });
});

describe('a signed-in person from a host (RFC 0010 HH-2)', () => {
  const maria = { id: 'u-maria', kind: 'person' as const, email: 'maria@insurer.example', groups: ['claims'], attributes: { region: 'EU' }, source: 'host' as const };
  const dev = { id: 'u-dev', kind: 'person' as const, email: 'dev@insurer.example', groups: ['growth'], attributes: { region: 'US' }, source: 'host' as const };
  const as = <T>(principal: DqlPrincipal, work: () => T): T => withRequestContext({ principal, requestId: principal.id }, work);
  const claimsOnly = {
    id: 'claims', domain: 'claims',
    policies: [{ id: 'claims-team', domain: 'claims', minClassification: 'public', allowedRoles: ['claims'], allowedUsers: [], accessLevel: 'execute', enabled: true }],
  } as never;

  afterEach(() => {
    defaultPersonaRegistry.useSlots(null);
    defaultPersonaRegistry.set(null);
  });

  it('keeps each person\'s App persona to themselves', () => {
    installHostPersonaSlots(defaultPersonaRegistry);
    as(maria, () => defaultPersonaRegistry.set(persona({ userId: 'maria@insurer.example' }) as never));
    expect(as(maria, () => defaultPersonaRegistry.active?.userId)).toBe('maria@insurer.example');
    expect(as(dev, () => defaultPersonaRegistry.active)).toBeNull();
    expect(defaultPersonaRegistry.active).toBeNull();
    as(dev, () => defaultPersonaRegistry.clear());
    expect(as(maria, () => defaultPersonaRegistry.active?.userId)).toBe('maria@insurer.example');
  });

  it('keeps persona slots for at most a set number of people, letting the least recently used go first', () => {
    expect(PERSONA_SLOT_LIMIT).toBe(5_000);
    installHostPersonaSlots(defaultPersonaRegistry, { limit: 3 });
    const person = (id: string): DqlPrincipal => ({ id, kind: 'person', email: `${id}@insurer.example`, source: 'host' });
    for (const id of ['p1', 'p2', 'p3']) as(person(id), () => defaultPersonaRegistry.set(persona({ userId: `${id}@insurer.example` }) as never));
    // p1 is used again, so p2 is now the least recently used.
    expect(as(person('p1'), () => defaultPersonaRegistry.active?.userId)).toBe('p1@insurer.example');
    for (let index = 4; index <= 40; index += 1) as(person(`p${index}`), () => defaultPersonaRegistry.active);
    expect(personaSlotCount()).toBeLessThanOrEqual(3);
    // An evicted person sees Apps as themselves again, never as anyone else.
    expect(as(person('p2'), () => defaultPersonaRegistry.active)).toBeNull();
    expect(as(person('p3'), () => defaultPersonaRegistry.active)).toBeNull();
    installHostPersonaSlots(defaultPersonaRegistry);
  });

  it('narrows rows by the person\'s own values, which a request cannot override', () => {
    const vars = as(maria, () => runtimeVariables({ 'user.region': 'US', region: 'US', limit: 5 }));
    expect(vars).toMatchObject({ 'user.region': 'EU', region: 'EU', 'user.id': 'maria@insurer.example', 'user.email': 'maria@insurer.example', 'user.roles': ['claims'], limit: 5 });
    expect(runtimeVariables({ region: 'US' })).toEqual({ region: 'US' });
  });

  it('checks App policies against the person\'s groups, never the owner\'s full access', () => {
    expect(() => as(maria, () => assertAppAccess({ app: claimsOnly }))).not.toThrow();
    expect(() => as(dev, () => assertAppAccess({ app: claimsOnly }))).toThrow(DQLAccessDeniedError);
    expect(() => assertAppAccess({ app: claimsOnly })).toThrow(DQLAccessDeniedError);
  });

  it('opens an App the host granted this person (HH-11), at the level granted', () => {
    const readOnly = { ...dev, appGrants: { claims: 'read' as const } };
    expect(() => as(readOnly, () => assertAppAccess({ app: claimsOnly, level: 'read' }))).not.toThrow();
    expect(() => as(readOnly, () => assertAppAccess({ app: claimsOnly }))).toThrow(DQLAccessDeniedError);
    expect(() => as({ ...dev, appGrants: { claims: 'execute' as const } }, () => assertAppAccess({ app: claimsOnly }))).not.toThrow();
    expect(() => as({ ...dev, appGrants: { finance: 'execute' as const } }, () => assertAppAccess({ app: claimsOnly }))).toThrow(DQLAccessDeniedError);
  });

  it('keys cached and proven results by person, and leaves a local project\'s keys unchanged', () => {
    const local = activePersonaPolicyFingerprint();
    const [a, b] = [as(maria, activePersonaPolicyFingerprint), as(dev, activePersonaPolicyFingerprint)];
    expect(new Set([local, a, b]).size).toBe(3);
    expect(activePersonaPolicyFingerprint()).toBe(local);
  });
});
