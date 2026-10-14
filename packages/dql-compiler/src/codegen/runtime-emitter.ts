export function emitRuntimeJS(): string {
  return `
// ZLens Runtime - Auto-generated
(function() {
  'use strict';

  // Store Vega view instances for signal listening
  var vegaViews = {};

  // Current filter state
  var filterState = {};
  var crossFilterState = {};
  var drillState = { stack: [] };
  var chartColumns = {};
  var restoredState = false;
  var suppressStateSync = false;
  var paramActionState = {};
  var VIEW_PRESET_STORAGE_PREFIX = 'dql:view-presets:';
  var queryCache = {};

  function computeVariables() {
    var vars = {};

    var urlParams = new URLSearchParams(window.location.search);

    // Prefer reading current filter UI values so variables always exist
    // (e.g. dropdown "All" option uses empty string).
    if (DQL_CONFIG.filters) {
      for (var fi = 0; fi < DQL_CONFIG.filters.length; fi++) {
        var f = DQL_CONFIG.filters[fi];
        if (!f || !f.id || !f.param) continue;

        var el = document.getElementById(f.id);
        if (el && el.tagName === 'SELECT' && el.multiple) {
          var selected = [];
          try {
            for (var si = 0; si < el.selectedOptions.length; si++) {
              selected.push(el.selectedOptions[si].value);
            }
          } catch (e) { console.warn('[dql] filter selectedOptions iteration failed for', f.id, e); }
          vars[f.param] = selected;
        } else if (el && 'value' in el) {
          vars[f.param] = el.value;
        } else if (filterState && filterState[f.param] !== undefined) {
          vars[f.param] = filterState[f.param];
        } else if (f.defaultValue !== undefined && vars[f.param] === undefined) {
          vars[f.param] = f.defaultValue;
        }
      }
    }

    // Merge filter state (fallback)
    try {
      Object.keys(filterState || {}).forEach(function(k) {
        if (vars[k] === undefined) vars[k] = filterState[k];
      });
    } catch (e) { console.warn('[dql] filterState merge failed', e); }

    // Merge dashboard params (URL/default-driven)
    if (DQL_CONFIG.params) {
      for (var i = 0; i < DQL_CONFIG.params.length; i++) {
        var p = DQL_CONFIG.params[i];
        if (vars[p.name] === undefined) {
          vars[p.name] = urlParams.get(p.name) || p.defaultValue;
        }
      }
    }

    // Apply parameter actions from chart interactions (highest precedence).
    try {
      Object.keys(paramActionState || {}).forEach(function(key) {
        vars[key] = paramActionState[key];
      });
    } catch (e) { console.warn('[dql] paramActionState merge failed', e); }

    // Merge URL params (lowest precedence; ignore breadcrumb/system params)
    urlParams.forEach(function(value, key) {
      if (key === '_from' || key === '_fromTitle' || key === 'dqlState') return;
      if (vars[key] === undefined) vars[key] = value;
    });

    return vars;
  }

  function getPresetStorageKey() {
    return VIEW_PRESET_STORAGE_PREFIX + (DQL_CONFIG.title || 'dashboard');
  }

  function getChartConfig(chartId) {
    if (!DQL_CONFIG || !Array.isArray(DQL_CONFIG.charts)) return null;
    for (var i = 0; i < DQL_CONFIG.charts.length; i++) {
      var chart = DQL_CONFIG.charts[i];
      if (chart && chart.id === chartId) return chart;
    }
    return null;
  }

  function getChartCacheTTL(chartId) {
    var chart = getChartConfig(chartId);
    if (!chart || chart.cacheTTL == null) return 0;
    var ttl = Number(chart.cacheTTL);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  }

  function getChartMaterializeRefresh(chartId) {
    var chart = getChartConfig(chartId);
    if (!chart || !chart.materializeRefresh) return null;
    return String(chart.materializeRefresh);
  }

  function buildQueryCacheKey(sql, params, connection, variables) {
    var role = DQL_CONFIG && DQL_CONFIG.userRole ? String(DQL_CONFIG.userRole) : '';
    var userId = DQL_CONFIG && DQL_CONFIG.userId ? String(DQL_CONFIG.userId) : '';
    var conn = connection ? String(connection) : '';
    return JSON.stringify({
      role: role,
      userId: userId,
      connection: conn,
      sql: sql,
      params: params || [],
      variables: variables || {},
    });
  }

  function isNonDeterministicSQL(sql) {
    var text = String(sql || '');
    if (!text) return false;
    return /\\b(now|random|rand)\\s*\\(/i.test(text)
      || /\\b(current_timestamp|current_date|current_time)\\b/i.test(text);
  }

  function isCacheableSQL(sql) {
    var allowNondeterministic = DQL_CONFIG.features && DQL_CONFIG.features.cacheAllowNondeterministic === true;
    if (allowNondeterministic) return true;
    return !isNonDeterministicSQL(sql);
  }

  function mergePredicateState() {
    var merged = {};

    // Drill stack predicates (hierarchical AND semantics)
    if (drillState && Array.isArray(drillState.stack)) {
      for (var i = 0; i < drillState.stack.length; i++) {
        var frame = drillState.stack[i];
        var predicates = frame && frame.predicates ? frame.predicates : {};
        var drillKeys = Object.keys(predicates);
        for (var dk = 0; dk < drillKeys.length; dk++) {
          var drillKey = drillKeys[dk];
          merged[drillKey] = predicates[drillKey];
        }
      }
    }

    // Cross-filters merge as OR lists per field across source charts.
    var sourceIds = Object.keys(crossFilterState || {});
    for (var s = 0; s < sourceIds.length; s++) {
      var sourceFilters = crossFilterState[sourceIds[s]] || {};
      var fields = Object.keys(sourceFilters);
      for (var f = 0; f < fields.length; f++) {
        var field = fields[f];
        var values = Array.isArray(sourceFilters[field]) ? sourceFilters[field] : [];
        if (!merged[field]) merged[field] = [];
        for (var v = 0; v < values.length; v++) {
          if (merged[field].indexOf(values[v]) < 0) {
            merged[field].push(values[v]);
          }
        }
      }
    }

    return merged;
  }

  function sanitizePredicateFieldName(field) {
    if (!field) return null;
    var raw = String(field);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return null;
    return raw;
  }

  function applyPredicateFiltersToQuery(chartId, baseSQL, baseParams, baseVariables) {
    var mergedPredicates = mergePredicateState();
    var fields = Object.keys(mergedPredicates);
    if (fields.length === 0) {
      return { sql: baseSQL, params: baseParams || [], variables: baseVariables || {} };
    }

    var knownColumns = chartColumns[chartId];
    if (!Array.isArray(knownColumns) || knownColumns.length === 0) {
      return { sql: baseSQL, params: baseParams || [], variables: baseVariables || {} };
    }

    var columnSet = {};
    for (var c = 0; c < knownColumns.length; c++) columnSet[String(knownColumns[c])] = true;

    var nextParams = (baseParams || []).slice();
    var nextVariables = {};
    var baseVarKeys = Object.keys(baseVariables || {});
    for (var bv = 0; bv < baseVarKeys.length; bv++) {
      var bk = baseVarKeys[bv];
      nextVariables[bk] = baseVariables[bk];
    }

    var maxPosition = 0;
    for (var p = 0; p < nextParams.length; p++) {
      var pos = Number(nextParams[p].position);
      if (Number.isFinite(pos) && pos > maxPosition) maxPosition = pos;
    }

    var whereClauses = [];
    for (var i = 0; i < fields.length; i++) {
      var rawField = fields[i];
      var safeField = sanitizePredicateFieldName(rawField);
      if (!safeField || !columnSet[safeField]) continue;

      var values = Array.isArray(mergedPredicates[rawField]) ? mergedPredicates[rawField] : [];
      var cleanedValues = [];
      for (var v = 0; v < values.length; v++) {
        if (values[v] === null || values[v] === undefined || values[v] === '') continue;
        if (cleanedValues.indexOf(values[v]) < 0) cleanedValues.push(values[v]);
      }
      if (cleanedValues.length === 0) continue;

      if (cleanedValues.length === 1) {
        maxPosition++;
        var singleName = '__dql_pred_' + safeField + '_' + maxPosition;
        nextParams.push({ name: singleName, position: maxPosition });
        nextVariables[singleName] = cleanedValues[0];
        whereClauses.push('"' + safeField + '" = $' + maxPosition);
      } else {
        var inPlaceholders = [];
        for (var cv = 0; cv < cleanedValues.length; cv++) {
          maxPosition++;
          var inName = '__dql_pred_' + safeField + '_' + maxPosition;
          nextParams.push({ name: inName, position: maxPosition });
          nextVariables[inName] = cleanedValues[cv];
          inPlaceholders.push('$' + maxPosition);
        }
        whereClauses.push('"' + safeField + '" IN (' + inPlaceholders.join(', ') + ')');
      }
    }

    if (whereClauses.length === 0) {
      return { sql: baseSQL, params: nextParams, variables: nextVariables };
    }

    return {
      sql: 'SELECT * FROM (' + baseSQL + ') __dql_state WHERE ' + whereClauses.join(' AND '),
      params: nextParams,
      variables: nextVariables,
    };
  }

  function captureStateSnapshot() {
    return {
      filters: filterState || {},
      crossFilters: crossFilterState || {},
      drillStack: drillState && Array.isArray(drillState.stack) ? drillState.stack : [],
      params: paramActionState || {},
    };
  }

  function updateURLState() {
    if (suppressStateSync) return;
    try {
      var snapshot = captureStateSnapshot();
      var encoded = encodeURIComponent(JSON.stringify(snapshot));
      var nextURL = new URL(window.location.href);
      nextURL.searchParams.set('dqlState', encoded);
      history.replaceState(null, '', nextURL.pathname + '?' + nextURL.searchParams.toString());
    } catch (_) {
      // noop
    }
  }

  function restoreURLState() {
    if (restoredState) return;
    restoredState = true;

    try {
      var params = new URLSearchParams(window.location.search);
      var encoded = params.get('dqlState');
      if (!encoded) return;
      var parsed = JSON.parse(decodeURIComponent(encoded));
      if (parsed && typeof parsed === 'object') {
        if (parsed.filters && typeof parsed.filters === 'object') filterState = parsed.filters;
        if (parsed.crossFilters && typeof parsed.crossFilters === 'object') crossFilterState = parsed.crossFilters;
        if (parsed.params && typeof parsed.params === 'object') paramActionState = parsed.params;
        if (Array.isArray(parsed.drillStack)) {
          drillState.stack = parsed.drillStack.filter(function(frame) {
            return frame && typeof frame === 'object' && frame.predicates;
          });
        }
      }
    } catch (_) {
      // noop
    }
  }

  function clearHierarchyExpandArtifacts(chartId) {
    var selector = chartId
      ? '.dql-hierarchy-expand-detail[data-chart-id="' + chartId + '"]'
      : '.dql-hierarchy-expand-detail';
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node && node.parentElement) node.parentElement.removeChild(node);
    }
  }

  function updateInlineDrillControls() {
    var controls = document.querySelectorAll('.dql-inline-drill-up');
    var activeCharts = {};
    if (drillState && Array.isArray(drillState.stack)) {
      for (var i = 0; i < drillState.stack.length; i++) {
        var frame = drillState.stack[i];
        if (!frame || frame.kind !== 'hierarchy' || frame.mode === 'modal') continue;
        if (frame.chartId) activeCharts[frame.chartId] = true;
      }
    }

    for (var c = 0; c < controls.length; c++) {
      var control = controls[c];
      var chartId = control.getAttribute('data-chart-id');
      if (chartId && activeCharts[chartId]) {
        control.style.display = 'inline-flex';
      } else {
        control.style.display = 'none';
      }
    }
  }

  function updateDrillHeader() {
    var titleEl = document.getElementById('dql-drill-title');
    var stackEl = document.getElementById('dql-drill-stack');
    var upBtn = document.getElementById('dql-drill-up');
    if (!titleEl) {
      if (!drillState.stack || drillState.stack.length === 0) {
        clearHierarchyExpandArtifacts();
      }
      updateInlineDrillControls();
      return;
    }

    if (!drillState.stack || drillState.stack.length === 0) {
      titleEl.textContent = 'Detail View';
      if (stackEl) stackEl.textContent = '';
      if (upBtn) upBtn.setAttribute('disabled', 'true');
      clearHierarchyExpandArtifacts();
      updateInlineDrillControls();
      return;
    }

    var labels = drillState.stack.map(function(frame) {
      return frame.label || frame.chartId || 'detail';
    });
    titleEl.textContent = 'Detail View - ' + labels[labels.length - 1];
    if (stackEl) stackEl.textContent = labels.join(' > ');
    if (upBtn) upBtn.removeAttribute('disabled');
    updateInlineDrillControls();
  }

  function buildPredicateMapFromDatum(datum) {
    var map = {};
    if (!datum || typeof datum !== 'object') return map;
    var keys = Object.keys(datum);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === '_vgsid_' || key.indexOf('__') === 0) continue;
      var safeKey = sanitizePredicateFieldName(key);
      if (!safeKey) continue;
      var value = datum[key];
      if (value === null || value === undefined || value === '') continue;
      map[safeKey] = [value];
    }
    return map;
  }

  async function fetchQueryData(chartId, sql, params, connection, variables) {
    try {
      var runtimeCacheEnabled = !DQL_CONFIG.features || DQL_CONFIG.features.runtimeCacheEnabled !== false;
      var cacheTTL = runtimeCacheEnabled ? getChartCacheTTL(chartId) : 0;
      var canUseCache = cacheTTL > 0 && isCacheableSQL(sql);
      var cacheKey = null;
      if (canUseCache) {
        cacheKey = buildQueryCacheKey(sql, params, connection, variables);
        var cached = queryCache[cacheKey];
        if (cached && cached.expiresAt > Date.now()) {
          return cached.result;
        }
      }

      var payload = { sql: sql, sqlParams: params || [], variables: variables || {} };
      if (connection) payload.connectionId = connection;
      var materializationEnabled = !DQL_CONFIG.features || DQL_CONFIG.features.materializationEnabled !== false;
      var materializeRefresh = materializationEnabled ? getChartMaterializeRefresh(chartId) : null;
      if (materializeRefresh) {
        payload.materialize = {
          chartId: chartId,
          refreshPolicy: materializeRefresh,
        };
      }
      const response = await fetch(DQL_CONFIG.apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Query failed: ' + response.statusText);
      }

      var parsed = await response.json();
      if (canUseCache && cacheKey) {
        queryCache[cacheKey] = {
          result: parsed,
          expiresAt: Date.now() + (cacheTTL * 1000),
        };
      }
      return parsed;
    } catch (error) {
      console.error('DQL query error for ' + chartId + ':', error);
      return { columns: [], rows: [], error: error.message };
    }
  }

  async function renderVegaLiteChart(chartId, spec, data) {
    var container = document.getElementById(chartId);
    if (!container) {
      console.error('[DQL] Container not found for ' + chartId);
      return;
    }

    // Check if Vega libraries loaded
    if (typeof vegaEmbed === 'undefined') {
      container.innerHTML = '<div class="dql-error">Vega-Lite library failed to load. Check your internet connection.</div>';
      return;
    }

    if (!data || data.length === 0) {
      container.innerHTML = '<div class="dql-loading">No data returned</div>';
      return;
    }

    try {
      // Deep clone spec to avoid mutating the original
      var renderSpec = JSON.parse(JSON.stringify(spec));
      renderSpec.data = { values: data };

      // Replace "container" width with actual pixel width
      if (renderSpec.width === 'container' || !renderSpec.width) {
        var containerWidth = container.clientWidth - 32; // account for padding
        renderSpec.width = Math.max(containerWidth, 200);
      }
      if (!renderSpec.height) {
        renderSpec.height = 300;
      }

      var result = await vegaEmbed('#' + chartId, renderSpec, {
        actions: false,
        renderer: 'svg',
      });

      // Store the view for signal handling
      vegaViews[chartId] = result.view;

      // Setup interaction handlers if configured
      var interaction = DQL_CONFIG.interactions && DQL_CONFIG.interactions[chartId];
      if (interaction) {
        setupChartInteractions(chartId, result.view, interaction, data);
      }

      console.log('[DQL] Rendered ' + chartId + ' with ' + data.length + ' rows');
    } catch (error) {
      console.error('[DQL] Chart render error for ' + chartId + ':', error);
      container.innerHTML = '<div class="dql-error">Chart error: ' + (error.message || String(error)) + '</div>';
    }
  }

  function renderKPICard(chartId, data) {
    var container = document.getElementById(chartId);
    if (!container || !data || data.length === 0) return;

    var row = data[0];
    var keys = Object.keys(row);
    var html = '<div style="display:flex;flex-wrap:wrap;gap:24px;padding:8px;">';

    for (var i = 0; i < keys.length; i++) {
      var label = keys[i].replace(/_/g, ' ');
      var value = row[keys[i]];
      if (typeof value === 'number') {
        value = value.toLocaleString();
      }
      html += '<div style="flex:1;min-width:120px;text-align:center;">' +
        '<div style="font-size:32px;font-weight:700;color:#4C78A8;">' + escapeHTMLRuntime(String(value)) + '</div>' +
        '<div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px;opacity:0.7;">' + escapeHTMLRuntime(label) + '</div>' +
        '</div>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  // Table pagination state per chart
  var tablePages = {};

  function renderTable(chartId, data) {
    var container = document.getElementById(chartId);
    if (!container || !data || data.length === 0) {
      if (container) container.innerHTML = '<div class="dql-loading">No data</div>';
      return;
    }

    var colNames = Object.keys(data[0]);
    var pageSize = 25;
    var currentPage = tablePages[chartId] || 0;
    var totalPages = Math.ceil(data.length / pageSize);
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    var startRow = currentPage * pageSize;
    var endRow = Math.min(startRow + pageSize, data.length);

    // CSV export button
    var html = '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">';
    html += '<button class="dql-export-csv" data-chart="' + chartId + '" style="padding:4px 12px;font-size:12px;cursor:pointer;border:1px solid var(--dql-border, #ddd);border-radius:4px;background:var(--dql-card-bg, #fff);color:var(--dql-fg, #333);">Export CSV</button>';
    html += '</div>';

    html += '<table class="dql-drill-table" style="width:100%"><thead><tr>';
    for (var i = 0; i < colNames.length; i++) {
      var label = colNames[i].replace(/_/g, ' ');
      html += '<th style="cursor:pointer;" data-col="' + colNames[i] + '">' + escapeHTMLRuntime(label) + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var r = startRow; r < endRow; r++) {
      html += '<tr>';
      for (var c = 0; c < colNames.length; c++) {
        var val = data[r][colNames[c]];
        if (val === null || val === undefined) val = '';
        else if (typeof val === 'number') val = val.toLocaleString();
        else val = String(val);
        html += '<td>' + escapeHTMLRuntime(val) + '</td>';
      }
      html += '</tr>';
    }

    html += '</tbody></table>';

    // Pagination controls
    if (totalPages > 1) {
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:12px;font-size:13px;">';
      html += '<span style="opacity:0.7;">Showing ' + (startRow + 1) + '–' + endRow + ' of ' + data.length + ' rows</span>';
      html += '<div>';
      html += '<button class="dql-page-btn" data-chart="' + chartId + '" data-page="' + (currentPage - 1) + '"' + (currentPage === 0 ? ' disabled' : '') + ' style="padding:4px 10px;margin-right:4px;cursor:pointer;border:1px solid var(--dql-border, #ddd);border-radius:4px;background:var(--dql-card-bg, #fff);color:var(--dql-fg, #333);">Prev</button>';
      html += '<span style="margin:0 8px;">Page ' + (currentPage + 1) + ' / ' + totalPages + '</span>';
      html += '<button class="dql-page-btn" data-chart="' + chartId + '" data-page="' + (currentPage + 1) + '"' + (currentPage >= totalPages - 1 ? ' disabled' : '') + ' style="padding:4px 10px;margin-left:4px;cursor:pointer;border:1px solid var(--dql-border, #ddd);border-radius:4px;background:var(--dql-card-bg, #fff);color:var(--dql-fg, #333);">Next</button>';
      html += '</div></div>';
    }

    container.innerHTML = html;

    // Store data reference for pagination and export
    container._dqlTableData = data;

    // Bind pagination buttons
    var pageBtns = container.querySelectorAll('.dql-page-btn');
    for (var p = 0; p < pageBtns.length; p++) {
      pageBtns[p].addEventListener('click', function(e) {
        var btn = e.currentTarget;
        var cid = btn.getAttribute('data-chart');
        var page = parseInt(btn.getAttribute('data-page'), 10);
        if (isNaN(page) || page < 0) return;
        tablePages[cid] = page;
        var el = document.getElementById(cid);
        if (el && el._dqlTableData) renderTable(cid, el._dqlTableData);
      });
    }

    // Bind CSV export button
    var exportBtn = container.querySelector('.dql-export-csv');
    if (exportBtn) {
      exportBtn.addEventListener('click', function() {
        exportTableCSV(chartId, colNames, data);
      });
    }
  }

  function exportTableCSV(chartId, colNames, data) {
    var csv = colNames.join(',') + '\\n';
    for (var r = 0; r < data.length; r++) {
      var row = [];
      for (var c = 0; c < colNames.length; c++) {
        var val = data[r][colNames[c]];
        if (val === null || val === undefined) val = '';
        else val = String(val);
        // Escape quotes and wrap in quotes if contains comma/quote/newline
        if (val.indexOf(',') >= 0 || val.indexOf('"') >= 0 || val.indexOf('\\n') >= 0) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        row.push(val);
      }
      csv += row.join(',') + '\\n';
    }
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = chartId + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Interaction Handlers ----

  function setupChartInteractions(chartId, view, interaction, data) {
    // Listen for click signals from Vega-Lite selection
    view.addEventListener('click', function(event, item) {
      if (!item || !item.datum) return;

      var datum = item.datum;
      var chartConfig = getChartConfig(chartId);
      var hasHierarchyDrill = chartConfig && chartConfig.drillConfig;

      if (interaction.onClick) {
        handleOnClick(interaction.onClick, datum, chartId);
      } else if (hasHierarchyDrill || interaction.drillDown) {
        // Default click behavior for drill-capable charts.
        handleOnClick('drill_down', datum, chartId);
      } else if (interaction.linkTo) {
        handleOnClick('link', datum, chartId);
      }
    });

    // Filter-by: listen for selection changes to filter other charts
    if (interaction.filterBy) {
      setupFilterByInteraction(chartId, view, interaction.filterBy, data);
    }
  }

  function setupFilterByInteraction(chartId, view, filterBy, data) {
    var fields = Array.isArray(filterBy) ? filterBy : [filterBy];

    // Listen for the dql_filter selection signal
    view.addSignalListener('dql_filter', function(name, value) {
      var selectedValues = {};
      if (value && value.vlPoint && value.vlPoint.or) {
        for (var i = 0; i < value.vlPoint.or.length; i++) {
          var point = value.vlPoint.or[i];
          for (var j = 0; j < fields.length; j++) {
            var field = fields[j];
            if (point[field] !== undefined && point[field] !== null && point[field] !== '') {
              if (!selectedValues[field]) selectedValues[field] = [];
              if (selectedValues[field].indexOf(point[field]) < 0) {
                selectedValues[field].push(point[field]);
              }
            }
          }
        }
      }

      applyCrossChartFilter(chartId, selectedValues);
    });
  }

  function applyCrossChartFilter(sourceChartId, selectedValues) {
    var keys = Object.keys(selectedValues || {});
    if (keys.length === 0) {
      delete crossFilterState[sourceChartId];
    } else {
      crossFilterState[sourceChartId] = selectedValues;
    }
    updateURLState();
    refreshDashboardWithFilters();
  }

  function sanitizeDrillMode(mode) {
    if (mode === 'replace' || mode === 'expand' || mode === 'modal') return mode;
    return 'modal';
  }

  function toRollupSQL(rollup, metricField) {
    if (!metricField) return 'COUNT(*)';
    switch (rollup) {
      case 'count':
        return 'COUNT(' + metricField + ')';
      case 'count_distinct':
        return 'COUNT(DISTINCT ' + metricField + ')';
      case 'avg':
        return 'AVG(' + metricField + ')';
      case 'min':
        return 'MIN(' + metricField + ')';
      case 'max':
        return 'MAX(' + metricField + ')';
      case 'none':
        return metricField;
      case 'sum':
      default:
        return 'SUM(' + metricField + ')';
    }
  }

  function buildHierarchyDrillRequest(chartId, datum) {
    var chartConfig = getChartConfig(chartId);
    if (!chartConfig || !chartConfig.drillConfig) return null;

    var drillConfig = chartConfig.drillConfig;
    var levels = Array.isArray(drillConfig.levels) ? drillConfig.levels : [];
    if (levels.length === 0) return null;

    var sameChartFrames = (drillState.stack || []).filter(function(frame) {
      return frame && frame.kind === 'hierarchy' && frame.chartId === chartId;
    });
    var topFrame = sameChartFrames.length > 0 ? sameChartFrames[sameChartFrames.length - 1] : null;

    var baseIndex = 0;
    if (topFrame && Number.isFinite(topFrame.hierarchyLevelIndex)) {
      baseIndex = topFrame.hierarchyLevelIndex + 1;
    } else if (chartConfig.config && chartConfig.config.x) {
      for (var li = 0; li < levels.length; li++) {
        if (levels[li].dimension === chartConfig.config.x) {
          baseIndex = li + 1;
          break;
        }
      }
    }

    if (baseIndex >= levels.length) return null;
    var nextLevel = levels[baseIndex];

    var predicates = {};
    for (var i = 0; i < sameChartFrames.length; i++) {
      var framePredicates = sameChartFrames[i].predicates || {};
      var fields = Object.keys(framePredicates);
      for (var f = 0; f < fields.length; f++) {
        predicates[fields[f]] = framePredicates[fields[f]];
      }
    }

    var previousLevel = levels[Math.max(0, baseIndex - 1)];
    var currentField = previousLevel ? previousLevel.dimension : (chartConfig.config && chartConfig.config.x);
    if (currentField && datum && datum[currentField] !== undefined) {
      predicates[currentField] = [datum[currentField]];
    } else {
      var datumPredicates = buildPredicateMapFromDatum(datum || {});
      var keys = Object.keys(datumPredicates);
      for (var dk = 0; dk < keys.length; dk++) {
        predicates[keys[dk]] = datumPredicates[keys[dk]];
      }
    }

    var metricField = chartConfig.config && chartConfig.config.y ? chartConfig.config.y : null;
    var rollup = drillConfig.rollup || 'sum';

    return {
      hierarchy: drillConfig.hierarchy,
      path: drillConfig.path || null,
      mode: sanitizeDrillMode(drillConfig.mode || 'modal'),
      levelIndex: baseIndex,
      nextDimension: nextLevel.dimension,
      metricField: metricField,
      rollup: rollup,
      rollupSQL: toRollupSQL(rollup, metricField),
      baseSQL: chartConfig.sql,
      baseParams: chartConfig.params || [],
      predicates: predicates,
      connectionId: chartConfig.connection || undefined,
      variables: computeVariables(),
    };
  }

  async function fetchHierarchyDrill(chartId, request) {
    try {
      var response = await fetch(DQL_CONFIG.apiEndpoint.replace('/query', '/drill/hierarchy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chartId: chartId,
          baseSQL: request.baseSQL,
          baseParams: request.baseParams || [],
          variables: request.variables || {},
          predicates: request.predicates || {},
          nextDimension: request.nextDimension,
          metricField: request.metricField,
          rollup: request.rollup,
          connectionId: request.connectionId,
        }),
      });
      if (!response.ok) {
        throw new Error('Hierarchy drill query failed: ' + response.statusText);
      }
      return await response.json();
    } catch (error) {
      console.error('DQL hierarchy drill error for ' + chartId + ':', error);
      return { columns: [], rows: [], error: error.message };
    }
  }

  function openDrillModalWithResult(title, result) {
    var modal = document.getElementById('dql-drill-modal');
    var titleEl = document.getElementById('dql-drill-title');
    var bodyEl = document.getElementById('dql-drill-body');
    if (!modal || !titleEl || !bodyEl) return;

    titleEl.textContent = title;
    modal.classList.add('active');
    if (result.error) {
      bodyEl.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
      return;
    }
    if (!result.rows || result.rows.length === 0) {
      bodyEl.innerHTML = '<div class="dql-loading">No data found</div>';
      return;
    }
    bodyEl.innerHTML = renderDrillTable(result.columns, result.rows);
  }

  async function renderHierarchyInPlace(chartId, result, nextDimension, metricField, mode) {
    var container = document.getElementById(chartId);
    if (!container) return;

    if (result.error) {
      container.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
      return;
    }

    var baseSpec = DQL_CONFIG.vegaLiteSpecs && DQL_CONFIG.vegaLiteSpecs[chartId];
    if (!baseSpec) {
      container.innerHTML = renderDrillTable(result.columns, result.rows || []);
      return;
    }

    var spec = JSON.parse(JSON.stringify(baseSpec));
    spec.data = { values: result.rows || [] };
    if (spec.encoding && spec.encoding.x) {
      spec.encoding.x.field = nextDimension;
      if (spec.encoding.x.axis && typeof spec.encoding.x.axis === 'object') {
        spec.encoding.x.axis.title = nextDimension;
      }
    }
    if (metricField && spec.encoding && spec.encoding.y) {
      spec.encoding.y.field = metricField;
    }

    try {
      var rendered = await vegaEmbed('#' + chartId, spec, { actions: false, renderer: 'svg' });
      vegaViews[chartId] = rendered.view;
      if (mode === 'expand') {
        var detailId = chartId + '-hierarchy-expand';
        var detailEl = document.getElementById(detailId);
        if (!detailEl) {
          detailEl = document.createElement('div');
          detailEl.id = detailId;
          detailEl.className = 'dql-hierarchy-expand-detail';
          detailEl.setAttribute('data-chart-id', chartId);
          detailEl.style.marginTop = '12px';
          container.parentElement.appendChild(detailEl);
        }
        detailEl.innerHTML = renderDrillTable(result.columns, result.rows || []);
      } else {
        clearHierarchyExpandArtifacts(chartId);
      }
    } catch (error) {
      container.innerHTML = '<div class="dql-error">Chart error: ' + escapeHTMLRuntime(error.message || String(error)) + '</div>';
    }
  }

  async function handleHierarchyDrill(chartId, datum, interaction) {
    var request = buildHierarchyDrillRequest(chartId, datum);
    if (!request) {
      if (interaction && interaction.drillDown) {
        await handleDrillDown(chartId, interaction.drillDown, datum);
        return true;
      }
      return false;
    }

    var cleanDatum = {};
    var datumKeys = Object.keys(datum || {});
    for (var i = 0; i < datumKeys.length; i++) {
      var key = datumKeys[i];
      if (key !== '_vgsid_' && key.indexOf('__') !== 0) cleanDatum[key] = datum[key];
    }

    var result = await fetchHierarchyDrill(chartId, request);
    if (result.error && interaction && interaction.drillDown) {
      // Fallback to legacy drill SQL when hierarchy planning cannot execute.
      await handleDrillDown(chartId, interaction.drillDown, datum);
      return true;
    }
    if (result.error) return false;

    drillState.stack.push({
      kind: 'hierarchy',
      chartId: chartId,
      mode: request.mode,
      hierarchyLevelIndex: request.levelIndex,
      label: request.nextDimension + ': ' + (getClickedLabel(cleanDatum) || String(getClickedValue(cleanDatum) || chartId)),
      predicates: request.predicates || {},
      hierarchyRequest: request,
      datum: cleanDatum,
    });
    updateDrillHeader();
    updateURLState();

    if (request.mode === 'modal') {
      openDrillModalWithResult('Detail View - ' + request.nextDimension, result);
    } else {
      await renderHierarchyInPlace(chartId, result, request.nextDimension, request.metricField, request.mode);
    }
    refreshDashboardWithFilters();
    return true;
  }

  // ---- Drill-Down ----

  async function handleDrillDown(chartId, drillDownSQL, datum) {
    var modal = document.getElementById('dql-drill-modal');
    var titleEl = document.getElementById('dql-drill-title');
    var bodyEl = document.getElementById('dql-drill-body');

    if (!modal || !bodyEl) return;

    var cleanDatum = {};
    var datumKeys = Object.keys(datum || {});
    for (var dk = 0; dk < datumKeys.length; dk++) {
      var datumKey = datumKeys[dk];
      if (datumKey !== '_vgsid_' && datumKey.indexOf('__') !== 0) {
        cleanDatum[datumKey] = datum[datumKey];
      }
    }

    drillState.stack.push({
      kind: 'legacy',
      chartId: chartId,
      mode: 'modal',
      label: getClickedLabel(cleanDatum) || String(getClickedValue(cleanDatum) || chartId),
      predicates: buildPredicateMapFromDatum(cleanDatum),
      templateSQL: drillDownSQL,
      datum: cleanDatum,
    });
    updateDrillHeader();
    updateURLState();

    // Show modal with loading state
    titleEl.textContent = 'Detail View - ' + (getClickedLabel(cleanDatum) || chartId);
    bodyEl.innerHTML = '<div class="dql-loading">Loading details...</div>';
    modal.classList.add('active');

    // Send template SQL + datum to server for safe parameterized interpolation
    var result = await fetchDrillDown(chartId, drillDownSQL, cleanDatum);

    if (result.error) {
      bodyEl.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
      return;
    }

    if (!result.rows || result.rows.length === 0) {
      bodyEl.innerHTML = '<div class="dql-loading">No data found</div>';
      return;
    }

    // Render results as a table
    bodyEl.innerHTML = renderDrillTable(result.columns, result.rows);

    // Refresh all charts to apply query-level drill predicates.
    refreshDashboardWithFilters();
  }

  async function drillUp() {
    if (!drillState.stack || drillState.stack.length === 0) return;
    drillState.stack.pop();
    updateDrillHeader();
    updateURLState();

    if (!drillState.stack || drillState.stack.length === 0) {
      var modal = document.getElementById('dql-drill-modal');
      if (modal) modal.classList.remove('active');
    } else {
      var top = drillState.stack[drillState.stack.length - 1];
      if (top.kind === 'hierarchy' && top.hierarchyRequest) {
        var hierarchyResult = await fetchHierarchyDrill(top.chartId, top.hierarchyRequest);
        if (top.mode === 'modal') {
          openDrillModalWithResult('Detail View - ' + (top.label || top.chartId), hierarchyResult);
        } else {
          await renderHierarchyInPlace(
            top.chartId,
            hierarchyResult,
            top.hierarchyRequest.nextDimension,
            top.hierarchyRequest.metricField,
            top.mode || 'replace',
          );
        }
      } else {
        var bodyEl = document.getElementById('dql-drill-body');
        if (bodyEl) bodyEl.innerHTML = '<div class="dql-loading">Loading details...</div>';
        var result = await fetchDrillDown(top.chartId, top.templateSQL, top.datum || {});
        if (bodyEl) {
          if (result.error) {
            bodyEl.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
          } else {
            bodyEl.innerHTML = renderDrillTable(result.columns, result.rows || []);
          }
        }
      }
    }

    refreshDashboardWithFilters();
  }

  async function fetchDrillDown(chartId, templateSQL, datum) {
    try {
      // Clean datum: remove Vega internal fields
      var cleanDatum = {};
      var keys = Object.keys(datum);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k !== '_vgsid_' && !k.startsWith('__')) {
          cleanDatum[k] = datum[k];
        }
      }

      var chartConfig = null;
      if (DQL_CONFIG && Array.isArray(DQL_CONFIG.charts)) {
        for (var ci = 0; ci < DQL_CONFIG.charts.length; ci++) {
          if (DQL_CONFIG.charts[ci].id === chartId) {
            chartConfig = DQL_CONFIG.charts[ci];
            break;
          }
        }
      }

      var response = await fetch(DQL_CONFIG.apiEndpoint.replace('/query', '/drill'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chartId: chartId,
          templateSQL: templateSQL,
          datum: cleanDatum,
          connectionId: chartConfig && chartConfig.connection ? chartConfig.connection : undefined
        }),
      });

      if (!response.ok) {
        throw new Error('Drill-down query failed: ' + response.statusText);
      }

      return await response.json();
    } catch (error) {
      console.error('DQL drill-down error for ' + chartId + ':', error);
      return { columns: [], rows: [], error: error.message };
    }
  }

  function getClickedValue(datum) {
    // Return the first meaningful value from the datum
    var keys = Object.keys(datum).filter(function(k) {
      return k !== '_vgsid_' && !k.startsWith('__');
    });
    if (keys.length > 0) return datum[keys[0]];
    return '';
  }

  function getClickedLabel(datum) {
    var keys = Object.keys(datum).filter(function(k) {
      return k !== '_vgsid_' && !k.startsWith('__') && typeof datum[k] === 'string';
    });
    if (keys.length > 0) return datum[keys[0]];
    return null;
  }

  function renderDrillTable(columns, rows) {
    var colNames = columns ? columns.map(function(c) { return c.name; }) : Object.keys(rows[0] || {});

    var html = '<table class="dql-drill-table"><thead><tr>';
    for (var i = 0; i < colNames.length; i++) {
      html += '<th>' + escapeHTMLRuntime(colNames[i]) + '</th>';
    }
    html += '</tr></thead><tbody>';

    var maxRows = Math.min(rows.length, 100);
    for (var r = 0; r < maxRows; r++) {
      html += '<tr>';
      for (var c = 0; c < colNames.length; c++) {
        var val = rows[r][colNames[c]];
        html += '<td>' + escapeHTMLRuntime(val === null || val === undefined ? '' : String(val)) + '</td>';
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    if (rows.length > 100) {
      html += '<p style="margin-top: 12px; color: #888;">Showing first 100 of ' + rows.length + ' rows</p>';
    }
    return html;
  }

  // ---- Navigation ----

  function handleLinkTo(linkTo, datum) {
    // Interpolate datum values into the URL
    var url = interpolateDatum(linkTo, datum);

    // Add referrer info for breadcrumb navigation
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    url += sep + '_from=' + encodeURIComponent(location.pathname) + '&_fromTitle=' + encodeURIComponent(DQL_CONFIG.title);
    try {
      var state = encodeURIComponent(JSON.stringify(captureStateSnapshot()));
      url += '&dqlState=' + state;
    } catch (e) { console.warn('[dql] dqlState capture failed', e); }

    window.location.href = url;
  }

  function handleOnClick(action, datum, chartId) {
    // Dispatch a custom event with clicked data for external integrations
    var event = new CustomEvent('dql:click', {
      detail: {
        chartId: chartId,
        action: action,
        datum: datum,
      },
      bubbles: true,
    });
    document.dispatchEvent(event);

    // Built-in actions
    if (action === 'drill_down') {
      var interaction = DQL_CONFIG.interactions ? DQL_CONFIG.interactions[chartId] : null;
      var chartConfig = getChartConfig(chartId);
      if (chartConfig && chartConfig.drillConfig && DQL_CONFIG.features && DQL_CONFIG.features.hierarchyDrillEnabled !== false) {
        handleHierarchyDrill(chartId, datum, interaction);
      } else if (interaction && interaction.drillDown) {
        handleDrillDown(chartId, interaction.drillDown, datum);
      }
    } else if (action === 'navigate' || action === 'link') {
      var interaction2 = DQL_CONFIG.interactions ? DQL_CONFIG.interactions[chartId] : null;
      if (interaction2 && interaction2.linkTo) {
        handleLinkTo(interaction2.linkTo, datum);
      }
    } else if (String(action || '').indexOf('set_param:') === 0 || String(action || '').indexOf('set_params:') === 0) {
      applyParameterAction(action, datum);
    }
  }

  // ---- Filter System ----

  async function initFilters() {
    if (!DQL_CONFIG.filters || DQL_CONFIG.filters.length === 0) return;

    // Load filter options from SQL queries
    for (var i = 0; i < DQL_CONFIG.filters.length; i++) {
      var filter = DQL_CONFIG.filters[i];
      if (filter.sql) {
        await loadFilterOptions(filter);
      }

      // Set default values
      if (filter.defaultValue) {
        filterState[filter.param] = filter.defaultValue;
        setFilterUIValue(filter.id, filter.defaultValue);
      }
    }

    // Apply state restored from URL if available.
    for (var j = 0; j < DQL_CONFIG.filters.length; j++) {
      var restoredFilter = DQL_CONFIG.filters[j];
      if (!restoredFilter || !restoredFilter.param) continue;
      if (Object.prototype.hasOwnProperty.call(filterState, restoredFilter.param)) {
        var restoredEl = document.getElementById(restoredFilter.id);
        var restoredValue = filterState[restoredFilter.param];
        if (restoredEl && restoredEl.tagName === 'SELECT' && restoredEl.multiple && Array.isArray(restoredValue)) {
          for (var ro = 0; ro < restoredEl.options.length; ro++) {
            restoredEl.options[ro].selected = restoredValue.indexOf(restoredEl.options[ro].value) >= 0;
          }
        } else {
          setFilterUIValue(restoredFilter.id, restoredValue);
        }
      }
    }

    // Setup event handlers
    setupFilterEventHandlers();
  }

  async function loadFilterOptions(filter) {
    var variables = computeVariables();
    var result = await fetchQueryData(filter.id, filter.sql, filter.params || [], null, variables);
    if (result.error || !result.rows) return;

    var selectEl = document.getElementById(filter.id);
    if (!selectEl || selectEl.tagName !== 'SELECT') return;

    // Get the first column's values as options
    var colName = result.columns && result.columns.length > 0 ? result.columns[0].name : Object.keys(result.rows[0] || {})[0];
    if (!colName) return;

    for (var i = 0; i < result.rows.length; i++) {
      var val = result.rows[i][colName];
      if (val === null || val === undefined) continue;
      var option = document.createElement('option');
      option.value = String(val);
      option.textContent = String(val);
      selectEl.appendChild(option);
    }
  }

  function setFilterUIValue(filterId, value) {
    var el = document.getElementById(filterId);
    if (!el) return;
    el.value = String(value);
  }

  function setupFilterEventHandlers() {
    var applyBtn = document.getElementById('dql-filter-apply');
    var resetBtn = document.getElementById('dql-filter-reset');

    if (applyBtn) {
      applyBtn.addEventListener('click', function() {
        collectFilterState();
        refreshDashboardWithFilters();
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        resetFilters();
        refreshDashboardWithFilters();
      });
    }

    // Auto-apply for select/date filters on change
    var filterElements = document.querySelectorAll('.dql-filter-select, .dql-filter-date');
    filterElements.forEach(function(el) {
      el.addEventListener('change', function() {
        collectFilterState();
        refreshDashboardWithFilters();
      });
    });

    // Debounced auto-apply for text inputs
    var textInputs = document.querySelectorAll('.dql-filter-input[type="text"]');
    var debounceTimers = {};
    textInputs.forEach(function(el) {
      el.addEventListener('input', function() {
        var id = el.id;
        if (debounceTimers[id]) clearTimeout(debounceTimers[id]);
        debounceTimers[id] = setTimeout(function() {
          collectFilterState();
          refreshDashboardWithFilters();
        }, 300);
      });
    });
  }

  function collectFilterState() {
    filterState = {};
    if (!DQL_CONFIG.filters) return;

    for (var i = 0; i < DQL_CONFIG.filters.length; i++) {
      var filter = DQL_CONFIG.filters[i];
      var el = document.getElementById(filter.id);
      if (!el) continue;

      if (el.tagName === 'SELECT' && el.multiple) {
        var selected = [];
        try {
          for (var s = 0; s < el.selectedOptions.length; s++) {
            selected.push(el.selectedOptions[s].value);
          }
        } catch (e) { console.warn('[dql] captureFilters selectedOptions failed for', filter.id, e); }
        if (selected.length > 0) {
          filterState[filter.param] = selected;
        }
      } else {
        var value = el.value;
        if (value && value !== '') {
          filterState[filter.param] = value;
        }
      }
    }

    updateURLState();
  }

  function resetFilters() {
    filterState = {};
    if (!DQL_CONFIG.filters) return;

    for (var i = 0; i < DQL_CONFIG.filters.length; i++) {
      var filter = DQL_CONFIG.filters[i];
      var el = document.getElementById(filter.id);
      if (!el) continue;

      if (filter.defaultValue) {
        el.value = String(filter.defaultValue);
        filterState[filter.param] = filter.defaultValue;
      } else {
        el.value = '';
      }
    }

    updateURLState();
  }

  async function refreshDashboardWithFilters() {
    for (var i = 0; i < DQL_CONFIG.charts.length; i++) {
      var chart = DQL_CONFIG.charts[i];
      var container = document.getElementById(chart.id);

      // Error boundary per chart during filter refresh
      try {
        var variables = computeVariables();
        var prepared = applyPredicateFiltersToQuery(chart.id, chart.sql, chart.params, variables);

        if (container) {
          container.innerHTML = '<div class="dql-loading">Updating...</div>';
        }

        var result = await fetchQueryData(chart.id, prepared.sql, prepared.params, chart.connection, prepared.variables);

        if (result.error) {
          if (container) {
            container.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
          }
          continue;
        }

        chartColumns[chart.id] = Array.isArray(result.columns)
          ? result.columns.map(function(col) { return col && col.name ? col.name : null; }).filter(Boolean)
          : [];

        var spec = DQL_CONFIG.vegaLiteSpecs[chart.id];
        if (spec) {
          await renderVegaLiteChart(chart.id, JSON.parse(JSON.stringify(spec)), result.rows);
        } else if (chart.type === 'kpi' || chart.type === 'metric') {
          renderKPICard(chart.id, result.rows);
        } else if (chart.type === 'table') {
          renderTable(chart.id, result.rows);
        }
      } catch (err) {
        console.error('[DQL] Error boundary caught during filter refresh for ' + chart.id + ':', err);
        if (container) {
          container.innerHTML = '<div class="dql-error">' +
            '<strong>Chart Error</strong><br>' +
            escapeHTMLRuntime(err.message || String(err)) +
            '</div>';
        }
      }
    }
  }

  // ---- Breadcrumb Navigation ----

  function initBreadcrumb() {
    var breadcrumb = document.getElementById('dql-breadcrumb');
    if (!breadcrumb) return;

    var urlParams = new URLSearchParams(window.location.search);
    var fromPath = urlParams.get('_from');
    var fromTitle = urlParams.get('_fromTitle');

    if (fromPath && fromTitle) {
      breadcrumb.innerHTML = '<a href="' + escapeHTMLRuntime(fromPath) + '">' + escapeHTMLRuntime(fromTitle) + '</a>' +
        '<span class="dql-breadcrumb-sep">/</span>' +
        '<span>' + escapeHTMLRuntime(DQL_CONFIG.title) + '</span>';
    }
  }

  // ---- Modal ----

  function initModal() {
    var modal = document.getElementById('dql-drill-modal');
    var closeBtn = document.getElementById('dql-drill-close');
    var upBtn = document.getElementById('dql-drill-up');
    var inlineUpButtons = document.querySelectorAll('.dql-inline-drill-up');

    for (var bi = 0; bi < inlineUpButtons.length; bi++) {
      inlineUpButtons[bi].addEventListener('click', function() {
        drillUp();
      });
    }

    if (!modal || !closeBtn) return;

    function closeModalAndResetDrill() {
      modal.classList.remove('active');
      if (drillState && Array.isArray(drillState.stack) && drillState.stack.length > 0) {
        drillState.stack = [];
        updateDrillHeader();
        updateURLState();
        refreshDashboardWithFilters();
      }
    }

    closeBtn.addEventListener('click', function() {
      closeModalAndResetDrill();
    });

    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        closeModalAndResetDrill();
      }
    });

    if (upBtn) {
      upBtn.addEventListener('click', function() {
        drillUp();
      });
    }

    // Close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        closeModalAndResetDrill();
      }
    });

    updateDrillHeader();
    updateInlineDrillControls();
  }

  // ---- Utility ----

  function interpolateDatum(template, datum) {
    return template.replace(/\{(\w+)\}/g, function(_match, key) {
      var val = datum[key];
      return val === null || val === undefined ? '' : String(val);
    }).replace(/\{clicked\.(\w+)\}/g, function(_match, field) {
      var val = datum[field];
      return val === null || val === undefined ? '' : String(val);
    });
  }

  function applyParameterAction(action, datum) {
    if (!action) return;
    var actionText = String(action);
    var updates = {};

    if (actionText.indexOf('set_param:') === 0) {
      var parts = actionText.split(':');
      var paramName = (parts[1] || '').trim();
      var datumField = (parts[2] || '').trim();
      if (!paramName) return;
      var nextValue = datumField ? datum[datumField] : getClickedValue(datum);
      if (nextValue !== undefined) updates[paramName] = nextValue;
    } else if (actionText.indexOf('set_params:') === 0) {
      var pairs = actionText.slice('set_params:'.length).split(',');
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i];
        var eq = pair.indexOf('=');
        if (eq <= 0) continue;
        var pName = pair.slice(0, eq).trim();
        var fieldName = pair.slice(eq + 1).trim();
        if (!pName || !fieldName) continue;
        if (datum[fieldName] !== undefined) {
          updates[pName] = datum[fieldName];
        }
      }
    }

    var keys = Object.keys(updates);
    if (keys.length === 0) return;

    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      paramActionState[key] = updates[key];
      filterState[key] = updates[key];
      if (DQL_CONFIG.filters) {
        for (var fi = 0; fi < DQL_CONFIG.filters.length; fi++) {
          var filter = DQL_CONFIG.filters[fi];
          if (filter && filter.param === key) {
            setFilterUIValue(filter.id, updates[key]);
          }
        }
      }
      var url = new URL(window.location.href);
      url.searchParams.set(key, String(updates[key]));
      history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
    }

    updateURLState();
    refreshDashboardWithFilters();
  }

  function escapeHTMLRuntime(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadSavedPresets() {
    try {
      var raw = localStorage.getItem(getPresetStorageKey());
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (_) {
      return {};
    }
  }

  function persistPresets(presets) {
    try {
      localStorage.setItem(getPresetStorageKey(), JSON.stringify(presets || {}));
    } catch (_) {
      // noop
    }
  }

  function applyStateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;

    suppressStateSync = true;
    if (snapshot.filters && typeof snapshot.filters === 'object') filterState = snapshot.filters;
    if (snapshot.crossFilters && typeof snapshot.crossFilters === 'object') crossFilterState = snapshot.crossFilters;
    if (snapshot.params && typeof snapshot.params === 'object') paramActionState = snapshot.params;
    if (Array.isArray(snapshot.drillStack)) {
      drillState.stack = snapshot.drillStack.filter(function(frame) {
        return frame && typeof frame === 'object' && frame.predicates;
      });
    } else {
      drillState.stack = [];
    }

    if (DQL_CONFIG.filters) {
      for (var i = 0; i < DQL_CONFIG.filters.length; i++) {
        var filter = DQL_CONFIG.filters[i];
        if (!filter || !filter.id || !filter.param) continue;
        var el = document.getElementById(filter.id);
        if (!el) continue;
        var value = Object.prototype.hasOwnProperty.call(filterState, filter.param)
          ? filterState[filter.param]
          : '';
        if (el.tagName === 'SELECT' && el.multiple && Array.isArray(value)) {
          for (var o = 0; o < el.options.length; o++) {
            el.options[o].selected = value.indexOf(el.options[o].value) >= 0;
          }
        } else {
          el.value = value == null ? '' : String(value);
        }
      }
    }

    suppressStateSync = false;
    updateDrillHeader();
    updateURLState();
    refreshDashboardWithFilters();
  }

  function refreshPresetDropdown(selectEl, presets) {
    if (!selectEl) return;
    var current = selectEl.value;
    selectEl.innerHTML = '<option value="">Views</option>';
    var names = Object.keys(presets || {}).sort();
    for (var i = 0; i < names.length; i++) {
      var option = document.createElement('option');
      option.value = names[i];
      option.textContent = names[i];
      selectEl.appendChild(option);
    }
    if (current && presets[current]) selectEl.value = current;
  }

  function initViewPresets() {
    var saveBtn = document.getElementById('dql-save-view');
    var presetSelect = document.getElementById('dql-view-presets');
    if (!saveBtn && !presetSelect) return;

    var presets = loadSavedPresets();
    refreshPresetDropdown(presetSelect, presets);

    if (saveBtn) {
      saveBtn.addEventListener('click', function() {
        var name = prompt('Save current view as:');
        if (!name) return;
        var cleanName = name.trim();
        if (!cleanName) return;
        presets[cleanName] = captureStateSnapshot();
        persistPresets(presets);
        refreshPresetDropdown(presetSelect, presets);
      });
    }

    if (presetSelect) {
      presetSelect.addEventListener('change', function() {
        var selected = presetSelect.value;
        if (!selected || !presets[selected]) return;
        applyStateSnapshot(presets[selected]);
      });
    }
  }

  function shouldEnableTestHooks() {
    try {
      if (globalThis.__DQL_ENABLE_TEST_HOOKS__) return true;
      var params = new URLSearchParams(window.location.search);
      return params.get('dqlTest') === '1';
    } catch (_) {
      return false;
    }
  }

  function initTestHooks() {
    if (!shouldEnableTestHooks()) return;

    globalThis.__DQL_TEST_HOOKS__ = {
      getState: function() {
        return captureStateSnapshot();
      },
      getChartColumns: function() {
        return JSON.parse(JSON.stringify(chartColumns || {}));
      },
      setCrossFilter: function(sourceChartId, selectedValues) {
        if (!sourceChartId) return;
        if (!selectedValues || Object.keys(selectedValues).length === 0) {
          delete crossFilterState[sourceChartId];
        } else {
          crossFilterState[sourceChartId] = selectedValues;
        }
        updateURLState();
      },
      clearCrossFilter: function(sourceChartId) {
        if (!sourceChartId) return;
        delete crossFilterState[sourceChartId];
        updateURLState();
      },
      pushDrill: function(chartId, templateSQL, datum) {
        return handleDrillDown(chartId, templateSQL, datum || {});
      },
      drillUp: function() {
        return drillUp();
      },
      refresh: function() {
        return refreshDashboardWithFilters();
      },
    };
  }

  // ---- Dashboard Init ----

  async function initDashboard() {
    // Initialize breadcrumb navigation
    initBreadcrumb();

    // Initialize modal
    initModal();

    // Restore bookmarkable state from URL before initializing filter UI.
    restoreURLState();
    initTestHooks();

    // Initialize filters
    await initFilters();
    initViewPresets();

    // Render charts with lazy loading for below-the-fold content
    var lazyObserver = null;
    if (typeof IntersectionObserver !== 'undefined') {
      lazyObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) {
            var chartId = entry.target.getAttribute('data-chart-id');
            if (chartId) {
              lazyObserver.unobserve(entry.target);
              loadAndRenderChart(chartId);
            }
          }
        });
      }, { rootMargin: '200px' });
    }

    for (var i = 0; i < DQL_CONFIG.charts.length; i++) {
      var chart = DQL_CONFIG.charts[i];
      var container = document.getElementById(chart.id);
      if (!container) continue;

      container.innerHTML = '<div class="dql-loading">Loading...</div>';

      // First 4 charts load eagerly; rest use lazy loading if available
      var wrapper = container.parentElement;
      if (i < 4 || !lazyObserver || !wrapper) {
        await loadAndRenderChart(chart.id);
      } else {
        wrapper.setAttribute('data-chart-id', chart.id);
        lazyObserver.observe(wrapper);
      }
    }

    updateDrillHeader();
    updateURLState();
  }

  async function loadAndRenderChart(chartId) {
    var chart = DQL_CONFIG.charts.find(function(c) { return c.id === chartId; });
    if (!chart) return;

    var container = document.getElementById(chartId);

    // Error boundary: isolate each chart so one failure doesn't break the page
    try {
      var variables = computeVariables();
      var prepared = applyPredicateFiltersToQuery(chartId, chart.sql, chart.params, variables);
      var result = await fetchQueryData(chartId, prepared.sql, prepared.params, chart.connection, prepared.variables);

      if (result.error) {
        if (container) {
          container.innerHTML = '<div class="dql-error">' + escapeHTMLRuntime(result.error) + '</div>';
        }
        return;
      }

      chartColumns[chartId] = Array.isArray(result.columns)
        ? result.columns.map(function(col) { return col && col.name ? col.name : null; }).filter(Boolean)
        : [];

      var spec = DQL_CONFIG.vegaLiteSpecs[chartId];
      if (spec) {
        await renderVegaLiteChart(chartId, spec, result.rows);
      } else if (chart.type === 'kpi' || chart.type === 'metric') {
        renderKPICard(chartId, result.rows);
      } else if (chart.type === 'table') {
        renderTable(chartId, result.rows);
      }
    } catch (err) {
      console.error('[DQL] Error boundary caught for ' + chartId + ':', err);
      if (container) {
        container.innerHTML = '<div class="dql-error">' +
          '<strong>Chart Error</strong><br>' +
          escapeHTMLRuntime(err.message || String(err)) +
          '</div>';
      }
    }
  }

  // Hot-reload support
  function initHotReload() {
    if (typeof WebSocket === 'undefined') return;

    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = protocol + '//' + location.host + '/__dql_hmr';

    var ws;
    var reconnectAttempts = 0;

    function connect() {
      ws = new WebSocket(wsUrl);

      ws.onopen = function() {
        console.log('[DQL] Hot-reload connected');
        reconnectAttempts = 0;
      };

      ws.onmessage = function(event) {
        var msg = JSON.parse(event.data);
        if (msg.type === 'reload') {
          console.log('[DQL] Reloading dashboard...');
          location.reload();
        } else if (msg.type === 'error') {
          document.body.innerHTML = '<div class="dql-error" style="padding: 24px;"><h2>Compilation Error</h2><pre>' + msg.message + '</pre></div>';
        }
      };

      ws.onclose = function() {
        if (reconnectAttempts < 10) {
          reconnectAttempts++;
          var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);
          setTimeout(connect, delay);
        }
      };
    }

    connect();
  }

  // Auto-refresh support: @refresh(seconds) decorator
  function initAutoRefresh() {
    var interval = DQL_CONFIG.refreshInterval;
    if (!interval || interval <= 0) return;

    var intervalMs = interval * 1000;
    console.log('[DQL] Auto-refresh enabled: every ' + interval + 's');

    setInterval(function() {
      console.log('[DQL] Auto-refreshing dashboard...');
      refreshDashboardWithFilters();
    }, intervalMs);
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      initDashboard();
      initHotReload();
      initAutoRefresh();
    });
  } else {
    initDashboard();
    initHotReload();
    initAutoRefresh();
  }
})();
`;
}
