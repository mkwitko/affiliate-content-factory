---
name: Content Factory
description: "Two worlds for one product: the operator's counter thermal printer (Content Factory panel) and the shopper's weekly deals flyer (Example Shop storefront)."
colors:
  paper: "#f6f6f2"
  paper-2: "#ecece6"
  field: "#fdfdfb"
  ink: "#161616"
  ink-hover: "#34363b"
  fade: "#66665f"
  rule: "#b4b4ab"
  input: "#8d8d85"
  counter: "#26282c"
  counter-2: "#1b1d20"
  counter-line: "#3b3e44"
  counter-ink: "#ecece6"
  counter-fade: "#a9abaf"
  stamp: "#1d43c4"
  stamp-deep: "#1636a3"
  stamp-red: "#c4281b"
  flyer-paper: "#ffffff"
  flyer-ink: "#111111"
  flyer-ink-soft: "#444444"
  flyer-dots: "#9a9a9a"
  flyer-photo-bed: "#f2f2f2"
  flyer-yellow: "#ffd400"
  flyer-red: "#e3001b"
  flyer-red-deep: "#c40017"
  flyer-casa: "#0f8a4f"
  flyer-beleza: "#d61c6f"
  flyer-tech: "#1450d6"
typography:
  dupla:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "'wdth' 75"
  fonte-a:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'tnum', 'zero'"
    fontVariation: "'wdth' 87.5"
  fonte-b:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.04em"
    fontVariation: "'wdth' 87.5"
  tab-label:
    fontFamily: "Martian Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.625rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.02em"
    fontVariation: "'wdth' 75"
  flyer-display:
    fontFamily: "Anton, Arial Narrow, Impact, sans-serif"
    fontSize: "2.6rem"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "0.01em"
  flyer-price:
    fontFamily: "Anton, Arial Narrow, Impact, sans-serif"
    fontSize: "clamp(1.5rem, 9vw, 3.1rem)"
    fontWeight: 400
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  flyer-headline:
    fontFamily: "Anton, Arial Narrow, Impact, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.02em"
  flyer-title:
    fontFamily: "Barlow, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  flyer-body:
    fontFamily: "Barlow, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
  flyer-label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.1em"
rounded:
  none: "0px"
spacing:
  "2xs": "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  base: "16px"
  lg: "20px"
  xl: "24px"
  "2xl": "28px"
  edge: "7px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.fonte-a}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.fonte-a}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "46px"
  button-outline-hover:
    backgroundColor: "{colors.paper-2}"
  button-sm:
    typography: "{typography.fonte-b}"
    padding: "0 10px"
    height: "36px"
  button-disabled:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.fade}"
  stamp-approve:
    backgroundColor: "{colors.stamp}"
    textColor: "{colors.paper}"
    typography: "{typography.fonte-a}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "46px"
  stamp-approve-hover:
    backgroundColor: "{colors.stamp-deep}"
  stamp-return:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.stamp-red}"
    typography: "{typography.fonte-a}"
    rounded: "{rounded.none}"
    padding: "0 16px"
    height: "46px"
  stamp-return-hover:
    backgroundColor: "{colors.stamp-red}"
    textColor: "{colors.paper}"
  printed-field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.fonte-a}"
    rounded: "{rounded.none}"
    padding: "10px 12px"
    height: "46px"
  stage-cell:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.fonte-b}"
    rounded: "{rounded.none}"
    padding: "8px 12px"
    height: "64px"
    width: "108px"
  stage-cell-current:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  line-item:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.fonte-a}"
    padding: "12px 6px"
  line-item-hover:
    backgroundColor: "{colors.paper-2}"
  line-item-open:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  tag:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.fonte-b}"
    rounded: "{rounded.none}"
    padding: "2px 7px"
    height: "24px"
  tag-review:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  tag-bad:
    textColor: "{colors.stamp-red}"
  tag-quiet:
    textColor: "{colors.fade}"
  nav-item:
    backgroundColor: "{colors.counter}"
    textColor: "{colors.counter-fade}"
    typography: "{typography.fonte-b}"
    rounded: "{rounded.none}"
    padding: "0 14px 0 10px"
    height: "42px"
  nav-item-current:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  tab-item:
    backgroundColor: "{colors.counter-2}"
    textColor: "{colors.counter-fade}"
    typography: "{typography.tab-label}"
    padding: "8px 1px 6px"
    height: "58px"
  tab-item-current:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
  ticket:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    width: "440px"
  seal:
    textColor: "{colors.stamp}"
    typography: "{typography.dupla}"
    padding: "10px 18px"
  flyer-cta:
    backgroundColor: "{colors.flyer-red}"
    textColor: "{colors.flyer-paper}"
    rounded: "{rounded.none}"
    padding: "0 20px"
    height: "58px"
  flyer-cta-hover:
    backgroundColor: "{colors.flyer-red-deep}"
  flyer-card-button:
    backgroundColor: "{colors.flyer-paper}"
    textColor: "{colors.flyer-red}"
    rounded: "{rounded.none}"
    padding: "0 8px"
    height: "40px"
  flyer-card-button-hover:
    backgroundColor: "{colors.flyer-red}"
    textColor: "{colors.flyer-paper}"
  flyer-follow-top:
    textColor: "{colors.flyer-paper}"
    rounded: "{rounded.none}"
    padding: "0 12px"
    height: "40px"
  flyer-price-tag:
    backgroundColor: "{colors.flyer-yellow}"
    textColor: "{colors.flyer-red}"
    rounded: "{rounded.none}"
    padding: "3px 8px 2px"
  flyer-stamp:
    textColor: "{colors.flyer-red}"
    typography: "{typography.flyer-label}"
    rounded: "{rounded.none}"
    padding: "5px 8px 4px"
  flyer-flag:
    backgroundColor: "{colors.flyer-red}"
    textColor: "{colors.flyer-paper}"
    rounded: "{rounded.none}"
    padding: "6px 12px 5px"
