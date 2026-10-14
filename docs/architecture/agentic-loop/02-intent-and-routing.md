# 2 · Intent & Routing — how it decides what to build

> `packages/dql-agent/src/intent-controller.ts` · `agent-run-engine.ts` (`selectRoute`) ·
> `research-loop.ts`

Before any LLM call, ZLens **classifies** the question deterministically and picks a **route**. This is
what keeps a fast lookup fast and sends a genuine investigation deep — without making the user choose.

## Two-stage decision

```mermaid
flowchart TD
    Q["Question + signals<br/>(certifiedScore, metricScore, hasRetrieval, isFollowUp, missingContext)"] --> IC

    subgraph IC["① Intent Controller — decideAgentAction() (deterministic)"]
        direction TB
        C1{"'why / root cause /<br/>trend over time' ?"} -->|yes| INV["action = investigate"]
        C1 -->|no| C2{"'build me a<br/>dashboard / app' ?"}
        C2 -->|yes| APP["action = compose_app"]
        C2 -->|no| C3{"missing context /<br/>ambiguous ?"}
        C3 -->|yes| CLA["action = clarify"]
        C3 -->|no| ANS["action = answer"]
    end

    IC --> RT

    subgraph RT["② selectRoute() — map action + signals → route"]
        direction TB
        R0{"requestedMode<br/>forced?"} -->|"ask/research/app/sql/block"| FORCED["that route (confidence 1)"]
        R0 -->|auto| R1{"looksLikeSql / block /<br/>composeApp ?"}
        R1 -->|sql| SQLR["sql_cell"]
        R1 -->|block| BLKR["dql_block_draft"]
        R1 -->|app| APPR["app_build"]
        R1 -->|no| R2{"certifiedScore ≥ 0.5 ?"}
        R2 -->|yes| CERTR["certified_answer"]
        R2 -->|no| R3{"action = investigate ?"}
        R3 -->|yes| RESR["research"]
        R3 -->|no| GENR["generated_answer"]
    end

    classDef fast fill:#dcfce7,stroke:#16a34a;
    class CERTR fast;
```

## The routes

| Route | What it does | Trust ceiling |
|---|---|---|
| `certified_answer` | Execute a matched certified block / governed metric. **One-shot, fast.** | `certified` |
| `generated_answer` | Ground + write review-required SQL, preview it. | `grounded` → certify |
| `research` | Multi-step grounded investigation (a dossier). | `grounded` → certify |
| `sql_cell` | Author SQL for a notebook cell (analyst). | `review_required` |
| `dql_block_draft` | AI drafts a new certified block (review-required). | `review_required` |
| `app_build` | Compose a dashboard from certified blocks. | per-tile |
| `clarify` | Ask **one** sharp question and stop. | `not_applicable` |

## Depth is route-gated (the cost guard)

The certified path is a single block execution — **fast**. Only `generated_answer` / `research` do
the deeper grounding + preview + gating work. This is why the loop can be both snappy on lookups and
thorough on investigations.

```mermaid
flowchart LR
    Q1["'what is total revenue?'"] -->|"certified match ≥ 0.5"| F["✅ certified_answer<br/>one block, one shot"]
    Q2["'why is revenue down by region?'"] -->|"why-signal → investigate"| D["🔍 research<br/>multi-step, deeper budget"]

    classDef fast fill:#dcfce7,stroke:#16a34a;
    classDef deep fill:#dbeafe,stroke:#2563eb;
    class F fast; class D deep;
```

## "Research deeper" — honoring a forced depth

When the user explicitly forces research (the *Dig deeper* toggle → `requestedMode: 'research'`), the
research executor sets **`forceInvestigate`**. Inside `planResearch`, that overrides the inner
decision so it can't silently collapse to a single-step "the governed metric answers this directly."

```mermaid
sequenceDiagram
    participant U as User (Dig deeper ON)
    participant E as research executor
    participant P as planResearch()
    participant D as decideAgentAction()
    U->>E: question, requestedMode=research
    E->>P: planResearch({ ..., forceInvestigate: true })
    P->>D: decide (signals from real match, no inflated 0.85)
    D-->>P: action = answer  (ranking question)
    Note over P: forceInvestigate ⇒ override answer → investigate
    P-->>E: multi-step investigate plan
```

> This fixed a real defect: a hard-coded `certifiedScore: 0.85` used to flip forced research back to a
> one-step answer. It now derives from the real metric-match score.

## Design notes

- **The intent controller is deterministic** — no LLM, offline-safe, and the same every run. That
  makes routing testable and predictable.
- **`requestedMode` is a hint, not a hard mode** on the stakeholder surface — the UI defaults to
  `auto` and only the *Dig deeper* one-shot toggle nudges depth. (Analyst notebook surfaces still
  expose explicit `sql` / `block` routes.)
- **Certified-first**: a confident certified match always wins over generating fresh SQL.

→ Next: [Search & grounding](./03-search-and-grounding.md)
