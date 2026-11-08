# Design spec: SWIFTLY POS and AI Insights

How to use this file in a new session: attach it and say "Apply the POS spec" or "Apply the AI Insights spec" (or both) to the new product. Every value below is taken from the live code on 2026-11-08:
- POS comes from SWIFTLY `apps/web/public/shell.css`, branch `option-b-mongodb`.
- AI Insights comes from `arm-chat-report` `src/designer.css`, `src/index.css` and `src/arm-theme.css`, branch `main`.

Copy the token values as they are. Rename the classes to suit the new product.

---

## 0. What both products share

| | Value |
|---|---|
| Accent (one only) | `#0F766E` teal. White text on it. Hover/pressed `#0B5F58`. |
| Accent as text | light `#0F766E`, dark `#5EEAD4` (POS) or `#3CCAB7` (AI Insights) |
| Arabic font | IBM Plex Sans Arabic 400 and 600, loaded with `unicode-range: U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF`, so Latin text keeps the main font |
| Themes | Light and dark, set with `[data-theme="light"]` / `[data-theme="dark"]` on `<html>`. Both themes are complete. |
| RTL | Use logical properties everywhere (`inset-inline-start`, `margin-inline-end`, `padding-inline`, `border-inline-start`, `text-align: start`). `[dir="rtl"]` mirrors the layout without separate CSS. |
| Focus | `outline: 2px solid <accent-text>; outline-offset: 2px` (AI Insights uses 3px) |
| Touch | Every control is at least 44px. Main actions are 48–56px. |
| Numbers | `font-variant-numeric: tabular-nums` on prices, totals, times and KPIs |
| Danger | light `#DC2626`, dark `#F87171`. Solid fill is always `#DC2626` with white text, pressed `#B91C1C`. Soft fill: light `#FEE7E7`, dark `#3B1A1A`. |
| Copy | Sentence case, plain words, no exclamation marks. A change says what it is compared to ("vs last week"). |

---

## 1. POS (SWIFTLY)

**Character:** a light workspace that works with fingers on a tablet. It has a white sidebar, a soft grey canvas, white cards and grey board columns. It is calm, dense and quick to scan.

### 1.1 Tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | `#F4F4F5` | `#111113` | page background |
| `--card` | `#FFFFFF` | `#1A1A1D` | cards, sidebar, panels |
| `--tile` | `#F4F4F5` | `#232327` | board columns, tags, quiet fills, active nav row |
| `--tile-2` | `#EBEBED` | `#2C2C31` | segmented track, disabled primary |
| `--line` | `#E7E7EA` | `#2C2C31` | hairlines, card borders |
| `--line-2` | `#D8D8DD` | `#3A3A40` | input borders, stronger edges |
| `--t1` | `#18181B` | `#F4F4F5` | primary text |
| `--t2` | `#5F5F68` | `#A8A8B1` | secondary text |
| `--t3` | `#85858F` | `#80808A` | muted text, labels, icons |
| `--accent` | `#0F766E` | `#0F766E` | primary button, selection |
| `--accent-h` | `#0B5F58` | `#0D8A80` | pressed primary |
| `--accent-soft` | `#E3F4F1` | `#123430` | selected fill, avatar |
| `--accent-text` | `#0F766E` | `#5EEAD4` | accent used as text, focus ring |
| `--late` | `#C2410C` | `#FB923C` | warnings, "Late" |
| `--late-soft` | `#FFEDE3` | `#3A2114` | warning fill |
| `--shadow` | `0 1px 2px rgba(24,24,27,.05)` | `none` | cards (dark mode uses no shadows) |

**Order status colours.** Use them as a 14% tint behind a dot, never as a solid fill.

`color-mix(in srgb, var(--st) 14%, transparent)`

| Status | Colour |
|---|---|
| progress | `#D97706` |
| ready | `#0D9488` |
| available / free | `#16A34A` |
| served | `#7C3AED` |
| billed | `#EA580C` |
| reserved | `#DB2777` |
| placed | `#2563EB` |
| not sent (draft) | `#D97706`, drawn as a hollow ring (`box-shadow: inset 0 0 0 2px`) so it never reads as Free |

### 1.2 Type

- **Font:** Figtree for everything. Arabic uses IBM Plex Sans Arabic.
- **Body:** 14px / 20px.
- **Inputs:** 16px, which stops iOS from zooming.

