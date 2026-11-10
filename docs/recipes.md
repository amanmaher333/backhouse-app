# Recipes and costing

Recipes say what each dish costs to make and what share of its price goes on food.

## Recipes

There are two kinds of recipe.
- **Menu items** are what you sell. They usually make one portion, and you can link each one to its Foodics menu item.
- **Preps** are batches that other recipes use, for example 2 kg of tomato sauce or 5 L of stock. Preps can use other preps; a recipe that would end up using itself is refused.

Each ingredient line uses an item or a prep, with a quantity in any unit that converts to the item's unit. That includes the item's packs and its catalogue conversions, such as one bun being 60 g or oil weighing 0.91 g/ml.

**Usable %** covers trim and peel loss. For example, 2.5 kg of tomatoes at 80% usable means 3.125 kg bought.

Allergens are collected from the ingredients, preps included.

## Costing

Costs are worked out whenever a recipe is shown, so they follow price changes with nothing to recalculate. Two bases are available:

- **Supplier prices** (default): the preferred supplier's current price, or else the cheapest.
- **Stock average**: the weighted average cost of stock across sites, which follows what deliveries actually cost. Items with no stock use the supplier price.

**Menu items** show:
- their cost per portion;
- the price before VAT (the selling price, or the Foodics price when none is set; prices include VAT unless unticked, at the organisation's VAT rate);
- their **food cost %**;
- whether that is over the item's target.

**Preps** show the batch cost and the cost per kg, L or each.

Ingredients with no cost, or with a unit that doesn't convert, are listed on the recipe, because the total would otherwise be too low.

The editor recalculates as you type (`POST /v1/recipes/preview`). Nothing is saved until you press Save.

## From Foodics

**Recipes → Create from Foodics** turns the recipes Foodics keeps for its menu items into Kitchain menu recipes:
- Each recipe is linked to its Foodics product, and Foodics quantities are converted to our units (e.g. Gram → g, Liter → ml).
- A product whose ingredients aren't all linked to Kitchain items (Integrations → Items) is skipped, with the reason.
- Products that already have a recipe are left alone.

## Permissions

- `recipe:read`: see recipes (site and operations managers, data managers).
- `recipe:manage`: create, edit and delete recipes (data and operations managers).
- Costs and food cost % also need `price:read`.

A prep that other recipes use can't be deleted. Edits are recorded in the audit log.

## API

| | |
|---|---|
| `GET /v1/recipes?kind=menu\|prep&q&basis=supplier\|average` | list with cost, price and food cost % |
| `GET /v1/recipes/:id?basis` | detail with costed lines and where it's used |
| `POST /v1/recipes` · `PATCH /v1/recipes/:id` · `DELETE /v1/recipes/:id` | `PATCH` changes only the fields sent; `lines` replaces all lines |
| `POST /v1/recipes/preview` | cost an unsaved recipe (`recipeId` for edits to an existing one) |
| `GET /v1/recipes/pos-products` | Foodics products without a recipe |
| `POST /v1/recipes/from-pos` | `{ productIds? }` |

## Not yet

- Dated versions of recipes, so past food cost uses the recipe that was in force at the time. Comes with theoretical vs actual.
- Theoretical vs actual food cost from POS sales and stock movements, and the Cost Controller agent's weekly report: the next part of Phase 5.
- Modifiers and combos from Foodics.
