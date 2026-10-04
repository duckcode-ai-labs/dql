/** Which Apps the library shows. */
export type LibraryFilter = 'all' | 'drafts' | 'private' | 'shared' | 'fav';

const FILTER_LABELS: Record<LibraryFilter, string> = {
  all: 'All',
  drafts: 'Local drafts',
  private: 'Private',
  shared: 'Shared',
  fav: 'Favourites',
};

/**
 * The App library's words. A reader under a host (RFC 0010 HH-9 `audience: 'reader'`) reads Apps shared with them
 * and drafts nothing here, so the single-user notebook's words (local drafts, private, local files) are left out.
 */
export function appLibraryWords(reader: boolean): {
  intro: string;
  filters: LibraryFilter[];
  label: (filter: LibraryFilter) => string;
  localCounts: boolean;
  loadingDetail: string;
  emptyDetail: string;
  appNote: (app: { name: string; domain?: string }) => string;
} {
  if (!reader) {
    return {
      intro: 'Local drafts and Project-published Apps live together here, with their visibility and trust state always clear.',
      filters: ['all', 'drafts', 'private', 'shared', 'fav'],
      label: (filter) => FILTER_LABELS[filter],
      localCounts: true,
      loadingDetail: 'Reading local app files from this DQL project.',
      emptyDetail: 'Change the filter or start a new App above. New work always begins as a local private draft.',
      appNote: (app) => `${app.name} consumption surface for ${app.domain}.`,
    };
  }
  return {
    intro: 'The Apps shared with you, each with how far its figures can be trusted.',
    filters: ['all', 'shared', 'fav'],
    label: (filter) => (filter === 'shared' ? 'Shared Apps' : FILTER_LABELS[filter]),
    localCounts: false,
    loadingDetail: 'Getting the Apps shared with you.',
    emptyDetail: 'Change the filter. An App you need but cannot see: ask its owner to share it with you.',
    appNote: (app) => (app.domain ? `An App for ${app.domain}.` : ''),
  };
}
