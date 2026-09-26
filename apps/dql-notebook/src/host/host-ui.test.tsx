import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRun } from '../api/client';
import { HostAnswerActions, HostAnswerStatusView, answerNeedsReview } from '../components/agent/HostAnswerActions';
import { HostPersonMenu } from '../components/shell/HostPersonMenu';
import { themes } from '../themes/notebook-theme';
import { HostUiProvider, hostAllows, hostPageSrc, navItemAllowed, type HostUi, type HostUiState } from './host-ui';

const NO_HOST: HostUiState = { host: false };

function hosted(overrides: Partial<HostUi> = {}): HostUi {
  return {
    host: true,
    person: { id: 'u_priya', name: 'Priya Shah', email: 'priya@harbor.example', kind: 'person' },
    capabilities: { ask: true, 'query.run': true },
    signOutUrl: '/auth/logout',
    environment: 'Production',
    links: [{ id: 'requests', label: 'My requests', href: '/e/requests', placement: 'nav' }],
    answerActions: [
      { id: 'certify', label: 'Ask an analyst to check this', url: '/enterprise/api/requests' },
      { id: 'note', label: 'Add a note', url: '/enterprise/api/notes' },
    ],
    ...overrides,
  };
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return { id: 'run_1', question: 'Claims paid last month?', status: 'needs_review', trustState: 'review_required', ...overrides } as AgentRun;
}

const t = themes.dark;

function render(state: HostUiState, node: JSX.Element): string {
  return renderToStaticMarkup(<HostUiProvider initial={state}>{node}</HostUiProvider>);
}

describe('host UI (RFC 0010 HH-9)', () => {
  it('without a host the local owner may do everything, as before', () => {
    for (const action of ['ask', 'dataset.certify', 'settings.manage']) expect(hostAllows(NO_HOST, action)).toBe(true);
    for (const key of ['ask', 'files', 'block_library', 'git', 'settings', 'apps']) expect(navItemAllowed(NO_HOST, key)).toBe(true);
  });

  it('with a host, screens follow what the person may do', () => {
    const priya = hosted();
    expect(hostAllows(priya, 'ask')).toBe(true);
    expect(hostAllows(priya, 'dataset.certify')).toBe(false);
    expect(navItemAllowed(priya, 'ask')).toBe(true);
    expect(navItemAllowed(priya, 'files')).toBe(false);
    expect(navItemAllowed(priya, 'block_library')).toBe(false);
    expect(navItemAllowed(priya, 'settings')).toBe(false);
    // Screens with no rule (Apps, Home) stay; their own routes check access.
    expect(navItemAllowed(priya, 'apps')).toBe(true);
    // Settings opens for either settings or connection managers.
    expect(navItemAllowed(hosted({ capabilities: { 'connection.manage': true } }), 'settings')).toBe(true);
  });

  it('opens host pages embedded', () => {
    expect(hostPageSrc('/e/requests')).toBe('/e/requests?embed=1');
    expect(hostPageSrc('/e/reviews?state=open')).toBe('/e/reviews?state=open&embed=1');
  });

  it('shows the person and sign-out only under a host', () => {
    expect(render(NO_HOST, <HostPersonMenu />)).toBe('');
    const html = render(hosted(), <HostPersonMenu />);
    expect(html).toContain('Account: Priya Shah');
    expect(html).toContain('>PS<');
    expect(html).toContain('Production');
  });

  it('offers the host answer actions only on answers that need review', () => {
    expect(answerNeedsReview(run())).toBe(true);
    expect(answerNeedsReview(run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>))).toBe(false);

    expect(render(NO_HOST, <HostAnswerActions run={run()} t={t} />)).toBe('');
    expect(render(hosted({ answerActions: [] }), <HostAnswerActions run={run()} t={t} />)).toBe('');
    expect(render(hosted(), <HostAnswerActions run={run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>)} t={t} />)).toBe('');

    const html = render(hosted(), <HostAnswerActions run={run()} t={t} />);
    expect(html).toContain('data-testid="host-answer-actions"');
    expect(html).toContain('Ask an analyst to check this');
    expect(html).toContain('Add a note');
  });

  it('offers only the actions meant for questions DQL could not answer on a blocked answer', () => {
    const withUnanswered = hosted({ answerActions: [
      { id: 'check', label: 'Ask an analyst to check this', url: '/x' },
      { id: 'certify', label: 'Make this a certified answer', url: '/y', on: ['review', 'unanswered'] },
    ] });
    const blocked = run({ status: 'blocked', trustState: 'blocked' } as Partial<AgentRun>);
    const html = render(withUnanswered, <HostAnswerActions run={blocked} t={t} />);
    expect(html).toContain('Make this a certified answer');
    expect(html).not.toContain('Ask an analyst to check this');
    expect(html).toContain('could not answer this');
    expect(render(hosted(), <HostAnswerActions run={blocked} t={t} />)).toBe('');
  });

  it('offers "This looks wrong" quietly on an answer DQL trusts, and nothing else there', () => {
    const withWrong = hosted({ answerActions: [
      { id: 'check', label: 'Ask an analyst to check this', url: '/x' },
      { id: 'wrong', label: 'This looks wrong', url: '/z', on: ['answered', 'review'] },
    ] });
    const certified = run({ status: 'completed', trustState: 'certified' } as Partial<AgentRun>);
    const html = render(withWrong, <HostAnswerActions run={certified} t={t} />);
    expect(html).toContain('data-testid="host-quiet-actions"');
    expect(html).toContain('This looks wrong');
    expect(html).not.toContain('Ask an analyst to check this');
    // On a review answer it sits with the other actions.
    expect(render(withWrong, <HostAnswerActions run={run()} t={t} />)).toContain('This looks wrong');
  });
});

describe('the host\'s review of an answer (HH-10)', () => {
  it('shows where it stands, with the page that tells the whole story', () => {
    const html = render(hosted(), <HostAnswerStatusView status={{ state: 'checked', label: 'Checked by Dan Kim', detail: 'Matches the claims ledger.', href: '/e/requests/R-142' }} t={t} />);
    expect(html).toContain('data-state="checked"');
    expect(html).toContain('Checked by Dan Kim');
    expect(html).toContain('Matches the claims ledger.');
    expect(html).toContain('>Open<');
    expect(render(hosted(), <HostAnswerStatusView status={{ state: 'requested', label: 'Request R-142 · waiting for a steward' }} t={t} />)).not.toContain('>Open<');
  });
});

describe('host sign-in on a refused request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('goes to the host sign-in once and comes back to the same page', async () => {
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal('window', {
      location: { pathname: '/', search: '?x=1', hash: '#view=apps', assign },
      dispatchEvent: vi.fn(),
    });
    const { reportServerAuthRejected } = await import('../api/server-auth');
    expect(reportServerAuthRejected(401, '/auth/login')).toBe(true);
    expect(assign).toHaveBeenCalledWith(`/auth/login?returnTo=${encodeURIComponent('/?x=1#view=apps')}`);
    reportServerAuthRejected(401, '/auth/login');
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('never follows a sign-in link to another site', async () => {
    vi.resetModules();
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '', assign }, dispatchEvent: vi.fn() });
    const { reportServerAuthRejected, wasServerAuthRejected } = await import('../api/server-auth');
    reportServerAuthRejected(401, '//evil.example/login');
    reportServerAuthRejected(401, 'https://evil.example/login');
    expect(assign).not.toHaveBeenCalled();
    expect(wasServerAuthRejected()).toBe(true);
  });
});
