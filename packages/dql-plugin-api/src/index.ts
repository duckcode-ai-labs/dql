// Public plugin API for DQL. FROZEN at v1.0.
//
// These types are the contract between DQL core and third-party extensions.
// Breaking changes require a major bump and a 6-month deprecation window.
// Don't import from anywhere else in @zlens/* — those internals
// can change between minor versions.

export * from './connector.js';
export * from './chart.js';
export * from './governance.js';

/** Marker re-exported so plugin authors can assert stability. */
export const PLUGIN_API_VERSION = '1.0';
