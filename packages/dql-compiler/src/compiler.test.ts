import { describe, it, expect } from 'vitest';
import { SemanticLayer } from '@zlens/core';
import { compile } from './compiler.js';

describe('compile', () => {
  it('compiles a standalone chart to HTML', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue,
      title = "Revenue Trend"
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards).toHaveLength(1);

    const dashboard = result.dashboards[0];
    expect(dashboard.html).toContain('<!DOCTYPE html>');
    expect(dashboard.html).toContain('vega-lite');
    expect(dashboard.html).toContain('Revenue Trend');
    expect(dashboard.metadata.queries).toHaveLength(1);
    expect(dashboard.metadata.queries[0].sql).toContain('SELECT date, revenue FROM sales');
  });

  it('compiles a dashboard with multiple charts', () => {
    const source = `dashboard "Sales Overview" {
      chart.line(
        SELECT date, revenue FROM sales,
        x = date,
        y = revenue,
        title = "Revenue Trend"
      )

      chart.bar(
        SELECT product, SUM(qty) as units FROM items GROUP BY product,
        x = product,
        y = units,
        title = "Top Products"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards).toHaveLength(1);

    const dashboard = result.dashboards[0];
    expect(dashboard.html).toContain('Sales Overview');
    expect(dashboard.metadata.title).toBe('Sales Overview');
    expect(dashboard.metadata.queries).toHaveLength(2);
    expect(dashboard.chartSpecs).toHaveLength(2);
  });

  it('compiles with dark theme', () => {
    const source = `chart.line(
      SELECT date, val FROM data,
      x = date,
      y = val,
      theme = "dark"
    )`;

    const result = compile(source, { theme: 'dark' });
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards[0].html).toContain('#1a1a2e'); // dark background
  });

  it('extracts schedule metadata from decorators', () => {
    const source = `@schedule(daily, "9:00 AM")
    @email_to("team@company.com")
    dashboard "Report" {
      chart.kpi(
        SELECT SUM(revenue) as total FROM orders,
        metrics = ["total"]
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const meta = result.dashboards[0].metadata;
    expect(meta.schedule).toBeDefined();
    expect(meta.schedule?.cron).toBe('0 9 * * *');
    expect(meta.notifications).toHaveLength(1);
    expect(meta.notifications[0].type).toBe('email');
    expect(meta.notifications[0].recipients).toContain('team@company.com');
  });

  it('generates Vega-Lite specs for chart types', () => {
    const charts = [
      { type: 'line', mark: 'line' },
      { type: 'bar', mark: 'bar' },
      { type: 'sparkline', mark: 'line' },
      { type: 'scatter', mark: 'point' },
      { type: 'area', mark: 'area' },
      { type: 'pie', mark: 'arc' },
      { type: 'heatmap', mark: 'rect' },
      { type: 'treemap', mark: 'rect' },
    ];

    for (const { type, mark } of charts) {
      const source = `chart.${type}(
        SELECT a, b FROM t,
        x = a,
        y = b
      )`;

      const result = compile(source);
      expect(result.errors).toHaveLength(0);
      const spec = result.dashboards[0].chartSpecs[0];
      expect(spec.kind).toBe('vega-lite');
      if (spec.kind === 'vega-lite') {
        expect((spec.spec.mark as Record<string, unknown>).type).toBe(mark);
      }
    }
  });

  it('generates KPI spec for chart.kpi', () => {
    const source = `chart.kpi(
      SELECT SUM(revenue) as total FROM orders,
      metrics = ["total"],
      compare_to_previous = true
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('kpi');
  });

  it('treats single_value block visualization as KPI output', () => {
    const source = `block "Approval Rate" {
      domain = "cards"
      type = "custom"
      query = """SELECT 77.78 AS approval_rate"""
      visualization {
        chart = "single_value"
      }
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('kpi');
  });

  it('handles SQL with template variables', () => {
    const source = `dashboard "Test" {
      let today = CURRENT_DATE

      chart.line(
        SELECT * FROM orders WHERE date = '{today}',
        x = date,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const query = result.dashboards[0].metadata.queries[0];
    expect(query.sql).toContain('$1');
    expect(query.sql).not.toContain('{today}');
  });

  it('handles SQL with ${var} template variables', () => {
    const source = `dashboard "Test" {
      param region: string = "NA"

      chart.line(
        SELECT * FROM orders WHERE region = '\${region}',
        x = date,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const query = result.dashboards[0].metadata.queries[0];
    expect(query.sql).toContain('$1');
    expect(query.sql).not.toContain('${region}');
  });

  it('compiles a standalone block declaration into a dashboard', () => {
    const source = `block "Revenue by Segment" {
      domain = "revenue"
      type = "custom"
      params {
        period = "current_quarter"
      }
      query = """
        SELECT segment, SUM(revenue) AS revenue
        FROM fct_revenue
        WHERE period = \${period}
        GROUP BY segment
      """
      visualization {
        x = segment
        y = revenue
      }
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards).toHaveLength(1);
    expect(result.dashboards[0].metadata.title).toBe('Revenue by Segment');
    expect(result.dashboards[0].metadata.queries).toHaveLength(1);
    expect(result.dashboards[0].metadata.queries[0].sql).toContain('$1');
  });

  it('generates CSS grid layout in HTML', () => {
    const source = `dashboard "Grid Test" {
      chart.line(SELECT a, b FROM t, x = a, y = b)
      chart.bar(SELECT c, d FROM t, x = c, y = d)
    }`;

    const result = compile(source);
    expect(result.dashboards[0].html).toContain('grid-template-columns: repeat(12, 1fr)');
    expect(result.dashboards[0].html).toContain('chart-0');
    expect(result.dashboards[0].html).toContain('chart-1');
  });

  it('includes runtime JS with hot-reload support', () => {
    const source = `chart.line(SELECT a, b FROM t, x = a, y = b)`;
    const result = compile(source);
    expect(result.dashboards[0].html).toContain('initHotReload');
    expect(result.dashboards[0].html).toContain('vegaEmbed');
    expect(result.dashboards[0].html).toContain('__dql_hmr');
  });

  it('compiles chart with drill_down interaction', () => {
    const source = `chart.bar(
      SELECT category, SUM(rev) as revenue FROM orders GROUP BY category,
      x = category,
      y = revenue,
      title = "Revenue by Category",
      drill_down = "SELECT * FROM orders WHERE category = '{clicked_value}'"
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);

    const html = result.dashboards[0].html;
    // Should contain interaction config
    expect(html).toContain('interactions');
    expect(html).toContain('drillDown');
    // Should contain the drill-down modal
    expect(html).toContain('dql-drill-modal');
    expect(html).toContain('dql-modal-close');
    // Should have interactive class
    expect(html).toContain('dql-interactive');

    // Vega-Lite spec should have selection params
    const spec = result.dashboards[0].chartSpecs[0];
    if (spec.kind === 'vega-lite') {
      expect(spec.spec.params).toBeDefined();
      expect(Array.isArray(spec.spec.params)).toBe(true);
    }
  });

  it('compiles chart with link_to navigation', () => {
    const source = `chart.pie(
      SELECT seg, COUNT(*) as cnt FROM users GROUP BY seg,
      x = seg,
      y = cnt,
      link_to = "segment-detail.dql?segment={clicked.seg}"
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);

    const html = result.dashboards[0].html;
    expect(html).toContain('linkTo');
    expect(html).toContain('handleLinkTo');
    // Should contain breadcrumb for back navigation
    expect(html).toContain('dql-breadcrumb');
  });

  it('compiles chart with filter_by interaction', () => {
    const source = `chart.bar(
      SELECT region, SUM(sales) as total FROM data GROUP BY region,
      x = region,
      y = total,
      filter_by = region
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);

    const spec = result.dashboards[0].chartSpecs[0];
    if (spec.kind === 'vega-lite') {
      expect(spec.spec.params).toBeDefined();
      const filterParam = (spec.spec.params as Array<{ name: string }>)?.find((p) => p.name === 'dql_filter');
      expect(filterParam).toBeDefined();
    }
  });

  it('compiles dashboard with filter widgets', () => {
    const source = `dashboard "Filtered Dashboard" {
      filter.dropdown(
        SELECT DISTINCT category FROM products,
        label = "Category",
        param = "cat_filter"
      )

      filter.text(
        label = "Search",
        param = "search_q",
        placeholder = "Type to search..."
      )

      chart.bar(
        SELECT name, revenue FROM products,
        x = name,
        y = revenue,
        title = "Products"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);

    const html = result.dashboards[0].html;
    // Should render filter bar
    expect(html).toContain('dql-filter-bar');
    expect(html).toContain('dql-filter-select');
    expect(html).toContain('dql-filter-input');
    // Should have apply/reset buttons
    expect(html).toContain('dql-filter-apply');
    expect(html).toContain('dql-filter-reset');
    // Should contain filter labels
    expect(html).toContain('Category');
    expect(html).toContain('Search');
    // Should include filter config in DQL_CONFIG
    expect(html).toContain('cat_filter');
    expect(html).toContain('search_q');
  });

  it('compiles dashboard with date_range filter', () => {
    const source = `dashboard "Date Filtered" {
      filter.date_range(
        label = "Report Date",
        param = "date_filter",
        default_value = "2024-01-01"
      )

      chart.line(
        SELECT date, val FROM data,
        x = date,
        y = val
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);

    const html = result.dashboards[0].html;
    expect(html).toContain('dql-filter-date');
    expect(html).toContain('Report Date');
    expect(html).toContain('2024-01-01');
  });

  it('runtime JS includes filter and interaction functions', () => {
    const source = `chart.bar(
      SELECT a, b FROM t,
      x = a,
      y = b,
      drill_down = "SELECT * FROM t WHERE a = '{clicked_value}'"
    )`;
    const result = compile(source);
    const html = result.dashboards[0].html;

    // Should include interaction handling functions
    expect(html).toContain('setupChartInteractions');
    expect(html).toContain('handleDrillDown');
    expect(html).toContain('handleLinkTo');
    expect(html).toContain('initFilters');
    expect(html).toContain('refreshDashboardWithFilters');
    expect(html).toContain('initBreadcrumb');
    expect(html).toContain('initModal');
  });

  it('includes drill-up controls and saved-view preset shell', () => {
    const source = `dashboard "Stateful Dashboard" {
      chart.bar(
        SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
        x = category,
        y = total,
        drill_down = "SELECT * FROM orders WHERE category = '{clicked_value}'"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('dql-drill-up');
    expect(html).toContain('dql-drill-stack');
    expect(html).toContain('dql-save-view');
    expect(html).toContain('dql-view-presets');
  });

  it('runtime emits query-level predicate propagation and parameter actions', () => {
    const source = `chart.bar(
      SELECT region, SUM(sales) as total FROM data GROUP BY region,
      x = region,
      y = total,
      filter_by = region,
      on_click = "set_param:selected_region:region"
    )`;
    const result = compile(source);
    const html = result.dashboards[0].html;
    expect(html).toContain('applyPredicateFiltersToQuery');
    expect(html).toContain('set_param:');
    expect(html).toContain('mergePredicateState');
    expect(html).toContain('initViewPresets');
  });

  it('runtime restores bookmarkable state before filter initialization', () => {
    const source = `dashboard "Bookmark State" {
      filter.dropdown(
        SELECT DISTINCT region FROM sales,
        label = "Region",
        param = "region"
      )

      chart.bar(
        SELECT region, SUM(revenue) as total FROM sales GROUP BY region,
        x = region,
        y = total
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('dqlState');
    expect(html).toContain('restoreURLState');

    const restoreIdx = html.indexOf('restoreURLState();');
    const initFilterIdx = html.indexOf('await initFilters();');
    expect(restoreIdx).toBeGreaterThan(-1);
    expect(initFilterIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeLessThan(initFilterIdx);
  });

  it('compiles the interactive example without errors', () => {
    const source = `dashboard "Sales Analytics" {
      filter.dropdown(
        SELECT DISTINCT category FROM products ORDER BY category,
        label = "Category",
        param = "selected_category",
        placeholder = "All Categories"
      )

      chart.bar(
        SELECT category, SUM(revenue) as total_revenue FROM orders GROUP BY category,
        x = category,
        y = total_revenue,
        title = "Revenue by Category",
        drill_down = "SELECT product_name, SUM(revenue) as revenue FROM order_items WHERE category = '{clicked_value}' GROUP BY product_name",
        filter_by = category
      )

      chart.line(
        SELECT DATE_TRUNC('month', order_date) as month, SUM(revenue) as monthly_revenue FROM orders GROUP BY month ORDER BY month,
        x = month,
        y = monthly_revenue,
        title = "Monthly Revenue Trend",
        link_to = "daily-detail.dql?month={clicked.month}"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards).toHaveLength(1);
    expect(result.dashboards[0].html.length).toBeGreaterThan(1000);
  });

  it('compiles @if conditional chart with data-condition attribute', () => {
    const source = `dashboard "Conditional" {
      param show_details: boolean = true

      @if(show_details)
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('data-condition');
    expect(html).toContain('show_details');
  });

  it('compiles @rls decorator and wraps SQL in subquery', () => {
    const source = `dashboard "Secure" {
      @rls("org_id", "{user.org}")
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const query = result.dashboards[0].metadata.queries[0];
    expect(query.sql).toContain('_dql_rls');
    expect(query.sql).toContain('org_id = COALESCE($1, org_id)');
    expect(query.sql).not.toContain('{user.org}');
    expect(result.dashboards[0].html).toContain('"params":[{"name":"user.org","position":1}]');
  });

  it('compiles @rls literal values as bound params', () => {
    const source = `dashboard "Secure Literal" {
      @rls("region", "EMEA")
      chart.table(
        SELECT * FROM orders
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const query = result.dashboards[0].metadata.queries[0];
    expect(query.sql).toContain('region = COALESCE($1, region)');
    expect(result.dashboards[0].html).toContain('"literalValue":"EMEA"');
  });

  it('compiles workbook with multiple pages', () => {
    const source = `workbook "Q4 Report" {
      page "Revenue" {
        chart.kpi(
          SELECT SUM(revenue) as total FROM orders
        )
      }
      page "Costs" {
        chart.bar(
          SELECT category, SUM(cost) as total FROM expenses GROUP BY category,
          x = category,
          y = total
        )
      }
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.isWorkbook).toBe(true);
    expect(result.dashboards).toHaveLength(1);
    const html = result.dashboards[0].html;
    expect(html).toContain('Q4 Report');
    expect(html).toContain('Revenue');
    expect(html).toContain('Costs');
    expect(html).toContain('dql-tab');
    expect(html).toContain('dqlSwitchPage');
  });

  it('compiles param declarations and includes them in config', () => {
    const source = `dashboard "Parameterized" {
      param region: string = "US"
      param year: number = 2024

      chart.kpi(
        SELECT SUM(revenue) as total FROM orders
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('region');
    expect(html).toContain('US');
  });

  it('compiles explicit layout with rows and spans', () => {
    const source = `dashboard "Layout Test" {
      layout(columns = 12) {
        row {
          chart.kpi(SELECT 1 as val) span 12
        }
        row {
          chart.bar(SELECT a, b FROM t, x = a, y = b) span 6
          chart.line(SELECT a, b FROM t, x = a, y = b) span 6
        }
      }
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('span 12');
    expect(html).toContain('span 6');
  });

  it('emits layout diagnostics metadata when explicit layout misses charts', () => {
    const source = `dashboard "Layout Diagnostics" {
      layout(columns = 12) {
        row {
          chart.kpi(SELECT 1 as total) span 12
        }
      }

      chart.bar(
        SELECT category, SUM(revenue) as total FROM orders GROUP BY category,
        x = category,
        y = total
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const diagnostics = result.dashboards[0].metadata.layoutDiagnostics || [];
    expect(diagnostics.some((d) => d.message.includes('missing from explicit layout'))).toBe(true);
  });

  it('runtime includes error boundary try-catch per chart', () => {
    const source = `chart.bar(SELECT a, b FROM t, x = a, y = b)`;
    const result = compile(source);
    const html = result.dashboards[0].html;
    expect(html).toContain('Error boundary');
    expect(html).toContain('Chart Error');
  });

  it('compiles stacked_bar chart type', () => {
    const source = `chart.stacked_bar(
      SELECT category, region, SUM(sales) as total FROM data GROUP BY category, region,
      x = category,
      y = total,
      color = region
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards[0].chartSpecs[0].kind).toBe('vega-lite');
  });

  it('compiles grouped_bar chart type', () => {
    const source = `chart.grouped_bar(
      SELECT category, region, SUM(sales) as total FROM data GROUP BY category, region,
      x = category,
      y = total,
      color = region
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards[0].chartSpecs[0].kind).toBe('vega-lite');
  });

  it('compiles combo chart type', () => {
    const source = `chart.combo(
      SELECT month, revenue, profit FROM data,
      x = month,
      y = revenue,
      color = profit
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles histogram chart type', () => {
    const source = `chart.histogram(
      SELECT price FROM products,
      x = price
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles funnel chart type', () => {
    const source = `chart.funnel(
      SELECT stage, count FROM pipeline,
      x = stage,
      y = count
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles gauge chart type', () => {
    const source = `chart.gauge(
      SELECT completion_rate FROM metrics,
      y = completion_rate
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles waterfall chart type', () => {
    const source = `chart.waterfall(
      SELECT item, amount FROM financials,
      x = item,
      y = amount
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles boxplot chart type', () => {
    const source = `chart.boxplot(
      SELECT category, value FROM measurements,
      x = category,
      y = value
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('compiles chart with connection profile override', () => {
    const source = `dashboard "Multi-Source" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue,
        connection = "warehouse"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('"connection":"warehouse"');
  });

  it('compiles chart with tooltip and format_y', () => {
    const source = `dashboard "Formatted" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue,
        format_y = "$,.2f"
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('emits CSS custom properties in dashboard HTML', () => {
    const source = `dashboard "Themed" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('--dql-bg:');
    expect(html).toContain('--dql-fg:');
    expect(html).toContain('--dql-card-bg:');
    expect(html).toContain('--dql-border:');
    expect(html).toContain('--dql-accent:');
    expect(html).toContain('var(--dql-bg)');
    expect(html).toContain('var(--dql-font)');
  });

  it('compiles @refresh decorator with interval', () => {
    const source = `@refresh(30)
    dashboard "Live" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('refreshInterval: 30');
    expect(html).toContain('initAutoRefresh');
  });

  it('compiles chart with y2 dual axis arg without warnings', () => {
    const source = `chart.combo(
      SELECT month, revenue, cost FROM finance,
      x = month,
      y = revenue,
      y2 = cost
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('emits loading skeleton placeholders in chart containers', () => {
    const source = `dashboard "Skeleton Test" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('dql-skeleton');
    expect(html).toContain('dql-shimmer');
  });

  it('emits table CSV export and pagination in runtime', () => {
    const source = `dashboard "Table Test" {
      chart.table(
        SELECT id, name FROM users,
        sortable = true,
        page_size = 10
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('exportTableCSV');
    expect(html).toContain('dql-export-csv');
    expect(html).toContain('dql-page-btn');
    expect(html).toContain('tablePages');
  });

  it('compiles @materialize decorator without errors', () => {
    const source = `dashboard "Materialized" {
      @materialize("hourly")
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
  });

  it('default compile uses inline runtime, not external script src', () => {
    const source = `dashboard "Runtime Mode" {
      chart.bar(
        SELECT category, revenue FROM sales,
        x = category,
        y = revenue
      )
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    // Default compile inlines the runtime JS
    expect(html).toContain('initDashboard');
    expect(html).toContain('function fetchQueryData');
    // External mode marker should not appear in default output
    expect(html).not.toContain('src="/dql-runtime.js"');
  });

  it('supports local Vega asset bundles', () => {
    const source = `chart.line(
      SELECT date, revenue FROM sales,
      x = date,
      y = revenue
    )`;

    const result = compile(source, { vegaAssets: 'local', vegaBasePath: '/static/vega' });
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('/static/vega/vega@5.js');
    expect(html).toContain('/static/vega/vega-lite@5.js');
    expect(html).toContain('/static/vega/vega-embed@6.js');
    expect(html).not.toContain('cdn.jsdelivr.net/npm/vega@5');
  });

  it('compiles treemap charts', () => {
    const source = `chart.treemap(
      SELECT category, SUM(revenue) as total FROM sales GROUP BY category,
      x = category,
      y = total,
      color_field = category
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('vega-lite');
    if (spec.kind === 'vega-lite') {
      const markType = typeof spec.spec.mark === 'string'
        ? spec.spec.mark
        : (spec.spec.mark as Record<string, unknown>)?.type;
      expect(markType).toBe('rect');
      expect((spec.spec as Record<string, unknown>).transform).toBeDefined();
    }
  });

  it('compiles sankey charts', () => {
    const source = `chart.sankey(
      SELECT src, dst, SUM(val) as total FROM flows GROUP BY src, dst,
      x = src,
      y = total,
      color_field = dst
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('vega-lite');
    if (spec.kind === 'vega-lite') {
      expect((spec.spec as Record<string, unknown>).layer).toBeDefined();
    }
  });

  it('compiles sparkline charts', () => {
    const source = `chart.sparkline(
      SELECT date, SUM(revenue) as total FROM sales GROUP BY date,
      x = date,
      y = total
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('vega-lite');
    if (spec.kind === 'vega-lite') {
      const markType = typeof spec.spec.mark === 'string'
        ? spec.spec.mark
        : (spec.spec.mark as Record<string, unknown>)?.type;
      expect(markType).toBe('line');
      expect((spec.spec.encoding as Record<string, unknown>)?.x).toBeDefined();
      expect((spec.spec.encoding as Record<string, unknown>)?.y).toBeDefined();
    }
  });

  it('compiles small_multiples charts', () => {
    const source = `chart.small_multiples(
      SELECT date, region, SUM(revenue) as total FROM sales GROUP BY date, region,
      x = date,
      y = total,
      facet = region
    )`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    const spec = result.dashboards[0].chartSpecs[0];
    expect(spec.kind).toBe('vega-lite');
    if (spec.kind === 'vega-lite') {
      expect((spec.spec as Record<string, unknown>).facet).toBeDefined();
      expect((spec.spec as Record<string, unknown>).spec).toBeDefined();
    }
  });

  it('emits hierarchy drill config and runtime feature contracts', () => {
    const source = `dashboard "Hierarchy Runtime Contract" {
      @cache(300)
      @materialize("hourly")
      chart.bar(
        SELECT order_year, SUM(revenue) as revenue FROM orders GROUP BY order_year,
        x = order_year,
        y = revenue,
        drill_hierarchy = "time_hierarchy",
        drill_path = "calendar",
        drill_mode = "replace"
      )
    }`;

    const semanticLayer = new SemanticLayer({
      metrics: [],
      dimensions: [],
      hierarchies: [
        {
          name: 'time_hierarchy',
          label: 'Time',
          description: 'Time hierarchy',
          defaultRollup: 'sum',
          defaultDrillPath: 'calendar',
          levels: [
            { name: 'year', label: 'Year', description: '', dimension: 'order_year', order: 1 },
            { name: 'quarter', label: 'Quarter', description: '', dimension: 'order_quarter', order: 2 },
          ],
          drillPaths: [{ name: 'calendar', levels: ['year', 'quarter'] }],
        },
      ],
    });

    const result = compile(source, { semanticLayer });
    expect(result.errors).toHaveLength(0);
    const html = result.dashboards[0].html;
    expect(html).toContain('"cacheTTL":300');
    expect(html).toContain('"materializeRefresh":"hourly"');
    expect(html).toContain('"drillConfig":{"hierarchy":"time_hierarchy"');
    expect(html).toContain('"mode":"replace"');
    expect(html).toContain('hierarchyDrillEnabled');
    expect(html).toContain('runtimeCacheEnabled');
    expect(html).toContain('materializationEnabled');
    expect(html).toContain('dql-drill-indicator');
    expect(html).toContain('dql-inline-drill-up');
  });
});

// ─── Comprehensive All-Features Integration Test ───────────────────────────
describe('all-features integration', () => {
  it('compiles a dashboard exercising every feature without errors', () => {
    const source = `
      @schedule(daily, "8:00 AM")
      @email_to("team@acme.com")
      @slack_channel("#analytics")
      @refresh(60)
      dashboard "Enterprise Analytics" {

        // Variables
        let today = CURRENT_DATE
        let lookback = 30

        // Parameters
        param region: string = "US"
        param show_details: boolean = true

        // Filters (all 5 types)
        filter.dropdown(
          SELECT DISTINCT category FROM orders ORDER BY category,
          label = "Category",
          param = "cat_filter",
          placeholder = "All Categories"
        )

        filter.date_range(
          label = "Date Range",
          param = "date_range",
          default_value = "2024-01-01"
        )

        filter.text(
          label = "Search",
          param = "search_q",
          placeholder = "Search orders..."
        )

        filter.multi_select(
          SELECT DISTINCT status FROM orders,
          label = "Status",
          param = "status_filter"
        )

        filter.range(
          label = "Revenue Range",
          param = "rev_range"
        )

        // Layout with explicit rows and spans
        layout(columns = 12) {
          row {
            chart.kpi(
              SELECT SUM(revenue) as total_revenue FROM orders,
              metrics = ["total_revenue"],
              compare_to_previous = true,
              title = "Total Revenue"
            ) span 4

            chart.kpi(
              SELECT COUNT(*) as order_count FROM orders,
              metrics = ["order_count"],
              title = "Total Orders"
            ) span 4

            chart.gauge(
              SELECT AVG(satisfaction) as score FROM feedback,
              y = score,
              title = "Customer Satisfaction"
            ) span 4
          }

          row {
            // Bar chart with drill-down, filter_by, tooltip, format_y, connection profile
            chart.bar(
              SELECT category, SUM(revenue) as total_revenue
              FROM orders
              GROUP BY category
              ORDER BY total_revenue DESC,

              x = category,
              y = total_revenue,
              title = "Revenue by Category",
              format_y = "$,.0f",
              connection = "warehouse",
              drill_down = "SELECT product_name, SUM(revenue) as rev FROM orders WHERE category = '{clicked_value}' GROUP BY product_name",
              filter_by = category
            ) span 6

            // Line chart with link_to navigation
            chart.line(
              SELECT order_date, SUM(revenue) as daily_revenue
              FROM orders
              GROUP BY order_date
              ORDER BY order_date,

              x = order_date,
              y = daily_revenue,
              title = "Revenue Over Time",
              x_axis_label = "Date",
              y_axis_label = "Revenue ($)",
              show_grid = true,
              link_to = "daily-detail.dql?date={clicked.order_date}"
            ) span 6
          }

          row {
            // Stacked bar
            chart.stacked_bar(
              SELECT category, region, SUM(sales) as total FROM data GROUP BY category, region,
              x = category,
              y = total,
              color = region,
              title = "Sales by Category & Region"
            ) span 4

            // Pie chart (donut)
            chart.pie(
              SELECT status, COUNT(*) as cnt FROM orders GROUP BY status,
              x = status,
              y = cnt,
              title = "Order Status",
              inner_radius = 50
            ) span 4

            // Area chart
            chart.area(
              SELECT month, SUM(revenue) as rev FROM orders GROUP BY month ORDER BY month,
              x = month,
              y = rev,
              title = "Cumulative Revenue"
            ) span 4
          }

          row {
            // Scatter with size encoding
            chart.scatter(
              SELECT price, quantity, profit FROM products,
              x = price,
              y = quantity,
              size = profit,
              title = "Price vs Quantity"
            ) span 4

            // Heatmap
            chart.heatmap(
              SELECT day_of_week, hour, COUNT(*) as visits FROM traffic GROUP BY day_of_week, hour,
              x = hour,
              y = day_of_week,
              color_field = visits,
              title = "Traffic Heatmap"
            ) span 4

            // Histogram
            chart.histogram(
              SELECT price FROM products,
              x = price,
              title = "Price Distribution"
            ) span 4
          }

          row {
            // Combo chart with dual y-axis
            chart.combo(
              SELECT month, revenue, cost FROM finance,
              x = month,
              y = revenue,
              y2 = cost,
              title = "Revenue vs Cost"
            ) span 4

            // Grouped bar
            chart.grouped_bar(
              SELECT quarter, region, SUM(sales) as total FROM data GROUP BY quarter, region,
              x = quarter,
              y = total,
              color = region,
              title = "Quarterly Sales by Region"
            ) span 4

            // Funnel chart
            chart.funnel(
              SELECT stage, count FROM pipeline,
              x = stage,
              y = count,
              title = "Sales Funnel"
            ) span 4
          }

          row {
            // Waterfall chart
            chart.waterfall(
              SELECT item, amount FROM financials,
              x = item,
              y = amount,
              title = "P&L Waterfall"
            ) span 4

            // Boxplot
            chart.boxplot(
              SELECT department, salary FROM employees,
              x = department,
              y = salary,
              title = "Salary Distribution"
            ) span 4

            // Geo chart
            chart.geo(
              SELECT country, SUM(revenue) as rev FROM global_sales GROUP BY country,
              x = country,
              y = rev,
              title = "Global Revenue"
            ) span 4
          }

          row {
            // @cache decorator
            @cache(300)
            chart.bar(
              SELECT product, SUM(qty) as units FROM items GROUP BY product,
              x = product,
              y = units,
              title = "Cached Product Sales"
            ) span 6

            // @materialize decorator
            @materialize("hourly")
            chart.line(
              SELECT hour, COUNT(*) as events FROM logs GROUP BY hour,
              x = hour,
              y = events,
              title = "Materialized Event Count"
            ) span 6
          }

          row {
            // @rls decorator (row-level security)
            @rls("org_id", "{user.org}")
            chart.table(
              SELECT order_id, customer_name, product_name, revenue, status
              FROM orders
              ORDER BY order_date DESC,

              title = "Secure Orders",
              sortable = true,
              page_size = 25
            ) span 12
          }

          row {
            // @if conditional rendering
            @if(show_details)
            chart.table(
              SELECT * FROM order_details WHERE region = '{region}',

              title = "Order Details (Conditional)",
              sortable = true,
              page_size = 10
            ) span 12
          }

          row {
            // @annotate decorator
            @annotate("2024-06-01", "Product Launch", "#ff0000")
            @annotate("2024-09-15", "Q3 Promo", "#00aa00")
            chart.line(
              SELECT date, SUM(revenue) as rev FROM orders GROUP BY date ORDER BY date,
              x = date,
              y = rev,
              title = "Revenue with Annotations"
            ) span 12
          }
        }
      }
    `;

    const result = compile(source);

    // ── No compilation errors ──
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards).toHaveLength(1);

    const html = result.dashboards[0].html;
    const meta = result.dashboards[0].metadata;

    // ── Dashboard metadata ──
    expect(meta.title).toBe('Enterprise Analytics');

    // ── Schedule + notifications ──
    expect(meta.schedule).toBeDefined();
    expect(meta.schedule?.cron).toBe('0 8 * * *');
    expect(meta.notifications).toBeDefined();
    expect(meta.notifications.length).toBeGreaterThanOrEqual(1);
    const emailNotif = meta.notifications.find((n: { type: string }) => n.type === 'email');
    expect(emailNotif).toBeDefined();
    expect(emailNotif!.recipients).toContain('team@acme.com');

    // ── Auto-refresh ──
    expect(html).toContain('refreshInterval: 60');
    expect(html).toContain('initAutoRefresh');

    // ── CSS custom properties (theming) ──
    expect(html).toContain('--dql-bg:');
    expect(html).toContain('--dql-fg:');
    expect(html).toContain('--dql-card-bg:');
    expect(html).toContain('--dql-accent:');
    expect(html).toContain('var(--dql-bg)');

    // ── Loading skeletons ──
    expect(html).toContain('dql-skeleton');
    expect(html).toContain('dql-shimmer');

    // ── Filter bar (all 5 types) ──
    expect(html).toContain('dql-filter-bar');
    expect(html).toContain('dql-filter-select');     // dropdown
    expect(html).toContain('dql-filter-date');        // date_range
    expect(html).toContain('dql-filter-input');       // text
    expect(html).toContain('cat_filter');
    expect(html).toContain('date_range');
    expect(html).toContain('search_q');
    expect(html).toContain('status_filter');
    expect(html).toContain('rev_range');

    // ── Layout (rows + spans) ──
    expect(html).toContain('span 12');
    expect(html).toContain('span 6');
    expect(html).toContain('span 4');

    // ── Vega-lite chart titles present in serialized specs ──
    // (KPI/gauge titles are rendered at runtime, not in static HTML)
    expect(html).toContain('Revenue by Category');
    expect(html).toContain('Revenue Over Time');
    expect(html).toContain('Order Status');
    expect(html).toContain('Sales Funnel');
    expect(html).toContain('Salary Distribution');
    expect(html).toContain('Global Revenue');
    expect(html).toContain('Revenue vs Cost');
    expect(html).toContain('Revenue with Annotations');

    // ── Interactions ──
    expect(html).toContain('drillDown');              // drill-down
    expect(html).toContain('dql-drill-modal');        // drill-down modal
    expect(html).toContain('linkTo');                 // link_to
    expect(html).toContain('dql-breadcrumb');         // breadcrumb nav
    expect(html).toContain('handleDrillDown');
    expect(html).toContain('handleLinkTo');
    expect(html).toContain('setupChartInteractions');

    // ── Connection profile ──
    expect(html).toContain('"connection":"warehouse"');

    // ── Format ──
    expect(html).toContain('$,.0f');

    // ── @rls — SQL wrapped in subquery ──
    const rlsQuery = meta.queries.find((q: { sql: string }) => q.sql.includes('_dql_rls'));
    expect(rlsQuery).toBeDefined();
    expect(rlsQuery!.sql).toContain('org_id');

    // ── @if conditional ──
    expect(html).toContain('data-condition');
    expect(html).toContain('show_details');

    // ── Params ──
    expect(html).toContain('region');
    expect(html).toContain('"US"');

    // ── Table features (CSV export + pagination) ──
    expect(html).toContain('exportTableCSV');
    expect(html).toContain('dql-export-csv');
    expect(html).toContain('dql-page-btn');
    expect(html).toContain('tablePages');

    // ── Error boundaries ──
    expect(html).toContain('Error boundary');

    // ── Hot-reload ──
    expect(html).toContain('initHotReload');
    expect(html).toContain('__dql_hmr');

    // ── Runtime functions ──
    expect(html).toContain('initDashboard');
    expect(html).toContain('fetchQueryData');
    expect(html).toContain('initFilters');
    expect(html).toContain('initModal');
    expect(html).toContain('initBreadcrumb');

    // ── Vega-Lite specs generated for all chart types ──
    const specs = result.dashboards[0].chartSpecs;
    expect(specs.length).toBeGreaterThanOrEqual(15);

    // Verify we have both vega-lite and kpi spec types
    const vegaSpecs = specs.filter((s) => s.kind === 'vega-lite');
    const kpiSpecs = specs.filter((s) => s.kind === 'kpi');
    expect(vegaSpecs.length).toBeGreaterThanOrEqual(12);
    expect(kpiSpecs.length).toBeGreaterThanOrEqual(2);

    // ── Queries extracted ──
    expect(meta.queries.length).toBeGreaterThanOrEqual(15);
  });

  it('compiles a workbook with all page-level features', () => {
    const source = `
      @schedule(weekly, "Monday 6:00 AM")
      @email_to("execs@acme.com")
      workbook "Quarterly Business Review" {
        page "Executive Summary" {
          param quarter: string = "Q4"

          chart.kpi(
            SELECT SUM(revenue) as total FROM orders,
            metrics = ["total"],
            title = "Quarterly Revenue"
          )

          chart.bar(
            SELECT category, SUM(revenue) as rev FROM orders GROUP BY category,
            x = category,
            y = rev,
            title = "Revenue by Category",
            drill_down = "SELECT product, SUM(revenue) as r FROM orders WHERE category = '{clicked_value}' GROUP BY product"
          )
        }

        page "Operations" {
          filter.dropdown(
            SELECT DISTINCT region FROM orders,
            label = "Region",
            param = "region_filter"
          )

          @cache(600)
          chart.line(
            SELECT date, COUNT(*) as orders FROM orders GROUP BY date ORDER BY date,
            x = date,
            y = orders,
            title = "Daily Order Volume"
          )

          chart.table(
            SELECT order_id, status, revenue FROM orders,
            title = "Order Details",
            sortable = true,
            page_size = 20
          )
        }

        page "Finance" {
          @rls("department", "{user.dept}")
          chart.waterfall(
            SELECT item, amount FROM budget,
            x = item,
            y = amount,
            title = "Budget Waterfall"
          )

          chart.pie(
            SELECT dept, SUM(cost) as total FROM expenses GROUP BY dept,
            x = dept,
            y = total,
            title = "Cost by Department",
            inner_radius = 40
          )
        }
      }
    `;

    const result = compile(source);

    // ── No errors ──
    expect(result.errors).toHaveLength(0);
    expect(result.isWorkbook).toBe(true);
    expect(result.dashboards).toHaveLength(1);

    const html = result.dashboards[0].html;
    const meta = result.dashboards[0].metadata;

    // ── Workbook title ──
    expect(meta.title).toBe('Quarterly Business Review');

    // ── Schedule ──
    expect(meta.schedule).toBeDefined();

    // ── Page tabs ──
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Operations');
    expect(html).toContain('Finance');
    expect(html).toContain('dql-tab');
    expect(html).toContain('dqlSwitchPage');

    // ── Charts from all pages (vega-lite titles appear in spec JSON) ──
    expect(html).toContain('Revenue by Category');
    expect(html).toContain('Daily Order Volume');
    expect(html).toContain('Budget Waterfall');
    expect(html).toContain('Cost by Department');

    // ── Interactions ──
    expect(html).toContain('drillDown');
    expect(html).toContain('dql-drill-modal');

    // ── Filter ──
    expect(html).toContain('dql-filter-bar');
    expect(html).toContain('region_filter');

    // ── Table features ──
    expect(html).toContain('exportTableCSV');
    expect(html).toContain('dql-page-btn');

    // ── @rls ──
    const rlsQuery = meta.queries.find((q: { sql: string }) => q.sql.includes('_dql_rls'));
    expect(rlsQuery).toBeDefined();

    // ── Runtime ──
    expect(html).toContain('initDashboard');
    expect(html).toContain('initHotReload');

    // ── Queries from all pages ──
    expect(meta.queries.length).toBeGreaterThanOrEqual(6);
  });

  it('compiles all 21 chart types in a single dashboard', () => {
    const source = `dashboard "All Charts" {
      chart.line(SELECT a, b FROM t, x = a, y = b, title = "Line")
      chart.bar(SELECT a, b FROM t, x = a, y = b, title = "Bar")
      chart.stacked_bar(SELECT a, b, c FROM t, x = a, y = b, color = c, title = "Stacked")
      chart.grouped_bar(SELECT a, b, c FROM t, x = a, y = b, color = c, title = "Grouped")
      chart.combo(SELECT a, b, c FROM t, x = a, y = b, y2 = c, title = "Combo")
      chart.pie(SELECT a, b FROM t, x = a, y = b, title = "Pie")
      chart.scatter(SELECT a, b FROM t, x = a, y = b, title = "Scatter")
      chart.area(SELECT a, b FROM t, x = a, y = b, title = "Area")
      chart.heatmap(SELECT a, b, c FROM t, x = a, y = b, color_field = c, title = "Heatmap")
      chart.treemap(SELECT a, b FROM t, x = a, y = b, title = "Treemap")
      chart.sankey(SELECT a, b, c FROM t, x = a, y = c, color_field = b, title = "Sankey")
      chart.sparkline(SELECT a, b FROM t, x = a, y = b, title = "Sparkline")
      chart.small_multiples(SELECT a, b, c FROM t, x = a, y = b, facet = c, title = "Small Multiples")
      chart.histogram(SELECT a FROM t, x = a, title = "Histogram")
      chart.funnel(SELECT a, b FROM t, x = a, y = b, title = "Funnel")
      chart.gauge(SELECT a FROM t, y = a, title = "Gauge")
      chart.waterfall(SELECT a, b FROM t, x = a, y = b, title = "Waterfall")
      chart.boxplot(SELECT a, b FROM t, x = a, y = b, title = "Boxplot")
      chart.geo(SELECT a, b FROM t, x = a, y = b, title = "Geo")
      chart.kpi(SELECT SUM(a) as total FROM t, metrics = ["total"], title = "KPI")
      chart.table(SELECT a, b FROM t, sortable = true, page_size = 10, title = "Table")
    }`;

    const result = compile(source);
    expect(result.errors).toHaveLength(0);
    expect(result.dashboards[0].chartSpecs).toHaveLength(21);
    expect(result.dashboards[0].metadata.queries).toHaveLength(21);

    const html = result.dashboards[0].html;
    // All 21 titles present
    for (const title of ['Line', 'Bar', 'Stacked', 'Grouped', 'Combo', 'Pie', 'Scatter',
      'Area', 'Heatmap', 'Treemap', 'Sankey', 'Sparkline', 'Small Multiples', 'Histogram', 'Funnel', 'Gauge', 'Waterfall', 'Boxplot', 'Geo', 'KPI', 'Table']) {
      expect(html).toContain(title);
    }

    // Verify spec types
    const vegaLite = result.dashboards[0].chartSpecs.filter((s) => s.kind === 'vega-lite');
    const kpi = result.dashboards[0].chartSpecs.filter((s) => s.kind === 'kpi');
    const table = result.dashboards[0].chartSpecs.filter((s) => s.kind === 'table');
    expect(vegaLite.length).toBe(19); // all except kpi + table (geo + treemap + sankey + sparkline + small_multiples are vega-lite)
    expect(kpi.length).toBe(1);
    expect(table.length + kpi.length + vegaLite.length).toBe(21);
  });
});