---

# Design System: Content Factory

## Overview

**Creative North Star: "The Counter Printer and the Weekly Flyer"**

One product, two audiences, two worlds that never share a screen. The operator panel (Content Factory: every authenticated route, plus sign-in and invitation) is a shop-counter thermal printer, "Bobina Térmica". Every package the factory delivers is a printed ticket: a graphite counter carries a roll of bright thermal paper fed out of a printer slot, section headers print in double height over a double rule, items are separated by dashed cut lines, facts run on dot leaders, and the roll ends in a serrated tear. The operator reads the ticket, stamps it APROVADO in blue or DEVOLVIDO in red, and watches it tear off and reprint in its new stage. Colour exists only inside plates (product photos, slides) and in those two rubber-stamp inks. The public niche storefront (`/n/:slug`) is a supermarket deals flyer: glossy white paper, black ink, an encarte-yellow starburst with red numerals, dotted cut lines between the finds, and the niche color as the masthead band. The shopper recognizes the flyer, finds the cover deal, reads when the price was checked, and taps the red block.

How they relate: both are evidence-first and both are printed matter. The panel prints a price with the date it was verified; the flyer stamps the same date onto the offer. Both are flat, both are square-cornered, both read at phone width first, both separate items with cut lines rather than boxes. They differ in everything else on purpose: the panel is one monospace face at three print sizes, near-monochrome on a dark counter, with state carried by line form; the flyer is loud condensed caps and Anton on white with yellow and red. The panel never shows the flyer's yellow, encarte red, Anton or Barlow; the flyer never shows the Content Factory name, the thermal palette, Martian Mono or the stamp inks.

**Key Characteristics:**
- Panel: graphite counter (`counter`) under thermal paper (`paper`), thermal ink (`ink`) and faded print (`fade`); no other hue outside plates and the two stamp inks.
- Panel: Martian Mono only, at three print sizes (Fonte B, Fonte A, Dupla); hierarchy by weight, caps, double height and the inverse band, never by a fourth size.
- Panel: state by line form: inverse needs you, solid is done, dashed is waiting, red double has failed.
- Panel: zero radius, zero shadow; dashed cut lines, double rules, dot leaders, crop marks around plates, serrated tear edges.
- Panel motion is the printer's: paper feeds, stamps thud, tickets tear, rows reprint; nothing floats.
- Flyer: white paper, black ink, no radius anywhere, 2 to 3px black rules and dotted cut lines instead of borders.
- Flyer: niche color owns the masthead and the follow block; yellow and red own price and action; nothing else is colored.

## Colors

The panel is warm-grey thermal paper and graphite with two stamp inks; the flyer is black-on-white with two encarte primaries and one niche color chosen at runtime.

### Content Factory panel (counter printer)

#### Primary
- **Thermal Ink** (`ink`): all text on paper, every rule and cut line that carries meaning, the inverse band (primary button, current stage, open line item, "needs you" tag, bars in Resultados), and `::selection` (ink ground, paper text). Its hover lift is **Warm Graphite** (`ink-hover`), used only on the primary button.

