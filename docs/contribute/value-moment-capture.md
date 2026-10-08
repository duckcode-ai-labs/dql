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
The only run evidence in the repository is the older report
`apps/cli/test/ask-golden/baseline-report-authoritative_v2.json` (commit
`f964bb5c`, 17 of 34 passing). **At that commit all four candidate questions
landed off the expected lane** (last column). It is old and on a different
fixture, so it does not predict `main` today; it only says not to trust the
"expected" column.

| # | Moment | Exact question | Expected lane | Observed at `f964bb5c` (route / status / trust) | Must be visible on screen |
|---|--------|----------------|---------------|-----------------------------------------------|---------------------------|
| 1 | Certified block | `who are the top customers for beverage product category` | Certified block `top_beverage_customers` | `generated_answer` / `blocked` / `blocked` | Certified label, block owner, then the **How it answered** tab opened |
| 2 | Governed semantic metrics | `what is the average order value` | Semantic metric, no generated SQL | `generated_answer` / `needs_review` / `review_required` | Governed label; the metric used shown in **How it answered** |
| 3 | Generated SQL | `supply cost by product` | AI-written SQL | `generated_answer` / `blocked` / `blocked` | Badge **AI-generated**; the SQL tab |
| 4 | Clarifying question | `who are the top customers` | Bounded clarification (gross or pretax spend) | `certified_answer` / `completed` / `certified` (answered by `customer_profile`, no clarification) | The clarifying question, then the answer after you pick an option |

Questions 2 and 3 are candidates picked from the golden list, not from a run.
If a candidate lands in the wrong lane, try another question from the same file
and write down both attempts. Do not edit a question to force a lane. This
applies to all four sequences. Other candidates, with their observed outcome
at `f964bb5c`:

- Sequence 1 (certified): `revenue by month` (`certified_answer`, certified),
  `beverage revenue by product` (`certified_answer`, certified). Both are
  certified, but neither is the beverage-customer block.
- Sequence 2 (governed): `total revenue` (`semantic_answer`, governed),
  `how many orders are there` (`semantic_answer`, governed).
- Sequence 3 (generated SQL): `which customers placed the most orders`
  (`generated_answer`, `needs_review`). No candidate in the report ended
  `completed` as generated SQL; this may need a new question.
- Sequence 4 (clarification): `outcome: clarify_or_rows` in `questions.json`
  also covers `revenue by shopper` (not in the report, never observed),
  `total revenue` (answered as governed, not clarified),
  `I need to get the bevereage catogery` (`needs_review`, no clarification),
  `top 5 customers by revenue` (`generated_answer`, `blocked`),
  `what is the total revenue for "Ryan Byrd"` (`generated_answer`, `blocked`),
  `what is the "Ryan byrd" revenue by total revenue and beverage revenue? give me both`
  (`generated_answer`, `needs_review`) and
  `what is the average order value of customers first acquired in 2024`
  (not in the report, never observed).
  **No question is known to produce a clarification.** If none does, mark
  sequence 4 "not reproduced".

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

## Result log (fill in after each take)

Status on 2026-10-08: an agent run with no GUI, no built `dql notebook` and no
provider key could not record anything. All four are therefore
`not reproduced (not attempted: no recording environment)`. Replace each line
when @theo or @zara records it.

| # | Status | Question actually typed | Label shown | Elapsed | Provider / model | DQL commit | Project commit | Files |
|---|--------|-------------------------|-------------|---------|------------------|------------|----------------|-------|
| 1 | not reproduced (not attempted) | | | | | | | |
| 2 | not reproduced (not attempted) | | | | | | | |
| 3 | not reproduced (not attempted) | | | | | | | |
| 4 | not reproduced (not attempted) | | | | | | | |

## Not checked

- No sequence was run. Lanes, labels and tab names come from reading the
  repository only (`apps/dql-notebook/src/components/agent/UnifiedAgentRunPanel.tsx`
  defines the **How it answered** tab).
- Whether the public project holds certified blocks and metrics matching the
  fixture is unknown.
- Benchmark numbers from `commercial/` are not used here and must not be added.
