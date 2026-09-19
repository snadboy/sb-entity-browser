# SB Entity Browser

A Home Assistant dashboard card: a pattern-matched entity list with an
**interactive state filter** at the top — chips with live counts (or a min/max
range when the entities are numeric) — and an opt-in **F12-style diagnostics
mode**. Everything is configured in the visual editor; the card creates **no
helper entities**: the viewer's filter selection is card-local UI state,
persisted per browser.

## Features

- **Entity matching** by patterns, **labels**, and **areas** — any mix of
  domains. A pattern without spaces is a substring glob on the entity id with
  implied wildcards (`battery` means `*battery*`; explicit `*`/`?` work too).
  A pattern **with spaces is a word query**, HA target-picker style: every
  word must match the entity id *or the friendly name*, in any order —
  `fp300 occupancy` and `occupancy fp300` find the same entities. Within a
  category any entry matches; across categories every configured one must be
  satisfied — so patterns + an area means "these entities, in that area".
  Each pattern field in the editor shows its own live match count.
- **URL override**: `?seb-<storage_id>=<pattern>` replaces the card's
  configured patterns for that page view (labels/areas still constrain);
  spaces URL-encode as `%20` or `+`. The card shows a "URL filter" note with
  a tap-to-clear. Great for buttons that deep-link one browser card to
  different searches — no helper entities involved.
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
| `secondary_template` | Jinja secondary line, rendered live for VISIBLE rows only; `entity_id` = the row's entity |
| `group_by` | `none`, `floor`, `area`, `state`, or `domain` — collapsible section headers with per-card collapse/expand-all buttons |
| `density` | `comfortable` (two lines) or `compact` (one line) |
| `state_style` | `text` or `pill` (tinted badge; active states accent-colored, unavailable red) |
| `buckets` | Comma-separated thresholds for numeric sets (`20, 50` → chips `<20 · 20–50 · >50`) |
| `show_search` | Word-query search box on the card (ids + friendly names) |
| `sort` | `name`, `state`, or `last_changed` |
| `sort_dir` | `asc` (default) or `desc` |
| `list_rows` | Max visible rows; the list scrolls beyond this (empty = no cap) |
| `tap_action` | Standard HA action |
| `diagnostics_button` | Show the F12-style toggle |
| `storage_id` | Key for the per-browser filter persistence (auto-generated) |

## Roadmap

- Jinja templates for secondary info (server-rendered, live)
- Numeric bucket presets ("< 20%", "20–50%", …)
- Group-by (domain / area)

## License

MIT