#### Stamp inks
- **Approve Blue** (`stamp`): the APROVAR stamp in the ticket foot, the APROVADO seal, the 2px focus outline on every focusable, `accent-color` and `caret-color`, and the sign-in button hover. Deepens to `stamp-deep` on the approve stamp hover.
- **Return Red** (`stamp-red`): the DEVOLVER stamp and the DEVOLVIDO seal, pressed rejection reasons, the danger button, failed tags, the failed-packages frame, `bad` notices and front-door errors.

#### Neutral
- **Thermal Paper** (`paper`): the roll, the ticket, the sign-in card, the current nav tab joined to the roll. **Paper Shade** (`paper-2`): hover fill on line items, stages, outline buttons and toggles; slide placeholder.
- **Field White** (`field`): the fill of printed fields, a hair brighter than the paper so the slip reads as fill-in.
- **Faded Print** (`fade`): hints, meta lines, fact terms, the date line under a title, disabled labels, quiet tags.
- **Cut Line Grey** (`rule`): secondary dashed separators between line items, dot leaders, disabled outlines, the skeleton dashes, thin scrollbars on paper. **Field Stroke** (`input`): the 1px side and top strokes of a printed field.
- **Graphite Counter** (`counter`): the page ground behind the roll and the sign-in ticket. **Counter Shadow** (`counter-2`): the top bar, the mobile tab bar, and the 6px printer slot at the top of the roll. **Counter Line** (`counter-line`): hairlines and dot leaders printed on the counter. **Counter Ink** (`counter-ink`) and **Counter Fade** (`counter-fade`): text on the counter, at rest and faded.

### Example Shop storefront (flyer)

#### Primary
- **Encarte Red** (`flyer-red`): the price numerals in the starburst and tags, the "Achado da semana" flag, the "conferido" stamp stroke, the buy CTA (hover `flyer-red-deep`), the card button stroke and its hover fill.
- **Encarte Yellow** (`flyer-yellow`): the starburst fill, the small price tag, `::selection`.

#### Secondary
- **Niche Color** (runtime `--accent`, one of `flyer-casa`, `flyer-beleza`, `flyer-tech`; Tech is also the fallback): masthead band, follow block, the follow button text on white. Picked by matching "casa" or "beleza" in the niche name.

#### Neutral
- **Flyer Paper** (`flyer-paper`): page, card backgrounds. **Photo Bed** (`flyer-photo-bed`): behind product photos while they load; skeleton uses `#ececec`.
- **Ink** (`flyer-ink`): all text, focus outlines, the 2 to 3px rules. **Soft Ink** (`flyer-ink-soft`): strip, was-price, source labels, footer, assurance line.
- **Cut Line Grey** (`flyer-dots`): the 2px dotted lines between grid cells.

### Named Rules
**The Plates Only Rule (panel).** Colour on the panel lives inside plates (product photos, slides) and nowhere else. Paper, ink, fade and the counter greys carry every surface, text and state.
**The Two Stamps Rule (panel).** Blue means approve or focus; red means return or failure. A stamp ink never decorates, never marks a category, and never appears as a wash or tint behind text.
**The Two Inks Rule (flyer).** Prices and actions are red; the starburst and tag are yellow; the masthead is the niche color. Black and its soft grey carry everything else. No fourth chromatic color exists on the flyer.
**The No Crossover Rule.** The thermal palette, the stamp inks, Martian Mono and the Content Factory name never appear on `/n/:slug`; encarte yellow, encarte red, Anton and Barlow never appear on the panel. The two reds are different inks on purpose (`stamp-red` is the panel's, `flyer-red` the flyer's).

## Typography

**Panel Font:** Martian Mono, self-hosted variable (weight 400 to 800, width 75 to 112.5%), fallback ui-monospace, SFMono-Regular, Menlo, Consolas. Root width 87.5%, tabular and slashed-zero numerals, no synthesis.
**Flyer Display / Price Font:** Anton (fallback Arial Narrow, Impact).
**Flyer Label Font:** Barlow Condensed 600, 700, 800 (fallback Arial Narrow).
**Flyer Body Font:** Barlow 400 to 700 (fallback Helvetica Neue, Arial). Flyer faces are injected at runtime by the storefront component only.

