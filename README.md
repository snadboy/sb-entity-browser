# SB Entity Browser

A Home Assistant dashboard card: a pattern-matched entity list with an
**interactive state filter** at the top — chips with live counts (or a min/max
range when the entities are numeric) — and an opt-in **F12-style diagnostics
mode**. Everything is configured in the visual editor; the card creates **no
helper entities**: the viewer's filter selection is card-local UI state,
persisted per browser.

## Features

- **Entity matching** by patterns, **labels**, and **areas** — any mix of
  domains. Patterns are substring matches with implied wildcards (`battery`
  means `*battery*`; explicit `*`/`?` work too). Within a category any entry
  matches; across categories every configured one must be satisfied — so
  patterns + an area means "these entities, in that area". Each pattern field in the editor
  shows its own live match count directly beneath it.
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
