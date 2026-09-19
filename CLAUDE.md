# sb-entity-browser — session notes

HACS **dashboard card** (category: plugin/Dashboard): pattern-matched entity list
with interactive state-filter chips and an opt-in F12-style diagnostics mode.
Design brief (2026-09-18): all setup visual, NO helper entities (filter state is
card-local, localStorage per `storage_id`), multi-domain globs + labels,
state chips w/ counts (numeric → min/max range), configurable secondary info,
tap actions. Polish is the goal; diagnostics is a per-card opt-in mode.

| | |
|---|---|
| Repo | https://github.com/snadboy/sb-entity-browser — local `~/projects/git/sb-entity-browser` |
| Card | `custom:sb-entity-browser` (+ `sb-entity-browser-editor`) |
| File | `dist/sb-entity-browser.js` — **vanilla JS, no build step**; hand-edit, bump VERSION const + release |
| Install | HACS custom repo, category Dashboard; resource auto-registered at `/hacsfiles/sb-entity-browser/sb-entity-browser.js` |

## Architecture notes

- Vanilla custom element, full innerHTML re-render, event delegation after render.
  Change gate: re-render at most every 2s unless the matched set's signature
  (id|state|last_updated) changed.
- Editor is `ha-form` with selector schema (text multiple for globs, `label`
  selector, `ui_action` selector) — zero custom form code.
- Icons via `ha-state-icon` (`.hass` + `.stateObj`) — HA-registered element.
- Numeric mode heuristic: all non-unavailable states parse as float AND >8
  distinct values → min/max inputs instead of chips.
- List capped at 100 rows in normal mode; diagnostics shows all.
- Tap actions implemented manually (more-info via `hass-more-info` event,
  navigate via pushState + `location-changed`, perform-action via callService)
  — not `handleAction` helpers, to stay dependency-free.

## Release flow

Bump `VERSION` in dist/sb-entity-browser.js, commit, tag `vX.Y.Z`, GitHub
release. HACS: update_information → download (users: Update in HACS), then
**hard-refresh the browser** (cards are cached aggressively; HACS appends
`?hacstag=` but a Ctrl-F5 after update is the reliable path).

## Status

- [x] v0.1.0 released 2026-09-18; installed via HACS (repo id 1376132759), resource auto-registered
- [x] v0.1.1: numeric mode engages on mixed sets (>=8 numeric entities, >8 distinct values) —
      range inputs gate numeric rows, chips gate text rows side by side. Verified headless on
      the Card Lab view (dashboard-monitor/card-lab, 2 test cards: switch.* chips mode,
      sensor.*_battery* mixed mode); zero console errors from the card.
- [x] v0.2.0: implied leading/trailing wildcards ("battery" = *battery*; blank patterns match
      nothing); live per-pattern match counts in the editor + diag note; matching = OR within a
      category, AND across configured categories (patterns ∧ labels ∧ areas — areas new);
      perform-action with an empty/blank target acts on the clicked row's entity. Lab Batteries
      card now uses bare "battery" pattern (verified headless: minmax=2, chips=10).
- [x] v0.2.1/v0.3.0: match counts moved into the editor — first as the patterns helper line,
      then (v0.3.0) as CUSTOM pattern rows: one ha-textfield per pattern with its live count as
      that field's helper, per-row delete, add button. Rows rebuild only on add/delete (rebuilding
      per keystroke steals focus — the reason ha-form's text-multiple couldn't do this: one helper
      per FIELD GROUP only). `list_rows` option: visible-row cap via max-height (~3.3em/row) +
      overflow-y scroll; render cap 100 → 500 when set. Verified headless (154 switch rows in a
      33em scroller).
- Areas picker stays HA's native `area` selector (looks different from the labels chip-adder —
  that's upstream's widget inconsistency). Owner decided 2026-09-18: LEAVE AS IS; don't swap it
  for a chips-style select selector unless asked.
- [x] v0.3.1: pattern inputs are plain <input>s — bare `ha-textfield` outside ha-form is a TRAP
      (lazily defined + pre-upgrade property sets get shadowed → renders invisible). list_rows
      defaults to 10 (0 = no limit); scroll height measured from the first rendered row post-rAF
      (em estimates were off). Verified: cards clamp at exactly rows×measured px; editor
      instantiated headless shows visible inputs + per-pattern counts.
- [x] v0.3.2 PERF (user hit frozen Save): `set hass` fires on EVERY system state change — the
      old gate re-rendered unconditionally after 2s, so broad patterns = full 500-row rebuild
      per tick = saturated main thread = Save click never processed. Now: render only when the
      matched set's rolling-hash signature changes, coalesced to 1/s; editor debounces
      config-changed 250ms (per-keystroke preview rebuilds); count refresh throttled 2s on hass
      ticks. LESSON for any list card: gate on change AND throttle, never either alone.
- [x] v0.4.0 sort_dir (asc/desc; last_changed asc = oldest first — was implicitly newest-first).
- [x] v0.5.0 word queries + URL override: spaced pattern = word query over id AND friendly_name
      (any order, case-insensitive, tokens keep */?; spaceless = id-only glob, unchanged);
      `?seb-<storage_id>=<pattern>` overrides configured patterns at view time (labels/areas
      still AND), card shows "URL filter" note + tap-to-clear, follows location-changed/popstate.
      Card Lab: 2 Bubble buttons (FP300/LWR02 Occupancy) deep-link the lab-occ card; verified
      headless (15 FP300 rows w/ param + note, 30 without).
- Card Lab view (dashboard-monitor/card-lab) is the card's permanent demo/test home for now —
  owner reviewed v0.5.0 and said to LEAVE the buttons + Occupancy/Switches/Batteries cards there
  (2026-09-18); don't promote or clean up without asking.
- [x] v0.6.0 "implement all": Jinja secondary_template — one render_template WS subscription
      per row IN THE DOM (filtered/capped/uncollapsed), diffed 300ms after each render, torn down
      on filter-out/disconnect; `entity_id` variable. Numeric buckets (thresholds "20, 50" →
      range chips w/ counts, _bsel persisted). group_by area/domain (collapsible, _coll
      persisted). state_style pill + ACTIVE-state accent coloring. density compact. Header
      shown/matched count. show_search box (word-query; hass renders SKIPPED while focused,
      focus restored across re-renders). 60s relative-time tick. Fade-in only on filter
      interactions (this._animate flag — constant fade would flicker on live updates).
      Verified headless: groups+pills+search+jinja models on Occupancy, bucket chips + 344
      compact pill rows on Batteries, zero page errors.
- [x] v0.6.1 grouping: group_by gains floor (area.floor_id → hass.floors) and state; header
      collapse-all/expand-all fold buttons when grouping active (verified headless: 30 rows →
      0 → 30; collapsed groups also drop their jinja subs since they leave the DOM).
- Test rig: scratchpad render_test.js (playwright-core + ~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome,
  hassTokens localStorage recipe); walks shadow roots counting cards/chips/rows.
- Roadmap: Jinja secondary info (WS render_template subscription per row —
  budget it), numeric bucket presets, group-by domain/area.