| Role | Size / line height | Weight |
|---|---|---|
| Page title | 36/44, letter-spacing −0.02em (28/36 under 760px, 24/32 on POS tablet) | 700 |
| Page subtitle | 15/22, `--t2` | 400 |
| Card title | 16/24 | 600 |
| Panel or dialog title | 20/28 | 700 |
| Stat value | 26/34 (compact "today" row: 20/28; phone: 20/28) | 700 |
| Stat label | 13 | 500 |
| Table header | 12, `--t3` | 500 |
| Tag | 12/22 | 500 |
| Sidebar section label | 11, uppercase, 0.06em tracking, `--t3` | 600 |

### 1.3 Shape and spacing

- **Radius:**
  - cards and board columns 16
  - table tiles and tickets 14 (12 on the dashboard)
  - list items, menu buttons and inputs 12
  - nav rows 10
  - thumbnails 8
  - pills (tags, crumbs, branch picker, segmented control) 999
  - dialogs 20
- **Card:** padding 20, gap 16, 1px `--line` border, `--shadow`.
- **Page padding:** 16 32 40 on desktop, 12 20 on tablet (≤1200px), 12 16 on phone (≤760px).
- **Gaps:** 20 between page sections, 16 between cards, 12 between stats, 8–10 inside tile grids.

### 1.4 Layout and breakpoints

| Width | Shell |
|---|---|
| > 1200px | Fixed sidebar 272px (collapses to 72px icon rail). Content is fluid. The order panel is a 400px right column (`grid: main 1fr / panel 400px`). |
| ≤ 1200px | The sidebar becomes a slide-in drawer, `min(300px, 86vw)`, with a scrim `rgba(0,0,0,.4)`, opened by a 44px round menu button. Order panel 360px. |
| ≤ 900px | The order panel becomes a fixed overlay from the inline-end edge, `min(440px, 100vw)`. |
| ≤ 760 / 640px | Single column. Board columns stack. Table grid is 2 columns. Stats are 2 columns. Page actions are full width. |

- **Top bar:** frosted, 69px tall, absolute over the content, so pages scroll under it.
  - `background: color-mix(in srgb, var(--canvas) 62%, transparent); backdrop-filter: blur(18px) saturate(170%)`
  - bottom hairline is `--line` at 70%
  - holds a pill breadcrumb (44px), a back button (44px circle), a theme toggle (44px) and a sync pill
- **Sync pill:** 32px, `--tile` with `--t2` text. When offline: `#FEF3C7` background, `#92400E` text.

### 1.5 Components

**Sidebar**
- Brand block: 36px logo plus name 15/700 and a 12px subtitle, with a hairline under it.
- Branch picker and app picker: 56px cards with a 32px icon tile and an 11px uppercase label over a 15px/600 select.
- Search: 48px, radius 10, 1px `--line`.
- Nav row: 48px, radius 10, 20px icon with a 12px gap, 15px/500 `--t2`.
  - Active row: `--tile` background, `--t1` text, weight 600.
  - Child rows: 44px, indented with a 1px `--line` guide on the inline-start side.
  - Count badge: pill, `--tile-2`, 12/600.
- Footer: user row 52px with a 36px avatar on `--accent-soft`.

**Buttons**
- Small 44px, medium 48px (15px text), large 56px (16px). All are weight 600.
- Primary: accent background, white text, no gloss and no shadow. Pressed uses `--accent-h`. Disabled uses `--tile-2` with `--t3` text.
- Tertiary: `--tile` background. On the canvas it gets a 1px `--line-2` border and a `--card` background.
- Every button presses in: `transform: scale(.97)` over 0.08s. Mouse hover colours are removed so they don't stick after a tap.

**Segmented control**
- Track: `--tile-2`, pill, padding 4.
- Option: 44px, padding 18, 14px.
- Selected option: `--card` background, `--t1` text, weight 600, `--shadow`.

**Stat card**
- Label 13/500 `--t2`, then the value, then a delta at 12/500 (neutral delta uses `--t3`).
- Grid: `repeat(auto-fit, minmax(170px, 1fr))`.
- No icons and no sparklines.

**Channel tabs** (Dine in / Take away / Delivery…)
- Underline tabs, 56px tall, 24px gap, with a 32px picture.
- Active tab: 2px `--accent-text` underline, accent-text colour, weight 600.

**Table tile** (table grid)
- Grid: `minmax(150px, 1fr)`; 124px on tablet, 132px on the dashboard, 2 columns on phone.
- Tile: min height 112px, padding 14, radius 14.
- Table code 18/600. Time 13px, which turns `--late` when late. The time line wraps under the code instead of being cut off.
- Status pill: 24px tall, 14% tint, with a 7px dot.
- Selected tile: accent border plus `inset 0 0 0 1px` accent.

