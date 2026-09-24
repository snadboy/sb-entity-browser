/* SB Entity Browser — filterable entity list card for Home Assistant.
 * Vanilla custom element (no build step). GUI-configured, no helper entities:
 * filter selection is card-local UI state persisted per browser.
 */

const CARD = "sb-entity-browser";
const VERSION = "0.14.0";
// How long typing must pause before a costly search runs — the editor's
// config-changed emit, its per-pattern counts, the card's own search box, and
// the card's re-render on a repeated setConfig all wait this long.
const TYPING_QUIET_MS = 400;

const SECONDARY_OPTIONS = [
  { value: "state", label: "State" },
  { value: "area", label: "Area" },
  { value: "device", label: "Device" },
  { value: "entity_id", label: "Entity ID" },
  { value: "device_class", label: "Device class" },
  { value: "last_changed", label: "Last changed" },
  { value: "last_updated", label: "Last updated" },
];

const fire = (node, type, detail) =>
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));

// Implied leading/trailing wildcards: "battery" matches *battery*.
const globToRegex = (glob, flags) =>
  new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."), flags);

// Every pattern token (space-separated, any order) matches case-insensitively
// as a substring of the entity id OR the friendly name — HA target-picker
// style — or as an EXACT match of the current state (so "CR2450" finds the
// battery-type sensors reporting CR2450). * and ? wildcards work per token.
// Single tokens use the same rules: users type what they see on screen, and
// what they see is friendly names and states, not lowercase ids.
const patternMatcher = (p) => {
  if (!p || !p.trim()) return null;
  const toks = p.trim().split(/\s+/).map((t) => ({
    re: globToRegex(t, "i"),
    exact: /[*?]/.test(t) ? null : t.toLowerCase(),
  }));
  // `fmt` is the displayed state ("Detected"): typing what you see must work
  // whether what you see is the raw state or HA's formatted one.
  return (id, name, state, fmt) =>
    toks.every(
      (t) =>
        t.re.test(id) ||
        (name && t.re.test(name)) ||
        (t.exact != null && state != null && String(state).toLowerCase() === t.exact) ||
        (t.exact != null && fmt != null && String(fmt).toLowerCase() === t.exact)
    );
};

const entityAreaId = (hass, id) => {
  const reg = hass.entities?.[id];
  return reg?.area_id || hass.devices?.[reg?.device_id]?.area_id || null;
};

// Matching semantics: within a category any entry matches (OR); across the
// categories that are configured — patterns ∧ labels ∧ areas — ALL must be
// satisfied. An empty category doesn't constrain.
const matchInfo = (hass, config, extra) => {
  // Index-aligned with config.patterns. A blank entry is IGNORED (it never
  // excludes anything); with no active pattern at all, patterns don't
  // constrain and labels/areas decide alone.
  const matchers = (config.patterns || []).map(patternMatcher);
  const active = matchers.filter(Boolean).length;
  const labels = config.labels || [];
  const areas = config.areas || [];
  const patCounts = new Array(matchers.length).fill(0);
  const ids = [];
  for (const id of Object.keys(hass.states)) {
    const st = hass.states[id];
    const name = st.attributes.friendly_name;
    const fmt = active || extra ? fmtState(hass, st) : null;
    let pOk = active === 0;
    matchers.forEach((m, i) => {
      if (m && m(id, name, st.state, fmt)) {
        patCounts[i]++;
        pOk = true;
      }
    });
    if (!pOk) continue;
    if (labels.length) {
      // An entity matches a label it carries itself OR one its DEVICE
      // carries. HA does not propagate device labels to entities, and the
      // registry lets you label a device in one click — so "Matter Hub" on
      // seven plugs matched zero entities and the card looked broken.
      const reg = hass.entities?.[id];
      const own = reg?.labels || [];
      const dev = reg?.device_id ? hass.devices?.[reg.device_id]?.labels || [] : [];
      if (!own.some((l) => labels.includes(l)) && !dev.some((l) => labels.includes(l))) continue;
    }
    if (areas.length && !areas.includes(entityAreaId(hass, id))) continue;
    if (extra && !extra(id, name, st.state, fmt)) continue;
    ids.push(id);
  }
  return { ids, patCounts };
};

const relTime = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The state as HA itself displays it: hass.formatEntityState() applies the
// device class ("on" → "Detected" for occupancy, "Open" for a door), the
// user's language, and numeric formatting with the unit — the same call every
// built-in card makes. Cached per entity+state because matchInfo runs it for
// the whole estate on every hass tick; capped because numeric sensors mint a
// new key on every reading.
const fmtCache = new Map();
const fmtState = (hass, st) => {
  const a = st.attributes || {};
  const k = `${st.entity_id}|${st.state}|${a.device_class || ""}|${a.unit_of_measurement || ""}`;
  let v = fmtCache.get(k);
  if (v === undefined) {
    try { v = hass.formatEntityState ? hass.formatEntityState(st) : st.state; }
    catch (e) { v = st.state; }
    if (fmtCache.size > 5000) fmtCache.clear();
    fmtCache.set(k, v);
  }
  return v;
};

