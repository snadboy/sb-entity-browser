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
- [x] v0.2.0: implied leading/trailing wildcards ("battery" = *battery*; ~~blank patterns match
      nothing~~ — STALE: since the `active === 0` logic a blank row is IGNORED, measured
      2026-09-21: `["", "occupancy"]` = `["occupancy"]` = 32, `[""]`+label = label alone; a
      lone blank row with nothing else used to pass validation and render all 4,000 — v0.10.3
      makes validation ignore blank rows so that case gets the "configure at least one" error
      instead); live per-pattern match counts in the editor + diag note; matching = OR within a
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
- [x] v0.6.2 show_group_selector: opt-in header dropdown; viewer's grouping choice persists per
      browser (localStorage `gsel`) and OVERRIDES cfg.group_by. Verified live switching
      area/state/floor on the lab Occupancy card.
- [x] v0.7.0-v0.7.3 hard on-screen limits (user req): list_rows ALWAYS in effect (invalid/0→10,
      min 3; the "0 = unlimited" escape hatch is gone); template subs scoped to rows ON SCREEN
      (geometry reconcile on render + scroll (150ms) + 5s sweep; 60-sub ceiling; failed subs
      just retry next sweep). Two hard-won lifecycle traps:
      * **HA renders cards DETACHED and re-attaches during layout** — any render-time arm that
        checks isConnected/geometry silently no-ops, and disconnectedCallback teardown kills
        timers with nothing restarting them. connectedCallback MUST re-arm (v0.7.3). A one-shot
        IntersectionObserver initial report is unusable for the same reason (v0.7.2 removed it).
      * **Manual deploys to /config/www/community MUST also replace the .gz sibling** — HA serves
        <file>.js.gz to any gzip-accepting client (all browsers); tee-ing only the .js means curl
        sees your change and every browser sees the old release. HACS download refreshes both.
      Also: BusyBox ls in the container shows UTC mtimes — "yesterday 19:32" may be "right now".
      Verified: fresh load 15 subs/11 jinja on-screen of 30 rendered; scroll reconciles 18/18.
