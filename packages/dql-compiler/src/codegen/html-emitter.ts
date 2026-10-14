import type { DashboardIR, FilterIR, InteractionConfig, WorkbookIR, PageIR, ParamIR } from '../ir/ir-nodes.js';
import type { ThemeConfig } from '../themes/theme-types.js';
import type { ChartSpec } from './vega-lite-emitter.js';
import { emitChartSpecs } from './vega-lite-emitter.js';
import { emitRuntimeJS } from './runtime-emitter.js';

export interface HTMLEmitOptions {
  vegaAssets?: 'cdn' | 'local';
  vegaBasePath?: string;
}

export function emitDashboardHTML(
  dashboard: DashboardIR,
  chartSpecs: ChartSpec[],
  theme: ThemeConfig,
  runtimeJS: string,
  options: HTMLEmitOptions = {},
): string {
  const chartContainers = dashboard.layout.items
    .map((item) => {
      const spec = chartSpecs.find((s) => s.chartId === item.chartId);
      const chartIR = dashboard.charts.find((c) => c.id === item.chartId);
      const chartType = spec?.kind ?? 'vega-lite';
      const hasInteraction = spec?.interaction && (spec.interaction.drillDown || spec.interaction.linkTo || spec.interaction.onClick);
      const hasDrill = Boolean(chartIR?.drillConfig || spec?.interaction?.drillDown);
      const conditionAttr = chartIR?.condition ? ` data-condition="${escapeHTML(chartIR.condition)}"` : '';
      const conditionStyle = chartIR?.condition ? ' display: none;' : '';

      return `
      <div class="dql-chart-wrapper" style="grid-column: ${item.gridColumn}; grid-row: ${item.gridRow};${conditionStyle}"${conditionAttr}>
        ${hasDrill ? `<div class="dql-drill-indicator">Drill</div>` : ''}
        <button class="dql-inline-drill-up" type="button" data-chart-id="${item.chartId}" style="display:none;">Drill Up</button>
        <div id="${item.chartId}" class="dql-chart dql-chart-${chartType}${hasInteraction ? ' dql-interactive' : ''}" style="
          background: ${theme.cardBackground};
          border: 1px solid ${theme.borderColor};
          border-radius: 8px;
          padding: 16px;
          min-height: 200px;
        "><div class="dql-skeleton"></div></div>
      </div>`;
    })
    .join('\n');

  const vegaLiteSpecs: Record<string, unknown> = {};
  const interactions: Record<string, InteractionConfig> = {};
  for (const spec of chartSpecs) {
    if (spec.kind === 'vega-lite') {
      vegaLiteSpecs[spec.chartId] = spec.spec;
    }
    if (spec.interaction) {
      interactions[spec.chartId] = spec.interaction;
    }
  }

  const filterBar = emitFilterBar(dashboard.filters, theme);

  return `<!DOCTYPE html>
<html lang="en" data-theme="obsidian">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(dashboard.title)}</title>
  ${emitVegaScriptTags(options)}
  <style>
    :root {
      --dql-bg: ${theme.background};
      --dql-fg: ${theme.foreground};
      --dql-card-bg: ${theme.cardBackground};
      --dql-border: ${theme.borderColor};
      --dql-font: ${theme.fontFamily};
      --dql-title-color: ${theme.titleColor};
      --dql-text-color: ${theme.textColor};
      --dql-grid-color: ${theme.gridColor};
      --dql-axis-color: ${theme.axisColor};
      --dql-accent: ${theme.colors[0]};
    }

    /* Luna tokens — parity with notebook App mode (v1.3.2).
       Three themes: obsidian (dark), paper (warm light), white (plain light).
       Available to cards/chrome alongside the legacy --dql-* variables. */
    [data-theme="obsidian"] {
      --color-bg-0: #08090b;
      --color-bg-1: #0d0e11;
      --color-bg-2: #16181c;
      --color-border-subtle: rgba(255, 255, 255, 0.07);
      --color-border-default: rgba(255, 255, 255, 0.13);
      --color-text-primary: #e6e8ec;
      --color-text-secondary: #a8adb8;
      --color-text-muted: #6d7380;
      --color-accent-blue: #4f8bff;
      --color-accent-green: #3fb950;
      --color-accent-yellow: #e3b341;
      --color-accent-red: #f85149;
    }
    [data-theme="paper"] {
      --color-bg-0: #efebe2;
      --color-bg-1: #f7f4ed;
      --color-bg-2: #e9e4d8;
      --color-border-subtle: rgba(40, 30, 15, 0.10);
      --color-border-default: rgba(40, 30, 15, 0.20);
      --color-text-primary: #15120c;
      --color-text-secondary: #4a4336;
      --color-text-muted: #8a8070;
      --color-accent-blue: #2541b2;
      --color-accent-green: #0a5e30;
      --color-accent-yellow: #8a5a10;
      --color-accent-red: #a32020;
    }
    [data-theme="white"] {
      --color-bg-0: #f5f6f8;
      --color-bg-1: #ffffff;
      --color-bg-2: #ffffff;
      --color-border-subtle: rgba(15, 23, 42, 0.08);
      --color-border-default: rgba(15, 23, 42, 0.16);
      --color-text-primary: #0f172a;
      --color-text-secondary: #475569;
      --color-text-muted: #64748b;
      --color-accent-blue: #2563eb;
      --color-accent-green: #16a34a;
      --color-accent-yellow: #ca8a04;
      --color-accent-red: #dc2626;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--dql-font);
      background: var(--dql-bg);
      color: var(--dql-fg);
      padding: 24px;
      min-height: 100vh;
    }

    .dql-dashboard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--dql-border);
    }

    .dql-dashboard-title {
      font-size: 24px;
      font-weight: 700;
      color: ${theme.titleColor};
    }

    .dql-header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .dql-header-btn {
      padding: 6px 12px;
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      background: ${theme.cardBackground};
      color: ${theme.textColor};
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }

    .dql-header-btn:hover {
      border-color: ${theme.colors[0]};
      color: ${theme.colors[0]};
    }

    .dql-header-select {
      padding: 6px 10px;
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      background: ${theme.cardBackground};
      color: ${theme.textColor};
      font-size: 13px;
      font-family: inherit;
      min-width: 110px;
    }

    /* Filter Bar */
    .dql-filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 20px;
      padding: 16px;
      background: ${theme.cardBackground};
      border: 1px solid ${theme.borderColor};
      border-radius: 8px;
    }

    .dql-filter-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .dql-filter-label {
      font-size: 12px;
      font-weight: 600;
      color: ${theme.textColor};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .dql-filter-select,
    .dql-filter-input,
    .dql-filter-date {
      padding: 8px 12px;
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      background: ${theme.background};
      color: ${theme.foreground};
      font-size: 14px;
      font-family: inherit;
      min-width: 160px;
    }

    .dql-filter-select:focus,
    .dql-filter-input:focus,
    .dql-filter-date:focus {
      outline: none;
      border-color: ${theme.colors[0]};
      box-shadow: 0 0 0 2px ${theme.colors[0]}33;
    }

    .dql-filter-apply {
      padding: 8px 20px;
      background: ${theme.colors[0]};
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .dql-filter-apply:hover {
      opacity: 0.9;
    }

    .dql-filter-reset {
      padding: 8px 16px;
      background: transparent;
      color: ${theme.textColor};
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }

    .dql-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(${dashboard.layout.columns}, 1fr);
      gap: 16px;
    }

    .dql-chart-wrapper {
      min-width: 0;
      position: relative;
    }

    .dql-drill-indicator {
      position: absolute;
      top: 10px;
      right: 12px;
      z-index: 2;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 999px;
      border: 1px solid ${theme.borderColor};
      background: ${theme.cardBackground};
      color: ${theme.textColor};
      opacity: 0.8;
      pointer-events: none;
    }

    .dql-inline-drill-up {
      position: absolute;
      top: 10px;
      left: 12px;
      z-index: 3;
      padding: 4px 8px;
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      background: ${theme.cardBackground};
      color: ${theme.textColor};
      font-size: 12px;
      cursor: pointer;
    }

    .dql-chart canvas, .dql-chart svg {
      max-width: 100%;
    }

    .dql-interactive {
      cursor: pointer;
    }

    .dql-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      color: ${theme.textColor};
    }

    .dql-error {
      color: #E45756;
      padding: 16px;
      background: ${theme.cardBackground};
      border: 1px solid #E45756;
      border-radius: 8px;
    }

    /* Drill-down Modal */
    .dql-modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }

    .dql-modal-overlay.active {
      display: flex;
    }

    .dql-modal {
      background: ${theme.cardBackground};
      border: 1px solid ${theme.borderColor};
      border-radius: 12px;
      width: 90%;
      max-width: 900px;
      max-height: 80vh;
      overflow: auto;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }

    .dql-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px;
      border-bottom: 1px solid ${theme.borderColor};
    }

    .dql-modal-title {
      font-size: 18px;
      font-weight: 700;
      color: ${theme.titleColor};
    }

    .dql-drill-stack {
      margin-top: 4px;
      font-size: 12px;
      color: ${theme.textColor};
      opacity: 0.8;
    }

    .dql-drill-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .dql-drill-up {
      padding: 4px 10px;
      font-size: 12px;
    }

    .dql-modal-close {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      color: ${theme.textColor};
      font-size: 20px;
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .dql-modal-close:hover {
      background: ${theme.borderColor};
    }

    .dql-modal-body {
      padding: 24px;
    }

    .dql-drill-table {
      width: 100%;
      border-collapse: collapse;
    }

    .dql-drill-table th {
      text-align: left;
      padding: 10px 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: ${theme.textColor};
      background: ${theme.background};
      border-bottom: 2px solid ${theme.borderColor};
    }

    .dql-drill-table td {
      padding: 10px 12px;
      font-size: 14px;
      color: ${theme.foreground};
      border-bottom: 1px solid ${theme.borderColor};
    }

    .dql-drill-table tr:hover td {
      background: ${theme.background};
    }

    /* Breadcrumb for navigation */
    .dql-breadcrumb {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      font-size: 14px;
    }

    .dql-breadcrumb a {
      color: ${theme.colors[0]};
      text-decoration: none;
    }

    .dql-breadcrumb a:hover {
      text-decoration: underline;
    }

    .dql-breadcrumb-sep {
      color: ${theme.textColor};
    }

    /* Loading skeleton shimmer */
    .dql-skeleton {
      background: linear-gradient(90deg, var(--dql-card-bg) 25%, var(--dql-border) 50%, var(--dql-card-bg) 75%);
      background-size: 200% 100%;
      animation: dql-shimmer 1.5s infinite;
      border-radius: 4px;
      height: 200px;
      width: 100%;
    }

    @keyframes dql-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* Fullscreen support */
    .dql-fullscreen-btn {
      background: none;
      border: 1px solid var(--dql-border);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 14px;
      color: var(--dql-fg);
    }

    .dql-fullscreen-btn:hover {
      background: var(--dql-border);
    }

    /* Responsive breakpoints */
    @media (max-width: 1024px) {
      .dql-dashboard-grid {
        grid-template-columns: repeat(6, 1fr) !important;
      }
      .dql-chart-wrapper {
        grid-column: 1 / -1 !important;
      }
    }

    @media (max-width: 768px) {
      body { padding: 12px; }
      .dql-dashboard-grid {
        grid-template-columns: 1fr !important;
        gap: 12px;
      }
      .dql-chart-wrapper {
        grid-column: 1 / -1 !important;
      }
      .dql-dashboard-header {
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }
      .dql-filter-bar {
        flex-direction: column;
      }
      .dql-filter-select,
      .dql-filter-input,
      .dql-filter-date {
        min-width: 100% !important;
      }
      .dql-modal {
        width: 98%;
        max-height: 90vh;
      }
    }

    @media print {
      .dql-header-actions,
      .dql-filter-bar,
      .dql-modal-overlay { display: none !important; }
      body { background: white; color: black; padding: 0; }
      .dql-chart { border: none !important; box-shadow: none !important; }
    }
  </style>
</head>
<body>
  <header class="dql-dashboard-header">
    <div>
      <div class="dql-breadcrumb" id="dql-breadcrumb"></div>
      <h1 class="dql-dashboard-title">${escapeHTML(dashboard.title)}</h1>
    </div>
    <div class="dql-header-actions">
      <button class="dql-header-btn" id="dql-theme-toggle" title="Toggle theme">🌓 Theme</button>
      <select class="dql-header-select" id="dql-view-presets" title="Saved views">
        <option value="">Views</option>
      </select>
      <button class="dql-header-btn" id="dql-save-view" title="Save current view">Save View</button>
      <button class="dql-header-btn" id="dql-export-csv" title="Export data as CSV">⬇ Export</button>
      <button class="dql-header-btn" id="dql-fullscreen" title="Toggle fullscreen">⛶ Fullscreen</button>
    </div>
  </header>

  ${filterBar}

  <main class="dql-dashboard-grid">
    ${chartContainers}
  </main>

  <!-- Drill-down Modal -->
  <div class="dql-modal-overlay" id="dql-drill-modal">
    <div class="dql-modal">
      <div class="dql-modal-header">
        <div>
          <div class="dql-modal-title" id="dql-drill-title">Detail View</div>
          <div class="dql-drill-stack" id="dql-drill-stack"></div>
        </div>
        <div class="dql-drill-controls">
          <button class="dql-header-btn dql-drill-up" id="dql-drill-up" disabled>Drill Up</button>
          <button class="dql-modal-close" id="dql-drill-close">&times;</button>
        </div>
      </div>
      <div class="dql-modal-body" id="dql-drill-body">
        <div class="dql-loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    // DQL Dashboard Configuration
    const DQL_CONFIG = {
      title: ${JSON.stringify(dashboard.title)},
      charts: ${JSON.stringify(dashboard.charts.map((c) => ({
        id: c.id,
        type: c.chartType,
        sql: c.sql,
        params: c.sqlParams,
        condition: c.condition,
        connection: c.connection,
        cacheTTL: c.cacheTTL,
        materializeRefresh: c.materializeRefresh,
        drillConfig: c.drillConfig,
      })))},
      vegaLiteSpecs: ${JSON.stringify(vegaLiteSpecs, null, 2)},
      interactions: ${JSON.stringify(interactions)},
      filters: ${JSON.stringify(dashboard.filters.map((f) => ({ id: f.id, type: f.filterType, sql: f.sql, params: f.sqlParams, param: f.param, label: f.label, defaultValue: f.defaultValue })))},
      params: ${JSON.stringify(dashboard.params.map((p) => ({ name: p.name, type: p.paramType, defaultValue: p.defaultValue })))},
      apiEndpoint: '/api/query',
      refreshInterval: ${dashboard.refreshInterval ?? 0},
      features: {
        hierarchyDrillEnabled: true,
        runtimeCacheEnabled: true,
        materializationEnabled: true,
      },
    };

    // Dashboard Shell UI
    (function() {
      // Theme toggle — cycles Luna themes in sync with the notebook (v1.3.2).
      var THEMES = ['obsidian', 'paper', 'white'];
      var ALIAS = { midnight: 'obsidian', dark: 'obsidian', light: 'paper', arctic: 'white' };
      var saved = null;
      try { saved = localStorage.getItem('dql-theme'); } catch (_) {}
      if (saved && ALIAS[saved]) saved = ALIAS[saved];
      if (saved && THEMES.indexOf(saved) >= 0) {
        document.documentElement.setAttribute('data-theme', saved);
      }
      var themeBtn = document.getElementById('dql-theme-toggle');
      if (themeBtn) {
        themeBtn.addEventListener('click', function() {
          var html = document.documentElement;
          var current = html.getAttribute('data-theme') || 'obsidian';
          if (ALIAS[current]) current = ALIAS[current];
          var next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
          html.setAttribute('data-theme', next);
          try { localStorage.setItem('dql-theme', next); } catch (_) {}
        });
      }

      // CSV export
      var exportBtn = document.getElementById('dql-export-csv');
      if (exportBtn) {
        exportBtn.addEventListener('click', function() {
          if (!DQL_CONFIG.charts || DQL_CONFIG.charts.length === 0) return;
          var firstChart = DQL_CONFIG.charts[0];
          // Collect variables from filters + URL params + dashboard params defaults
          var variables = {};
          var urlParams = new URLSearchParams(window.location.search);

          if (DQL_CONFIG.filters) {
            for (var i = 0; i < DQL_CONFIG.filters.length; i++) {
              var f = DQL_CONFIG.filters[i];
              var el = document.getElementById(f.id);
              if (el && el.value !== '') {
                variables[f.param] = el.value;
              } else if (f.defaultValue && variables[f.param] === undefined) {
                variables[f.param] = f.defaultValue;
              }
            }
          }

          if (DQL_CONFIG.params) {
            for (var j = 0; j < DQL_CONFIG.params.length; j++) {
              var p = DQL_CONFIG.params[j];
              if (variables[p.name] === undefined) {
                variables[p.name] = urlParams.get(p.name) || p.defaultValue;
              }
            }
          }

          urlParams.forEach(function(value, key) {
            if (key === '_from' || key === '_fromTitle') return;
            if (variables[key] === undefined) variables[key] = value;
          });

          var exportEndpoint = (DQL_CONFIG.apiEndpoint || '/api/query').replace('/query', '/export/csv');
          fetch(exportEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sql: firstChart.sql,
              sqlParams: firstChart.params,
              variables: variables,
              connectionId: firstChart.connection,
              filename: DQL_CONFIG.title
            })
          }).then(function(r) { return r.blob(); }).then(function(blob) {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = (DQL_CONFIG.title || 'export') + '.csv';
            a.click();
            URL.revokeObjectURL(url);
          });
        });
      }

      // Fullscreen toggle
      var fsBtn = document.getElementById('dql-fullscreen');
      if (fsBtn) {
        fsBtn.addEventListener('click', function() {
          if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
          } else {
            document.exitFullscreen();
          }
        });
      }

      // Evaluate @if conditions based on URL params and param defaults
      function evaluateConditions() {
        var urlParams = new URLSearchParams(window.location.search);
        var paramValues = {};
        if (DQL_CONFIG.params) {
          for (var i = 0; i < DQL_CONFIG.params.length; i++) {
            var p = DQL_CONFIG.params[i];
            paramValues[p.name] = urlParams.get(p.name) || p.defaultValue;
          }
        }
        var conditionalEls = document.querySelectorAll('[data-condition]');
        conditionalEls.forEach(function(el) {
          var condParam = el.getAttribute('data-condition');
          var val = paramValues[condParam] || urlParams.get(condParam);
          if (val && val !== 'false' && val !== '0' && val !== '') {
            el.style.display = '';
          }
        });
      }
      evaluateConditions();
    })();
  </script>
  ${runtimeJS === '__EXTERNAL__'
    ? '<script src="/dql-runtime.js"></script>'
    : `<script>\n    ${runtimeJS}\n  </script>`}
</body>
</html>`;
}

