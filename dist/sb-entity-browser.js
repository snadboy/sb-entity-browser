/* SB Entity Browser — filterable entity list card for Home Assistant.
 * Vanilla custom element (no build step). GUI-configured, no helper entities:
 * filter selection is card-local UI state persisted per browser.
 */

const CARD = "sb-entity-browser";
const VERSION = "0.1.0";

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

const globToRegex = (glob) =>
  new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

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
      patterns: ["sensor.*_battery*"],
      secondary: ["area", "last_changed"],
      tap_action: { action: "more-info" },
      diagnostics_button: true,
      storage_id: "seb-" + Math.random().toString(36).slice(2, 8),
    };
  }

  setConfig(config) {
    if (!config || (!(config.patterns || []).length && !(config.labels || []).length)) {
      throw new Error("Configure at least one entity pattern or label");
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
    const h = this._hass;
    const regexes = (this._config.patterns || []).map(globToRegex);
    const labels = this._config.labels || [];
    const out = [];
    for (const id of Object.keys(h.states)) {
      let ok = regexes.some((r) => r.test(id));
      if (!ok && labels.length) {
        const reg = h.entities?.[id];
        ok = !!reg?.labels?.some((l) => labels.includes(l));
      }
      if (ok) out.push(id);
    }
    return out;
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
    const h = this._hass;
    const reg = h.entities?.[id];
    const areaId = reg?.area_id || h.devices?.[reg?.device_id]?.area_id;
    return h.areas?.[areaId]?.name || "";
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
      if (domain && service)
        this._hass.callService(domain, service, a.data || a.service_data || {}, a.target || { entity_id: id });
    }
  }

  _render() {
    this._lastRender = Date.now();
    this._sig = this._signature();
    const h = this._hass;
    const cfg = this._config;
    const ids = this._matches();

    const stateObjs = ids.map((id) => [id, h.states[id]]);
    const numericVals = stateObjs
      .filter(([, st]) => !["unavailable", "unknown"].includes(st.state))
      .map(([, st]) => parseFloat(st.state));
    const numericMode =
      numericVals.length > 0 && numericVals.every((v) => !isNaN(v)) &&
      new Set(stateObjs.map(([, st]) => st.state)).size > 8;

    // Distinct states with counts
    const counts = new Map();
    for (const [, st] of stateObjs) counts.set(st.state, (counts.get(st.state) || 0) + 1);

    // Filter
    let rows = stateObjs.filter(([, st]) => {
      const bad = ["unavailable", "unknown"].includes(st.state);
      if (numericMode) {
        if (bad) return this._selected.size === 0 || this._selected.has(st.state);
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
    const capped = rows.length > 100 && !this._diag;
    if (capped) rows = rows.slice(0, 100);

    const chipsHtml = numericMode
      ? `<div class="chips">
           <input type="number" class="minmax" id="min" placeholder="min" value="${esc(this._min)}">
           <span class="dash">–</span>
           <input type="number" class="minmax" id="max" placeholder="max" value="${esc(this._max)}">
           ${["unavailable", "unknown"]
             .filter((s) => counts.get(s))
             .map((s) => this._chip(s, counts.get(s)))
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
        ${this._diag ? `<div class="note">${ids.length} matched · ${rows.length} shown · v${VERSION}</div>` : ""}
        <div class="list">${rowsHtml || `<div class="empty">No entities match</div>`}</div>
        ${capped ? `<div class="note">List capped at 100 — narrow the filter (diagnostics shows all)</div>` : ""}
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
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) =>
        ({
          title: "Title",
          patterns: "Entity patterns (globs, e.g. sensor.*_battery*)",
          labels: "Or match entities by label",
          secondary: "Secondary info fields",
          sort: "Sort by",
          tap_action: "Tap action",
          diagnostics_button: "Show diagnostics (F12) button",
        }[s.name] || s.name);
      this._form.addEventListener("value-changed", (e) => {
        this._config = { ...this._config, ...e.detail.value };
        fire(this, "config-changed", { config: this._config });
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = [
      { name: "title", selector: { text: {} } },
      { name: "patterns", selector: { text: { multiple: true } } },
      { name: "labels", selector: { label: { multiple: true } } },
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
      { name: "tap_action", selector: { ui_action: {} } },
      { name: "diagnostics_button", selector: { boolean: {} } },
    ];
    this._form.data = this._config;
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
