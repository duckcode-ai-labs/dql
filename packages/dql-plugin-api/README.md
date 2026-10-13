# @zlens/plugin-api

Stable plugin contracts for ZLens. **Frozen at v1.0** — breaking changes
require a major version bump and a 6-month deprecation window.

## Exports

```ts
import type { Connector } from '@zlens/plugin-api/connector';
import type { ChartRenderer } from '@zlens/plugin-api/chart';
import type { RulePack } from '@zlens/plugin-api/governance';
```

Or all at once:

```ts
import type { Connector, ChartRenderer, RulePack } from '@zlens/plugin-api';
```

## Connector

See [`src/connector.ts`](./src/connector.ts). Implement `Connector`,
publish as a module, register in `cdql.yaml`:

```yaml
plugins:
  connectors:
    - my-company/dql-connector-exasol
```

## Chart renderer

See [`src/chart.ts`](./src/chart.ts). Registered the same way under
`plugins.charts`.

## Governance rule pack

See [`src/governance.ts`](./src/governance.ts). Registered under
`governance.rule_packs`.

## Stability guarantee

The interfaces in this package are versioned via `PLUGIN_API_VERSION`.
At v1.0:

- Adding optional fields to request/result shapes: **non-breaking**
- Adding new methods marked optional: **non-breaking**
- Removing or renaming fields: **breaking, major bump required**
- Changing method signatures (even "compatible" widening): **breaking**

Consumers can assert compatibility at runtime:

```ts
import { PLUGIN_API_VERSION } from '@zlens/plugin-api';
if (!PLUGIN_API_VERSION.startsWith('1.')) throw new Error('incompatible ZLens');
```
