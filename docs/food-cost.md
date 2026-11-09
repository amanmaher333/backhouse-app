# Theoretical vs actual food cost

Recipes → **Food cost** compares what a site actually used with what its sales and recorded waste say it should have used.

## The numbers

For each item, over a period at one site:

- **Used (actual)** = opening stock + deliveries received + transfers in − transfers out − closing stock. These figures come from the stock ledger.
- **Should have used (theoretical)** = sold + recorded waste.
  - Sold is the Foodics sales at the site's linked branches multiplied by each product's recipe.
  - Recipes are broken down to raw items, through any preps they use, and include trim loss.
  - Recorded waste is net of voided entries.
- **Difference** = used − should have used. A positive difference means more went than sales and waste explain: over-portioning, unrecorded waste, theft, wrong recipes or missed deliveries. It's valued at cost: the stock average across sites, or the supplier price for items with no stock.

The totals give net sales before VAT, actual and theoretical food cost (value and % of net sales), the gap in percentage points, and the unexplained value. Rows are sorted by the biggest loss first. Tap a row for its opening, received, transfers and closing figures.

## Periods

"Used" depends on stock at both ends of the period, so a period should start and end with a stock count.

- **Between counts** (recommended): pick two posted counts.
  - Stock is taken at the exact posting time of each count. Each count's own adjustments belong to its side.
  - Sales run from the day after the first count to the day of the second, assuming counts are taken at close of business.
- **Yesterday, last 7 days, dates**: business days in the site's time zone.
  - The report shows whether a count was posted near each end. "Near" means from 36 hours before to 6 hours after the start of the first day, and from 6 hours before to 36 hours after the end of the last day.
  - Without such counts, the "used" figures can be off.

## What the report flags

- **Sold without a recipe**: those sales aren't in "should have used" (they're in net sales), so food cost looks better than it is. Add the recipes, or create them from Foodics.
- **Foodics branches not linked to a site**: their sales aren't counted anywhere.
- **No Foodics connection**: nothing to compare against.
- **Items with no cost**: they show quantities but no values.

## API

| | |
|---|---|
| `GET /v1/food-cost?siteId&from&to` | by business dates |
| `GET /v1/food-cost?siteId&fromCountId&toCountId` | between two posted counts |
| `GET /v1/food-cost/periods?siteId` | posted counts at the site, newest first |

The report needs `stock:read` for the site and `recipe:read`. Values and percentages also need `price:read`.

## Not yet

- **Dated recipe versions**: theoretical use uses today's recipes for the whole period.
- **Foodics modifiers and combo choices**: combo products count as their products; modifier options aren't used.
- **Stock taken from sales as they happen**: today, stock only changes through deliveries, transfers, waste and counts, so the ledger's on-hand quantity between counts doesn't reflect sales.
- **The Cost Controller agent's weekly report**: comes next.

## Cost Controller agent

Hire the **Cost Controller** under Agents. Each week it puts a food cost report for every site into the inbox, and WhatsApp follows the usual inbox settings.

- **When:** on the daily scan. It reports the last completed week, which ends on Saturday by default; change this under Agents → Cost Controller. Weeks are worked out in each site's time zone. Each site gets one report per week: running it again refreshes the report, and last week's unread report expires when the new one arrives.
- **Which sites:** only sites with sales from a linked Foodics branch, since without sales there's nothing to compare.
- **What it says:** the same figures as the Food cost page for that week:
  - net sales;
  - actual vs theoretical food cost, the gap and the unexplained value;
  - the three biggest losses;
  - products sold without a recipe;
  - menu items over their food cost target.

  Claude writes the headline and summary from those figures when an Anthropic key is set (it never invents numbers); otherwise bilingual templates do.
- **Missing counts:** if stock wasn't counted at both ends of the week, the report doesn't give an actual food cost, gap or losses. It shows the theoretical food cost and asks for counts, and it offers **Start a stock count**: one tap creates a full blind count at the site, unless one is already open.
- **High priority** when the gap reaches the threshold (3 points by default, a setting), when over 20% of sales have no recipe, or when the counts are missing.
- **Permissions:** the agent's role can read sites, items, prices, stock, recipes and POS data. It also has `stock:manage`, but only so it can start a count; its guardrail allows no other action.
