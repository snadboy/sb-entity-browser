# SB Entity Browser

A Home Assistant dashboard card: a pattern-matched entity list with an
**interactive state filter** at the top — chips with live counts (or a min/max
range when the entities are numeric) — and an opt-in **F12-style diagnostics
mode**. Everything is configured in the visual editor; the card creates **no
helper entities**: the viewer's filter selection is card-local UI state,
persisted per browser.

## Features

- **Entity matching** by patterns, **labels**, and **areas** — any mix of
  domains. Every pattern word matches case-insensitively as a substring of
  the entity id *or the friendly name* (implied wildcards: `battery` means
  `*battery*`; explicit `*`/`?` work too), or as an **exact match of the
  current state** — `CR2450` finds the sensors reporting CR2450. Words
  combine in any order: `fp300 occupancy` ≡ `occupancy fp300`. Within a
  category any entry matches; across categories every configured one must be
  satisfied — so patterns + an area means "these entities, in that area".
  Each pattern field in the editor shows its own live match count.
- **Patterns are the card's identity, and words within a pattern are ANDed.**
  "fp300 occupancy" matches entities whose id or name carries both words.
  That is also how a dropdown narrows a browser: wrap it in an
  [SB Param Card](https://github.com/snadboy/sb-param-card) and write its
  parameter *inside* a pattern — `patterns: ["fp300 $q$"]` — so the base word
  stays fixed, the chosen word is added, and an empty choice collapses back to
  the base. (Areas and labels are pickers; drive those with the Param Card's
  *apply to field* instead.) The on-card search box narrows on top of all of
  it.
- **State chips with counts** at the top of the card; tap to filter the list.
  Multi-select, `unavailable`/`unknown` always surface as their own chips.
  When the matched set is numeric (temperatures, batteries), the chips become
  a **min–max range** instead.
- **Secondary info per row**: any of state, area, device, entity ID, device
  class, last changed, last updated.
- **Tap actions**: more-info (default), navigate, URL, perform action, none.
  A perform-action with an empty target acts on the clicked row's entity.
- **Diagnostics button** (optional, per card): a stethoscope icon that flips
  the card into inspector mode — entity IDs and update stamps on every row,
  unavailable entities first, match counts in the header. Like F12 for your
  dashboard: the polished list is the default face, diagnostics is a mode.
- Filter selection, range, and diagnostics state persist **per browser**
  (localStorage keyed by the card's `storage_id`) — two cards, two dashboards,
  two devices never couple, because there is no shared entity behind it.

## Editing

The editor is a read-only overview of three groups — **Matching** (with a live
"matches now" count), **Display**, **Controls** — each with an *Edit* button
that opens one focused dialog. Edits apply live to the preview; *Cancel*
restores.

## Installation (HACS)

1. HACS → custom repositories → `snadboy/sb-entity-browser`, category **Dashboard**.
2. Install, refresh the browser.
3. Add card → search "SB Entity Browser". Configure visually.

## Configuration

All options are in the visual editor. For reference:

| Option | Meaning |
|---|---|
| `title` | Card title |
| `patterns` | Entity-id substring globs, implied `*…*` |
| `labels` | Entities must also carry one of these labels |
| `areas` | Entities must also be in one of these areas |
| `secondary` | Row secondary-info fields, joined with `·` |
| `secondary_template` | Jinja secondary line, rendered live only for rows **on screen** (IntersectionObserver; subscriptions attach on scroll-in, release on scroll-out, hard cap 60) |
| `group_by` | `none`, `floor`, `area`, `state`, `domain`, or `label` (an entity with several labels, its own or its device's, is listed under each; when the card is filtered by `labels`, only those labels form groups) — collapsible section headers with per-card collapse/expand-all buttons |
| `density` | `comfortable` (two lines) or `compact` (one line) |
| `state_style` | `text` or `pill` (tinted badge; active states accent-colored, unavailable red) |
| `buckets` | Comma-separated thresholds for numeric sets (`20, 50` → chips `<20 · 20–50 · >50`) |
| `show_search` | Word-query search box on the card (ids + friendly names) |
| `show_group_selector` | Group-by dropdown in the card header; the viewer's choice persists per browser and overrides `group_by` |
| `sort` | `name`, `state`, or `last_changed` |
| `sort_dir` | `asc` (default) or `desc` |
| `list_rows` | Hard on-screen limit (3–50, default 10): the list shows this many rows and scrolls for the rest |
| `tap_action` | Standard HA action |
| `diagnostics_button` | Show the F12-style toggle |
| `storage_id` | Key for the per-browser filter persistence (auto-generated) |

## Roadmap

- Jinja templates for secondary info (server-rendered, live)
- Numeric bucket presets ("< 20%", "20–50%", …)
- Group-by (domain / area)

## License

MIT