**Character:** The panel is a receipt printer's one face at its three print sizes: Fonte A for everything you read, Fonte B for compact labels, Dupla (double height, condensed to 75%) for titles, counts and totals. Emphasis comes from weight (700 for names and values, 800 for headers and buttons), caps with 0.04 to 0.08em tracking, and the inverse band. The flyer is a poster: Anton for anything that shouts (niche word, prices, section heads), condensed caps with wide tracking for every label and stamp, Barlow at ease for product titles and the fine print.

### Hierarchy (panel)
- **Dupla** (800, 1.875rem, 1, -0.02em, width 75%, uppercase): section title (`h1` over the date line), the wordmark on the front door and in the top bar at 760px+, stage counts, measure totals, the seal word. The top-bar wordmark under 760px is the same cut at 1.25rem.
- **Fonte A** (400 to 800, 0.9375rem, 1.45; captions 1.6 at 62ch): body, line-item titles (700, clamped to 2 lines), ticket title (800, clamped to 2 lines), section heads (`h2`, 800, uppercase, 0.04em), field values, buttons (800, uppercase, 0.06em).
- **Fonte B** (700, 0.75rem, 0.04em, uppercase): stage names, tags, meta lines (400 with 700 ink strongs), fact terms, measure captions, small buttons, toggles, the nav on desktop, hints, the fine print, the seal's time line.
- **Tab label** (700, 0.625rem, 0.02em, width 75%, uppercase): the mobile tab bar label and its pending count only. The one size below Fonte B, forced by seven tabs at 320px.

### Hierarchy (flyer)
- **Display** (Anton 400, 2.6rem mobile / 3.4rem at 720px, 0.95, uppercase): the niche word in the masthead. Brand prefix above it: Barlow Condensed 700, 0.8rem, 0.18em tracking, uppercase, 92% opacity.
- **Price** (Anton 400, `clamp(1.5rem, 9vw, 3.1rem)` in the starburst, 1.25rem in the grid tag, tabular, no wrap): the number is the largest thing after the niche word.
- **Headline** (Anton 400, 1.5rem / 2rem at 900px, uppercase, followed by a 3px black rule): "Mais achados"; follow block title 1.7rem; state titles 2rem.
- **Title** (Barlow 600, 1.35rem / 2rem at 900px, 1.15, clamped to 3 lines, `text-wrap: pretty`): the cover product name. Grid card titles: Barlow 500, 0.9rem, clamped to 2 lines.
- **Body** (Barlow 400 to 500, 0.8 to 1rem, 1.3 to 1.4): assurance line, follow copy, footer.
- **Label** (Barlow Condensed 700, 0.7 to 0.85rem, 0.06 to 0.12em tracking, uppercase): strip, flag, stamp, was-price label, source lines, all buttons. CTA label is 1.05rem.

### Named Rules
**The Three Print Sizes Rule (panel).** Fonte B, Fonte A, Dupla. A new size is a new printer; reach for weight, caps or the inverse band instead. The mobile tab label is the single recorded exception.
**The Shout Once Rule (flyer).** Anton carries the niche word, prices and section heads; it is never used for running text or buttons. Buttons and stamps are always condensed caps.

## Layout

**Panel.** A `100svh` grid on the graphite counter: a 56px sticky top bar (`counter-2`, counter-line bottom) over the body. The main column (max 1320px, centered) holds the roll: paper with `18px 14px 28px` padding, a 6px `counter-2` printer slot at the top and the serrated edge hanging below. Under 1024px the roll runs full width with an 8px counter margin each side, the seven sections live in a fixed bottom tab bar (58px tabs, safe-area padded) and the main column pads `calc(86px + safe-area)` below. At 760px the top bar pads 20px and shows the user email, the main column pads 20px, the roll `22px 24px`, the stage strip stops scrolling and divides the width, `.two-col` becomes `1fr | 340px`, measures go two across with a 32px gutter, and bars become `label | bar | value` (1.4fr, 3fr, 6ch). At 1024px the body becomes `216px | 1fr`: the nav is printed on the counter (sticky at 56px, `22px 0 22px 14px`), the tab bar disappears, the roll pads `26px 32px 40px`, and when a ticket is open the roll yields 464px on the right for it. Under 640px a line item with actions drops its end column to a full-width second line.

Rhythm inside components is 2/4/6/8/10/12 (tag padding `2px 7px`, line items `12px 6px`, field `10px 12px`, gaps 6 to 12px); between blocks 14 to 22px (title 16px below its double rule, stage strip 18 to 20px, section heads 22px above). Line items are `56px | 1fr | auto` with 12px gaps; text-only items drop the plate column.