function emitFilterBar(filters: FilterIR[], theme: ThemeConfig): string {
  if (filters.length === 0) return '';

  const filterWidgets = filters.map((f) => {
    switch (f.filterType) {
      case 'dropdown':
        return `
        <div class="dql-filter-group">
          <label class="dql-filter-label" for="${f.id}">${escapeHTML(f.label)}</label>
          <select id="${f.id}" class="dql-filter-select" data-param="${escapeHTML(f.param)}"${f.options?.width ? ` style="min-width: ${f.options.width}px"` : ''}>
            <option value="">${escapeHTML(f.placeholder ?? 'All')}</option>
          </select>
        </div>`;

      case 'multi_select':
        return `
        <div class="dql-filter-group">
          <label class="dql-filter-label" for="${f.id}">${escapeHTML(f.label)}</label>
          <select id="${f.id}" class="dql-filter-select" data-param="${escapeHTML(f.param)}" multiple${f.options?.width ? ` style="min-width: ${f.options.width}px"` : ''}>
          </select>
        </div>`;

      case 'date_range':
        return `
        <div class="dql-filter-group">
          <label class="dql-filter-label" for="${f.id}">${escapeHTML(f.label)}</label>
          <input type="date" id="${f.id}" class="dql-filter-date" data-param="${escapeHTML(f.param)}"${f.defaultValue ? ` value="${escapeHTML(String(f.defaultValue))}"` : ''}${f.options?.width ? ` style="min-width: ${f.options.width}px"` : ''} />
        </div>`;

      case 'text':
        return `
        <div class="dql-filter-group">
          <label class="dql-filter-label" for="${f.id}">${escapeHTML(f.label)}</label>
          <input type="text" id="${f.id}" class="dql-filter-input" data-param="${escapeHTML(f.param)}" placeholder="${escapeHTML(f.placeholder ?? 'Search...')}"${f.options?.width ? ` style="min-width: ${f.options.width}px"` : ''} />
        </div>`;

      case 'range':
        return `
        <div class="dql-filter-group">
          <label class="dql-filter-label" for="${f.id}">${escapeHTML(f.label)}</label>
          <input type="range" id="${f.id}" class="dql-filter-input" data-param="${escapeHTML(f.param)}"${f.options?.min != null ? ` min="${f.options.min}"` : ''}${f.options?.max != null ? ` max="${f.options.max}"` : ''}${f.options?.step != null ? ` step="${f.options.step}"` : ''}${f.defaultValue ? ` value="${escapeHTML(String(f.defaultValue))}"` : ''} />
        </div>`;

      default:
        return '';
    }
  }).join('\n');

  return `
  <div class="dql-filter-bar" id="dql-filter-bar">
    ${filterWidgets}
    <div class="dql-filter-group" style="flex-direction: row; gap: 8px;">
      <button class="dql-filter-apply" id="dql-filter-apply">Apply</button>
      <button class="dql-filter-reset" id="dql-filter-reset">Reset</button>
    </div>
  </div>`;
}

