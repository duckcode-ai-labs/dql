import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { hostLandingView, type HostUiState } from './host-ui';
import { homeCardsFor, HomeSummaryView } from '../components/home/HomeSummary';
import type { HomeCard } from '../api/home-api';

const hosted = (capabilities: Record<string, boolean>): HostUiState => ({
  host: true,
  person: { id: 'p1', name: 'Person', kind: 'person' },
  capabilities,
  links: [],
  answerActions: [],
});
const root = { pathname: '/', mainView: 'apps', activeAppId: null };
const requests: HomeCard = { id: 'requests', title: 'Open requests', items: [{ id: 'R-1', title: 'A question' }] };
const moved: HomeCard = { id: 'other', title: 'Other card', items: [] };

describe('host landing', () => {
  it('sends a person who may ask to Ask', () => {
    expect(hostLandingView(hosted({ ask: true }), root)).toBe('ask');
  });
  it('keeps a viewer on Apps', () => {
    expect(hostLandingView(hosted({ 'project.read': true }), root)).toBeNull();
  });
  it('changes nothing without a host', () => {
    expect(hostLandingView({ host: false }, root)).toBeNull();
  });
  it('leaves deep links alone', () => {
    const state = hosted({ ask: true });
    expect(hostLandingView(state, { ...root, activeAppId: 'claims' })).toBeNull();
    expect(hostLandingView(state, { ...root, pathname: '/ask' })).toBeNull();
    expect(hostLandingView(state, { ...root, mainView: 'domains' })).toBeNull();
  });
});

describe('Open requests card', () => {
  it('shows only when the host allows request.create', () => {
    expect(homeCardsFor(hosted({ 'request.create': true }), [requests, moved]).map((card) => card.id)).toEqual(['requests', 'other']);
    expect(homeCardsFor(hosted({ ask: true }), [requests, moved]).map((card) => card.id)).toEqual(['other']);
  });
  it('is unchanged without a host', () => {
    expect(homeCardsFor({ host: false }, [requests])).toEqual([requests]);
  });
  it('a viewer sees the home-summary section with the cards the host sent', () => {
    const cards = homeCardsFor(hosted({ 'project.read': true }), [requests, moved]);
    const html = renderToStaticMarkup(<HomeSummaryView summary={null} cards={cards} onOpenApp={() => undefined} onOpenLink={() => undefined} />);
    expect(html).toContain('data-testid="home-summary"');
    expect(html).toContain('Other card');
    expect(html).not.toContain('Open requests');
  });
});
