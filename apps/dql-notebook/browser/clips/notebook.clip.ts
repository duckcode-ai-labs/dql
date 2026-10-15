import { clip, expect, openAndRecord } from './support/clip-test';

const SQL = 'select location_name, count(*) as orders from dev.orders join dev.locations using (location_id) group by 1 order by 2 desc';

const DQL = `block "orders_by_store" {
  domain = "commerce"
  type = "custom"
  description = "Orders taken at each store."
  query = """
    SELECT location_name, COUNT(*) AS orders
    FROM dev.orders JOIN dev.locations USING (location_id)
    GROUP BY 1
  """
  visualization {
    chart = "bar"
  }
}`;

/** Notebooks: a new notebook with a SQL cell and a DQL cell, both run against the sample's DuckDB, saved to the project. */
clip('notebook', async ({ page, sample, director }) => {
  const server = await sample.serve(sample.freshProject());
  await openAndRecord(page, director, server.baseUrl);

  await director.click(page.getByRole('button', { name: 'Notebooks', exact: true }).first());
  await director.click(page.getByRole('button', { name: 'New Notebook', exact: true }).first());
  await director.type(page.getByPlaceholder(/Customer retention/), 'Store orders');
  await director.click(page.getByRole('button', { name: 'Create notebook' }).last(), { after: 900 });

  // First cell: plain SQL.
  await director.click(page.getByRole('button', { name: /Create DQL query/ }));
  await director.click(page.getByRole('button', { name: 'Switch to SQL cell' }));
  const firstEditor = page.locator('.cm-content').first();
  await director.click(firstEditor, { after: 200 });
  await page.keyboard.type(SQL, { delay: 16 });
  await page.keyboard.press('Escape');
  await director.beat(500);
  await director.click(page.getByTitle('Run cell (Shift+Enter)').first(), { after: 300 });
  await director.fastForward(() => expect(page.getByText('Trust & Steps').first()).toBeVisible());
  await director.beat(1200);
  await director.click(page.getByRole('button', { name: 'Table', exact: true }).first(), { after: 1000 });

  // Second cell: a DQL block, the reusable form of the same query.
  const cells = page.locator('.cm-content');
  const box = await cells.first().boundingBox();
  const lineage = await page.getByText('Cell SQL lineage').first().boundingBox();
  await director.moveTo(900, Math.max(box!.y + box!.height, lineage!.y) + 30);
  const addCell = page.getByRole('button', { name: 'Add cell' }).last();
  await director.click(addCell, { after: 500 });
  await director.click(page.getByTestId('add-cell-dql').last(), { after: 700 });
  const secondEditor = cells.nth(1);
  await director.click(secondEditor, { after: 200 });
  await page.keyboard.insertText(DQL);
  await director.beat(1200);
  await director.press('Shift+Enter', 300);
  await director.fastForward(() => expect(page.getByText('Trust & Steps').nth(1)).toBeVisible());
  await page.getByText('Trust & Steps').nth(1).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await director.beat(1200);
  director.poster();

  // Saved to notebooks/ in the project.
  const save = page.getByRole('button', { name: /^(Save|✓ Saved|Saved)$/ }).first();
  await director.click(save, { after: 400 });
  await expect(page.getByRole('button', { name: /Saved/ }).first()).toBeVisible();
  await director.beat(1400);
});