class SbEntityBrowser extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._lastRender = 0;
    this._sig = "";
    this._diag = false;
    this._search = "";
    this._bsel = new Set();
    this._coll = new Set();
    this._tsubs = new Map();
    this._tres = new Map();
  }

  static getConfigElement() {
    return document.createElement("sb-entity-browser-editor");
  }

  static getStubConfig() {
    return {
      patterns: ["battery"],
      secondary: ["area", "last_changed"],
      tap_action: { action: "more-info" },
      diagnostics_button: true,
      storage_id: "seb-" + Math.random().toString(36).slice(2, 8),
    };
  }

  setConfig(config) {
    // A blank pattern row is neutral in matching (it never excludes anything),
    // so it must not count as "configured" here either — a lone blank row
    // with no label or area would otherwise render the whole estate.
    const realPatterns = (config?.patterns || []).filter((p) => p && p.trim());
    if (
      !config ||
      (!realPatterns.length && !(config.labels || []).length && !(config.areas || []).length)
    ) {
      throw new Error("Configure at least one entity pattern, label, or area");
    }
    this._config = {
      secondary: ["state"],
      tap_action: { action: "more-info" },
      sort: "name",
      list_rows: 10,
      ...config,
    };
    this._storeKey = `sb-entity-browser-${this._config.storage_id || "default"}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this._storeKey) || "{}");
      this._selected = new Set(saved.states || []);
      this._min = saved.min ?? "";
      this._max = saved.max ?? "";
      this._diag = !!saved.diag;
      this._bsel = new Set(saved.bsel || []);
      this._coll = new Set(saved.coll || []);
      this._gsel = saved.gsel ?? null;
    } catch (e) {
      this._selected = new Set();
      this._bsel = new Set();
      this._coll = new Set();
      this._min = this._max = "";
    }
    this._sig = "";
    if (!this._hass) return;
    // First config renders at once. A REPEATED setConfig is the editor
    // typing: coalesce, so only the pattern that survives the pause is built
    // (the validation above stays synchronous — HA relies on the throw).
    if (!this._lastRender) { this._render(); return; }
    clearTimeout(this._cfgTimer);
    this._cfgTimer = setTimeout(() => {
      this._cfgTimer = null;
      this._sig = "";
      this._render();
    }, TYPING_QUIET_MS);
  }

  set hass(hass) {
    this._hass = hass;
    if (this._searchFocus) return; // don't yank the list mid-typing in the card search
    if (this._cfgTimer) return;    // a coalesced config render is pending; a hass tick must not front-run it
    // hass updates arrive on EVERY state change in the system. Render only
    // when something we display changed, and coalesce bursts to one render
    // per second — a broad pattern otherwise rebuilds hundreds of rows on
    // every tick and saturates the main thread (the editor's Save click
    // never gets processed).
    if (this._renderQueued) return;
    if (this._sig && this._signature() === this._sig) return;
    const since = Date.now() - this._lastRender;
    if (since >= 1000) {
      this._render();
    } else {
      this._renderQueued = true;
      setTimeout(() => {
        this._renderQueued = false;
        this._render();
      }, 1000 - since);
    }
  }

  getCardSize() {
    return 4;
  }

  // This card knows nothing about the URL. To drive it from a dropdown, wrap
  // it in an SB Param Card and put the parameter INSIDE a pattern: words in
  // one pattern are ANDed, so "fp300 $q$" is the base word plus the chosen
  // word, and an empty choice collapses back to the base. (A separate
  // `filter` option existed in 0.12–0.13; it said the same thing twice.)
  connectedCallback() {
    // Keep "Nm ago" honest — those only change when something re-renders.
    // HA builds cards DETACHED and re-attaches them during layout — the
    // render-time template arm bails while disconnected and the sweep dies
    // in disconnectedCallback, so re-arm on every (re)attach.
    if (this._config && this._hass) {
      this._setupTplObserver(this._lastScrolls ?? false);
      this._setupIconReconcile(this._lastScrolls ?? false);
    }
    this._tick = setInterval(() => {
      const needs = this._diag || (this._config?.secondary || []).some((f) => f.startsWith("last_"));
      if (needs && this._hass && this._config && !this._searchFocus) {
        this._sig = "";
        this._render();
      }
    }, 60000);
  }

  disconnectedCallback() {
    clearInterval(this._tick);
    clearInterval(this._tplSweep);
    clearInterval(this._iconSweep);
    clearTimeout(this._iconScrollT);
    this._dropTemplates();
  }

  // The card's config (patterns/labels/areas) is its identity; the search box
  // is the only runtime narrowing on top of it.
  _matches() {
    return matchInfo(this._hass, this._config, null).ids;
  }

  _signature() {
    // Rolling hash instead of a joined string: a broad pattern matching
    // thousands of entities would otherwise allocate a ~100 KB string on
    // every hass tick just to compare it.
    const h = this._hass;
    let acc = 0;
    let n = 0;
    for (const id of this._matches()) {
      const st = h.states[id];
      const s = id + st.state + st.last_updated;
      for (let i = 0; i < s.length; i++) acc = (acc * 31 + s.charCodeAt(i)) | 0;
      n++;
    }
    return n + ":" + acc;
  }

  _persist() {
    try {
      localStorage.setItem(
        this._storeKey,
        JSON.stringify({ states: [...this._selected], min: this._min, max: this._max,
                         diag: this._diag, bsel: [...this._bsel], coll: [...this._coll],
                         gsel: this._gsel })
      );
    } catch (e) {
      /* private mode etc. — filter just won't persist */
    }
  }

  _area(id) {
    return this._hass.areas?.[entityAreaId(this._hass, id)]?.name || "";
  }

  _device(id) {
    const h = this._hass;
    const dev = h.devices?.[h.entities?.[id]?.device_id];
    return dev?.name_by_user || dev?.name || "";
  }

  _secondaryText(id, st) {
    const parts = [];
    for (const f of this._config.secondary || []) {
      let v = "";
      if (f === "state") v = st.state;
      else if (f === "area") v = this._area(id);
      else if (f === "device") v = this._device(id);
      else if (f === "entity_id") v = id;
      else if (f === "device_class") v = st.attributes.device_class || "";
      else if (f === "last_changed") v = relTime(st.last_changed);
      else if (f === "last_updated") v = relTime(st.last_updated);
      if (v) parts.push(v);
    }
    return parts.join(" · ");
  }

  _handleTap(id) {
    const a = this._config.tap_action || { action: "more-info" };
    const act = a.action || "more-info";
    if (act === "none") return;
    if (act === "more-info") fire(this, "hass-more-info", { entityId: id });
    else if (act === "history") {
      history.pushState(null, "", `/history?entity_id=${id}`);
      fire(this, "location-changed", {});
    } else if (act === "navigate") {
      history.pushState(null, "", a.navigation_path || "/");
      fire(this, "location-changed", {});
    } else if (act === "url") window.open(a.url_path, "_blank");
    else if (act === "perform-action" || act === "call-service") {
      const [domain, service] = (a.perform_action || a.service || "").split(".");
      // A target without any entity/device/area/label falls back to the
      // clicked row's entity, so one card can act on whichever row is tapped.
      const t = a.target || {};
      const hasTarget = ["entity_id", "device_id", "area_id", "label_id", "floor_id"].some(
        (k) => t[k] != null && (!Array.isArray(t[k]) || t[k].length)
      );
      if (domain && service)
        this._hass.callService(domain, service, a.data || a.service_data || {},
          hasTarget ? t : { entity_id: id });
    }
  }

  _render() {
    this._lastRender = Date.now();
    this._sig = this._signature();
    const h = this._hass;
    const cfg = this._config;
    const { ids, patCounts } = matchInfo(h, cfg, null);

    const stateObjs = ids.map((id) => [id, h.states[id]]);
    const isBad = (st) => ["unavailable", "unknown"].includes(st.state);
    const isNum = (st) => !isBad(st) && st.state !== "" && !isNaN(parseFloat(st.state)) && isFinite(st.state);
    const numericStates = stateObjs.filter(([, st]) => isNum(st));
    const numericMode =
      numericStates.length >= 8 && new Set(numericStates.map(([, st]) => st.state)).size > 8;

    // Numeric buckets: configured thresholds turn min/max into tappable
    // range chips with counts (e.g. "20, 50" -> <20 / 20-50 / >50).
    const thresholds = numericMode
      ? String(cfg.buckets || "").split(",").map((t) => parseFloat(t)).filter((t) => !isNaN(t)).sort((a, b) => a - b)
      : [];
    const bucketOf = (v) => {
      let i = 0;
      while (i < thresholds.length && v >= thresholds[i]) i++;
      return i;
    };
    const bucketLabel = (i) =>
      i === 0 ? `< ${thresholds[0]}` :
      i === thresholds.length ? `> ${thresholds[thresholds.length - 1]}` :
      `${thresholds[i - 1]}–${thresholds[i]}`;
    const bucketCounts = new Array(thresholds.length + 1).fill(0);
    if (thresholds.length)
      for (const [, st] of numericStates) bucketCounts[bucketOf(parseFloat(st.state))]++;

    // Chips are grouped by the state AS DISPLAYED, not the raw string: an
    // occupancy card reads "Clear 12 · On 3 · Detected 2", and the Detected
    // chip selects exactly the sensors that read Detected — not every raw
    // "on" in sight (the occupancy lights are "On", a separate chip). A
    // selection saved before this change holds raw values; the row filter
    // below accepts either, so nothing goes blank, and the next click
    // rewrites the selection in display terms.
    const counts = new Map();
    for (const [, st] of stateObjs)
      if (!numericMode || !isNum(st)) {
        const f = fmtState(h, st);
        counts.set(f, (counts.get(f) || 0) + 1);
      }

    // Card search refines WITHIN the matched set. Appending a "match-all"
    // token forces word-query semantics (id AND friendly name) even for a
    // single search word.
    const searchM = cfg.show_search && this._search.trim()
      ? patternMatcher(this._search.trim() + " *")
      : null;

    const name = (id, st) => st.attributes.friendly_name || id;
    let rows = stateObjs.filter(([id, st]) => {
      if (searchM && !searchM(id, st.attributes.friendly_name, st.state, fmtState(h, st))) return false;
      if (numericMode && isNum(st)) {
        const v = parseFloat(st.state);
        if (thresholds.length) return this._bsel.size === 0 || this._bsel.has(bucketOf(v));
        if (this._min !== "" && v < parseFloat(this._min)) return false;
        if (this._max !== "" && v > parseFloat(this._max)) return false;
        return true;
      }
      return this._selected.size === 0 || this._selected.has(fmtState(h, st)) || this._selected.has(st.state);
    });

    // Sort: group key first (when grouping), then the chosen order.
    const sort = this._diag ? "diag" : cfg.sort || "name";
    const dir = cfg.sort_dir === "desc" ? -1 : 1;
    // Viewer's header selection (per browser) overrides the configured default.
    const groupSel = this._gsel ?? cfg.group_by;
    const groupBy = ["floor", "area", "state", "domain"].includes(groupSel) ? groupSel : null;
    const groupOf = (id, st) => {
      if (groupBy === "domain") return id.split(".")[0];
      if (groupBy === "state") return st.state;
      if (groupBy === "floor") {
        const areaId = entityAreaId(h, id);
        const floorId = h.areas?.[areaId]?.floor_id;
        return h.floors?.[floorId]?.name || "No floor";
      }
      return this._area(id) || "No area";
    };
    const base = ([ia, sa], [ib, sb]) => {
      if (sort === "diag") {
        const ba = isBad(sa) ? 0 : 1;
        const bb = isBad(sb) ? 0 : 1;
        if (ba !== bb) return ba - bb;
        return sb.last_changed.localeCompare(sa.last_changed);
      }
      if (sort === "state") return dir * sa.state.localeCompare(sb.state, undefined, { numeric: true });
      if (sort === "last_changed") return dir * sa.last_changed.localeCompare(sb.last_changed);
      return dir * name(ia, sa).localeCompare(name(ib, sb));
    };
    rows.sort((a, b) => {
      if (groupBy) {
        const g = groupOf(a[0], a[1]).localeCompare(groupOf(b[0], b[1]));
        if (g) return g;
      }
      return base(a, b);
    });

    // Hard on-screen limit: list_rows is ALWAYS in effect (invalid/0 falls
    // back to 10) — the list never grows past it, everything else scrolls.
    const listRows = Math.max(3, parseInt(cfg.list_rows) || 10);
    const renderCap = 500;
    const shown = rows.length;
    const capped = rows.length > renderCap && !this._diag;
    if (capped) rows = rows.slice(0, renderCap);
    // Absolute ceiling on top of the row cap: the list never exceeds 70% of
    // the viewport, whatever list_rows and row heights add up to.
    const scrolls = rows.length > listRows;
    const listStyle = scrolls
      ? `max-height:min(${(listRows * (this._diag ? 4.3 : 3.6)).toFixed(1)}em, 70vh); overflow-y:auto;`
      : `max-height:70vh; overflow-y:auto;`;

    const compact = cfg.density === "compact";
    const pill = cfg.state_style === "pill";
    const tpl = (cfg.secondary_template || "").trim();
    const ACTIVE = new Set(["on", "open", "home", "playing", "heat", "cool", "heat_cool", "dry",
      "fan_only", "auto", "cleaning", "returning", "detected", "running", "charging",
      "unlocked", "above_horizon", "occupied", "wet"]);

    const chipsRow = (inner) => `<div class="chips">${inner}</div>`;
    // An "All" chip makes the group's unfiltered state VISIBLE. Without it the
    // group silently means "everything" when nothing is selected, which reads as
    // "no filter is doing anything" — the same trap as a stale selection below.
    const allChip = (kind, active) =>
      `<span class="chip allchip ${active ? "on" : ""}" data-all="${kind}">All</span>`;
    // A selected state with no current count still gets a chip, greyed. Chips are
    // built from states PRESENT in the matched set, so a selection left over from
    // when some entity was e.g. Off would otherwise filter everything away with
    // nothing on screen to clear — an invisible, unclearable filter (v0.11.1).
    const textChips = (max) => {
      const present = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
      const shown = new Set(present.map(([s]) => s));
      const stale = [...this._selected].filter((s) => !shown.has(s)).map((s) => [s, 0]);
      return allChip("states", this._selected.size === 0) +
             present.concat(stale).map(([s, c]) => this._chip(s, c)).join("");
    };
    const chipsHtml = numericMode
      ? thresholds.length
        ? chipsRow(allChip("buckets", this._bsel.size === 0) + bucketCounts.map((c, i) =>
            `<span class="chip bchip ${this._bsel.has(i) ? "on" : ""}" data-b="${i}">${esc(bucketLabel(i))}<span class="n">${c}</span></span>`).join("") + textChips(8))
        : chipsRow(`<input type="number" class="minmax" id="min" placeholder="min" value="${esc(this._min)}">
           <span class="dash">–</span>
           <input type="number" class="minmax" id="max" placeholder="max" value="${esc(this._max)}">` + textChips(10))
      : chipsRow(textChips(15));

    const rowHtml = ([id, st]) => {
      const bad = isBad(st);
      const act = !bad && ACTIVE.has(st.state);
      const sec = compact ? "" : this._secondaryText(id, st);
      return `
        <div class="row ${bad ? "bad" : ""} ${act ? "act" : ""} ${compact ? "cmp" : ""}" data-entity="${esc(id)}" role="button" tabindex="0">
          <span class="icon ph"></span>
          <div class="body">
            <div class="name">${esc(name(id, st))}</div>
            ${sec ? `<div class="sec">${esc(sec)}</div>` : ""}
            ${tpl && !compact ? `<div class="jinja">${esc(this._tres.get(id) ?? "")}</div>` : ""}
            ${this._diag ? `<div class="diag-line">${esc(id)} · raw ${esc(st.state)} · updated ${esc(relTime(st.last_updated))}</div>` : ""}
          </div>
          <div class="state ${pill ? "pill" : ""}" title="${esc(st.state)}">${esc(fmtState(h, st))}</div>
        </div>`;
    };

    let rowsHtml = "";
    const groupKeys = [];
    if (groupBy) {
      let i = 0;
      while (i < rows.length) {
        const g = groupOf(rows[i][0], rows[i][1]);
        groupKeys.push(g);
        let j = i;
        while (j < rows.length && groupOf(rows[j][0], rows[j][1]) === g) j++;
        const coll = this._coll.has(g);
        rowsHtml += `<div class="grp" data-g="${esc(g)}"><ha-icon icon="mdi:chevron-${coll ? "right" : "down"}"></ha-icon>${esc(g)}<span class="n">${j - i}</span></div>`;
        if (!coll) rowsHtml += rows.slice(i, j).map(rowHtml).join("");
        i = j;
      }
    } else {
      rowsHtml = rows.map(rowHtml).join("");
    }

    const filtered = !!(searchM || this._selected.size || this._bsel.size || this._min !== "" || this._max !== "");
    // An escape hatch, not just a message. Search and min/max can empty the list
    // with no chip to show for it, so the only way out must be on screen.
    const emptyHtml = `<div class="empty"><ha-icon icon="mdi:magnify-remove-outline"></ha-icon>` +
      `<div>No entities match${filtered ? " the current filters" : ""}</div>` +
      (filtered ? `<div class="clear-all" role="button" tabindex="0">Clear filters</div>` : "") +
      `</div>`;

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px 8px; }
        .header { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 1.2em; font-weight: 500; flex: 1; color: var(--primary-text-color); }
        .count { color: var(--secondary-text-color); font-size: .85em; }
        .diag-btn, .fold-btn { cursor: pointer; color: var(--secondary-text-color); --mdc-icon-size: 20px; padding: 4px; border-radius: 50%; }
        .diag-btn.on { color: var(--primary-color); background: rgba(var(--rgb-primary-color, 33,150,243), .12); }
        .gsel { font-size: .8em; color: var(--secondary-text-color); background: var(--card-background-color, transparent);
                border: 1px solid var(--divider-color); border-radius: 12px; padding: 2px 6px; cursor: pointer;
                outline-color: var(--primary-color); color-scheme: light dark; }
        /* Native select popup ignores the page theme — style options or dark
           themes get light-gray text on a white popup. */
        .gsel option { background: var(--card-background-color, Canvas);
                       color: var(--primary-text-color, CanvasText); }
        .searchbox { width: 100%; box-sizing: border-box; margin: 8px 0 2px; padding: 8px 12px; font: inherit;
                     color: var(--primary-text-color); background: var(--mdc-text-field-fill-color, rgba(127,127,127,.12));
                     border: none; border-bottom: 1px solid var(--divider-color); border-radius: 4px 4px 0 0;
                     outline-color: var(--primary-color); }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
        .chip { cursor: pointer; user-select: none; font-size: .85em; padding: 3px 10px; border-radius: 12px;
                border: 1px solid var(--divider-color); color: var(--secondary-text-color);
                transition: background .12s, color .12s; }
        .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .chip .n { opacity: .7; margin-left: 4px; }
        .chip.allchip { font-weight: 500; }
        .chip.zero { opacity: .55; border-style: dashed; }
        .chip.zero.on { opacity: 1; }
        .clear-all { margin-top: 8px; cursor: pointer; color: var(--primary-color);
          font-size: .9em; text-decoration: underline; }
        .minmax { width: 70px; background: none; border: 1px solid var(--divider-color); border-radius: 8px;
                  color: var(--primary-text-color); padding: 3px 8px; }
        .dash { color: var(--secondary-text-color); align-self: center; }
        .grp { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
               padding: 10px 0 2px; color: var(--secondary-text-color); font-size: .78em;
               font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
        .grp .n { opacity: .6; font-weight: 400; }
        .grp ha-icon { --mdc-icon-size: 16px; }
        .row { display: flex; align-items: center; gap: 12px; padding: 7px 0; cursor: pointer; border-radius: 8px; }
        .row.cmp { padding: 3px 0; }
        .list.anim .row { animation: seb-fade .18s ease-out; }
        @keyframes seb-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        .row:hover { background: rgba(var(--rgb-primary-text-color, 0,0,0), .05); }
        .row.bad .state { color: var(--error-color); }
        .row.act .state { color: var(--primary-color); }
        .icon { color: var(--state-icon-color, var(--paper-item-icon-color)); flex: none; }
        /* placeholder for a row not yet on screen: same 24px footprint as
           ha-state-icon so nothing shifts when the real icon arrives */
        .icon.ph { display: inline-block; width: 24px; height: 24px; border-radius: 50%;
                   background: var(--divider-color); opacity: .35; }
        .body { flex: 1; min-width: 0; }
        .name { color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sec, .jinja, .diag-line { color: var(--secondary-text-color); font-size: .85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .diag-line { font-family: monospace; font-size: .78em; }
        .state { color: var(--primary-text-color); font-weight: 500; white-space: nowrap; }
        .state.pill { font-size: .85em; font-weight: 500; padding: 3px 10px; border-radius: 12px;
                      background: rgba(var(--rgb-primary-text-color, 0,0,0), .06); }
        .row.act .state.pill { background: rgba(var(--rgb-primary-color, 33,150,243), .15); }
        .row.bad .state.pill { background: rgba(var(--rgb-error-color, 244,67,54), .12); }
        .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 20px 0;
                 color: var(--secondary-text-color); font-style: italic; }
        .empty ha-icon { --mdc-icon-size: 32px; opacity: .5; }
        .note { color: var(--secondary-text-color); font-style: italic; font-size: .8em; padding: 4px 0; }
      </style>
      <ha-card>
        <div class="header">
          <div class="title">${esc(cfg.title || "")}</div>
          <div class="count">${shown === ids.length ? ids.length : shown + " / " + ids.length}</div>
          ${cfg.show_group_selector
            ? `<select class="gsel" title="Group by">${["none", "floor", "area", "state", "domain"]
                .map((g) => `<option value="${g}" ${g === (groupBy || "none") ? "selected" : ""}>${g === "none" ? "No grouping" : g[0].toUpperCase() + g.slice(1)}</option>`)
                .join("")}</select>`
            : ""}
          ${groupBy
            ? `<ha-icon class="fold-btn" data-fold="collapse" icon="mdi:unfold-less-horizontal" title="Collapse all"></ha-icon>
               <ha-icon class="fold-btn" data-fold="expand" icon="mdi:unfold-more-horizontal" title="Expand all"></ha-icon>`
            : ""}
          ${cfg.diagnostics_button
            ? `<ha-icon class="diag-btn ${this._diag ? "on" : ""}" icon="mdi:stethoscope" title="Toggle diagnostics"></ha-icon>`
            : ""}
        </div>
        ${cfg.show_search ? `<input type="search" class="searchbox" placeholder="Search…" value="${esc(this._search)}">` : ""}
        ${chipsHtml}
        ${this._diag
          ? `<div class="note">${ids.length} matched · ${rows.length} shown · ${this._tsubs.size} template subs · v${VERSION}${
              (cfg.patterns || []).length > 1
                ? " — " + (cfg.patterns || []).map((p, i) => `${esc(p)}: ${patCounts[i]}`).join(" · ")
                : ""}</div>`
          : ""}
        <div class="list ${this._animate ? "anim" : ""}" style="${listStyle}">${rowsHtml || emptyHtml}</div>
        ${capped ? `<div class="note">List capped at ${renderCap} — narrow the filter (diagnostics shows all)</div>` : ""}
      </ha-card>`;
    this._animate = false;

    // Wire up
    const rerender = () => {
      this._animate = true;
      this._persist();
      this._render();
    };
    // Icons are NOT created here. Measured (v0.10.0): a broad pattern's 500
    // rows rendered in 44 ms, then spent ~1.2 s in long tasks upgrading 500
    // ha-state-icon elements — and with a churning estate the card
    // re-renders once a second, so the main thread never freed and the
    // editor's next setConfig queued behind it. Icons are created only for
    // rows on screen, by _reconcileIcons below.
    this.shadowRoot.querySelectorAll(".row").forEach((el) => {
      const id = el.dataset.entity;
      el.addEventListener("click", () => this._handleTap(id));
      el.addEventListener("keydown", (e) => e.key === "Enter" && this._handleTap(id));
    });
    const clearAll = this.shadowRoot.querySelector(".clear-all");
    if (clearAll) {
      const doClear = () => {
        this._selected.clear(); this._bsel.clear();
        this._min = this._max = ""; this._search = "";
        rerender();
      };
      clearAll.addEventListener("click", doClear);
      clearAll.addEventListener("keydown", (e) => e.key === "Enter" && doClear());
    }
    this.shadowRoot.querySelectorAll(".allchip").forEach((el) => {
      el.addEventListener("click", () => {
        // Clears only its own group, so the bucket and state groups stay independent.
        if (el.dataset.all === "buckets") this._bsel.clear();
        else this._selected.clear();
        rerender();
      });
    });
    this.shadowRoot.querySelectorAll(".chip:not(.bchip):not(.allchip)").forEach((el) => {
      el.addEventListener("click", () => {
        const s = el.dataset.state;
        this._selected.has(s) ? this._selected.delete(s) : this._selected.add(s);
        rerender();
      });
    });
    this.shadowRoot.querySelectorAll(".bchip").forEach((el) => {
      el.addEventListener("click", () => {
        const i = Number(el.dataset.b);
        this._bsel.has(i) ? this._bsel.delete(i) : this._bsel.add(i);
        rerender();
      });
    });
    this.shadowRoot.querySelectorAll(".grp").forEach((el) => {
      el.addEventListener("click", () => {
        const g = el.dataset.g;
        this._coll.has(g) ? this._coll.delete(g) : this._coll.add(g);
        rerender();
      });
    });
    const gsel = this.shadowRoot.querySelector(".gsel");
    if (gsel)
      gsel.addEventListener("change", () => {
        this._gsel = gsel.value;
        rerender();
      });
    this.shadowRoot.querySelectorAll(".fold-btn").forEach((el) => {
      el.addEventListener("click", () => {
        if (el.dataset.fold === "collapse") groupKeys.forEach((g) => this._coll.add(g));
        else this._coll.clear();
        rerender();
      });
    });
    const diagBtn = this.shadowRoot.querySelector(".diag-btn");
    if (diagBtn)
      diagBtn.addEventListener("click", () => {
        this._diag = !this._diag;
        rerender();
      });
    for (const key of ["min", "max"]) {
      const inp = this.shadowRoot.getElementById(key);
      if (inp)
        inp.addEventListener("change", () => {
          this[`_${key}`] = inp.value;
          rerender();
        });
    }
    const sb = this.shadowRoot.querySelector(".searchbox");
    if (sb) {
      sb.addEventListener("focus", () => (this._searchFocus = true));
      sb.addEventListener("blur", () => {
        this._searchFocus = false;
        this._sig = "";
      });
      sb.addEventListener("input", () => {
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => {
          this._search = sb.value;
          this._animate = true;
          this._render();
        }, TYPING_QUIET_MS);
      });
      if (this._searchFocus) {
        sb.focus();
        sb.setSelectionRange(sb.value.length, sb.value.length);
      }
    }
    if (scrolls) {
      const listEl = this.shadowRoot.querySelector(".list");
      requestAnimationFrame(() => {
        const r0 = listEl?.querySelector(".row");
        if (r0?.offsetHeight)
          listEl.style.maxHeight = `min(${r0.offsetHeight * listRows}px, 70vh)`;
      });
    }
    // Jinja secondary info: subscriptions exist ONLY for rows actually ON
    // SCREEN — an IntersectionObserver subscribes rows as they scroll into
    // view (the scroll container, or the page viewport for the card itself)
    // and releases them when they leave, under a hard concurrent cap.
    // Results stay cached, so scrolled-back rows fill instantly.
    this._setupTplObserver(scrolls);
    this._setupIconReconcile(scrolls);
  }

  // Same on-screen discipline for icons as for templates: a row gets a real
  // ha-state-icon only once it is within the list's viewport (±80 px). Runs
  // after every render, on scroll, on (re)attach — HA builds cards detached,
  // so render-time geometry is all zeros — and on a 5 s self-healing sweep.
  _setupIconReconcile(scrolls) {
    this._lastScrolls = scrolls;
    clearInterval(this._iconSweep);
    const listEl = this.shadowRoot.querySelector(".list");
    const reconcile = () => this._reconcileIcons(scrolls ? listEl : null);
    if (scrolls && listEl && !listEl._sebIconScrollBound) {
      listEl._sebIconScrollBound = true;
      listEl.addEventListener("scroll", () => {
        clearTimeout(this._iconScrollT);
        this._iconScrollT = setTimeout(reconcile, 150);
      });
    }
    this._iconSweep = setInterval(reconcile, 5000);
    reconcile();
    requestAnimationFrame(reconcile);   // once layout has happened
  }

  _reconcileIcons(rootEl) {
    if (!this.isConnected || !this._hass) return;
    const h = this._hass;
    const rootRect = rootEl ? rootEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    for (const r of this.shadowRoot.querySelectorAll(".row")) {
      const ph = r.querySelector(".icon.ph");
      if (!ph) continue;
      const b = r.getBoundingClientRect();
      if (!b.height || b.bottom < rootRect.top - 80 || b.top > rootRect.bottom + 80) continue;
      const st = h.states[r.dataset.entity];
      if (!st) continue;
      const icon = document.createElement("ha-state-icon");
      icon.className = "icon";
      icon.hass = h;
      icon.stateObj = st;
      ph.replaceWith(icon);
    }
  }

  // Deterministic template reconciliation: no IntersectionObserver (its
  // one-shot initial reports race HA's staged card mounting and never
  // retry). Instead, measure which rows are on screen and reconcile
  // subscriptions — on every render, on scroll (debounced), and every 5s
  // as a self-healing sweep. A failed subscribe is simply retried on the
  // next sweep.
  _setupTplObserver(scrolls) {
    const tpl = (this._config?.secondary_template || "").trim();
    if (tpl !== this._tplStr) {
      this._dropTemplates();
      this._tplStr = tpl;
    }
    clearInterval(this._tplSweep);
    if (!tpl || this._config.density === "compact") {
      if (this._tsubs.size) this._dropTemplates();
      return;
    }
    const listEl = this.shadowRoot.querySelector(".list");
    const reconcile = () => this._reconcileTemplates(scrolls ? listEl : null, tpl);
    if (scrolls && listEl && !listEl._sebScrollBound) {
      listEl._sebScrollBound = true;
      listEl.addEventListener("scroll", () => {
        clearTimeout(this._scrollT);
        this._scrollT = setTimeout(reconcile, 150);
      });
    }
    this._tplSweep = setInterval(reconcile, 5000);
    reconcile();
  }

  _reconcileTemplates(rootEl, tpl) {
    if (!this.isConnected) return;
    const rootRect = rootEl ? rootEl.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
    const want = new Set();
    for (const r of this.shadowRoot.querySelectorAll(".row")) {
      const b = r.getBoundingClientRect();
      if (b.height && b.bottom >= rootRect.top - 80 && b.top <= rootRect.bottom + 80)
        want.add(r.dataset.entity);
    }
    for (const id of this._tsubs.keys()) if (!want.has(id)) this._tplUnsub(id);
    for (const id of want) this._tplSub(id, tpl);
  }

  _tplSub(id, tpl) {
    if (this._tsubs.has(id)) return;
    if (this._tsubs.size >= 60) return; // hard ceiling, whatever the layout does
    const p = this._hass.connection.subscribeMessage(
      (msg) => {
        this._tres.set(id, msg.result ?? "");
        const el = this.shadowRoot.querySelector(`.row[data-entity="${CSS.escape(id)}"] .jinja`);
        if (el) el.textContent = this._tres.get(id);
      },
      { type: "render_template", template: tpl, variables: { entity_id: id } }
    );
    p.catch(() => this._tsubs.delete(id));
    this._tsubs.set(id, p);
  }

  _tplUnsub(id) {
    const p = this._tsubs.get(id);
    if (!p) return;
    p.then((u) => u()).catch(() => {});
    this._tsubs.delete(id); // cached result kept for instant refill
  }

  _chip(state, count) {
    const sel = this._selected.has(state);
    return `<span class="chip ${sel ? "on" : ""}${count === 0 ? " zero" : ""}" data-state="${esc(state)}" ` +
           `title="${count === 0 ? "Nothing is in this state right now — click to clear" : ""}">` +
           `${esc(state)}<span class="n">${count}</span></span>`;
  }

  _dropTemplates() {
    for (const p of this._tsubs.values()) p.then((u) => u()).catch(() => {});
    this._tsubs.clear();
    this._tres.clear();
  }

}