**Front door.** Sign-in, invitation and errors are one ticket (max 400px, `28px 24px` plus the edge) centered on the counter with 32px 12px page padding.

**Flyer.** One centered column, max width 1180px, 16px side padding. Mobile: masthead band (padding 14px top, 12px bottom), strip, cover deal stacked (photo 4:5 full width, then title, price, CTA), then a 2-column grid, follow block, footer. At 420px the follow button gains its full label. At 720px the grid is 3 across with `18px 14px 20px` cell padding. At 900px the cover deal becomes `5fr | 6fr` with 40px gap, the CTA shrinks to inline (min 340px), the follow block becomes a row, section gaps grow to 40 to 48px. At 1040px the grid is 4 across. Cut lines: every cell has a 2px dotted bottom and right border; the last cell in each row drops its right border by `nth-child`.

## Elevation & Depth

Both worlds are flat. The panel conveys depth by material, not shadow: paper lies on the darker counter, the top bar and tab bar sit on a darker shade of the counter, and the open ticket lies beside the roll on the counter. All shadcn shadow tokens are zeroed. The only box-shadows are inset rings that draw the stamps' double border (`inset 0 0 0 2px` and `3px` in paper and stamp ink); they are line construction, not elevation. The approval seal sits over the ticket body on 82% paper so the print under it stays legible. Stacking: top bar and tab bar `z-index` 20, ticket 30, seal 5 inside the ticket. The flyer has no shadows, no gradients, no glass: depth is the starburst overlapping the photo's lower right, the flag sitting on the photo's top left, and the 3px black rule above the footer.

### Named Rules
**The Counter Rule (panel).** Paper on graphite is the only depth. No shadow, blur, glass or gradient lifts anything; a surface that must stand apart is torn off and laid on the counter.
**The Paper Rule (flyer).** Product photos sit on white (or the photo bed while loading) with no shadow, no border, no radius.

## Shapes

**Panel:** zero radius everywhere (every shadcn radius token is 0). Form is made of rules: 1px dashed `ink` for cut lines around items, sections, slips and forms; 1px dashed `rule` between line items; 3px double `ink` under every header, the ticket head and the measures block; 3px double `stamp-red` for failure; 2px dotted `rule` for dot leaders. The **serrated edge** is a 7px (`edge`) zigzag of paper: drawn under the roll and under the desktop ticket as a conic-gradient strip hung below the paper (so nothing inside is masked), and cut into the bottom of the front-door ticket with a CSS mask. **Crop marks** register every plate: 8px corner ticks on 56px (44px for earlier versions) 4:5 thumbs, 12px ticks around each slide, drawn in `currentColor` so they invert with the open line item. Slides follow the channel ratio (4:5 default, 9:16, 16:9). **Flyer:** zero radius everywhere. The starburst is an authored 20-point SVG polygon (radii 50/41) in yellow, sized 44% of the photo width (max 280px), origin 60% 60%. The stamp is a 2px red outline rotated -1.5deg. Buttons are solid or 2px-outlined rectangles.

## Components

### Content Factory panel

#### Buttons (`.btn`)
- **Shape:** square, 46px, `0 16px`, Fonte A 800 caps at 0.06em, 18px icons, 8px gap; `.btn-sm` 36px, `0 10px`, Fonte B. Active `translateY(1px)`.
- **Primary (inverse band):** ink ground, paper text; hover `ink-hover`.
- **Outline:** transparent with a 1px ink stroke; hover `paper-2`.
- **Danger:** `stamp-red` text in a 2px red border with an inset paper gap and 1px red inner ring (the stamp double border); hover fills red with paper text.
- **Disabled:** not faded but reprinted: 1px dashed `rule`, `fade` text, no fill, `not-allowed` cursor. `aria-busy` shows the wait cursor.
- **Icon button** (ticket head back): 40px square, 1px ink stroke; hover inverts.
- **Front door:** full-width 50px inverse band, 700 caps; hover turns stamp blue. `.secondary-button` is a 40px transparent outline in `currentColor`.
- **Focus:** 2px `stamp` outline, 2px offset, on every focusable.

#### Stamps (ticket foot)
- **APROVAR:** `stamp` fill, paper text, 2px stamp border with a 1px paper inner ring; hover `stamp-deep`. Right column of the two-column foot.
- **DEVOLVER:** paper with `stamp-red` text and the red double border; hover fills red. Left column. Choosing rejection reasons is its first step.
- The foot is `1fr 1fr`, 10px gap, dashed ink top rule, safe-area padded; the note field and the reasons fieldset span both columns.

