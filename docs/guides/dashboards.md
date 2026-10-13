# Build a dashboard

> ~3 minutes · ends with an HTML file you can host anywhere

ZLens dashboards are **compiled static HTML**. No SaaS DB, no login, no
runtime server — just a file. Host on S3, GitHub Pages, Vercel, a USB stick.

## 1. Mark a notebook as a dashboard

Add a `dashboard:` header to any `.dql` file:

```dql
// dql-format: 1

dashboard: {
  title: "Revenue Overview"
  description: "Daily revenue + segment breakdown"
  layout: "grid"   // grid | single-column
}

// … your cells …
```

Or scaffold one:

```bash
zlens dashboard new overview --from notebooks/jaffle-overview.dql
```

## 2. Compile

```bash
zlens compile dashboards/overview.dql --out build/
# ✓ compiled 4 cells
# ✓ emitted build/overview.html (312 KB, self-contained)
```

The output is a single HTML file with inlined CSS, JS, and data. No
external fetches at runtime.

## 3. Host it

```bash
# Any static host works. Examples:
aws s3 cp build/overview.html s3://my-dashboards/
# or
vercel deploy build/
```

## Parameters

Params in the notebook become URL query params in the dashboard:

```dql
param region: select(options: ["us", "eu", "apac"], default: "us")
```

Results in `overview.html?region=eu`.

## Verify it worked

- Opening `build/overview.html` in a browser renders charts without network
- `curl -s build/overview.html | grep -c '<script'` is small — everything's inlined
- View-source shows your chart data (SSR-style)