// ============================================================================
// The editor: an OVERVIEW of grouped, read-only settings — Matching, Display,
// Controls — each with an Edit button that opens ONE focused dialog. The same
// shell as SB Param Card's editor (kept in step by hand; no build step).
// Native <dialog> + showModal(): the browser's top layer, so it stacks over
// HA's card-editor dialog — and over a Param Card's "Wrapped card" dialog
// when this card is wrapped. Edits apply live (debounced, so typing a
// pattern does not rebuild the preview per keystroke); a snapshot is taken on
// open, Cancel restores it, Done / ✕ / Escape keep.
// ============================================================================

const EDITOR_STYLE = `
  .spe { color: var(--primary-text-color); }
  .spe .sec { background: var(--secondary-background-color, rgba(127,127,127,.08)); border: 1px solid var(--divider-color); border-radius: 10px; margin-bottom: 12px; }
  .spe .sec h3 { margin: 0; padding: 10px 14px; font-size: .95em; font-weight: 500; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--divider-color); }
  .spe .sec h3 button { font: inherit; font-size: .8em; color: var(--primary-color); background: none; border: 1px solid var(--primary-color); border-radius: 14px; padding: 3px 12px; cursor: pointer; }
  .spe .rows { padding: 8px 14px 10px; }
  .spe .row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: .9em; }
  .spe .row .k { color: var(--secondary-text-color); white-space: nowrap; }
  .spe .row .v { text-align: right; min-width: 0; overflow-wrap: anywhere; }
  .spe code { background: rgba(127,127,127,.2); padding: 1px 6px; border-radius: 4px; font-size: .9em; }
  .spe .chip { display: inline-block; background: rgba(127,127,127,.2); border-radius: 10px; padding: 1px 8px; margin-left: 4px; font-size: .85em; }
  .spe .off { color: var(--secondary-text-color); font-style: italic; }
  .spe .warn { color: var(--warning-color, orange); }
  .spe .note { color: var(--secondary-text-color); font-size: .8em; padding: 2px 4px 6px; }
  dialog.sped { border: 1px solid var(--divider-color); border-radius: 12px; padding: 0; width: min(600px, 92vw); max-height: 85vh;
    background: var(--card-background-color, var(--ha-card-background, #fff)); color: var(--primary-text-color); box-shadow: 0 12px 40px rgba(0,0,0,.5); }
  dialog.sped::backdrop { background: rgba(0,0,0,.45); }
  dialog.sped .ph { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--divider-color); font-weight: 500; }
  dialog.sped .ph button { font: inherit; background: none; border: none; color: var(--secondary-text-color); font-size: 1.2em; cursor: pointer; }
  dialog.sped .pb { padding: 14px 18px; max-height: calc(85vh - 130px); overflow: auto; }
  dialog.sped .pf { display: flex; justify-content: flex-end; gap: 10px; padding: 10px 18px 16px; border-top: 1px solid var(--divider-color); }
  dialog.sped .pf button { font: inherit; font-size: .9em; padding: 8px 18px; border-radius: 20px; border: none; cursor: pointer; background: none; color: var(--primary-color); }
  dialog.sped .pf button.done { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  dialog.sped .hint { color: var(--secondary-text-color); font-size: .8em; padding: 6px 2px 10px; }
  dialog.sped .sub { color: var(--secondary-text-color); font-size: .75em; letter-spacing: .04em; text-transform: uppercase; margin: 10px 0 6px; }
  dialog.sped .prow { display: flex; align-items: center; gap: 4px; }
  dialog.sped .prow input { flex: 1; min-width: 0; box-sizing: border-box; font: inherit; color: var(--primary-text-color);
    background: var(--mdc-text-field-fill-color, rgba(127,127,127,.12)); border: none; border-bottom: 1px solid var(--divider-color);
    border-radius: 4px 4px 0 0; padding: 14px 12px; outline-color: var(--primary-color); }
  dialog.sped .prow .del { cursor: pointer; color: var(--secondary-text-color); padding: 8px 8px 8px 4px; }
  dialog.sped .count { color: var(--secondary-text-color); font-size: .8em; padding: 3px 12px 0; }
  dialog.sped .link { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; color: var(--primary-color); font-size: .95em; padding: 2px 4px 10px; }
`;

