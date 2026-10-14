# The ZLens Agentic Analyst Loop

> How ZLens turns a natural-language question into a **governed, grounded, trustworthy** answer —
> and how it searches, uses tools, evaluates, self-corrects, and learns over time.

This folder is the reference for the whole agentic architecture. Start here for the high-level
picture, then follow the links into each concern.

| # | Doc | Answers |
|---|-----|---------|
| 1 | [Control loop](./01-control-loop.md) | **How it loops** — plan → execute → evaluate → repair/escalate |
| 2 | [Intent & routing](./02-intent-and-routing.md) | **How it decides** what kind of answer to build |
| 3 | [Search & grounding](./03-search-and-grounding.md) | **How it searches** — knowledge graph, schema linking, cross-domain traversal |
| 4 | [Tools & executors](./04-tools-and-executors.md) | **What tools it uses** to act |
| 5 | [Evaluation & trust](./05-evaluation-and-trust.md) | **How it checks** its own work + the trust ladder |
| 6 | [Self-correction](./06-self-correction.md) | **How it corrects** — query-plan, repair, escalation |
| 7 | [Memory & learning](./07-memory-and-learning.md) | **How it memorizes** and improves over time |

---

## The thesis in one line

**ZLens is a *tiered governed analyst loop*: a Reflexion-style outer supervisor (plan → gate →
repair/escalate) whose executors are grounded in a governed semantic layer, with a
learn-from-experience memory — never a raw text-to-SQL guess, never an auto-certified answer.**

The moat is not "an LLM that writes SQL." It is the **governance scaffolding around it**: certified
blocks, a knowledge graph over dbt + DQL, execution-guided gates, an honest trust ladder, and a
scope-gated learning loop.

---

## Master flow (high level)

```mermaid
flowchart TD
    Q["👤 User question"] --> INT["🧭 Intent Controller<br/>(deterministic, no LLM)"]
    INT --> PLAN["🗺️ Planner<br/>(deterministic default · LLM multi-step optional)"]
    PLAN --> LOOP{{"🔁 Per-step control loop<br/>max 4 steps · budgeted repairs"}}

    LOOP --> ROUTE["Route this step"]
    ROUTE -->|"exact KPI / block"| CERT["✅ certified_answer<br/>(fast, one-shot)"]
    ROUTE -->|"ad-hoc / ranking"| GEN["📝 generated_answer"]
    ROUTE -->|"why / trend / deep"| RES["🔍 research"]
    ROUTE -->|"build a surface"| APP["📊 app_build"]
    ROUTE -->|"author"| AUTH["</> sql_cell · 🧱 block_draft"]
    ROUTE -->|"ambiguous"| CLR["❓ clarify"]

    CERT & GEN & RES & APP & AUTH --> GROUND["🔗 Ground + search<br/>(KG · schema linking · metric match)"]
    GROUND --> COT["🧠 Query-plan (CoT):<br/>grain · measures · dims · join path"]
    COT --> EXEC["⚙️ Execute against warehouse<br/>(bounded preview)"]
    EXEC --> GATE["🚦 Evaluate (gates):<br/>liveness + semantic correctness"]

    GATE -->|"pass"| TRUST["🏅 Compose trust:<br/>certified · grounded · review · blocked"]
    GATE -->|"fail · repairable"| REPAIR["🛠️ Repair<br/>(retry with hint)"]
    GATE -->|"fail · blocking"| ESC["⤴️ Escalate<br/>(switch route)"]
    REPAIR --> EXEC
    ESC --> LOOP

    TRUST --> OUT["📤 Answer + result table + trust + next actions"]
    CLR --> OUT

    OUT -->|"human certifies / corrects"| CAP["📥 Capture governed delta"]
    CAP --> MEM[("🧩 Memory · Hints · Skills")]
    MEM -.->|"retrieved on the next similar question"| GROUND

    classDef fast fill:#dcfce7,stroke:#16a34a;
    classDef learn fill:#ede9fe,stroke:#7c3aed;
    class CERT fast;
    class CAP,MEM learn;
```

**Reading it:** a question is *classified* (no LLM), *planned* into 1–N steps, and each step *routes*
to an executor. Certified matches short-circuit to a fast one-shot answer; everything else is
**grounded** (search the graph, link the schema), **planned** (state grain + joins before SQL),
**executed**, and **gated**. A gate failure drives a bounded **repair** (same route, corrected) or an
**escalation** (a different route). The result carries an **honest trust label**. When a human
certifies or corrects it, the **governed delta** is captured and retrieved on the next similar
question — the loop learns.

---

## The five capabilities the user asked about

```mermaid
mindmap
  root((ZLens Agentic Loop))
    How it loops
      Plan then execute then gate then repair or escalate
      Bounded 4 steps and budgeted repairs
      Reflexion-style outer supervisor
    How it searches
      FTS knowledge graph over dbt and DQL
      Two-tier schema linking
      Metric matching with measure families
      Cross-domain graph traversal
    What tools
      Route executors certified generated research app sql block
      Read-only tools search inspect preview traverse
      Warehouse preview execution
    How it memorizes
      Scope-gated experience memory SQLite FTS
      Git-authoritative approved hints
      Editable skills and domain consolidation
      Few-shot from certified blocks
    How it corrects
      Query-plan before SQL CoT
      Execution-guided repair loop
      Semantic-correctness gate
      Escalation to a deeper route
```

---

## The trust ladder (the governing invariant)

Every answer lands on exactly one rung. **AI never auto-promotes to `certified`** — that is always
a human act.

```mermaid
flowchart LR
    B["🚫 blocked<br/>can't ground it"] --> R["📝 review_required<br/>generated, unverified"]
    R --> G["🛡️ grounded / 'verified'<br/>executed cleanly on real data"]
    G ==>|"human certifies"| C["✅ certified<br/>governed metric"]
    NA["➖ not_applicable<br/>clarify / no data question"]

    classDef human fill:#fef9c3,stroke:#ca8a04;
    linkStyle 2 stroke:#ca8a04,stroke-width:2px;
```

See [Evaluation & trust](./05-evaluation-and-trust.md) for how each rung is decided.

---

## Key source files (the map)

| Concern | File |
|---|---|
| Outer control loop, budgets, escalation | `packages/dql-agent/src/agent-run-engine.ts` |
| Intent classification | `packages/dql-agent/src/intent-controller.ts` |
| Planner (deterministic + LLM) | `packages/dql-agent/src/agent-run-planner.ts` |
| Answer executor (certified → metric → generated SQL, query-plan, repair) | `packages/dql-agent/src/answer-loop.ts` |
| Research executor (investigate / answer / clarify) | `packages/dql-agent/src/research-loop.ts` |
| Evaluation gates (liveness + semantic correctness) | `packages/dql-agent/src/agent-run-gates.ts` |
| Knowledge graph + search + cross-domain traversal | `packages/dql-agent/src/kg/sqlite-fts.ts` |
| Schema linking / grounding | `packages/dql-agent/src/metadata/sql-grounding.ts`, `sql-retrieval.ts` |
| Metric matching | `packages/dql-agent/src/metadata/metric-match.ts` |
| Experience memory | `packages/dql-agent/src/memory/sqlite-memory.ts` |
| Hints (correction → candidate → approve → reuse) | `packages/dql-agent/src/hints/*` |
| Skills | `packages/dql-agent/src/skills/loader.ts` |
| Route executors + wiring | `apps/cli/src/local-runtime.ts` |
| UI (trace, trust chips, result table) | `apps/dql-notebook/src/components/agent/UnifiedAgentRunPanel.tsx` |
