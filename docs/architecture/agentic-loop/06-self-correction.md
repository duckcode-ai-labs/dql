# 6 · Self-Correction — how it corrects errors

> `packages/dql-agent/src/answer-loop.ts` (query-plan + repair) · `agent-run-engine.ts` (replan /
> escalate) · `agent-run-gates.ts`

ZLens corrects itself at three layers: **prevention** (a query-plan before SQL), **execution-guided
repair** (fix the SQL from the real error), and **escalation** (switch to a deeper route). Crucially,
the *recovery reasoning stays in the trace* — it never leaks into the answer the user reads.

## Prevention — query-plan before SQL (CoT)

The SQL-generation prompt requires the model to state its plan **before** writing SQL: the **grain**
(one row per what), the **measures** + aggregation, the **dimensions/filters**, and the exact **join
path + keys**. Reasoning about grain and joins up front is the single cheapest accuracy lever in the
text-to-SQL literature — it prevents wrong-grain answers and fan-out joins at the source.

```mermaid
flowchart LR
    Q["Question + grounded schema"] --> PLAN["1 · Query plan<br/>grain · measures · dims · join path + keys"]
    PLAN --> SQL["2 · SQL that matches the plan"]
    SQL --> EXEC["3 · Bounded preview execution"]
```

## Execution-guided repair loop

```mermaid
sequenceDiagram
    participant EX as Executor
    participant WH as Warehouse preview
    participant GT as Gate
    participant LP as Loop / replan

    EX->>WH: run generated SQL
    WH-->>EX: error — column customer_name not found
    Note over EX: 1. local lexical repair — cheap, deterministic
    EX->>WH: retry repaired SQL
    WH-->>EX: still failing
    Note over EX: 2. LLM SQL repair — corrected SQL + prose
    EX->>EX: adopt corrected SQL · keep prose in TRACE only
    EX->>WH: retry corrected SQL
    WH-->>EX: rows returned
    EX->>GT: result to gate
    GT-->>LP: passed, or semantic flag then one more retry
    Note over LP: budgeted repairs, then accept as needs_review
```

**The critical invariant — recovery reasoning never becomes the answer.** When the LLM repairs the
SQL it also emits error-recovery prose ("the column X was not recognized… I updated the query to use
Y"). That prose is captured as a **`repairNarrative`** and surfaced in the **trace / analysis plan**,
**not** as `parsed.text`. The answer the user sees stays a clean, data-first summary of the corrected
result.

```mermaid
flowchart LR
    RP["LLM repair response"] --> SQLc["corrected SQL → adopt ✅"]
    RP --> NAR["recovery prose"]
    NAR -->|"trace / assumptions"| TRACE["🔍 'Auto-corrected the query…'"]
    NAR -.->|"❌ never"| ANS["the answer text"]
    SQLc --> RESULT["execute → clean data summary → answer"]
```

> This fixed the exact repro where "who are the top customers?" showed the error narrative instead of
> the ranked customers. Now: clean summary + the real table.

## Escalation — switch route when repair can't help

If a step's failure isn't SQL-repairable (e.g. no answer could be grounded at all), the gate emits a
**blocking** eval with an `escalate` action. The loop switches to a deeper route.

```mermaid
flowchart LR
    G1["generated_answer<br/>(no grounded answer)"] -->|escalate| R["research"]
    C1["certified_answer<br/>(no certified block)"] -->|escalate| R
    A1["app_build<br/>(no certified tiles)"] -->|escalate| B["dql_block_draft"]
```

## The full correction ladder

```mermaid
flowchart TD
    START["Executor produces result"] --> E{"gate: passed?"}
    E -->|yes| DONE["accept → trust state"]
    E -->|"no · SQL error"| R1["local lexical repair"]
    R1 --> R2["LLM SQL repair (prose → trace)"]
    R2 --> E
    E -->|"no · semantic (fan-out)"| R3["retry: 'aggregate to one value'"]
    R3 --> E
    E -->|"no · can't ground"| ESC["escalate to deeper route"]
    E -->|"budget exhausted"| ACC["accept as needs_review<br/>(surface honestly, don't loop)"]
    ESC --> START
```

## What makes this *governed* self-correction

| Property | Why it matters |
|---|---|
| Recovery prose → trace, not answer | The user reads results, not the agent's debugging |
| Execution-guided (real error → fix) | Corrections are grounded in what the warehouse actually said |
| Bounded repairs | No infinite loops or runaway cost |
| Semantic gate drives a repair | Catches *wrong-but-runnable* SQL, not just crashes |
| Escalation is mapped, not random | Predictable "answer → research" deepening |

→ Next: [Memory & learning](./07-memory-and-learning.md)
