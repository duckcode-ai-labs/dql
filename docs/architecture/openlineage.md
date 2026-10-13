# OpenLineage export

ZLens emits [OpenLineage](https://openlineage.io) events from block and
notebook runs so your existing metadata platform sees DQL-level lineage
alongside dbt-level lineage.

## Enable

```json
{
  "openlineage": {
    "enabled": true,
    "url": "http://marquez.internal:5000",
    "namespace": "analytics"
  }
}
```

Or via environment:

```bash
export OPENLINEAGE_URL=http://marquez.internal:5000
export OPENLINEAGE_NAMESPACE=analytics
```

## Event shape

Every block execution emits a `START` and `COMPLETE` event:

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2026-04-15T12:34:56Z",
  "job": {
    "namespace": "analytics",
    "name": "block.revenue_by_segment"
  },
  "run": { "runId": "…" },
  "inputs":  [{ "namespace": "analytics", "name": "orders" }],
  "outputs": [{ "namespace": "analytics", "name": "block.revenue_by_segment" }]
}
```

## Compatible receivers

Verified against:

- [Marquez](https://marquezproject.ai/) (reference OL consumer)
- [DataHub](https://datahubproject.io/) via the OL connector
- [Atlan](https://atlan.com/) via the OL integration
- [Monte Carlo](https://www.montecarlodata.com/) via OL webhook

## What's emitted

- Block runs
- Notebook cell runs (one event per cell)
- Dashboard compilations
- dbt-backed ZLens compile/sync metadata, when dbt artifacts are configured

## Schema version

ZLens currently emits [OpenLineage spec
0.19](https://openlineage.io/spec). Facet support is full for `schema`,
`columnLineage` (commercial build), and `sql`.