const LABELS = {
  title: "Title", labels: "Labels", areas: "Areas",
  secondary: "Secondary info fields", sort: "Sort by", sort_dir: "Sort direction",
  secondary_template: "Jinja secondary line", buckets: "Numeric buckets", state_style: "State display",
  density: "Density", group_by: "Group by", show_search: "Show search box",
  show_group_selector: "Show group-by selector on card", list_rows: "Max visible rows",
  tap_action: "Tap action", diagnostics_button: "Show diagnostics (F12) button",
};
const HELPERS = {
  labels: "If set, the entity — or the device it belongs to — must ALSO carry one of these labels.",
  areas: "If set, entities must ALSO be in one of these areas.",
  list_rows: "Hard on-screen limit: the list shows this many rows and scrolls for the rest. Default 10.",
  sort_dir: "For Last changed: ascending = oldest first.",
  tap_action: "Perform-action with an empty target acts on the clicked entity.",
  secondary_template: "Jinja, rendered live per VISIBLE row only; entity_id holds the row's entity. Example: {{ states(entity_id) }} in {{ area_name(entity_id) }}",
  buckets: "Comma-separated thresholds for numeric sets, e.g. 20, 50 → chips <20 · 20–50 · >50. Empty = min/max inputs.",
  show_search: "A word-query box on the card, refining the list (matches ids and friendly names).",
  show_group_selector: "Lets the viewer switch grouping; their choice sticks per browser and overrides the Group by default.",
};
const OPT = {
  group_by: [["none", "No grouping"], ["floor", "Floor"], ["area", "Area"], ["state", "State"], ["domain", "Domain"]],
  density: [["comfortable", "Comfortable (two lines)"], ["compact", "Compact (one line)"]],
  state_style: [["text", "Text"], ["pill", "Pill"]],
  sort: [["name", "Name"], ["state", "State"], ["last_changed", "Last changed"]],
  sort_dir: [["asc", "Ascending"], ["desc", "Descending"]],
};
const optLabel = (k, v, dflt) => (OPT[k].find(([val]) => val === (v ?? dflt)) || [v, v])[1];
const sel = (name) => ({ name, selector: { select: { mode: "dropdown", options: OPT[name].map(([value, label]) => ({ value, label })) } } });

class SbEntityBrowserEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    if (!this._config.storage_id)
      this._config.storage_id = "seb-" + Math.random().toString(36).slice(2, 8);
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._form) this._form.hass = hass;
    // hass ticks are frequent; the counts don't need sub-second freshness.
    const now = Date.now();
    if (now - (this._lastCounts || 0) > 2000) {
      this._lastCounts = now;
      this._refreshCounts();
      if (first) this._renderOverview();
    }
  }

  // Debounced: emitting per keystroke makes the dialog re-render the preview
  // card on every character, which is what made typing sluggish. 400 ms sits
  // above a normal typing rhythm (150–350 ms between keys), so intermediate
  // patterns like "o" — which matches most of the estate — are never built.
  _emit(now = false) {
    clearTimeout(this._emitTimer);
    const go = () => fire(this, "config-changed", { config: this._config });
    now ? go() : (this._emitTimer = setTimeout(go, TYPING_QUIET_MS));
  }

  _set(patch, now = false) {
    this._config = { ...this._config, ...patch };
    this._emit(now);
    this._scheduleOverview();
  }

  // ---- overview -----------------------------------------------------------
  _scheduleOverview() {
    clearTimeout(this._ovTimer);
    this._ovTimer = setTimeout(() => this._renderOverview(), TYPING_QUIET_MS);
  }

  _total() {
    if (!this._hass) return null;
    try { return matchInfo(this._hass, this._config, null).ids.length; } catch (e) { return null; }
  }

  _summaryMatching() {
    const c = this._config;
    const pats = (c.patterns || []).filter((p) => p && p.trim());
    const total = this._total();
    return [
      ["Patterns", pats.length ? pats.map((p) => `<code>${esc(p)}</code>${/\$[a-zA-Z_][\w-]*(:\w+)?\$/.test(p) ? `<span class="chip">from a Param Card</span>` : ""}`).join(" ") : `<span class="off">none — labels/areas decide</span>`],
      ...((c.labels || []).length ? [["Labels", `${c.labels.length} <span class="chip">AND</span>`]] : []),
      ...((c.areas || []).length ? [["Areas", `${c.areas.length} <span class="chip">AND</span>`]] : []),
      ["Matches now", total == null ? `<span class="off">…</span>` : `<b>${total}</b> entit${total === 1 ? "y" : "ies"}${total > 500 ? ` <span class="warn">— large; consider a tighter pattern</span>` : ""}`],
    ];
  }

  _summaryDisplay() {
    const c = this._config;
    const sec = (c.secondary || []).map((k) => (SECONDARY_OPTIONS.find((o) => o.value === k) || { label: k }).label);
    return [
      ["Title", c.title ? esc(c.title) : `<span class="off">none</span>`],
      ["Row", `${optLabel("density", c.density, "comfortable")} · ${optLabel("state_style", c.state_style, "text")} state`],
      ["Secondary", sec.length ? esc(sec.join(", ")) : `<span class="off">none</span>`],
      ...(c.secondary_template ? [["Jinja line", `<code>${esc(String(c.secondary_template).slice(0, 48))}${String(c.secondary_template).length > 48 ? "…" : ""}</code>`]] : []),
      ["Group by", optLabel("group_by", c.group_by, "none")],
      ["Sort", `${optLabel("sort", c.sort, "name")} ${optLabel("sort_dir", c.sort_dir, "asc").toLowerCase()}`],
      ["Rows shown", `${c.list_rows || 10}${c.buckets ? ` · buckets ${esc(c.buckets)}` : ""}`],
    ];
  }

  _summaryControls() {
    const c = this._config;
    const on = (v) => (v ? "on" : `<span class="off">off</span>`);
    const a = c.tap_action || { action: "more-info" };
    return [
      ["Search box", on(c.show_search)],
      ["Group-by selector", on(c.show_group_selector)],
      ["Diagnostics button", on(c.diagnostics_button)],
      ["Tap action", esc((a.action || "more-info").replace(/[-_]/g, " ")) + (a.navigation_path ? ` <code>${esc(a.navigation_path)}</code>` : "") + (a.perform_action || a.service ? ` <code>${esc(a.perform_action || a.service)}</code>` : "")],
    ];
  }

  _renderOverview() {
    if (!this._ov) return;
    const sec = (id, title, rows) => `<div class="sec"><h3>${title}<button data-sec="${id}">Edit</button></h3>
      <div class="rows">${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div></div>`;
    this._ov.innerHTML =
      sec("matching", "Matching", this._summaryMatching()) +
      sec("display", "Display", this._summaryDisplay()) +
      sec("controls", "Controls", this._summaryControls()) +
      `<div class="note">Patterns, labels and areas are the card's identity. Words in one pattern are ANDed — put an SB Param Card's <code>$name$</code> inside a pattern (“fp300 $q$”) to let a dropdown narrow it; the search box narrows on top.</div>`;
    this._ov.querySelectorAll("button[data-sec]").forEach((b) => b.addEventListener("click", () => this._openDialog(b.dataset.sec)));
  }

  _render() {
    if (!this._ov) {
      this.classList.add("spe");
      const st = document.createElement("style");
      st.textContent = EDITOR_STYLE;
      this.appendChild(st);
      this._ov = document.createElement("div");
      this.appendChild(this._ov);
    }
    this._renderOverview();
  }

  // ---- dialogs -------------------------------------------------------------
  _openDialog(id) {
    this._closeDialog(false);
    this._open = id;
    this._snap = JSON.parse(JSON.stringify(this._config));
    const d = document.createElement("dialog");
    d.className = "sped";
    d.innerHTML = `<div class="ph"><span>${{ matching: "Matching", display: "Display", controls: "Controls" }[id]}</span><button class="x" title="Close">✕</button></div>
      <div class="pb"></div>
      <div class="pf"><button class="cancel">Cancel</button><button class="done">Done</button></div>`;
    this.appendChild(d);
    this._dlg = d;
    d.querySelector(".x").addEventListener("click", () => this._closeDialog(false));
    d.querySelector(".done").addEventListener("click", () => this._closeDialog(false));
    d.querySelector(".cancel").addEventListener("click", () => this._closeDialog(true));
    d.addEventListener("cancel", (e) => { e.preventDefault(); this._closeDialog(false); });   // Escape keeps (edits are live)
    d.addEventListener("close", () => { if (this._dlg === d) this._closeDialog(false); });
    this._renderDialogBody();
    d.showModal();
  }

  _closeDialog(restore) {
    const d = this._dlg;
    if (!d) return;
    this._dlg = null; this._open = null; this._form = null; this._patRows = null; this._patWrap = null;
    clearTimeout(this._emitTimer);
    if (restore && this._snap) { this._config = this._snap; }
    this._emit(true);                       // flush: a pending debounced edit, or the restore
    this._snap = null;
    try { d.close(); } catch (e) { /* already closed */ }
    d.remove();
    this._renderOverview();
  }

  _mkForm(schema, onChange) {
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.computeLabel = (s) => LABELS[s.name] || s.name;
    f.computeHelper = (s) => HELPERS[s.name];
    f.schema = schema;
    f.data = this._config;
    f.addEventListener("value-changed", (e) => { e.stopPropagation(); onChange(e.detail.value); });
    return f;
  }

  _renderDialogBody() {
    const d = this._dlg;
    if (!d) return;
    const body = d.querySelector(".pb");
    body.innerHTML = "";
    if (this._open === "matching") {
      const sub = document.createElement("div"); sub.className = "sub"; sub.textContent = "Entity patterns"; body.appendChild(sub);
      this._patWrap = document.createElement("div"); body.appendChild(this._patWrap);
      this._patRows = null;
      this._renderPatterns();
      this._form = this._mkForm([
        { name: "labels", selector: { label: { multiple: true } } },
        { name: "areas", selector: { area: { multiple: true } } },
      ], (v) => this._set(v));
      body.appendChild(this._form);
    } else if (this._open === "display") {
      this._form = this._mkForm([
        { name: "title", selector: { text: {} } },
        { name: "secondary", selector: { select: { multiple: true, mode: "dropdown", options: SECONDARY_OPTIONS } } },
        { name: "secondary_template", selector: { text: { multiline: true } } },
        sel("group_by"), sel("density"), sel("state_style"), sel("sort"), sel("sort_dir"),
        { name: "list_rows", selector: { number: { min: 3, max: 50, mode: "box" } } },
        { name: "buckets", selector: { text: {} } },
      ], (v) => this._set(v));
      body.appendChild(this._form);
    } else {
      this._form = this._mkForm([
        { name: "show_search", selector: { boolean: {} } },
        { name: "show_group_selector", selector: { boolean: {} } },
        { name: "diagnostics_button", selector: { boolean: {} } },
        { name: "tap_action", selector: { ui_action: {} } },
      ], (v) => this._set(v, true));
      body.appendChild(this._form);
    }
  }

  // ---- pattern rows (Matching dialog) ---------------------------------------
  // The live "Matches N entities" line is a full-estate scan per pattern row;
  // per keystroke that is a costly search too, so it waits for the same quiet.
  _scheduleCounts() {
    clearTimeout(this._countsTimer);
    this._countsTimer = setTimeout(() => this._refreshCounts(), TYPING_QUIET_MS);
  }

  _count(p) {
    if (!this._hass) return null;
    const m = patternMatcher(p);
    if (!m) return null;
    let n = 0;
    for (const id of Object.keys(this._hass.states)) {
      const st = this._hass.states[id];
      if (m(id, st.attributes.friendly_name, st.state, fmtState(this._hass, st))) n++;
    }
    return n;
  }

  _refreshCounts() {
    (this._patRows || []).forEach(({ input, count }) => {
      const n = this._count(input.value);
      count.textContent =
        n == null
          ? "Words match ids AND friendly names (any order, case-insensitive, * wildcards) — or an entity\u2019s exact state (“CR2450”). A $name$ from a wrapping SB Param Card works here too."
          : `Matches ${n} entit${n === 1 ? "y" : "ies"} now`;
    });
  }

  // Rebuild the pattern rows only when the row COUNT changes (add/delete);
  // on ordinary re-renders just sync values, skipping the focused field —
  // rebuilding on every keystroke would steal focus. Plain <input>s, NOT
  // ha-textfield: that component isn't reliably defined outside ha-form's
  // lazy loading, and pre-upgrade property sets are shadowed.
  _renderPatterns() {
    if (!this._patWrap) return;
    const pats = this._config.patterns || [];
    if (this._patRows && this._patRows.length === pats.length) {
      this._patRows.forEach(({ input }, i) => {
        if (document.activeElement !== input && input.value !== (pats[i] || ""))
          input.value = pats[i] || "";
      });
      this._refreshCounts();
      return;
    }
    this._patWrap.innerHTML = "";
    this._patRows = [];
    pats.forEach((p, i) => {
      const block = document.createElement("div");
      block.style.cssText = "margin-bottom:10px;";
      const row = document.createElement("div"); row.className = "prow";
      const input = document.createElement("input");
      input.type = "text";
      input.value = p || "";
      input.placeholder = "e.g. switch.rack_* or fp300 occupancy";
      input.autocomplete = "off";
      input.addEventListener("input", () => {
        const arr = [...(this._config.patterns || [])];
        arr[i] = input.value;
        this._set({ patterns: arr });
        this._scheduleCounts();
      });
      const del = document.createElement("ha-icon");
      del.icon = "mdi:delete-outline";
      del.title = "Remove pattern";
      del.className = "del";
      del.addEventListener("click", () => {
        const arr = [...(this._config.patterns || [])];
        arr.splice(i, 1);
        this._set({ patterns: arr }, true);
        this._renderPatterns();
      });
      row.append(input, del);
      const count = document.createElement("div"); count.className = "count";
      block.append(row, count);
      this._patWrap.appendChild(block);
      this._patRows.push({ input, count });
    });
    const add = document.createElement("div"); add.className = "link";
    add.innerHTML = `<ha-icon icon="mdi:plus"></ha-icon>Add pattern`;
    add.addEventListener("click", () => {
      this._set({ patterns: [...(this._config.patterns || []), ""] });
      this._renderPatterns();
      this._patRows[this._patRows.length - 1]?.input.focus();
    });
    this._patWrap.appendChild(add);
    this._refreshCounts();
  }
}

customElements.define(CARD, SbEntityBrowser);
customElements.define("sb-entity-browser-editor", SbEntityBrowserEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD,
  name: "SB Entity Browser",
  description: "Pattern-matched entity list with interactive state filter chips and an F12-style diagnostics mode. No helper entities.",
  preview: true,
  documentationURL: "https://github.com/snadboy/sb-entity-browser",
});
console.info(`%c SB-ENTITY-BROWSER %c v${VERSION} `, "background:#455a64;color:#fff", "background:#90a4ae;color:#000");
