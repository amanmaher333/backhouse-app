# Waste and transfers

Both live under Stock, next to on-hand quantities and counts.

## Waste

Waste is stock thrown away, with the reason it was thrown away.

- **Logging waste:** pick an item, a quantity (in a unit or one of its packs) and a reason, or type or say it:
  - "tomatoes 2 kg spoiled, milk 3 L expired"
  - "طماطم ٢ كيلو تالف، حليب ٣ قارورة منتهي"
  - "expired: milk 2 bottles, yoghurt 6", where one reason covers the whole message

  The text is shown back for checking before anything is logged, as with counts. An entry that doesn't say why is logged as **Other**.
- **Reasons:** expired, spoiled, damaged, overproduction, prep trim, dropped or spilled, returned by guest, staff meal, other. Reason words are recognised in English and Arabic (منتهي، تالف، خربان، مكسور، زيادة، طاح، مرتجع…).
- **Effect on stock:** each entry takes the stock off at its average cost (a `waste` movement). An item with no cost history is valued at its cheapest supplier price.
- **Mistakes:** an entry is never edited or deleted, only voided, which puts the stock back at the same cost.
  - You can void your own entry within 24 hours.
  - After that, or to void someone else's entry, you need `stock:approve`.
- **The Waste page:** shows the last 7 or 30 days for a site: total value, totals by reason, the items wasted most, and every entry. People without `price:read` see quantities but no values.

## Transfers

Transfers move stock between your sites, for example from a central kitchen to a branch.

1. **Draft:** choose the sites and items. A draft can be edited and changes no stock.
2. **Send:** takes the stock out of the source at its average cost (`transfer_out`). The cost is saved on the transfer.
3. **Receive:** adds the stock to the destination at that same cost (`transfer_in`), so value moves with the stock.
   - If less arrived than was sent, enter what arrived. The difference is recorded as the transfer's shortage, with its value.
   - Stock that didn't arrive isn't added anywhere.
4. **Cancel:** you can cancel a draft or a sent transfer. Cancelling a sent transfer puts the stock back at the source.

**Who can do what:**
- Only people with `stock:manage` at the source can create, send or cancel a transfer.
- Only people with `stock:manage` at the destination can receive it.
- Anyone with `stock:read` at either end can see it.

Received and cancelled transfers are final; the database enforces this.

Transfers between sites that belong to different legal entities (companies) currently move stock at cost, with no inter-company invoice.

## API

| | |
|---|---|
| `POST /v1/sites/:siteId/waste` | `{ entries: [{ itemId, qty, unit? \| packId?, reason, note? }] }` |
| `POST /v1/sites/:siteId/waste/read` | `{ text, apply?, defaultReason? }`: read typed or spoken waste; with `apply`, log the clear entries |
| `GET /v1/waste?siteId&from&to&reason&itemId&includeVoided` | entries |
| `GET /v1/waste/summary?siteId&from&to` | totals by reason, items wasted most |
| `POST /v1/waste/:id/void` | `{ reason }` |
| `GET /v1/stock-transfers?siteId&direction=in\|out\|both&status=active\|all\|…` | list |
| `POST /v1/stock-transfers` | `{ fromSiteId, toSiteId, lines: [{ itemId, qty, unit? \| packId? }], note?, send? }` |
| `GET` · `PATCH /v1/stock-transfers/:id` | detail; edit a draft |
| `POST /v1/stock-transfers/:id/send` · `receive` · `cancel` | `receive` takes `{ lines: [{ lineId, qty, unit? \| packId? }] }` for lines that arrived differently |
| `GET /v1/stock-items` | stockable items with their packs, for pickers |

Events for agents: `stock.wasted`, `transfer.sent`, `transfer.received`.
