/* SB Entity Browser — filterable entity list card for Home Assistant.
 * Vanilla custom element (no build step). GUI-configured, no helper entities:
 * filter selection is card-local UI state persisted per browser.
 */

const CARD = "sb-entity-browser";
const VERSION = "0.12.0";
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

  // Since 0.12.0 this card knows nothing about the URL. To filter it from an
  // SB Filter Select, wrap it in an SB Param Card and put that card's
  // $parameter$ in `filter` — the same path every other card takes.
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

  _filter() {
    const v = this._config?.filter;
    return v && String(v).trim() ? String(v).trim() : null;
  }

  // Two filter tiers: the card's own config (patterns/labels/areas) is the
  // BASE — the card's identity, always applied. `filter` (normally an SB
  // Param Card's $parameter$) and the search box are the OPTIONAL tier: they
  // only narrow within the base. A card configured with pattern * has
  // everything as its base, which recovers replace-like behavior when wanted.
  _filterMatcher() {
    return patternMatcher(this._filter());
  }

  _matches() {
    return matchInfo(this._hass, this._config, this._filterMatcher()).ids;
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
    const { ids, patCounts } = matchInfo(h, cfg, this._filterMatcher());

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
          ? `<div class="note">${ids.length} matched · ${rows.length} shown · ${this._tsubs.size} template subs${this._filter() ? ` · filter: “${esc(this._filter())}”` : ""} · v${VERSION}${
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

class SbEntityBrowserEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    if (!this._config.storage_id)
      this._config.storage_id = "seb-" + Math.random().toString(36).slice(2, 8);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._formTop) this._formTop.hass = hass;
    if (this._formRest) this._formRest.hass = hass;
    // hass ticks are frequent; the counts don't need sub-second freshness.
    const now = Date.now();
    if (now - (this._lastCounts || 0) > 2000) {
      this._lastCounts = now;
      this._refreshCounts();
    }
  }

  // Debounced: emitting per keystroke makes the dialog re-render the preview
  // card on every character, which is what made typing sluggish. 400 ms sits
  // above a normal typing rhythm (150–350 ms between keys), so intermediate
  // patterns like "o" — which matches most of the estate — are never built.
  _emit() {
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(
      () => fire(this, "config-changed", { config: this._config }), TYPING_QUIET_MS);
  }

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

  // Each pattern row's count line lives directly under its input.
  _refreshCounts() {
    (this._patRows || []).forEach(({ input, count }) => {
      const n = this._count(input.value);
      count.textContent =
        n == null
          ? "Matches ids and friendly names (any word order, case-insensitive, * wildcards) — or an entity\u2019s exact state (“CR2450”)"
          : `Matches ${n} entit${n === 1 ? "y" : "ies"} now`;
    });
  }

  // Rebuild the pattern rows only when the row COUNT changes (add/delete);
  // on ordinary re-renders just sync values, skipping the focused field —
  // rebuilding on every keystroke would steal focus. Plain <input>s, NOT
  // ha-textfield: that component isn't reliably defined outside ha-form's
  // lazy loading, and pre-upgrade property sets are shadowed (rendered as an
  // invisible unknown element).
  _renderPatterns() {
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
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:center; gap:4px;";
      const input = document.createElement("input");
      input.type = "text";
      input.value = p || "";
      input.placeholder = "e.g. switch.rack_* or fp300 occupancy";
      input.autocomplete = "off";
      input.style.cssText =
        "flex:1; box-sizing:border-box; font:inherit; color:var(--primary-text-color);" +
        "background:var(--mdc-text-field-fill-color, rgba(127,127,127,.12));" +
        "border:none; border-bottom:1px solid var(--divider-color);" +
        "border-radius:4px 4px 0 0; padding:14px 12px; outline-color:var(--primary-color);";
      input.addEventListener("input", () => {
        const arr = [...(this._config.patterns || [])];
        arr[i] = input.value;
        this._config = { ...this._config, patterns: arr };
        this._scheduleCounts();
        this._emit();
      });
      const del = document.createElement("ha-icon");
      del.icon = "mdi:delete-outline";
      del.title = "Remove pattern";
      del.style.cssText = "cursor:pointer; color:var(--secondary-text-color); padding:8px 8px 8px 4px;";
      del.addEventListener("click", () => {
        const arr = [...(this._config.patterns || [])];
        arr.splice(i, 1);
        this._config = { ...this._config, patterns: arr };
        this._renderPatterns();
        this._emit();
      });
      row.append(input, del);
      const count = document.createElement("div");
      count.style.cssText =
        "color:var(--secondary-text-color); font-size:.8em; padding:3px 12px 0;";
      block.append(row, count);
      this._patWrap.appendChild(block);
      this._patRows.push({ input, count });
    });
    const add = document.createElement("div");
    add.style.cssText =
      "display:inline-flex; align-items:center; gap:4px; cursor:pointer; color:var(--primary-color); font-size:.95em; padding:2px 4px 10px;";
    add.innerHTML = `<ha-icon icon="mdi:plus"></ha-icon>Add pattern`;
    add.addEventListener("click", () => {
      this._config = { ...this._config, patterns: [...(this._config.patterns || []), ""] };
      this._renderPatterns();
      this._patRows[this._patRows.length - 1]?.input.focus();
    });
    this._patWrap.appendChild(add);
    this._refreshCounts();
  }

  _render() {
    if (!this._formTop) {
      const helperMap = {
        filter: "Optional pattern applied WITHIN the patterns below. To drive it from an SB Filter Select, wrap this card in an SB Param Card and write its parameter here, e.g. $q$.",
        labels: "If set, the entity — or the device it belongs to — must ALSO carry one of these labels.",
        areas: "If set, entities must ALSO be in one of these areas.",
        list_rows: "Hard on-screen limit: the list shows this many rows and scrolls for the rest. Default 10.",
        sort_dir: "For Last changed: ascending = oldest first.",
        tap_action: "Perform-action with an empty target acts on the clicked entity.",
        secondary_template: "Jinja, rendered live per VISIBLE row only; entity_id holds the row's entity. Example: {{ states(entity_id) }} in {{ area_name(entity_id) }}",
        buckets: "Comma-separated thresholds for numeric sets, e.g. 20, 50 \u2192 chips <20 \u00b7 20\u201350 \u00b7 >50. Empty = min/max inputs.",
        show_search: "A word-query box on the card, refining the list (matches ids and friendly names).",
        show_group_selector: "Lets the viewer switch grouping; their choice sticks per browser and overrides the Group by default.",
      };
      const labelMap = {
        title: "Title",
        filter: "Narrowing filter",
        labels: "Labels",
        areas: "Areas",
        secondary: "Secondary info fields",
        sort: "Sort by",
        sort_dir: "Sort direction",
        secondary_template: "Jinja secondary line",
        buckets: "Numeric buckets",
        state_style: "State display",
        density: "Density",
        group_by: "Group by",
        show_search: "Show search box",
        show_group_selector: "Show group-by selector on card",
        list_rows: "Max visible rows",
        tap_action: "Tap action",
        diagnostics_button: "Show diagnostics (F12) button",
      };
      const mkForm = (schema) => {
        const f = document.createElement("ha-form");
        f.schema = schema;
        f.computeLabel = (s) => labelMap[s.name] || s.name;
        f.computeHelper = (s) => helperMap[s.name];
        f.addEventListener("value-changed", (e) => {
          this._config = { ...this._config, ...e.detail.value };
          this._emit();
        });
        return f;
      };
      this._formTop = mkForm([{ name: "title", selector: { text: {} } }, { name: "filter", selector: { text: {} } }]);
      // hass BEFORE appending, so the form's first render already has it.
      // (This did NOT fix the `localize` TypeError seen when the editor is
      // instantiated bare on a dashboard page: that throw is inside HA's
      // lazily-loaded ha-selector-label chunk, which ha-form pulls in while
      // rendering. Unconfirmed in the real edit dialog — see CLAUDE.md.)
      this._formTop.hass = this._hass;
      this.appendChild(this._formTop);

      const patLabel = document.createElement("div");
      patLabel.textContent = "Entity patterns";
      patLabel.style.cssText = "padding: 16px 0 8px; color: var(--primary-text-color);";
      this.appendChild(patLabel);
      this._patWrap = document.createElement("div");
      this.appendChild(this._patWrap);

      this._formRest = mkForm([
        { name: "labels", selector: { label: { multiple: true } } },
        { name: "areas", selector: { area: { multiple: true } } },
        {
          name: "secondary",
          selector: { select: { multiple: true, mode: "dropdown", options: SECONDARY_OPTIONS } },
        },
        {
          name: "group_by",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "none", label: "No grouping" },
                { value: "floor", label: "Floor" },
                { value: "area", label: "Area" },
                { value: "state", label: "State" },
                { value: "domain", label: "Domain" },
              ],
            },
          },
        },
        {
          name: "density",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "comfortable", label: "Comfortable (two lines)" },
                { value: "compact", label: "Compact (one line)" },
              ],
            },
          },
        },
        {
          name: "state_style",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "text", label: "Text" },
                { value: "pill", label: "Pill" },
              ],
            },
          },
        },
        { name: "secondary_template", selector: { text: { multiline: true } } },
        { name: "buckets", selector: { text: {} } },
        { name: "show_search", selector: { boolean: {} } },
        { name: "show_group_selector", selector: { boolean: {} } },
        {
          name: "sort",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "name", label: "Name" },
                { value: "state", label: "State" },
                { value: "last_changed", label: "Last changed" },
              ],
            },
          },
        },
        {
          name: "sort_dir",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ],
            },
          },
        },
        { name: "list_rows", selector: { number: { min: 3, max: 50, mode: "box" } } },
        { name: "tap_action", selector: { ui_action: {} } },
        { name: "diagnostics_button", selector: { boolean: {} } },
      ]);
      this._formRest.hass = this._hass;   // same ordering as _formTop
      this.appendChild(this._formRest);
    }
    this._formTop.hass = this._hass;
    this._formRest.hass = this._hass;
    this._formTop.data = this._config;
    this._formRest.data = this._config;
    this._renderPatterns();
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