- [x] v0.8.0/v0.9.0 (user's filter card "not working" + two-tier design): EVERY pattern token
      now matches case-insensitively vs id OR friendly name OR exact state ("CR2450" finds
      battery_type sensors by state; users type what they SEE). Then TWO FILTER TIERS: card
      config (patterns/labels/areas) = BASE, always applied, never overridable; URL param +
      search box = OPTIONAL, narrow-within-base (was: URL REPLACED patterns — a Batteries
      card could show humidity sensors). Replace-style still expressible via base pattern *.
      Verified: battery∧FP300=115, ∧CR2450=14, ∧TV=8; dual view filters intact.
- [x] v0.10.0 PERF (user: editor preview "took a very long time" after typing a pattern):
      the FIRST keystroke is the killer — "o" matches 3,792 of 3,991 entities (sensor./
      binary_sensor./on/off all contain it) → 500 rows. MEASURED on the live page: the sync
      render was only 44 ms, but ~1.2 s of long tasks followed, one per ~2.3 ms per row —
      500 `ha-state-icon` elements upgrading. And it compounds: with a broad pattern active the
      estate's churn changes the signature every tick, the card re-renders 1/s, each render
      costs >1 s, so the main thread never frees and the editor's next setConfig queues behind
      it (the v0.3.2 "frozen Save" mechanism through a different door — gate+throttle is not
      enough when ONE render exceeds the throttle interval). Fix: rows render a 24 px
      placeholder; `_reconcileIcons` creates `ha-state-icon` only for rows within the list's
      viewport ±80 px (the templates' geometry rule), after render, on scroll (150 ms), on
      re-attach, and on a 5 s sweep. Same probe after: "o" 227 ms long tasks (from 1,160),
      "oc" 0 (from 405), 11 icons instead of 500. Probe: scratchpad seb_perf.js — setConfig
      per intermediate pattern + PerformanceObserver longtask; measure, don't guess.
- [x] v0.10.1 (user's suggestion: "delay the new lookup 250–500 ms; if no new key arrives do the
      costly search"): ONE constant `TYPING_QUIET_MS = 400` (above a 150–350 ms typing rhythm)
      now gates every costly path — the editor's config-changed emit (was 250), the editor's
      per-pattern "Matches N" counts (were IMMEDIATE per keystroke: a full-estate scan per
      pattern row), the card's on-card search box (was 250), and NEW: the card coalesces a
      REPEATED `setConfig` (first config still renders at once; validation stays synchronous
      because HA relies on the throw) with `set hass` held off while the coalesce is pending —
      otherwise a state tick would render the half-typed pattern anyway. Measured headless:
      typing "occupancy" at 120 ms/key → 0 emits + 0 count refreshes while typing, 1 each after
      the pause; a 9-step setConfig burst → 0 renders during, 1 after, 0 long tasks.
      Harness: scratchpad seb_debounce.js (real editor instance + burst on the lab card).
      ⚠️ OPEN, pre-existing, cosmetic: that harness logs ONE `TypeError: Cannot read
      properties of undefined (reading 'localize')` at editor creation, stack entirely inside
      HA's bundles (`ha-form` formUpdate → a lazily-loaded selector chunk). Two hypotheses were
      MEASURED false: (1) forms appended before `hass` was set — fixed the ordering anyway, error
      unchanged; (2) `ha-form` undefined at creation → pre-upgrade property shadowing — no,
      ha-form is defined, upgraded, `hass` is a real accessor. What IS undefined at creation is
      `ha-selector-label`, which ha-form lazy-loads while rendering. NOT reproduced in HA's real
      edit dialog (not attempted headless); nothing in v0.10.x touches form creation. Stopped
      digging per the rabbit-hole rule; if it matters, drive the REAL dialog headless and watch
      the console.
- [x] v0.10.2 labels match through the DEVICE too. User removed every pattern and picked the
      label "Matter Hub" → "No entities match". Measured: the card was correct by HA's rules
      (no patterns = unconstrained, fine) — the label sat on 7 DEVICES and 0 entities, and HA
      does not propagate device labels to entities, while the card checked `hass.entities[id]
      .labels` only. Now an entity matches if it OR its device carries the label — the same
      fallback `entityAreaId` already does for areas. Helper text says so. Lesson: a label you
      applied "to the plug" in the device page is a device label; users expect its entities to
      count, and the registry shape doesn't tell them otherwise.
- [x] v0.11.0 states display as HA displays them (user: "FP300 Occupancy shows on/off, HA shows
      Occupancy/Detected"). Rows use `hass.formatEntityState(st)` — device class, language,
      numeric+unit in one call, same as built-in cards — via `fmtState`, a Map cache keyed
      entity|state|device_class|unit, CAPPED at 5000 (numeric sensors mint a key per reading)
      because matchInfo now runs it for the whole estate on every hass tick. The manual
      `state + unit` render is gone (formatEntityState includes the unit; "0%" no space is
      HA's own formatting). Chips are GROUPED BY THE DISPLAYED STATE — a first cut kept raw
      keys with a "label only when the whole group agrees" rule, and the user's own Occupancy
      card (FP300 sensors + occupancy lights, both raw on/off) fell straight into the mixed
      case and still read `on 14 · off 15`. Now it reads `Clear · On · Detected · Off`, and the
      Detected chip selects the sensors that read Detected, not every raw `on`. `_selected`
      holds display strings; the row filter accepts raw OR formatted so a selection persisted
      before v0.11.0 does not blank the list, and the next click rewrites it. State cell keeps
      the raw state in `title`; diag line shows `raw <state>`. Patterns and
      the search box exact-match the FORMATTED state too ("detected" → the 2 detecting
      sensors) — "type what you see" now literally. Perf probe unchanged within noise.
- [x] **v0.11.1 an unselected filter group says so, and a stale one can be cleared.** The user
      hit a Matter Thread Hubs card reading `0 / 6` with a single unselected `On 6` chip and
      no way out, and reasoned it was the "none selected = all" rule failing when only one
      chip exists. **Reproduced against the real class with a fake hass** (scratchpad
      `seb_repro.js`): that rule is fine — `_selected` was `["Off"]` from localStorage, no hub
      is Off any more, and chips are built only from states PRESENT in the matched set, so the
      Off chip never rendered. An invisible, unclearable filter. Three fixes:
      (1) **`All` chip per group** (states, buckets) — active when that group has no selection,
      clears only its own group. Makes "this group is not filtering" visible, which is what was
      missing, and removes the lone-chip ambiguity (`All* · On 6` instead of a bare `On 6` that
      looks like a no-op because selecting it changes nothing).
      (2) **A selected state with count 0 still gets a chip**, greyed + dashed, so the stale
      filter is visible and clickable; intent is preserved (when a hub does go Off it returns).
      (3) **The empty state is an escape hatch** — `Clear filters` appears whenever `filtered`
      and zero rows, because search and min/max can empty the list with no chip to show for it.
      NOT changed, by decision: cross-group semantics. A bucket selection still leaves
      non-numerics unconstrained (measured: buckets `20,50` + `<20` → 7 rows = 3 temps AND all
      4 doors). The `All` chips at least make that legible; a stricter "hide what the group
      does not apply to" rule would be a config option, not a silent change.
- ⚠️ The scratchpad add_view.py REPLACES the card-lab view wholesale — it clobbered a
  GUI-added card once (2026-09-19, restored from a prior dump). The USER now edits Card Lab
  in the GUI: never regenerate the view; dump lovelace/config, modify surgically, save.
- Test rig: scratchpad render_test.js (playwright-core + ~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome,
  hassTokens localStorage recipe); walks shadow roots counting cards/chips/rows.
- Roadmap: Jinja secondary info (WS render_template subscription per row —
  budget it), numeric bucket presets, group-by domain/area.

## v0.12.0 — no longer reads the URL (2026-09-23)

The `?seb-<storage_id>=` handling, the "URL filter … show configured" note
and the `location-changed`/`popstate` listeners are gone. The optional tier
is now the **`filter`** option (editor field "Narrowing filter"); to drive it
from a dropdown, wrap the card in an SB Param Card (the socket) with
`filter: $q$` and point an SB Filter Select (the knob) at the socket. This
makes Entity Browser an ordinary wrapped card — the same path as a map or a
markdown card — instead of the one card with its own URL logic. `storage_id`
stays: it keys the per-browser localStorage state, not the URL. Diagnostics
show `filter: “…”` when set.

v0.12.1: editor helper for `filter` points at SB Param Card's own dropdown
(*Show a dropdown*); SB Filter Select no longer exists as such.

## v0.13.0 — the editor is an overview with dialogs (2026-09-23)

Same shell as SB Param Card's editor (copied by hand — no build step; keep
the two in step). Three groups: **Matching** (patterns with live per-row
counts, labels, areas, narrowing filter — flagged "from a Param Card" when
it holds a `$token$`), **Display** (title, row density/state style,
secondary fields, Jinja line, grouping, sort, rows, buckets), **Controls**
(search box, group selector, diagnostics, tap action). The overview also
shows "Matches now: N entities" via `matchInfo` (a full scan; recomputed on
open and after edits, debounced, not on hass ticks) and warns past 500.

Edits apply live but DEBOUNCED (`TYPING_QUIET_MS`, as before — per-keystroke
emits rebuilt the preview per character); toggles emit immediately. Cancel
restores the snapshot; closing flushes any pending debounced emit so the
last keystroke is never lost. Verified headless (`eb_editor_test.js`,
`eb_live_check.js`): standalone on Monitor → Home, and wrapped four deep
(HA editor → Param Card's Wrapped-card dialog → this overview → Matching
dialog), both `:modal`, inner Done leaves the outer open, no page errors.

## v0.14.0 — `filter` removed (2026-09-24)

User: "remove the narrowing field; use $name$ in Patterns instead." Correct,
because words inside ONE pattern are ANDed: `patterns: ["fp300 $q$"]` is the
base word plus the dropdown's word, and an empty value collapses to the
base — the two-tier behaviour `filter` provided, with no extra field. Gone:
`_filter`, `_filterMatcher`, the editor field, the overview row, the diag
note; `matchInfo(..., null)`. Pattern chips in the overview flag a `$token$`
as "from a Param Card". Areas/labels stay pickers — the Param Card's
`apply` handles those. Wrapped browsers on Monitor were rewired from
`filter: $x$` to `"base $x$"` patterns (`rewire_filter_to_pattern.py`);
a Home-view card with `filter: hub` and no patterns became `patterns: [hub]`
(equivalent).

v0.14.1: `matchInfo` ignores `___no_items_available___` placeholders in
`labels`/`areas` — HA's pickers emit that when their list is empty.

## v0.14.2 — unconfigured = empty state, not an error (2026-09-24)

Under an SB Param Card the browser starts with empty `labels`/`areas`
until the user picks something; `setConfig` threw "Configure at least one
entity pattern, label, or area" and HA rendered a red error card in the
knob's socket. Now `_unconfigured` is set instead, matching yields nothing
(never the whole estate — the render path calls `matchInfo` directly, so
it is guarded there too, not only in `_matches()`), and the list shows
"Choose an area or label, or configure an entity pattern". `clean()` also
accepts a single string in `labels`/`areas`.

## v0.14.3 — group by label (2026-09-24)

User: "sb entity cannot group by label". `group_by`/header selector gain
`label`. Names come from `config/label_registry/list` (hass carries no
label registry), fetched once per card, render forced on arrival, names
TRIMMED — 42 live labels are named " MTR …" with a leading space and
sorted ahead of everything. An entity's labels = own + device's
(`entityLabelIds`, now shared with matching); an entity with several is
listed under EACH (rows become `[id, st, group]` in label mode), the
header count stays unique entities (284, not 304 rows). Measured on demo
⑥'s browser: 15 groups, 3 BILRESA entities appear twice.

## v0.14.4 — label names are NOT trimmed (2026-09-24)

The leading space on the " MTR …" labels is INTENTIONAL (user: "It is
intentional") — it makes them sort first. v0.14.3's trim undid that;
names are now used verbatim for grouping.

## v0.14.5 — label groups honour the label filter (2026-09-24)

User: "should only group by the areas/labels that were included in the
filter". In label mode, when `labels` is set, an entity's group labels are
intersected with the filter: the six Matter-hub entities carry six other
MTR labels between them and no longer spawn those groups. Areas need no
change — an entity has one area and the area filter already implies it.
Measured on the Home card: hub → 1 group/6, relay → 1/4, both → 2/10.