#### Printed fields
- `field` fill, 1px `input` stroke on three sides and a 2px `ink` baseline, 0 radius, 46px, `10px 12px`; hover turns the whole stroke ink. Labels are 700 (caps on the front door) stacked 6px above. Placeholder in a mid fade. Textareas 96px in forms, 72px for the ticket note. Top-bar workspace select: 36px on the counter, Fonte B 600 caps condensed, counter-line stroke, chevron at right 10px.

#### Stage strip (`.stage-rail` > `.stage`)
- Five printed cells sharing their borders (-1px overlap): 108px min, 64px tall, `8px 12px`, Fonte B stage name over a Dupla count, 1px dashed ink. Scrolls under 760px with hidden scrollbar; divides the width above.
- Hover `paper-2`. Current (`aria-current="true"`): inverse band with a solid border.
- Tick: a changed count scales to 1.18 from the bottom left over 200ms on the feed ease; JS clears it at 220ms.

#### Line items (`.rows` > `.row`)
- A list opened by a 1px dashed ink rule, each item closed by a 1px dashed `rule`; each item a `56px | 1fr | auto` button, `12px 6px`.
- Plate: crop-marked 56px 4:5 thumb; placeholder shows a faded icon. Title Fonte A 700 clamped to 2 lines; meta Fonte B in `fade` with 700 ink strongs (handle, price); end column right-aligned tags and small actions.
- Hover `paper-2`. Open (`aria-pressed="true"`): the inverse band; meta, tags and crop marks flip to paper.
- **Failed packages:** printed inside a 3px double `stamp-red` frame with a red section head and red opening rule, above the roll's items.

#### State tags (`.chip`)
- Fonte B 700 caps, 24px, `2px 7px`, 0 radius, 13px icons. State is the line form, never hue alone:
- `review` (needs you): inverse band, solid. `ok` (done): solid 1px ink border with a drawn check. `wait`: dashed ink border. `bad` (failed): 3px double `stamp-red`, red text. `quiet`: no border, `fade` text, no side padding. Default: dashed.
- Notices (`.alert-line`) reuse the same grammar at Fonte A with `10px 12px`: solid ink by default, dashed for wait, red double and 700 for bad, `rule` border and `fade` text for quiet.

#### The ticket (`.inspector`)
- The open package, torn off the roll. Mobile: fixed full-screen paper slip, `auto | 1fr | auto` rows, enters with `slip-up` (32px rise and fade, 260ms). Desktop (1024px): fixed 440px on the counter beside the roll, top 78px, bottom 30px, right edge aligned to the main column, serrated edge below, enters with `slip-left` (24px and fade, 280ms).
- Head: 56px min, back icon button, Fonte A 800 title clamped to 2 lines, state tag, 3px double ink rule below. Body: scrolls, `14px 14px 24px`. Foot: the two stamps.
- Body: phone toggle, crop-marked slides strip (snap-x; `min(74vw, 300px)` at 4:5, `min(58vw, 220px)` at 9:16, `min(86vw, 420px)` at 16:9; 200/160/380px on desktop), dot-leader facts, the caption between dashed cut lines (62ch, 1.6, pre-wrap), the plan.
- **Facts** (`.facts`): term in Fonte B caps `fade`, a 2px dotted `rule` leader filling the gap, value 700 right-aligned (max 34ch). Links inside are ink 700 underlined at 3px offset.

#### Review tools
- **Rejection reasons:** a borderless fieldset with an 800 caps legend and a wrap of 34px dashed small buttons; pressed fills `stamp-red` with paper text.
- **Scene reject:** a full-width 34px dashed ink select under each slide, Fonte B caps; disabled at 0.5 opacity.
- **Phone preview** (`.phone-toggle` + `.slides.phone`): a 34px dashed Fonte B toggle; pressed is the inverse band. Phone mode sizes each slide to `min(390px, 100vw - 48px)` and hatches the 9:16 Story UI bands (top 14%, bottom 20%) with a -45deg black stripe at 42/30% so the reviewer sees what the platform chrome covers.
- **Plan** (`details` > `.plan`): a dashed-underlined summary opening a 22px-indented ordered list of scene line, voice line and `.versions` (44px crop-marked thumbs of earlier attempts carrying the attempt number and rejection reasons).

