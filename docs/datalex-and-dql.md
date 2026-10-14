# dbt-first ZLens

ZLens is the open-source workspace for governed analytics: it connects dbt
transformation and MetricFlow to analytical blocks, notebooks, business views,
stakeholder apps, lineage, Ask AI, evaluations, and approved learning hints.

In dbt-first mode, **dbt owns physical modeling**. ZLens does not replace dbt and does
not maintain a second `schema.yml`.

## One source of truth, one sparse overlay

| Concern                                                         | Owner            | ZLens behavior                                                     |
| --------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| Model SQL, columns, descriptions, dbt tests                     | dbt              | Read from dbt artifacts; edit through a previewed dbt YAML patch |
| Transformation lineage                                          | dbt              | Import as provenance and transformation lineage                  |
| MetricFlow models, measures, dimensions and formulas            | dbt / MetricFlow | Compose from the dbt semantic artifact                           |
| Domain/subdomain/microdomain organization                       | ZLens              | Git-versioned Domain Packages                                    |
| Entity binding, relationship cardinality, fanout, export policy | ZLens              | Sparse analytical overlay only where dbt is insufficient         |
| Business contracts, conformance, reusable blocks and apps       | ZLens              | Version, review and certify in the ZLens project                   |
| Agent hints and evaluations                                     | ZLens              | Draft → evaluate → review → approved retrieval                   |

The compiler records dbt **provenance**—unique IDs, artifact paths,
fingerprints and availability—not a serialized copy of physical columns,
descriptions, tests, or MetricFlow formulas. This prevents a second schema from
drifting out of sync with dbt.

## Domain Packages

Each analytical domain is an ordinary Git folder:

```text
domains/
  commerce/
    domain.dql
    modeling/
      model.dql.yaml
      layouts/
    terms/
    blocks/
    notebooks/
    views/
    skills/
    evaluations/
    tests/
    apps/
  growth/
    domain.dql
    modeling/
      model.dql.yaml
    blocks/
    views/
    apps/
```

The model file is unified by default: entities, relationships, contracts, and
cross-domain interfaces are sections of the same Git-versioned Domain Model.
Split files remain an optional organization choice for large domains.

Domains organize ownership and retrieval; they do **not** imply a safe join or
automatic cross-domain access. A generated analytical join needs a DQL
relationship with explicit keys, cardinality, fanout policy, lifecycle state,
and—across a domain boundary—a certified provider export plus a purpose-bound
consumer import.

## Safe agent behavior

Ask AI follows this order:

1. compatible certified DQL block;
2. compatible dbt/MetricFlow semantic query;
3. review-required generated SQL backed by certified, fanout-safe DQL
   relationships;
4. a clarification or refusal when policy is missing, stale, unsafe, or
   attribution-dependent.

dbt's DAG can explain how a model was transformed. It never proves that two
models may be joined or that a revenue aggregate will not fan out. For example,
revenue by customer acquisition channel can use a certified customer-grain
relationship; revenue through raw campaign touches must ask for first-touch,
last-touch, fractional, or another explicit attribution policy.

## Enable dbt-first mode

```json
{
  "project": "commerce-analytics",
  "manifestVersion": 3,
  "modeling": { "mode": "dbt-first" },
  "dbt": {
    "projectDir": "../dbt",
    "manifestPath": "target/manifest.json"
  }
}
```

Then run:

```bash
dbt parse
zlens compile .
zlens notebook .
```

Manifest v3 is opt-in during the compatibility window. Existing manifest v2
projects keep their current behavior and do not need a separate migration.

## Migrating from DataLex

DataLex can be migrated into a dbt-first ZLens project without treating it as a
second runtime dependency:

```bash
# Review only; default and --dry-run never write source
zlens migrate datalex --input ../datalex/datalex-manifest.json --dry-run

# Write draft Domain Package overlays and suggested dbt YAML patch files
zlens migrate datalex --input ../datalex/datalex-manifest.json --apply
```

The migration matches legacy objects to dbt unique IDs, deliberately drops
mirrored dbt facts, converts only DataLex-specific analytical semantics into
draft overlays, writes divergent dbt-owned descriptions as suggested patches,
and reports every loss. It is idempotent and never auto-certifies a migrated
relationship, contract, block, or hint.

See [RFC 0002](rfcs/0002-dbt-first-domain-modeling.md) for the full contract
and [the implementation plan](rfcs/0002-implementation-plan.md) for acceptance
gates.