**Floor plan** (SVG, drawn at 0.6 of the designed size and centred)
- Table body:
  - fill is the status at 10% over `--card`
  - stroke is the status at 2.5px
  - a free table is `--card` with a 1.5px `--line-2` stroke
- Selected table: accent stroke, 4px.
- Not sent: dashed stroke `8 6`.
- Late: the stroke turns red `#DC2626`, and so does the time.
- Chairs: `r=7`, `--card` with a `--line-2` stroke. A taken chair is the status at 45%.
- Text in plan units: code 26/600, word and time 19/500. On screen at 0.6 this is about 16px and 12px.

**Live board** (orders by status)
- 3 columns on `--tile`, radius 16, padding 12.
- Order cards: `--card`, radius 12, padding 14. Name 15/600, detail 13 `--t2`.
- Meta row under a hairline: 12px, tabular figures.
- Tags: pill, `--tile`, 12/22. Late tag: `--late-soft` background, `--late` text.

**Order panel**
- Head: padding 20 24, title 20/700.
- Line rows: min 64px, name 500 with a 12px `--t2` subline.
- Total row: 18/700.
- Payment choices: 3 columns, 80px tall. The selected one gets a 2px accent border, `--accent-soft` fill and accent text.

**Add order popup**
- Size: `min(960px, 100%)` × `min(720px, 100dvh − 32px)`, padding 24.
- Body: two columns, `1fr | 300px`.
- Search: 44px, radius 12, with a magnifier icon inside on the inline-start side. Focus ring: `0 0 0 3px` accent at 18%. A 44px square voice button sits on its inline-end side; it is filled with the accent while listening.
- Category chips: 36px pills, 1px `--line`. The selected chip is filled with `--t1` and uses inverse text.
- Item grid: `minmax(124px, 1fr)`, gap 10.
  - Item tile: radius 14, padding 8. Photo `aspect-ratio: 16/11`, radius 10. Name 14/500, price 13 `--t2`.
  - In the order: accent-text border plus inset ring, and a quantity badge (accent pill, 24px, white 13/600) in the top inline-end corner.
- Order list: `--tile` panel, radius 16, padding 16. Each line is a `--card` row, radius 12, with − / count / + and 44px icon buttons.
- ≤ 820px: the order list moves under the tiles and is capped at 38dvh.
- ≤ 640px: full screen, with padding that includes `env(safe-area-inset-*)`, and a 3-column grid.

**Thumbnails**
- 40px (36px small), radius 8, `object-fit: cover`.
- No photo: a `--tile` square with initials in `--t3`, weight 500. Never a coloured placeholder.

**Toggle switch:** 56×32, knob 24, track `--line-2`, accent when on.

**Dialog:** radius 20, 1px `--line`, title 20/700, close button 48px.

**Floating banner:** fixed at the bottom centre, above the safe area. `--card` with 1px `--line-2`, radius 14, shadow `0 8px 24px rgba(0,0,0,.12)`.

### 1.6 Behaviour rules

- Touch only:
  - no text selection outside inputs
  - no long-press menu
  - `overscroll-behavior: none`
  - `touch-action: manipulation`
- A press shows at once with `scale(.97)` and a `--tile` background on tiles.
- Destructive buttons ask twice. The first tap arms the button (solid red); the second tap confirms.
- Durations are short: "6m", "2h 14m", "3d 4h".

---

## 2. AI Insights (chat analytics)

**Character:** exact, warm and plain-spoken, like the back office after closing. It is one conversation column. The answer chart is the moment that carries the colour; everything around it is quiet.

### 2.1 Tokens

