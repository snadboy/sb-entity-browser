# SB Entity Browser

A Home Assistant dashboard card: a pattern-matched entity list with an
**interactive state filter** at the top — chips with live counts (or a min/max
range when the entities are numeric) — and an opt-in **F12-style diagnostics
mode**. Everything is configured in the visual editor; the card creates **no
helper entities**: the viewer's filter selection is card-local UI state,
persisted per browser.

> **Requires the [SB Filter](https://github.com/snadboy/sb-filter) integration** (HACS → Integration, then *Settings → Add integration → SB Filter*). The card decides nothing about matching. It shows **one source**: SB Filter's selection (*which* entities — patterns, labels, areas, device class, unit; [FILTER.md](https://github.com/snadboy/sb-filter/blob/main/FILTER.md)), **or** an [SB Watch](https://github.com/snadboy/sb-watch) rule's active set (*which of them are in a given state* — "batteries under 20 %"). Never both. Without SB Filter the card shows an explanatory message instead of a list.
>
> **0.31.0:** the state options (`states`, `state_min`, `state_max`, `state_for`, `rate`, `rate_window`) moved to SB Watch. A card that still has one shows a notice instead of a list; the editor's Matching overview has a **Remove** button for them. "Save as SB Watch rule" is gone — make the rule in the SB Watch panel, then set `rule`.

## Features

- **Entity matching** by patterns, **labels**, and **areas** — any mix of
  domains. Every pattern word matches case-insensitively as a substring of
  the entity id *or the friendly name* (implied wildcards: `battery` means
  `*battery*`; explicit `*`/`?` work too). (The card's search box also
  matches an exact state — `CR2450` — but that only narrows what is shown.) Words
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
| `rule` | An SB Watch rule's Count sensor (`sensor.<rule>_count`): the card shows exactly what the rule holds **active** — after its durations, the list it notified about. The card's other source: picking a rule in the editor clears `patterns`/`labels`/`areas`/`device_classes`/`units`/`classes`, and editing any of those clears the rule |
| `patterns` | Entity-id substring globs, implied `*…*` |
| `labels` | Entities must also carry one of these labels |
| `areas` | Entities must also be in one of these areas |
| `device_classes` | Entities must carry one of these device classes (`battery, temperature`) — ANDed with the rest |
| `units` | Entities must have one of these units of measurement (`%`, `°F`, `W`), exact match |
| `classes` | Device class AND unit as pairs, ORed: `["battery:%", "temperature", ":°F"]` (YAML only) |
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
| **Collapse** | The chevron beside ⤢ hides the entries; the title, count and state chips stay, so a collapsed card still summarises its states |
| `group_bar` | `auto` / `states` / `power`: a stacked distribution bar on every group header. Power = each entity's share of the group's watts (its own reading, or its outlet's power sensor on the same device), total shown beside the bar; states = the share of each state. Every row carries a dot in its segment's colour. `auto` uses power where the group has any, else states |
| `fixed_size` | Keep the card as tall as `list_rows` even when fewer entities match, so neighbouring cards don't shift (any view) |
| **Layout rows** | In a sections view, give the card fixed rows in its **Layout** tab and it fills that cell, the list scrolling inside — also when wrapped in an SB Param Card |
| **Collapse** | The chevron in the header hides the entries (chips and list); remembered per browser |
| `popout` | The ⤢ button opens the same card full size in a dialog (same chips, search and grouping). `false` hides the button |
| `list_rows` | Hard on-screen limit (3–50, default 10): the list shows this many rows and scrolls for the rest |
| `tap_action` | Standard HA action for the row (more-info, toggle, navigate, url, perform-action, assist, none) |
| `icon_tap_action` | A separate action for the row's **icon**; the rest of the row keeps `tap_action`. A `toggle` only arms (pointer, hover ring) on rows whose domain registers a `toggle` service on your HA and whose state is known — elsewhere the icon click falls through to the row |
| `toggle_all_button` | Header button: toggles every toggleable row **currently on screen** (filters, chips, search all apply) after a confirmation that states how many go on → off and off → on and how many are skipped; then verifies each entity's state changed and names any that did not |
| `diagnostics_button` | Show the F12-style toggle |
| `storage_id` | Key for the per-browser filter persistence (auto-generated) |

## Roadmap

- Jinja templates for secondary info (server-rendered, live)
- Numeric bucket presets ("< 20%", "20–50%", …)
- Group-by (domain / area)

## License

MIT
