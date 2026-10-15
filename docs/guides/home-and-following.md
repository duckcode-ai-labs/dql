# Home, following a page, and who an App is for

What a reader sees first when they open ZLens, how to keep an eye on a page, and
how an author says who an App is for.

## Home

Open **Ask** on a new chat. Above the question box:

- **My Apps** — the Apps you may open. Pages you follow come first (★), then
  the ones you opened most recently.
- **What moved** — for each page you follow or opened, the figures that
  changed between your last two complete runs of it, for example
  `Claims filed 41 → 47 (+6)`. Only certified or governed single figures (a
  KPI, a driver's current value, a leader's value) are compared; never a tile
  that needs review, never rows. They are *your* figures: your filters, your
  persona and — when ZLens runs inside a host that signs people in — your row
  rules. Nobody else's runs are read, and nothing is shared between people.
- Anything your host adds, for example **Open requests**.

A project without Apps shows nothing here, as before. What Home keeps lives in
`.dql/local/private/home/` (never in git).

## Follow a page

Open an App page and click **Follow**. The page then leads What moved on your
Home. Inside a host, following is kept by the host, which tells you about
each new edition — a scheduled run whose figures changed — the way your
notification settings say (in the app, by email or Slack). The notice carries
a link, never a figure: you open the page and see it as yourself.

## Ask about this App

Every App page has an **Ask about <App>** box above its charts, beside the
questions you can ask about one chart. It asks Ask, scoped to the App: its
domain and the filters on screen are read from the App's own files and
stated in the question, so the answer is never wider than the view you asked
from, and it carries the usual trust label (certified, governed or needs
review).

A question about what the page shows ("which player is ranked first in this
App?", "what does this table show?") is answered from the page's current
results. The question names the page run on your screen; ZLens reads that
run's tiles, each tile's source block and trust label, the filters it applied
and the rows it shows from its own record of the run (never from the browser),
and cites the tiles it read. The answer's trust label is the weakest of those
tiles: an answer read from a tile that needs review is labelled needs review.
The page values reach the AI model only inside the privacy boundary; otherwise
ZLens reads the rows to you without a model. A page keeps its results for Ask
for 15 minutes, and only for the person who ran it: after that, or before the
page has run, the box says Ask cannot see the results yet, and you refresh the
page.

## Who an App is for

In an App, **Edit → ⋯ → App settings → Audience**: describe the audience in words and
name the identity-provider groups it is for. They are saved in
`dql.app.json`:

```json
{ "audience": "Claims leadership", "audienceGroups": ["claims-leaders"] }
```

Without a host, you type the group names; ZLens has one local owner, so this is
a note that carries over when the project is hosted. Inside a host that signs
people in, you pick from the host's groups, and the App opens only for those
groups, its owners, people the host gave it, and people allowed to change it.
A host that keeps Production to reviewed changes asks you to make the change
in a draft space instead.

## Verify it worked

1. Open an App page twice after its data changed (or change a filter back
   and forth); open Ask on a new chat: the page is under **What moved**.
2. Click **Follow** on the page; the App shows ★ under **My Apps**.
3. Set an audience, then check `apps/<id>/dql.app.json` has `audienceGroups`.

Details for hosts: [RFC 0010, HH-16](../rfcs/0010-host-hooks.md).