| Token | Light | Dark (graphite) | Use |
|---|---|---|---|
| `--bg` | `#F2F7F5` | `#111214` | page |
| `--surface` | `#FFFFFF` | `#0C0D0F` | drawer, header base |
| `--header-bg` | `rgba(242,247,245,.82)` | `rgba(17,18,20,.86)` | frosted header |
| `--card` | `#FFFFFF` | `#18191C` | cards, composer |
| `--field` | `#FFFFFF` | `#202226` | inputs, table header |
| `--raised` | `#E6EFEC` | `#202226` | user bubble, active chat row |
| `--border` | `rgba(24,24,27,.08)` | `rgba(255,255,255,.08)` | hairlines |
| `--btn-border` | `rgba(24,24,27,.14)` | `rgba(255,255,255,.14)` | button and chip borders |
| `--hover` / `--track` | `#F4F4F5` / `#E6EFEC` | `#22252A` | hover, bar tracks |
| `--text` | `#172A28` | `#F2F3F5` | primary text |
| `--body` | `#22332F` | `#DCDEE2` | answer text |
| `--secondary` | `#3B4D49` | `#A9AEB5` | secondary text |
| `--muted` | `#52525B` | `#A1A6AD` | labels |
| `--faint` | `#6E6E76` | `#8A9097` | axis labels, placeholders, notes |
| `--accent` | `#0F766E` | `#0F766E` | primary button, focus, line chart |
| `--accent-hover` | `#0B5F58` | `#0B5F58` | |
| `--accent-soft` | `#DCEDE9` | `rgba(15,118,110,.24)` | focus halo |
| `--accent-text` / `--link` | `#0F766E` | `#3CCAB7` | accent as text |
| `--ask-bg` / `--ask-text` | `#172A28` / `#FFFFFF` | `#F4F3F1` / `#18181B` | the Send ("Ask") button, an inverse pill |
| `--green` / `--red` | `#15803D` / `#DC2626` | `#4CC38A` / `#E5484D` | deltas |
| `--card-shadow` | `0 1px 2px rgba(24,24,27,.05)` | `none` | |
| Tooltip | `--tip-bg #172A28`, text `#F2F7F5` | `#F4F3F1`, text `#18181B` | inverse tooltip |

**Chart colours.**
- Dark mode uses one colour per series:
  - teal `#2BC4B0`
  - orange `#FB923C`
  - blue `#60A5FA`
  - violet `#A78BFA`
  - pink `#F472B6`
  - amber `#FACC15`
  - Single-series bars: the top bar is teal and the others take the colours above. With more than 8 bars, the rest are `#34373D`.
- Light mode stays restrained:
  - teal `#0F766E`, neutral `#71717A`, deep teal `#2C645E`
  - Single-series bars: the top bar is teal and the rest are `#D4D4D8`.

### 2.2 Type

- **Fonts:**
  - Poppins 400/500/600, with IBM Plex Sans Arabic for Arabic.
  - JetBrains Mono 400–600 for figures: KPI values, axis ticks, table numbers, usage %.
- **Weights:** 400 to 600 only. Headings and buttons use 500, the brand name 600.

| Role | Size / line height | Notes |
|---|---|---|
| Empty-state headline | `clamp(28px, 4.5vw, 36px)` / 1.15 | 500, letter-spacing −0.02em |
| Login hero headline | `clamp(32px, 3.4vw, 44px)` / 1.12 | 500, −0.03em, white on the dark hero |
| Answer text | 15/1.6 (Arabic 16/1.75) | `--body` |
| User bubble | 15/1.5 | |
| Card title | 15 | 500 |
| KPI value | 22, mono | 600, −0.02em |
| KPI label, card sub | 12 | `--muted` |
| Table | 13, header 12 `--muted` on `--field` | numbers in mono, aligned to the end |
| Chart axis | 11, mono | `--faint` |
| Disclaimer, note | 11 | `--faint`, centred |

### 2.3 Shape and spacing

- **Pills (999) are for actions only:** buttons, chips, the composer (radius 29), language and install buttons, mic and send (circles).
- **Everything else has a radius by size:**
  - cards 16
  - KPIs, side cards and tables 12
  - search fields, chat rows and form fields 10–12
  - segmented control 10 with 8 inside
  - user bubble `20 20 6 20` (mirrored in RTL)
- **Spacing:**
  - Thread: max width 920, padding 32 24 24, gap 32 between messages, 16 inside a message.
  - Card padding 20, KPI padding 16, drawer padding 16.
  - 4px grid throughout.

### 2.4 Layout

- **Header:**
  - fixed, 65px, frosted (`var(--header-bg)` + `blur(18px) saturate(1.4)`), hairline bottom
  - brand: a 40px logo tile, radius 12, then the name at 16/600 and a status line at 12px with a 7px live dot (green; amber when offline)
  - actions: usage meter pill (40px), language picker, install button, theme toggle, 44px avatar
- **Drawer (left rail):**
  - 320px, fixed below the header on screens ≥ 769px, collapsible
  - contents: search (40px), then grouped chat rows (36px, radius 10, 13px; the active row uses `--raised`, `--text` and weight 500)
  - group labels: 12px, sentence case, `--muted2`
  - usage card pinned to the bottom, then the user row
- **Composer:**
  - sticky at the bottom, max width 880, a single pill (radius 29)
  - auto-growing textarea, max height 160px
  - mic: a transparent 44px circle
  - send: a 44px circle in `--ask-bg`
  - focus: accent border plus `0 0 0 3px var(--accent-soft)`
  - a notice line sits under it