#### Navigation
- **Top bar:** on the counter: "SELETO HUB" printed wordmark (800, width 75%, caps; 1.25rem, Dupla at 760px+), workspace select pushed right, user email in Fonte B counter-fade (760px+), "SAIR" 36px counter-line outline in Fonte B caps.
- **Desktop nav (1024px):** items printed on the counter, 42px, `0 14px 0 10px`, 17px Lucide icons, Fonte B caps in `counter-fade`, a 2px dotted counter-line leader running to the pending count at the right. The current section is a paper tab joined to the roll (`margin-right: -1px`), ink text, rule-colored leader.
- **Mobile tab bar:** three equal tabs (Aprovar, Links, Contas) on `counter-2`, 58px, 20px icon over the tab label; current tab is paper with ink text; the pending count is a 16px paper block at top right (inverted on the current tab).

#### Measures and bars (Resultados)
- `.measures`: totals as printed lines: Fonte B caps caption, 2px dotted leader, Dupla total; dashed `rule` between, 3px double ink rule below the block. Two columns at 760px.
- `.bar`: inside a dashed `.rows` list; label 700, value 800, a 12px solid ink bar (3px min).

#### Slips and forms
- `.desk-form`: a fill-in slip between dashed ink rules, `16px 0`, 14px gap, max 560px; labels 700; actions right-aligned with 8px gap; hints Fonte B `fade`.
- `.slip` (Integrações): one section per provider closed by a dashed ink rule. `.copy-line`: a value to copy on one unbroken dashed-framed line with the copy button behind a dashed divider.
- `.setup-strip`: a dashed ink slip, `10px 12px`, `fade` text with ink 800 caps strong and an ink underlined link. `.setup`: dashed list; done steps fade and strike through.

#### Empty and loading
- `.empty`: a dashed ink slip, `28px 16px`, centered, Fonte A heading flanked by receipt asterisks in `fade`, copy at 46ch.
- `.skeleton`: faint printed dashes (`rule` 6px on, 4px off) blinking in 4 steps over 1.1s.

#### Front door (`.page-shell` > `.card`)
- One paper ticket on the counter, max 400px, serrated bottom edge, feeding in top-down over 420ms. Dupla wordmark centered over a 3px double rule; uppercase Fonte A heading; the form opens with a dashed `rule`; notices in a 3px double `currentColor` frame (red for errors); fine print in Fonte B caps `fade` under a dashed rule; empty state a dashed ink slip.

#### Signature motion
All on `--ease-feed` `cubic-bezier(0.16, 1, 0.3, 1)` unless stated, and all off under `prefers-reduced-motion: reduce`.
- **Feed:** every direct child of the roll prints in top-down (`clip-path` inset from 100% to 0) over 360ms with backwards fill only, so no clip-path is left behind; the front-door ticket feeds over 420ms.
- **Seal thud:** on approve or return the seal (3px border plus a 1px outline at 3px offset, Dupla word "APROVADO"/"DEVOLVIDO" over a Fonte B time) drops onto the ticket from `scale(1.5) rotate(-12deg)` and transparent to rest at -7deg (approve, blue) or 5deg (return, red) over 240ms. JS holds it 520ms.
- **Tear-off:** the line item leaves upward (`translateY(-16px)`, opacity 0) over 200ms; JS waits 200ms, then clears the seal.
- **Reprint:** an approved item appears in Aprovado clipped top-down in 8 steps over 360ms (`steps(8, end)`); the flag clears at 950ms.

### Example Shop flyer

#### Masthead (`.sf-bar`)
- Niche-color band, white text. Brand prefix small condensed caps over the niche word in Anton. "Seguir no Instagram" is a 40px white 2px-outlined rectangle at the right (label shortens to "Seguir" under 420px); hover inverts to white fill with niche-color text.
- Strip below: 2px black rule, condensed caps 0.75rem 0.12em soft ink, "Achados do Mercado Livre" left, count right.

