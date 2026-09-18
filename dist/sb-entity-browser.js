/* SB Entity Browser — filterable entity list card for Home Assistant.
 * Vanilla custom element (no build step). GUI-configured, no helper entities:
 * filter selection is card-local UI state persisted per browser.
 */

const CARD = "sb-entity-browser";
const VERSION = "0.3.0";

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
const globToRegex = (glob) =>
  new RegExp(glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, "."));

const entityAreaId = (hass, id) => {
  const reg = hass.entities?.[id];
  return reg?.area_id || hass.devices?.[reg?.device_id]?.area_id || null;
};

// Matching semantics: within a category any entry matches (OR); across the
// categories that are configured — patterns ∧ labels ∧ areas — ALL must be
// satisfied. An empty category doesn't constrain.
const matchInfo = (hass, config) => {
  // Index-aligned with config.patterns (blank entries match nothing).
  const regexes = (config.patterns || []).map((p) => (p && p.trim() ? globToRegex(p) : null));
  const active = regexes.filter(Boolean).length;
  const labels = config.labels || [];
  const areas = config.areas || [];
  const patCounts = new Array(regexes.length).fill(0);
  const ids = [];
  for (const id of Object.keys(hass.states)) {
    let pOk = active === 0;
    regexes.forEach((r, i) => {
      if (r && r.test(id)) {
        patCounts[i]++;
        pOk = true;
      }
    });
    if (!pOk) continue;
    if (labels.length) {
      const reg = hass.entities?.[id];
      if (!reg?.labels?.some((l) => labels.includes(l))) continue;
    }
    if (areas.length && !areas.includes(entityAreaId(hass, id))) continue;
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

class SbEntityBrowser extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._lastRender = 0;
    this._sig = "";
    this._diag = false;
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
    if (
      !config ||
      (!(config.patterns || []).length && !(config.labels || []).length && !(config.areas || []).length)
    ) {
      throw new Error("Configure at least one entity pattern, label, or area");
    }
    this._config = {
      secondary: ["state"],
      tap_action: { action: "more-info" },
      sort: "name",
      ...config,
    };
    this._storeKey = `sb-entity-browser-${this._config.storage_id || "default"}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this._storeKey) || "{}");
      this._selected = new Set(saved.states || []);
      this._min = saved.min ?? "";
      this._max = saved.max ?? "";
      this._diag = !!saved.diag;
    } catch (e) {
      this._selected = new Set();
      this._min = this._max = "";
    }
    this._sig = "";
    if (this._hass) this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Cheap change gate: re-render at most every 2s unless our entities changed.
    const now = Date.now();
    if (now - this._lastRender < 2000 && this._sig) {
      const sig = this._signature();
      if (sig === this._sig) return;
    }
    this._render();
  }

  getCardSize() {
    return 4;
  }

  _matches() {
    return matchInfo(this._hass, this._config).ids;
  }

  _signature() {
    const h = this._hass;
    return this._matches()
      .map((id) => id + "|" + h.states[id].state + "|" + h.states[id].last_updated)
      .join(";");
  }

  _persist() {
    try {
      localStorage.setItem(
        this._storeKey,
        JSON.stringify({ states: [...this._selected], min: this._min, max: this._max, diag: this._diag })
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
    const { ids, patCounts } = matchInfo(h, cfg);

    const stateObjs = ids.map((id) => [id, h.states[id]]);
    const isBad = (st) => ["unavailable", "unknown"].includes(st.state);
    const isNum = (st) => !isBad(st) && st.state !== "" && !isNaN(parseFloat(st.state)) && isFinite(st.state);
    // Numeric mode when a meaningful numeric population exists (a mixed set —
    // e.g. battery % sensors alongside battery_state text sensors — gets the
    // range for the numbers AND chips for the text states).
    const numericStates = stateObjs.filter(([, st]) => isNum(st));
    const numericMode =
      numericStates.length >= 8 && new Set(numericStates.map(([, st]) => st.state)).size > 8;

    // Distinct states with counts (numeric mode: only the non-numeric states chip)
    const counts = new Map();
    for (const [, st] of stateObjs)
      if (!numericMode || !isNum(st)) counts.set(st.state, (counts.get(st.state) || 0) + 1);

    // Filter: chips gate non-numeric rows; the range gates numeric rows
    let rows = stateObjs.filter(([, st]) => {
      if (numericMode && isNum(st)) {
        const v = parseFloat(st.state);
        if (this._min !== "" && v < parseFloat(this._min)) return false;
        if (this._max !== "" && v > parseFloat(this._max)) return false;
        return true;
      }
      return this._selected.size === 0 || this._selected.has(st.state);
    });

    // Sort
    const name = (id, st) => st.attributes.friendly_name || id;
    const sort = this._diag ? "diag" : cfg.sort || "name";
    rows.sort(([ia, sa], [ib, sb]) => {
      if (sort === "diag") {
        const ba = ["unavailable", "unknown"].includes(sa.state) ? 0 : 1;
        const bb = ["unavailable", "unknown"].includes(sb.state) ? 0 : 1;
        if (ba !== bb) return ba - bb;
        return sb.last_changed.localeCompare(sa.last_changed);
      }
      if (sort === "state") return sa.state.localeCompare(sb.state, undefined, { numeric: true });
      if (sort === "last_changed") return sb.last_changed.localeCompare(sa.last_changed);
      return name(ia, sa).localeCompare(name(ib, sb));
    });
    // With a visible-row cap the list scrolls, so render generously; without
    // one keep the old hard cap so a broad pattern can't flood the DOM.
    const listRows = parseInt(cfg.list_rows) || 0;
    const renderCap = listRows ? 500 : 100;
    const capped = rows.length > renderCap && !this._diag;
    if (capped) rows = rows.slice(0, renderCap);
    // Approximate row height (two text lines + padding); diagnostics adds a line.
    const rowEm = this._diag ? 4.1 : 3.3;
    const listStyle = listRows && rows.length > listRows
      ? `max-height:${(listRows * rowEm).toFixed(1)}em; overflow-y:auto;`
      : "";

    const chipsHtml = numericMode
      ? `<div class="chips">
           <input type="number" class="minmax" id="min" placeholder="min" value="${esc(this._min)}">
           <span class="dash">–</span>
           <input type="number" class="minmax" id="max" placeholder="max" value="${esc(this._max)}">
           ${[...counts.entries()]
             .sort((a, b) => b[1] - a[1])
             .slice(0, 10)
             .map(([s, c]) => this._chip(s, c))
             .join("")}
         </div>`
      : `<div class="chips">${[...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([s, c]) => this._chip(s, c))
          .join("")}</div>`;

    const rowsHtml = rows
      .map(([id, st]) => {
        const bad = ["unavailable", "unknown"].includes(st.state);
        return `
        <div class="row ${bad ? "bad" : ""}" data-entity="${esc(id)}" role="button" tabindex="0">
          <ha-state-icon class="icon"></ha-state-icon>
          <div class="body">
            <div class="name">${esc(name(id, st))}</div>
            <div class="sec">${esc(this._secondaryText(id, st))}</div>
            ${this._diag ? `<div class="diag-line">${esc(id)} · updated ${esc(relTime(st.last_updated))}</div>` : ""}
          </div>
          <div class="state">${esc(st.state)}${st.attributes.unit_of_measurement ? " " + esc(st.attributes.unit_of_measurement) : ""}</div>
        </div>`;
      })
      .join("");

    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 12px 16px 8px; }
        .header { display: flex; align-items: center; gap: 8px; }
        .title { font-size: 1.2em; font-weight: 500; flex: 1; color: var(--primary-text-color); }
        .diag-btn { cursor: pointer; color: var(--secondary-text-color); --mdc-icon-size: 20px; padding: 4px; border-radius: 50%; }
        .diag-btn.on { color: var(--primary-color); background: rgba(var(--rgb-primary-color, 33,150,243), .12); }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
        .chip { cursor: pointer; user-select: none; font-size: .85em; padding: 3px 10px; border-radius: 12px;
                border: 1px solid var(--divider-color); color: var(--secondary-text-color); }
        .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
        .chip .n { opacity: .7; margin-left: 4px; }
        .minmax { width: 70px; background: none; border: 1px solid var(--divider-color); border-radius: 8px;
                  color: var(--primary-text-color); padding: 3px 8px; }
        .dash { color: var(--secondary-text-color); align-self: center; }
        .row { display: flex; align-items: center; gap: 12px; padding: 7px 0; cursor: pointer;
               border-radius: 8px; }
        .row:hover { background: rgba(var(--rgb-primary-text-color, 0,0,0), .05); }
        .row.bad .state { color: var(--error-color); }
        .icon { color: var(--state-icon-color, var(--paper-item-icon-color)); flex: none; }
        .body { flex: 1; min-width: 0; }
        .name { color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sec, .diag-line { color: var(--secondary-text-color); font-size: .85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .diag-line { font-family: monospace; font-size: .78em; }
        .state { color: var(--primary-text-color); font-weight: 500; white-space: nowrap; }
        .empty, .note { color: var(--secondary-text-color); font-style: italic; padding: 12px 0; }
        .note { font-size: .8em; padding: 4px 0; }
      </style>
      <ha-card>
        <div class="header">
          <div class="title">${esc(cfg.title || "")}</div>
          ${cfg.diagnostics_button
            ? `<ha-icon class="diag-btn ${this._diag ? "on" : ""}" icon="mdi:stethoscope" title="Toggle diagnostics"></ha-icon>`
            : ""}
        </div>
        ${chipsHtml}
        ${this._diag
          ? `<div class="note">${ids.length} matched · ${rows.length} shown · v${VERSION}${
              (cfg.patterns || []).length > 1
                ? " — " + (cfg.patterns || []).map((p, i) => `${esc(p)}: ${patCounts[i]}`).join(" · ")
                : ""}</div>`
          : ""}
        <div class="list" style="${listStyle}">${rowsHtml || `<div class="empty">No entities match</div>`}</div>
        ${capped ? `<div class="note">List capped at ${renderCap} — narrow the filter (diagnostics shows all)</div>` : ""}
      </ha-card>`;

    // Wire up
    this.shadowRoot.querySelectorAll(".row").forEach((el) => {
      const id = el.dataset.entity;
      const icon = el.querySelector("ha-state-icon");
      if (icon) {
        icon.hass = h;
        icon.stateObj = h.states[id];
      }
      el.addEventListener("click", () => this._handleTap(id));
      el.addEventListener("keydown", (e) => e.key === "Enter" && this._handleTap(id));
    });
    this.shadowRoot.querySelectorAll(".chip").forEach((el) => {
      el.addEventListener("click", () => {
        const s = el.dataset.state;
        this._selected.has(s) ? this._selected.delete(s) : this._selected.add(s);
        this._persist();
        this._render();
      });
    });
    const diagBtn = this.shadowRoot.querySelector(".diag-btn");
    if (diagBtn)
      diagBtn.addEventListener("click", () => {
        this._diag = !this._diag;
        this._persist();
        this._render();
      });
    for (const key of ["min", "max"]) {
      const inp = this.shadowRoot.getElementById(key);
      if (inp)
        inp.addEventListener("change", () => {
          this[`_${key}`] = inp.value;
          this._persist();
          this._render();
        });
    }
  }

  _chip(state, count) {
    return `<span class="chip ${this._selected.has(state) ? "on" : ""}" data-state="${esc(state)}">${esc(state)}<span class="n">${count}</span></span>`;
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
    this._refreshCounts();
  }

  _emit() {
    fire(this, "config-changed", { config: this._config });
  }

  _count(p) {
    if (!this._hass || !p || !p.trim()) return null;
    const r = globToRegex(p);
    let n = 0;
    for (const id of Object.keys(this._hass.states)) if (r.test(id)) n++;
    return n;
  }

  // Each pattern row's helper line shows its own live match count.
  _refreshCounts() {
    (this._patRows || []).forEach((tf) => {
      const n = this._count(tf.value);
      tf.helper =
        n == null
          ? "Implied *…* wildcards — “battery” means “*battery*”"
          : `Matches ${n} entit${n === 1 ? "y" : "ies"} now`;
      tf.helperPersistent = true;
    });
  }

  // Rebuild the pattern rows only when the row COUNT changes (add/delete);
  // on ordinary re-renders just sync values, skipping the focused field —
  // rebuilding on every keystroke would steal focus.
  _renderPatterns() {
    const pats = this._config.patterns || [];
    if (this._patRows && this._patRows.length === pats.length) {
      this._patRows.forEach((tf, i) => {
        if (document.activeElement !== tf && tf.value !== (pats[i] || "")) tf.value = pats[i] || "";
      });
      this._refreshCounts();
      return;
    }
    this._patWrap.innerHTML = "";
    this._patRows = [];
    pats.forEach((p, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; align-items:flex-start; gap:4px; margin-bottom:8px;";
      const tf = document.createElement("ha-textfield");
      tf.label = `Pattern ${i + 1}`;
      tf.value = p || "";
      tf.style.cssText = "flex:1;";
      tf.addEventListener("input", () => {
        const arr = [...(this._config.patterns || [])];
        arr[i] = tf.value;
        this._config = { ...this._config, patterns: arr };
        this._refreshCounts();
        this._emit();
      });
      const del = document.createElement("ha-icon");
      del.icon = "mdi:delete-outline";
      del.title = "Remove pattern";
      del.style.cssText = "cursor:pointer; color:var(--secondary-text-color); padding:16px 8px 0 4px;";
      del.addEventListener("click", () => {
        const arr = [...(this._config.patterns || [])];
        arr.splice(i, 1);
        this._config = { ...this._config, patterns: arr };
        this._renderPatterns();
        this._emit();
      });
      row.append(tf, del);
      this._patWrap.appendChild(row);
      this._patRows.push(tf);
    });
    const add = document.createElement("div");
    add.style.cssText =
      "display:inline-flex; align-items:center; gap:4px; cursor:pointer; color:var(--primary-color); font-size:.95em; padding:2px 4px 10px;";
    add.innerHTML = `<ha-icon icon="mdi:plus"></ha-icon>Add pattern`;
    add.addEventListener("click", () => {
      this._config = { ...this._config, patterns: [...(this._config.patterns || []), ""] };
      this._renderPatterns();
      this._patRows[this._patRows.length - 1]?.focus();
    });
    this._patWrap.appendChild(add);
    this._refreshCounts();
  }

  _render() {
    if (!this._formTop) {
      const helperMap = {
        labels: "If set, entities must ALSO carry one of these labels.",
        areas: "If set, entities must ALSO be in one of these areas.",
        list_rows: "The list scrolls beyond this many rows. Empty = no limit.",
        tap_action: "Perform-action with an empty target acts on the clicked entity.",
      };
      const labelMap = {
        title: "Title",
        labels: "Labels",
        areas: "Areas",
        secondary: "Secondary info fields",
        sort: "Sort by",
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
      this._formTop = mkForm([{ name: "title", selector: { text: {} } }]);
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
        { name: "list_rows", selector: { number: { min: 3, max: 50, mode: "box" } } },
        { name: "tap_action", selector: { ui_action: {} } },
        { name: "diagnostics_button", selector: { boolean: {} } },
      ]);
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
