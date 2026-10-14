# 3 · Search & Grounding — how it searches

> `packages/dql-agent/src/kg/*` · `metadata/sql-grounding.ts` · `metadata/sql-retrieval.ts` ·
> `metadata/metric-match.ts` · `embeddings/provider.ts`

An LLM writing SQL from a raw schema hallucinates. ZLens avoids that by **grounding** every generated
answer in a knowledge graph built from dbt + DQL, and by **schema-linking** only the relevant tables
into the prompt. Accuracy comes from *context*, not a bigger model.

## The knowledge graph

On `zlens compile`, ZLens builds a knowledge graph into `.dql/cache/agent-kg.sqlite` (SQLite + FTS5).

```mermaid
flowchart LR
    subgraph Sources
        M["DQL manifest<br/>(blocks, terms, views, metrics, domains)"]
        D["dbt manifest.json<br/>(models, sources, lineage)"]
        S["semantic_manifest.json<br/>(MetricFlow metrics/measures/dims)"]
        C["catalog.json<br/>(real columns + types)"]
    end
    M & D & S & C --> BUILD["buildKG*()"]
    BUILD --> NODES[("kg_nodes<br/>8 kinds: block · metric · dimension ·<br/>term · business_view · dbt_model · source · domain · entity")]
    BUILD --> EDGES[("kg_edges<br/>depends_on · composes · contains · defines ·<br/>reads_from · feeds_into · related_to")]
    NODES --> FTS[("kg_nodes_fts (FTS5 / BM25)")]
```

Each node carries `name`, `domain`, `description`, `llmContext`, `examples`, `grain`, `entities`,
`allowedFilters`, `businessRules`, `certification`, and a data-freshness state.

## Two-tier schema linking (retrieve only what's relevant)

```mermaid
flowchart TD
    Q["Question"] --> T1["Tier 1 · FTS5 lexical retrieval<br/>token overlap vs name/alias/columns/tags/desc"]
    T1 --> HR["hybridRank()<br/>score = (1-α)·lexical + α·cosine<br/>(α = 0 default: pure lexical, offline)"]
    HR --> REL["Relevant model names"]
    REL --> T2["Tier 2 · buildSchemaGrounding()<br/>top ~24 tables"]
    T2 --> GT["Grounded tables:<br/>qualified relation · real columns+types ·<br/>join keys (dbt depends_on + shared *_id)"]
    GT --> PROMPT["Prompt context:<br/>top ~12 relations, 50 cols each"]
```

- **Tier 1** ranks candidate models by lexical token overlap (FTS5 / BM25). An **embedding blend**
  exists (`hybridRank`, `HashedTokenEmbeddingProvider`) but defaults to `α = 0` (pure lexical) so the
  OSS path is deterministic + offline. Flip `α > 0` behind config for paraphrase robustness.
- **Tier 2** turns the winners into *grounded tables* — qualified warehouse relations, real columns
  (from `catalog.json`, falling back to manifest YAML), and inferred join keys — and only those go
  into the prompt. Generated SQL is then validated against this context so hallucinated
  relations/columns are caught before execution.

## Routing the answer source

```mermaid
flowchart TD
    Q["Question"] --> S1{"certified artifact hit<br/>≥ 0.18 + pickCertifiedArtifact() ?"}
    S1 -->|yes| CERT["Execute certified block<br/>(or cite dashboard/app)"]
    S1 -->|no| S2{"semantic-metric match<br/>≥ 0.34 (measure families) ?"}
    S2 -->|yes| SEM["Governed metric SQL<br/>(semantic_layer tier)"]
    S2 -->|no| GEN["Generate review-required SQL<br/>(grounded + validated)"]

    classDef fast fill:#dcfce7,stroke:#16a34a;
    class CERT fast;
```

**Metric matching** (`metric-match.ts`) uses *measure families* so "revenue" bridges to
"sales / arr / mrr", plus a name boost, blended through `hybridRank`. A confidence threshold (0.34)
prevents false-positive metric matches.

## Cross-domain reasoning (traversing the graph)

The lineage edges existed but had **no traversal API** — so a question spanning domains ("revenue by
support-ticket-volume") relied on the LLM guessing a join. Two methods now walk `kg_edges`:

```mermaid
flowchart LR
    subgraph KG["kg_edges"]
        RT["block: revenue_total<br/>(growth)"] -->|reads_from| CU["entity: customer<br/>(shared)"]
        CH["block: churn_logo<br/>(retention)"] -->|reads_from| CU
    end
    Q["'revenue vs churn by customer'"] --> FJP["findJoinPath(revenue_total, churn_logo)"]
    FJP --> PATH["['revenue_total', 'customer', 'churn_logo']<br/>(bounded BFS, cycle-guarded)"]
    NB["neighbors(customer)"] --> BR["out + in edges, interleaved<br/>(inbound bridges never starved)"]
```

- **`neighbors(nodeId, {edgeKinds, direction})`** — adjacent nodes over `kg_edges`, interleaving
  outbound + inbound so a hub entity's inbound cross-domain bridge isn't truncated by a large fan-out.
- **`findJoinPath(from, to, maxDepth)`** — bounded, cycle-guarded BFS returning the node path — the
  join route between two domains.

These are the substrate for the `traverse_domain_graph` tool (see [Tools](./04-tools-and-executors.md)).

## Accuracy levers (grounded in research)

| Lever | Status in ZLens |
|---|---|
| Schema linking (retrieve relevant tables) | ✅ two-tier FTS + grounding |
| Certified-first routing | ✅ |
| Few-shot from certified blocks (DAIL-SQL) | ✅ (see [Memory](./07-memory-and-learning.md)) |
| Query-plan before SQL (CoT) | ✅ (see [Self-correction](./06-self-correction.md)) |
| Execution-guided self-correction | ✅ repair loop |
| Semantic-correctness gate | ✅ cardinality (grain/join = roadmap) |
| Cross-domain graph traversal | ✅ substrate (`neighbors`/`findJoinPath`) |
| Embedding retrieval | ⚙️ opt-in (`α > 0`) |

→ Next: [Tools & executors](./04-tools-and-executors.md)
