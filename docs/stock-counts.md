# Stock counts

A count records what is actually on the shelves at one site. The differences are posted to the stock ledger as adjustments.

## Counting

- **Start a count** from Stock → Counts. It can cover everything stocked at the site, or only items you choose. You can add more items while counting.
- **Blind counts** are the default: people counting don't see the expected quantity until the count is submitted. Anyone with `stock:approve` can see it.
- **Record counts in three ways:**
  - **Tap:** type a quantity on an item and pick a unit or pack (kg, a 10 kg carton, a tray of 30).
  - **Type:** for example `tomatoes 12 kg, chicken 3 cartons` or `طماطم ١٢ كيلو، دجاج ٣ كراتين`.
  - **Speak:** uses the browser's speech recognition (Arabic `ar-SA` or English).

  Typed and spoken text is checked before anything is saved:
  - Entries that are clear can be recorded in one tap.
  - Unclear entries say what's missing: no quantity, item not found, which item, or which unit.
  - The parser reads Arabic-Indic digits, small number words ("half a bag", "نص كيس"), and unit and pack words in both languages.
  - When no unit is given, it uses the obvious one: "eggs 60" means 60 each, and "chicken 4" means 4 of its only pack.
- **Several people can count at once.** "Add" mode adds to a line's count instead of replacing it, for example when the same item is stored in two places.

## Expected quantity and variance

Each line's expected quantity is what was on hand **at the moment that line was counted**. A delivery, transfer or waste entry made during a long count doesn't show up as a variance on items already counted, and stays in stock after posting.

Variance value is the difference multiplied by the item's average cost. An item with no cost history uses its cheapest supplier price.

## Submit, approve, post

1. **Submit:** works out each line's variance and the totals. Items that weren't counted are left as they are.
2. **Approval:** if the absolute variance values add up to more than the organisation's limit (default 500 in the organisation's currency; set with `PATCH /v1/settings/stock-counts`), only someone with `stock:approve` who didn't count or submit the count can post it. Site managers, operations managers and data managers have `stock:approve`. Org admins are exempt from the separation-of-duties rule.
3. **Post:** writes one `adjustment` movement per changed item, with source `stock_count`. It also emits `stock.counted` for agents. A posted count can't be changed; the database enforces this.

A submitted count can be reopened. An open or submitted count can be cancelled.

## API

| | |
|---|---|
| `POST /v1/sites/:siteId/stock-counts` | `{ scope: 'full' \| 'partial', itemIds?, blind?, note? }` |
| `GET /v1/stock-counts?siteId&status=active\|all\|open\|…` | list |
| `GET /v1/stock-counts/:id` | lines with packs; expected quantities and costs only when the viewer may see them |
| `PATCH /v1/stock-counts/:id/lines` | `{ lines: [{ itemId, qty, unit? \| packId?, mode?: 'set'\|'add', clear? }] }` |
| `POST /v1/stock-counts/:id/entries` | `{ text, apply? }`: read typed or spoken counts; with `apply`, record the clear ones |
| `POST /v1/stock-counts/:id/submit` · `post` · `reopen` · `cancel` | |
