# `@zlens/dql-compiler`

Compiler for DQL source files.

It parses DQL, runs semantic analysis, lowers dashboards/workbooks into intermediate structures, and emits HTML, runtime JavaScript, metadata, and chart specs.

## Install

```bash
pnpm add @zlens/dql-compiler
```

## Example

```ts
import { compile } from '@zlens/dql-compiler';

const source = `
block revenue_by_segment {
  type = "custom"
  title = "Revenue by Segment"

  query = <<SQL
    select segment, sum(revenue) as revenue
    from revenue
    group by 1
  SQL

  visualization {
    chart = "bar"
    x = "segment"
    y = "revenue"
  }
}
`;

const result = compile(source, { file: 'blocks/revenue_by_segment.dql', theme: 'light' });

console.log(result.errors);
console.log(result.dashboards[0]?.metadata.title);
console.log(result.dashboards[0]?.html.slice(0, 80));
```

## Common Uses

- compile DQL into browser-ready HTML
- generate chart specs for preview or embedding
- build custom publishing or export pipelines

## Learn More

- Getting started: [`../../docs/getting-started.md`](../../docs/getting-started.md)
- Root docs: [`../../README.md`](../../README.md)
