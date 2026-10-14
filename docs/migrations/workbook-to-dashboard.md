# Migrating `workbook { }` to `dashboard { tabs: [...] }`

**Status:** `workbook` is deprecated in v1.2 and will be removed in v1.3.

`workbook` has always been a tabbed-dashboard variant — the compiler has
lowered both constructs through the same IR and HTML emitter path for several
releases. v1.2 keeps the feature working but emits a deprecation warning at
compile time and on `zlens fmt --check`. Migrate before v1.3.

## One-sentence rewrite

Replace the outer `workbook "<title>" { page "..." { ... } }` wrapper with
`dashboard "<title>" { tabs: [ tab("...", { ... }) ] }`. Tab semantics, layout,
and emitted HTML are identical.

## Before

```dql
workbook "Q4 Finance" {
    page "Overview" {
        chart.bar(
            SELECT month, revenue FROM monthly_revenue,
            x = month,
            y = revenue,
            title = "Monthly revenue"
        )
    }

    page "Customers" {
        chart.pie(
            SELECT segment, count FROM customer_segments,
            category = segment,
            value = count,
            title = "Segments"
        )
    }
}
```

## After

```dql
dashboard "Q4 Finance" {
    tabs: [
        tab("Overview", {
            chart.bar(
                SELECT month, revenue FROM monthly_revenue,
                x = month,
                y = revenue,
                title = "Monthly revenue"
            )
        }),
        tab("Customers", {
            chart.pie(
                SELECT segment, count FROM customer_segments,
                category = segment,
                value = count,
                title = "Segments"
            )
        })
    ]
}
```

## Equivalence guarantees

- Emitted HTML bytes match the v1.1 `workbook` output for the same tab
  contents — the codegen path is shared. Verified as part of the v1.2
  release test.
- Schedule (`@schedule`), notification (`@email_to`, `@slack_to`), and alert
  decorators move unchanged to the `dashboard` wrapper.
- `ref()` / `@include` / semantic references resolve identically — the
  deprecation is purely surface syntax.

## Detecting workbook files

```bash
zlens fmt --check '**/*.dql'
```

Files that still use `workbook { }` report:

```
  ⚠ workbook { } is deprecated and will be removed in v1.3. See docs/migrations/workbook-to-dashboard.md.
```

Exit code is non-zero, so this can gate CI.

## Timeline

- **v1.2** — deprecation warning on build + fmt; `workbook` still compiles.
- **v1.3** — `workbook` keyword removed from the grammar.