export function emitWorkbookHTML(
  workbook: WorkbookIR,
  theme: ThemeConfig,
  runtimeJS: string,
  options: HTMLEmitOptions = {},
): string {
  // Build page tabs
  const pageTabs = workbook.pages
    .map((page, i) => {
      const activeClass = i === 0 ? ' dql-tab-active' : '';
      return `<button class="dql-tab${activeClass}" data-page="${i}" onclick="dqlSwitchPage(${i})">${escapeHTML(page.title)}</button>`;
    })
    .join('\n      ');

  // Build page content sections
  const pageContents = workbook.pages
    .map((page, pageIndex) => {
      const pageChartSpecs = emitChartSpecs(page.charts, theme);
      const filterBar = emitFilterBar(page.filters, theme);

      const vegaLiteSpecs: Record<string, unknown> = {};
      const interactions: Record<string, InteractionConfig> = {};
      for (const spec of pageChartSpecs) {
        if (spec.kind === 'vega-lite') {
          vegaLiteSpecs[spec.chartId] = spec.spec;
        }
        if (spec.interaction) {
          interactions[spec.chartId] = spec.interaction;
        }
      }

      const chartContainers = page.layout.items
        .map((item) => {
          const spec = pageChartSpecs.find((s) => s.chartId === item.chartId);
          const chartIR = page.charts.find((c) => c.id === item.chartId);
          const chartType = spec?.kind ?? 'vega-lite';
          const hasInteraction = spec?.interaction && (spec.interaction.drillDown || spec.interaction.linkTo || spec.interaction.onClick);
          const hasDrill = Boolean(chartIR?.drillConfig || spec?.interaction?.drillDown);
          return `
          <div class="dql-chart-wrapper" style="grid-column: ${item.gridColumn}; grid-row: ${item.gridRow};">
            ${hasDrill ? `<div class="dql-drill-indicator">Drill</div>` : ''}
            <button class="dql-inline-drill-up" type="button" data-chart-id="${item.chartId}" style="display:none;">Drill Up</button>
            <div id="${item.chartId}" class="dql-chart dql-chart-${chartType}${hasInteraction ? ' dql-interactive' : ''}" style="
              background: ${theme.cardBackground};
              border: 1px solid ${theme.borderColor};
              border-radius: 8px;
              padding: 16px;
              min-height: 200px;
            "></div>
          </div>`;
        })
        .join('\n');

      const displayStyle = pageIndex === 0 ? 'block' : 'none';

      return `
      <div class="dql-page" id="dql-page-${pageIndex}" style="display: ${displayStyle};" data-config='${JSON.stringify({
        charts: page.charts.map((c) => ({
          id: c.id,
          type: c.chartType,
          sql: c.sql,
          params: c.sqlParams,
          connection: c.connection,
          cacheTTL: c.cacheTTL,
          materializeRefresh: c.materializeRefresh,
          drillConfig: c.drillConfig,
        })),
        vegaLiteSpecs,
        interactions,
        filters: page.filters.map((f) => ({ id: f.id, type: f.filterType, sql: f.sql, params: f.sqlParams, param: f.param, label: f.label, defaultValue: f.defaultValue })),
      })}'>
        ${filterBar}
        <div class="dql-dashboard-grid" style="display: grid; grid-template-columns: repeat(${page.layout.columns}, 1fr); gap: 16px;">
          ${chartContainers}
        </div>
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHTML(workbook.title)}</title>
  ${emitVegaScriptTags(options)}
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: ${theme.fontFamily};
      background: ${theme.background};
      color: ${theme.foreground};
      padding: 24px;
      min-height: 100vh;
    }

    .dql-dashboard-header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid ${theme.borderColor};
    }

    .dql-dashboard-title {
      font-size: 24px;
      font-weight: 700;
      color: ${theme.titleColor};
      margin-bottom: 16px;
    }

    .dql-tabs {
      display: flex;
      gap: 0;
      border-bottom: 2px solid ${theme.borderColor};
    }

    .dql-tab {
      padding: 10px 20px;
      border: none;
      background: transparent;
      color: ${theme.textColor};
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -2px;
      transition: color 0.2s, border-color 0.2s;
    }

    .dql-tab:hover {
      color: ${theme.titleColor};
    }

    .dql-tab-active {
      color: ${theme.colors[0]};
      border-bottom-color: ${theme.colors[0]};
    }

    .dql-filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 20px;
      padding: 16px;
      background: ${theme.cardBackground};
      border: 1px solid ${theme.borderColor};
      border-radius: 8px;
    }

    .dql-filter-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .dql-filter-label {
      font-size: 12px;
      font-weight: 600;
      color: ${theme.textColor};
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .dql-filter-select,
    .dql-filter-input,
    .dql-filter-date {
      padding: 8px 12px;
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      background: ${theme.background};
      color: ${theme.foreground};
      font-size: 14px;
      font-family: inherit;
      min-width: 160px;
    }

    .dql-filter-apply {
      padding: 8px 20px;
      background: ${theme.colors[0]};
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }

    .dql-filter-reset {
      padding: 8px 16px;
      background: transparent;
      color: ${theme.textColor};
      border: 1px solid ${theme.borderColor};
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }

    .dql-chart-wrapper { min-width: 0; position: relative; }
    .dql-drill-indicator { position: absolute; top: 10px; right: 12px; z-index: 2; padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 999px; border: 1px solid ${theme.borderColor}; background: ${theme.cardBackground}; color: ${theme.textColor}; opacity: 0.8; pointer-events: none; }
    .dql-inline-drill-up { position: absolute; top: 10px; left: 12px; z-index: 3; padding: 4px 8px; border: 1px solid ${theme.borderColor}; border-radius: 6px; background: ${theme.cardBackground}; color: ${theme.textColor}; font-size: 12px; cursor: pointer; }
    .dql-chart canvas, .dql-chart svg { max-width: 100%; }
    .dql-interactive { cursor: pointer; }
    .dql-loading { display: flex; align-items: center; justify-content: center; min-height: 200px; color: ${theme.textColor}; }
    .dql-error { color: #E45756; padding: 16px; background: ${theme.cardBackground}; border: 1px solid #E45756; border-radius: 8px; }

    .dql-modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000; align-items: center; justify-content: center; }
    .dql-modal-overlay.active { display: flex; }
    .dql-modal { background: ${theme.cardBackground}; border: 1px solid ${theme.borderColor}; border-radius: 12px; width: 90%; max-width: 900px; max-height: 80vh; overflow: auto; }
    .dql-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 20px 24px; border-bottom: 1px solid ${theme.borderColor}; }
    .dql-modal-title { font-size: 18px; font-weight: 700; color: ${theme.titleColor}; }
    .dql-drill-stack { margin-top: 4px; font-size: 12px; color: ${theme.textColor}; opacity: 0.8; }
    .dql-drill-controls { display: flex; align-items: center; gap: 8px; }
    .dql-drill-up { padding: 4px 10px; font-size: 12px; border: 1px solid ${theme.borderColor}; border-radius: 6px; background: ${theme.cardBackground}; color: ${theme.textColor}; cursor: pointer; }
    .dql-drill-up[disabled] { opacity: 0.6; cursor: not-allowed; }
    .dql-modal-close { width: 32px; height: 32px; border: none; background: transparent; color: ${theme.textColor}; font-size: 20px; cursor: pointer; border-radius: 6px; display: flex; align-items: center; justify-content: center; }
    .dql-modal-close:hover { background: ${theme.borderColor}; }
    .dql-modal-body { padding: 24px; }
    .dql-drill-table { width: 100%; border-collapse: collapse; }
    .dql-drill-table th { text-align: left; padding: 10px 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; color: ${theme.textColor}; background: ${theme.background}; border-bottom: 2px solid ${theme.borderColor}; }
    .dql-drill-table td { padding: 10px 12px; font-size: 14px; color: ${theme.foreground}; border-bottom: 1px solid ${theme.borderColor}; }

    /* Responsive breakpoints */
    @media (max-width: 1024px) {
      .dql-dashboard-grid { grid-template-columns: repeat(6, 1fr) !important; }
      .dql-chart-wrapper { grid-column: 1 / -1 !important; }
    }
    @media (max-width: 768px) {
      body { padding: 12px; }
      .dql-dashboard-grid { grid-template-columns: 1fr !important; gap: 12px; }
      .dql-chart-wrapper { grid-column: 1 / -1 !important; }
      .dql-tabs { overflow-x: auto; }
      .dql-tab { white-space: nowrap; }
      .dql-filter-bar { flex-direction: column; }
      .dql-filter-select, .dql-filter-input, .dql-filter-date { min-width: 100% !important; }
      .dql-modal { width: 98%; max-height: 90vh; }
    }
    @media print {
      .dql-tabs, .dql-filter-bar, .dql-modal-overlay { display: none !important; }
      .dql-page { display: block !important; page-break-after: always; }
      body { background: white; color: black; padding: 0; }
      .dql-chart { border: none !important; }
    }
  </style>
</head>
<body>
  <header class="dql-dashboard-header">
    <h1 class="dql-dashboard-title">${escapeHTML(workbook.title)}</h1>
    <nav class="dql-tabs">
      ${pageTabs}
    </nav>
  </header>

  ${pageContents}

  <!-- Drill-down Modal -->
  <div class="dql-modal-overlay" id="dql-drill-modal">
    <div class="dql-modal">
      <div class="dql-modal-header">
        <div>
          <div class="dql-modal-title" id="dql-drill-title">Detail View</div>
          <div class="dql-drill-stack" id="dql-drill-stack"></div>
        </div>
        <div class="dql-drill-controls">
          <button class="dql-drill-up" id="dql-drill-up" disabled>Drill Up</button>
          <button class="dql-modal-close" id="dql-drill-close">&times;</button>
        </div>
      </div>
      <div class="dql-modal-body" id="dql-drill-body">
        <div class="dql-loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    // DQL Workbook Configuration
    var DQL_CURRENT_PAGE = 0;
    var DQL_PAGE_CONFIGS = [];

    // Initialize page configs from data attributes
    document.querySelectorAll('.dql-page').forEach(function(el, i) {
      DQL_PAGE_CONFIGS[i] = JSON.parse(el.getAttribute('data-config'));
    });

    function dqlGetInitialPage() {
      try {
        var u = new URL(window.location.href);
        var sp = u.searchParams.get('page');
        if (sp !== null && sp !== undefined && sp !== '') {
          var n = parseInt(sp, 10);
          if (!isNaN(n)) return n;
        }
        var h = (window.location.hash || '').replace(/^#/, '');
        var m = h.match(/(?:^|&)page=(\\d+)(?:&|$)/);
        if (m) {
          var n2 = parseInt(m[1], 10);
          if (!isNaN(n2)) return n2;
        }
      } catch (e) { console.warn('[zlens] dqlGetInitialPage URL/hash parse failed', e); }
      return 0;
    }

    (function() {
      var initial = dqlGetInitialPage();
      if (typeof initial === 'number' && initial >= 0 && initial < DQL_PAGE_CONFIGS.length) {
        DQL_CURRENT_PAGE = initial;
        // Update page visibility + tab state before the runtime initializes.
        document.querySelectorAll('.dql-page').forEach(function(el, i) { el.style.display = (i === initial ? 'block' : 'none'); });
        document.querySelectorAll('.dql-tab').forEach(function(el) { el.classList.remove('dql-tab-active'); });
        if (document.querySelectorAll('.dql-tab')[initial]) document.querySelectorAll('.dql-tab')[initial].classList.add('dql-tab-active');
      }
    })();

    // Set initial DQL_CONFIG from current page
    var DQL_CONFIG = Object.assign({}, DQL_PAGE_CONFIGS[DQL_CURRENT_PAGE] || DQL_PAGE_CONFIGS[0], {
      title: ${JSON.stringify(workbook.title)},
      apiEndpoint: '/api/query',
      features: {
        hierarchyDrillEnabled: true,
        runtimeCacheEnabled: true,
        materializationEnabled: true,
      },
    });

    function dqlSwitchPage(pageIndex) {
      if (pageIndex < 0 || pageIndex >= DQL_PAGE_CONFIGS.length) return;
      // Hide all pages
      document.querySelectorAll('.dql-page').forEach(function(el) { el.style.display = 'none'; });
      // Show target page
      var targetPage = document.getElementById('dql-page-' + pageIndex);
      if (targetPage) targetPage.style.display = 'block';

      // Update active tab
      document.querySelectorAll('.dql-tab').forEach(function(el) { el.classList.remove('dql-tab-active'); });
      document.querySelectorAll('.dql-tab')[pageIndex].classList.add('dql-tab-active');

      // Update DQL_CONFIG for the new page
      DQL_CONFIG = Object.assign({}, DQL_PAGE_CONFIGS[pageIndex], {
        title: ${JSON.stringify(workbook.title)},
        apiEndpoint: '/api/query',
        features: {
          hierarchyDrillEnabled: true,
          runtimeCacheEnabled: true,
          materializationEnabled: true,
        },
      });
      DQL_CURRENT_PAGE = pageIndex;

      // Keep URL in sync (makes deep-links and iframe navigation possible).
      try {
        var u = new URL(window.location.href);
        u.searchParams.set('page', String(pageIndex));
        history.replaceState(null, '', u.toString());
      } catch (e) { console.warn('[zlens] page URL sync failed', e); }

      // Re-initialize charts for the new page
      if (typeof initDashboard === 'function') initDashboard();
    }
  </script>
  ${runtimeJS === '__EXTERNAL__'
    ? '<script src="/dql-runtime.js"></script>'
    : `<script>\n    ${runtimeJS}\n  </script>`}
</body>
</html>`;
}

function emitVegaScriptTags(options: HTMLEmitOptions): string {
  const assets = options.vegaAssets ?? 'cdn';
  if (assets === 'local') {
    const base = (options.vegaBasePath ?? '/vendor/vega').replace(/\/+$/, '');
    return [
      `<script src="${base}/vega@5.js"></script>`,
      `<script src="${base}/vega-lite@5.js"></script>`,
      `<script src="${base}/vega-embed@6.js"></script>`,
    ].join('\n  ');
  }
  return [
    '<script src="https://cdn.jsdelivr.net/npm/vega@5"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/vega-lite@5"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/vega-embed@6"></script>',
  ].join('\n  ');
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
