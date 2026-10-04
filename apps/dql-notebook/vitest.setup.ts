// Node 21+ defines a global `navigator` whose userAgent names Node.js; Node 20
// has none. Many notebook tests stub `window`, and ECharts (zrender) then reads
// `navigator.userAgent` to decide between its browser and its Node code path.
// On Node 20 that read threw "navigator is not defined" while importing any
// chart module. Give Node 20 the same minimal global newer Node versions
// provide, so every supported Node version takes the same path.
if (typeof globalThis.navigator === 'undefined') {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: `Node.js/${process.versions.node.split('.')[0]}`,
      language: locale,
      languages: [locale],
    },
    configurable: true,
    writable: true,
  });
}
