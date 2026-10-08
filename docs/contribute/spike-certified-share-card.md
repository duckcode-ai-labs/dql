# Spike: local "certified share card"

Status: plan only. Nothing here is built, merged or released. Do not describe it
outside the company until it ships.

## Answer

Yes, it is feasible from the manifest as it is today. The data part is small and
needs no manifest change. The picture part needs one decision: how to write a PNG.
Rough size: about 400 changed lines across three small pull requests, so it does
not fit in one.

## What the card shows

- A 1200x630 image.
- Three counts of blocks: certified, review, draft. Drawn as a filled circle,
  a half-filled circle and an empty ring (the ● ◐ ○ shapes).
- No block names, no project name, no file paths.
- A company or title line only if the user types one (for example `--title "Acme"`).
- Nothing is sent anywhere. The command writes one file and prints its path.

## What the manifest gives us

Source: `packages/dql-core/src/manifest/types.ts`, `ManifestBlock` (line 381).

- `status` is an optional free string, not a fixed set. It can be missing.
- Other statuses exist in the code: `deprecated` and `pending_recertification`
  (`packages/dql-core/src/lineage/builder.ts:20`). The canonical status-to-label
  mapping is `trustLabelIdForStatus` in `packages/dql-core/src/trust/labels.ts`.
- `manifest.blocks` is keyed by name and keeps one block per name.
  `manifest.blockDeclarations` lists every declaration, including draft and
  review variants, but it is optional. Counting `blocks` alone would undercount
  drafts and review blocks that share a name with a certified one.
- `dql-manifest.json` also holds `projectRoot` (an absolute path) and `project`.
  The card code must never read either.
- The file is a compiled artifact and can be stale. `dql doctor` already checks
  freshness (`apps/cli/src/commands/doctor.ts`, `isManifestFresh`).

## Counting rules (proposed)

- Count `blockDeclarations` when present, else `Object.values(blocks)`.
- Do not add a new status mapping. `summarizeTrust` calls the existing
  `trustLabelIdForStatus` (`packages/dql-core/src/trust/labels.ts:228`), so the card
  agrees with the badge, MCP and agent surfaces for the same block:
  - `certified` (label `certified`; also `approved`) counts as certified.
  - `reviewed` (label `reviewed`; also `review`, `research`) counts as review.
  - `ai_generated` (label `ai_generated`; also `draft`, `draft_ready`, `generated`,
    `pending`, `analyst_review_required`) counts as draft.
  - `pending_recertification` is in the draft group in that function, so it counts
    as draft, not review.
- No `status`: count as draft. The function alone would send it to
  `insufficient_context`, so pass `block.status ?? 'draft'`, as
  `packages/dql-core/src/manifest/retirement.ts:158` already does.
- Every other label (`conflict`, `insufficient_context`, and statuses such as
  `deprecated`, `mixed`, `unknown`, `uncertified`, or any unrecognised string) is left
  out of the three counts. The card prints no footnote with names. It may print
  "N not counted" as a number only.
- Zero blocks: write no image. Print "no blocks found" and exit non-zero.
  A card of three zeros is not worth sharing.

The product owner left these rules to the engineer, so they are the plan.

## Picture options

There is no image library in the repo today (checked every `package.json`).

1. **SVG to PNG in the CLI.** Build the card as an SVG string, then convert it.
   The SVG step needs no dependency and is easy to test. The PNG step needs a
   renderer such as `@resvg/resvg-wasm`. That adds a dependency to
   `apps/cli/package.json` and the lockfile, which needs the owner's approval.
2. **Notebook button, browser canvas.** Draw on a `<canvas>` and call `toBlob`.
   No new dependency, and fonts come from the browser. The user saves the file.
3. **Hand-written PNG in Node.** `node:zlib` can encode a PNG, but text needs a
   font. Not worth it.

Recommendation: share one pure function for the counts and the layout, ship the
notebook button first (option 2, no dependency), then the CLI command writing SVG.
Add CLI PNG only if the owner approves the dependency.

Draw the three marks as shapes, not as text glyphs. ◐ is missing from many fonts
and would render as a box.

## Split

1. `summarizeTrust(manifest)` in `packages/dql-core`, built on
   `trustLabelIdForStatus`, with tests for each rule above: one status per group
   (including `approved`, `reviewed` and `pending_recertification`), missing status,
   `deprecated` and unknown strings (not counted), duplicate names and an empty
   manifest.
   About 80 lines.
2. Card layout (pure, returns drawing instructions or SVG) plus the notebook
   button. About 200 lines.
3. `dql share-card` command: reads `dql-manifest.json`, warns if stale, writes SVG
   only. About 120 lines, no new dependency. A later PR can add PNG once the
   dependency is approved.

## Not checked

- Whether the notebook app can already read the manifest in the browser, or needs
  a new server route.
- Which fonts ship with the notebook app.
- Whether `blockDeclarations` is present in manifests written by older versions
  (`manifestVersion` 1 and 2).
- Whether `@resvg/resvg-wasm` licence and size are acceptable.

## Decisions from the owner

- Blocks with no `status` count as draft. The owner left this to the engineer.
- Ship the notebook button and an SVG-only CLI first. No new dependency now.
  CLI PNG output waits for a separate approval of `@resvg/resvg-wasm`.
  Until then, a user who wants a PNG from the CLI opens the SVG in a browser or
  uses the notebook button.