- **≤ 768px:** the drawer slides over the content (300px) with a backdrop. The thread padding becomes 20 16 and bubbles are 90% wide.
- **Login:**
  - a dark hero panel (58% width, `#0C1917` with soft teal radial light from the bottom right) beside the form
  - the hero holds a glass label, a headline, a lead paragraph (17/1.6 at 75% white) and slide dashes (48×6 bars in 44px tap targets)
  - phone: the form comes first and the hero becomes a short card with radius 24
  - fields: 50px, radius 12, focus halo
  - the primary button is full width, 50px, a pill

### 2.5 Components

**User message:** a bubble on the inline-end side, `--raised`, 1px `--raised-border`, max width 560.

**Bot answer:** no bubble. Text, then optional cards, KPIs, a chart, a table and action buttons (36px, radius 10, 12px).

**KPI row:** `repeat(auto-fit, minmax(160px, 1fr))`, gap 10. Label, value in mono, and a delta (green, or red when negative).

**Answer chart** (Recharts)
- Line or area: 280px tall, stroke 3, dots r 3.5 (active 5), area fill a soft gradient of the series colour.
- Bar: 280px, top radius 4, category gap 20%. Labels tilt −30° when crowded and show at most 14 labels.
- Donut: 260px, inner radius 55, outer 85, padding angle 2.
- Grid: horizontal lines only, in `--border`. Axes have no lines and no ticks.
- Tooltip: `--card`, radius 10, 8px colour squares, label weight 800.

**Data table:** wrapped in a 1px border with radius 12 that scrolls horizontally. Header on `--field`. Rows are separated by hairlines.

**Suggestion chips:** 40px pills, 1px `--btn-border`, `--card` background. On hover they invert to `--text` background with `--bg` text.

**Typing indicator:** a pill with three 6px accent dots blinking with a 0.2s stagger.

**Usage meter**
- Header pill 40px with a 104×4 track.
- Side card with the % in mono.
- Low usage turns the bar, border and text amber. Used up turns them red and hides the composer behind a notice card.

**Live voice**
- Floating button: a 52px pill with a `--card` background, a 1.5px accent border and a gently moving 4-bar sound wave. No glow.
- Voice screen: full-screen flat colour per state:
  - idle `--voice-bg`
  - listening `#12302C` dark / `#DCEDE9` light
  - thinking and speaking `--voice-mid`
- 120px orb with rings. Close is a 48px circle in the safe-area corner.
- Start and stop are 48px pills, min width 120.

**Top-up modal:** max width 540, radius 20, padding 24. Pack cards have a 2px border; the chosen one gets the accent border. A small badge sits over the top edge.

**Line loader:** a 3px bar under the header with a 40% accent segment sliding across it.

### 2.6 Motion

- One curve, `cubic-bezier(.22, 1, .36, 1)`, at 0.15s for colour, border, shadow and transform. The drawer uses 0.3s.
- Press: `scale(.97)`.
- `prefers-reduced-motion` turns off transitions, the sound wave, the typing dots and the slide animation.

---

## 3. Standing rules to carry over (from SWIFTLY's CLAUDE.md)

1. **PWA.** Include:
   - a manifest (standalone, theme and background colours, 192 and 512 icons)
   - a service worker caching the app shell
   - an "Install app" button
   - an offline/online indicator (the live dot, or the sync pill)
2. **Responsive.** Phone from 360px, tablet (split views), desktop (sidebar). No horizontal scroll. Touch targets ≥ 44px.
3. **Bilingual EN/AR.** A language toggle mirrors the whole layout. Use logical properties.
4. **Saudi context** where relevant: SAR (with the riyal symbol image `.riyal`, `height: .82em`), 15% VAT, ZATCA and mada shown only as labelled placeholders.
5. **Safe areas:** `viewport-fit=cover`, with `env(safe-area-inset-*)` padding on full-screen surfaces and fixed bars.
6. **No real brand logos.** After building, list what was built and what was simplified.

## 4. Known gaps in the source products (don't copy these)

- **POS phone navigation.** SWIFTLY's POS uses the slide-in drawer on phones, not the bottom navigation its own rules ask for. In a new product, add a bottom bar on phones:
  - 4–5 items, 56px plus the safe-area inset
  - `--card` background with a top hairline
  - active item in `--accent-text`
- **POS platform shell.** It is not yet translated to Arabic (the back-office screens are). Build RTL from the start.
- **AI Insights base CSS.** `designer.css` still holds old 700/800 weights and uppercase labels that later layers override. In a new product, use the final values in section 2, not the base file.
