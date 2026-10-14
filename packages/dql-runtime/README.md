# `@zlens/runtime`

Browser runtime for compiled DQL output.

It includes query fetching, chart rendering helpers, table/KPI renderers, filter and interaction management, and hot-reload helpers used by preview flows.

## Install

```bash
pnpm add @zlens/runtime
```

## Example

```ts
import { DataFetcher } from '@zlens/runtime';

const fetcher = new DataFetcher('/api/query');

const result = await fetcher.fetch(
  'revenue_by_segment',
  'select 1 as revenue',
  [],
  {},
);

console.log(result.rows);
```

## Common Uses

- power browser previews for compiled DQL bundles
- connect compiled charts to a local or hosted query API
- add interactions and filters to runtime rendering flows

## Learn More

- Root docs: [`../../README.md`](../../README.md)
- Getting started: [`../../docs/getting-started.md`](../../docs/getting-started.md)