#### Cover deal (`.sf-hero`)
- Photo link 4:5 on photo bed, `overflow: hidden`, with the red flag "Achado da semana" at top left (`6px 12px 5px`) and the starburst at bottom right (8px inset).
- Starburst: yellow SVG, inner text "só"/"por" in condensed 0.7rem ink caps over the price in red Anton, 14% side padding. Stamp-on motion: from `scale(1.14) rotate(-4deg)` and opacity 0 to rest, 260ms `cubic-bezier(0.2, 0.9, 0.3, 1)`, 120ms delay, once, only under `prefers-reduced-motion: no-preference`.
- Price block: optional "preço cheio" label with the struck list price (condensed 600, 1.2rem, soft ink, 2px strike), then the stamp: 2px red outline, red condensed caps 0.75rem 0.1em, `5px 8px 4px`, rotated -1.5deg, reading "conferido no Mercado Livre em DD/MM às HHh" in Brasília time. No price: a condensed uppercase line "Veja o preço de agora no Mercado Livre."
- Red block CTA: full width, 58px, red, white condensed caps 1.05rem 0.08em, 20px bag icon; hover red-deep; active `scale(0.98)` over 120ms. Assurance line under it in Barlow 500 0.85rem soft ink.

#### Flyer grid (`.sf-grid` > `.sf-card`)
- Each cell a full-height column link: 4:5 photo (hover zoom 1.03 over 160ms), Barlow 500 0.9rem title (2 lines), price tag, source line, and a bottom-pinned card button.
- Price tag: yellow block, Anton 1.25rem red, struck list price in condensed 0.75rem ink beside it. Source line: condensed 600 0.7rem 0.06em soft ink, deliberately broken into two lines before "em". No price: "preço não conferido" in the same condensed caps.
- Card button: 40px, 2px red outline, red condensed caps 0.8rem; on card hover fills red with white text.

#### Follow block and foot
- `.sf-follow`: niche-color block, `22px 18px` (28px 32px at 900px), Anton 1.7rem title, handle, white button with niche-color text at 48px.
- `.sf-foot`: 3px black rule, Barlow 500 0.8rem soft ink, affiliate and price disclaimers, max 46rem.

#### States
- Loading: masthead band with a 25% white bar, hero photo bed skeleton, four grid cells. Not found / error / empty: Anton 2rem uppercase title, soft ink copy, inline red CTA when there is a handle.
- Focus: 3px ink outline, 2px offset.

## Do's and Don'ts

### Do:
- **Do** build every panel section from the printer's vocabulary (`.desk-title`, `.stage-rail`, `.rows`, `.chip`, `.inspector`, `.facts`, `.desk-form`, `.slip`, `.btn`, `.measures`, `.bar`, `.empty`) before adding a class.
- **Do** carry panel state by line form: inverse needs you, solid is done, dashed is waiting, red double has failed. Hue alone never encodes a state.
- **Do** keep the stamp inks for their two meanings: `stamp` approves and focuses, `stamp-red` returns and fails.
- **Do** register every plate with crop marks and keep colour inside plates.
- **Do** print every header in Dupla over a 3px double ink rule with its date line, and separate items with dashed cut lines.
- **Do** keep panel motion to the printer's verbs (feed, thud, tear, reprint) on `cubic-bezier(0.16, 1, 0.3, 1)` or stepped timing, and off under `prefers-reduced-motion`.
- **Do** show a price with its verification date on both surfaces, and show absence ("preço não conferido") rather than a placeholder.
- **Do** give every interactive element a visible focus outline (2px `stamp` blue on the panel, 3px ink on the flyer) and 34px or taller touch targets (46px for primary actions).
- **Do** keep the flyer square-cornered, shadowless, and limited to black, soft grey, yellow, red and the one niche color.
- **Do** pick the flyer's niche color from the niche name (`casa`, `beleza`, otherwise Tech blue) and pass it as `--accent`.
- **Do** keep per-item review controls (scene reject, reason toggles, phone toggle) dashed and Fonte B, below the work. The ticket foot owns the stamps.
- **Do** preview Stories at phone width with the platform UI bands hatched before approving.

### Don't:
- **Don't** put the Content Factory name, Martian Mono, the thermal palette or the stamp inks on `/n/:slug`, and don't put encarte yellow, encarte red, Anton or Barlow on the panel.
- **Don't** add a fourth print size to the panel; use weight, caps, Dupla or the inverse band.
- **Don't** add radius, drop shadows, gradients or glass to panel surfaces; depth is paper on the counter.
- **Don't** tint panel surfaces or tags with a hue, or use a stamp ink as decoration or a category color.
- **Don't** nest boxed cards on the panel or build KPI-card-plus-table dashboards; results are dot-leader totals and bars inside a cut-line list.
- **Don't** add rounded corners, gradients, glass, or photo drop shadows to the flyer.
- **Don't** use Anton for running text or buttons on the flyer; labels and buttons are Barlow Condensed caps.
- **Don't** invent a price, discount or earnings figure to fill a starburst, tag, total, bar or line item.
