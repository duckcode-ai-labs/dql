# Answers that need review

When no certified block or semantic metric answers a question, Ask can write
SQL from your tables with AI. That answer may well be right, but nobody has
checked it yet, so ZLens labels it and keeps it as a draft for review.

{{ clip("ask-review") }}

## What you see

For a question such as `How many orders were placed at each store location?`
in the sample project:

1. The trust line reads **AI-generated answer**, with the checks it passed,
   for example **4 checks passed**.
2. The summary says where the answer came from, for example
   `Source: SQL written by AI from the schema (review before relying on it)`.
3. The result card says `AI-generated`.
4. Under the result, a line reads **Saved for review as a draft block (not
   certified):** and the draft's path, such as
   `blocks/_drafts/many_orders_placed_each_store_location.dql`.
5. **Open draft to review** opens that draft in Block Studio.

If the same question is asked again, ZLens reuses the same draft and counts
the repeats (**asked N times**). A question many people ask is a good one to
certify first.

## Review and certify the draft

1. Click **Open draft to review**, or find it in **Blocks** in the **Drafts**
   folder.
2. Check the SQL and click **Run** to look at the rows.
3. Set an **Owner** and a clear description. Add a test if you can.
4. Click **Certify**.

When it passes, the block is **Certified**. Ask uses it from then on: the
same question now gets a **Certified answer**. See
[Save and certify](../blocks/certify.md).

## When no draft is saved

ZLens saves a review draft only when the answer actually ran and produced
SQL. It does not save one for a refusal, a cancelled run, or a Research
report. Evaluation runs (`zlens agent eval`) never write drafts.

To keep an answer that was not saved, click **Save as block** on it.
**Save as block** opens the **Save as Block** dialog; **Save draft block**
saves a draft and opens it in Block Studio.

## Other labels you may see

- **Governed answer**: built from semantic metrics and dimensions, with no
  AI-written SQL. If ZLens had to guess how to group a dimension, the note says
  **Review required** and asks you to check the mapping.
- **Needs review** on an App page answer: the answer read an App tile whose
  data is not certified. See [Ask about an App](../apps/ask-about-an-app.md).
- On the command line, `zlens agent ask` prints
  `! AI-generated · review required` and the draft path:
  `Review draft saved: <path>`.
