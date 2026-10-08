# Capture plan: four value-moment recordings on Jaffle Shop

Status: **plan only. Nothing has been recorded yet.** The recordings need a
machine with a GUI, a built `dql notebook`, and a provider key. The agent that
wrote this had none of these. Until a recording exists, every sequence below is
"not reproduced" and must be dropped or labelled "illustration" in the launch.

Owners: @theo and @zara record. Questions, setup and pass rules are fixed here
so the recording does not depend on memory.

## Setup

1. Check out `main`. Record the commit with `git rev-parse HEAD`.
2. Build the CLI and run it from the build, not from Vite alone
   (`AGENTS.md`: Vite-only proof does not count).
3. Use the public project `duckcode-ai/jaffle-shop-duckdb` (linked from
   `docs/01-quickstart.md`). Run `dbt build`, then `dql notebook` in that
   project. The test fixture `apps/cli/test/fixtures/jaffle-golden` is a
   copy of the same marts plus certified blocks; it is not the public example.
4. Configure one AI provider. Note which provider and model.
5. Confirm that the certified block `top_beverage_customers` (owner
   `analytics@jaffle.shop` in the fixture) exists in the public project. If the
   public project has no certified blocks, sequence 1 cannot be recorded
   as "real" until it does. Say so; do not copy the fixture blocks in silently.

## The four sequences

The question text below is copied from
`apps/cli/test/ask-golden/questions.json`. The expected lane is what that file
and its notes say should happen. **It is not verified.** The recording decides.
An older run report in `apps/cli/test/ask-golden/baseline-report-authoritative_v2.json`
(commit `f964bb5c`, 17 of 34 passing) shows `top-beverage-customers` blocked,
so do not assume sequence 1 works on `main` today.

| # | Moment | Exact question | Expected lane | Must be visible on screen |
|---|--------|----------------|---------------|---------------------------|
| 1 | Certified block | `who are the top customers for beverage product category` | Certified block `top_beverage_customers` | Certified label, block owner, then the **How it answered** tab opened |
| 2 | Governed semantic metrics | `what is the average order value` | Semantic metric, no generated SQL | Governed label; the metric used shown in **How it answered** |
| 3 | Generated SQL | `supply cost by product` | AI-written SQL | Badge **AI-generated**; the SQL tab |
| 4 | Clarifying question | `who are the top customers` | Bounded clarification (gross or pretax spend) | The clarifying question, then the answer after you pick an option |

Questions 2 and 3 are candidates picked from the golden list, not from a run.
If a candidate lands in the wrong lane, try another question from the same file
and write down both attempts. Do not edit a question to force a lane.

## Recording rules

- One take per sequence, fresh Ask thread, no edits to the project between takes.
- Record the whole screen at 1080p or higher. Keep the real latency; trim only
  in the designer's cut, never in the saved raw file.
- Type the question exactly as in the table. Do not paste a different one.
- Save per sequence: the raw video, a final screenshot, and a text file with the
  question, the label shown, the elapsed time, the provider and model, the DQL
  commit, and the project commit.
- If a run shows blocked, wrong-looking numbers or a different label than
  expected, keep the recording and mark the sequence "not reproduced".

## Handoff to the designer

For each sequence write one line: `reproduced`, `reproduced with a different
question (say which)`, or `not reproduced (say why)`. The designer animates
only the first two. The third becomes "illustration" or is cut.

## Not checked

- No sequence was run. Lanes, labels and tab names come from reading the
  repository only (`apps/dql-notebook/src/components/agent/UnifiedAgentRunPanel.tsx`
  defines the **How it answered** tab).
- Whether the public project holds certified blocks and metrics matching the
  fixture is unknown.
- Benchmark numbers from `commercial/` are not used here and must not be added.
