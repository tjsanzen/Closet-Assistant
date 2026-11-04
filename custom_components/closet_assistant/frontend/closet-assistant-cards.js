/*
 * Closet Assistant cards
 *   custom:closet-assistant-today-card   - "Wear Today"
 *   custom:closet-assistant-closet-card  - "Manage Closet"
 * Served and auto-loaded by the closet_assistant integration. No build step.
 */
const CA_VERSION = "0.1.0";
const DOMAIN = "closet_assistant";

/* ------------------------------------------------------------------ shared store */
const caStore = {
  data: null,
  error: null,
  conn: null,
  listeners: new Set(),
  connect(hass) {
    if (!hass || this.conn === hass.connection) return;
    this.conn = hass.connection;
    hass.connection
      .subscribeMessage(
        (msg) => {
          this.data = msg;
          this.error = null;
          this.emit();
        },
        { type: `${DOMAIN}/subscribe` }
      )
      .catch((err) => {
        this.error = (err && err.message) || "Closet Assistant is not set up yet.";
        this.conn = null;
        this.emit();
      });
  },
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  emit() {
    for (const fn of this.listeners) fn(this.data);
  },
};

const ws = (hass, cmd, payload = {}) => hass.callWS({ type: `${DOMAIN}/${cmd}`, ...payload });

/* ------------------------------------------------------------------ helpers */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const WEATHER_ICONS = {
  "clear-night": "mdi:weather-night", cloudy: "mdi:weather-cloudy", exceptional: "mdi:alert-circle-outline",
  fog: "mdi:weather-fog", hail: "mdi:weather-hail", lightning: "mdi:weather-lightning",
  "lightning-rainy": "mdi:weather-lightning-rainy", partlycloudy: "mdi:weather-partly-cloudy",
  pouring: "mdi:weather-pouring", rainy: "mdi:weather-rainy", snowy: "mdi:weather-snowy",
  "snowy-rainy": "mdi:weather-snowy-rainy", sunny: "mdi:weather-sunny", windy: "mdi:weather-windy",
  "windy-variant": "mdi:weather-windy-variant",
};

const SLOT_LABELS = {
  hat: "Hat", outer: "Outer layer", mid: "Mid layer", top: "Top", accessory: "Accessory",
  belt: "Belt", bottom: "Bottom", socks: "Socks", shoes: "Shoes", underwear: "Underwear",
};

function daysAgo(iso) {
  if (!iso) return "never worn";
  const then = new Date(iso + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = Math.round((now - then) / 86400000);
  if (d <= 0) return "worn today";
  if (d === 1) return "worn yesterday";
  return `worn ${d}d ago`;
}

function weekdayName(iso) {
  if (!iso) return "-";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtTemp(v) {
  return v === null || v === undefined ? "--" : `${Math.round(v)}°`;
}

function itemVisual(item, categories) {
  const icon = (categories && categories[item.category] && categories[item.category].icon) || "mdi:hanger";
  return `<div class="img" style="--c:${esc(item.color)}">
      ${item.image_url
        ? `<img src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy">`
        : `<ha-icon icon="${esc(icon)}" style="color:${esc(item.color)}"></ha-icon>`}
    </div>`;
}

function pips(item) {
  if (!item.tracks_cleanliness) return "";
  const max = item.max_wears_effective || 1;
  const left = item.cleanliness ?? max;
  let out = "";
  for (let i = 0; i < Math.min(max, 10); i++) out += `<i class="${i < left ? "on" : ""}"></i>`;
  return `<span class="pips" title="${left} of ${max} wears left">${out}</span>`;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

function dominantColor(img) {
  const n = 48;
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, n, n);
  const d = ctx.getImageData(0, 0, n, n).data;
  const px = (x, y) => (y * n + x) * 4;
  const corners = [px(0, 0), px(n - 1, 0), px(0, n - 1), px(n - 1, n - 1)];
  let bg = null;
  if (corners.every((i) => d[i + 3] > 250)) {
    bg = [0, 1, 2].map((k) => corners.reduce((s, i) => s + d[i + k], 0) / 4);
  }
  const buckets = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    if (bg && Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) < 40) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best) return null;
  const hex = (v) => Math.round(v / best.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

async function prepareImage(file) {
  const img = await loadImage(file);
  const max = 640;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  let dataUrl = c.toDataURL("image/webp", 0.9);
  if (!dataUrl.startsWith("data:image/webp")) dataUrl = c.toDataURL("image/png");
  return { dataUrl, color: dominantColor(img) };
}

const SHARED_CSS = `
  :host { display:block; }
  ha-card { padding:16px; overflow:hidden; }
  button { font:inherit; cursor:pointer; border:none; border-radius:999px; padding:8px 14px;
    background:var(--secondary-background-color); color:var(--primary-text-color); display:inline-flex; align-items:center; gap:6px; }
  button:hover { filter:brightness(0.96); }
  button.primary { background:var(--primary-color); color:var(--text-primary-color, #fff); }
  button.danger { color:var(--error-color, #db4437); }
  button.small { padding:5px 10px; font-size:0.85em; }
  button[disabled] { opacity:.55; cursor:default; }
  button ha-icon { --mdc-icon-size:18px; }
  .muted { color:var(--secondary-text-color); }
  .img { position:relative; aspect-ratio:1/1; border-radius:12px; display:flex; align-items:center; justify-content:center;
    background:color-mix(in srgb, var(--c, #888) 14%, var(--secondary-background-color)); overflow:hidden; }
  .img img { width:88%; height:88%; object-fit:contain; filter:drop-shadow(0 2px 4px rgba(0,0,0,.18)); }
  .img ha-icon { --mdc-icon-size:44%; opacity:.85; }
  .pips { display:inline-flex; gap:3px; }
  .pips i { width:7px; height:7px; border-radius:50%; background:var(--divider-color); }
  .pips i.on { background:var(--success-color, #43a047); }
  .err { padding:16px; color:var(--error-color, #db4437); }
`;

/* ================================================================== WEAR TODAY */
class ClosetAssistantTodayCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._busy = false;
    this._showWhy = false;
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
  }
  setConfig(config) {
    this._config = config || {};
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    caStore.connect(hass);
  }
  connectedCallback() {
    this._off = caStore.on(() => this._render());
    this._render();
  }
  disconnectedCallback() {
    if (this._off) this._off();
  }
  getCardSize() {
    return 8;
  }
  static getStubConfig() {
    return {};
  }

  async _onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn || this._busy) return;
    const action = btn.dataset.action;
    if (action === "why") {
      this._showWhy = !this._showWhy;
      return this._render();
    }
    this._busy = true;
    this._render();
    try {
      if (action === "randomize") await ws(this._hass, "randomize");
      if (action === "wear") await ws(this._hass, "wear");
    } catch (err) {
      this._toast = err.message || String(err);
    }
    this._busy = false;
    this._render();
  }

  _tile(item, cats, small = false) {
    return `<div class="tile ${item.removable ? "removable" : ""} ${small ? "small" : ""}" title="${esc(item.name)}">
      ${itemVisual(item, cats)}
      ${item.removable ? `<span class="badge">shed later</span>` : ""}
      <div class="cap">${esc(item.name)}</div>
      ${small ? "" : `<div class="slot">${esc(SLOT_LABELS[item.slot] || "")}</div>`}
    </div>`;
  }

  _render() {
    if (!this.shadowRoot) return;
    const d = caStore.data;
    const title = this._config && this._config.title;
    let body;
    if (caStore.error) {
      body = `<div class="err">${esc(caStore.error)}</div>`;
    } else if (!d) {
      body = `<div class="muted" style="padding:24px;text-align:center">Opening the closet...</div>`;
    } else {
      const w = d.weather || {};
      const t = d.today || { items: [], notes: [] };
      const cats = d.categories;
      const by = {};
      for (const it of t.items || []) by[it.slot] = it;
      const layers = ["top", "mid", "outer"].filter((s) => by[s]);
      const lower = ["bottom", "belt", "shoes"].filter((s) => by[s]);
      const extras = ["hat", "accessory"].filter((s) => by[s]);
      const basics = ["underwear", "socks"].filter((s) => by[s]);
      const removable = (t.items || []).filter((i) => i.removable);
      const meta = [];
      if (w.precip_prob !== null && w.precip_prob !== undefined) meta.push(`<span><ha-icon icon="mdi:water-percent"></ha-icon>${Math.round(w.precip_prob)}%</span>`);
      if (w.uv !== null && w.uv !== undefined) meta.push(`<span><ha-icon icon="mdi:sun-wireless-outline"></ha-icon>UV ${esc(w.uv)}</span>`);
      if (w.wind_mph) meta.push(`<span><ha-icon icon="mdi:weather-windy"></ha-icon>${Math.round(w.wind_mph)} mph</span>`);

      body = `
        <div class="wx">
          <ha-icon class="wx-icon" icon="${WEATHER_ICONS[w.condition] || "mdi:weather-partly-cloudy"}"></ha-icon>
          <div class="temps">
            <div><span class="hi">${fmtTemp(w.high)}</span><span class="lo"> / ${fmtTemp(w.low)}</span></div>
            <div class="muted cond">${esc((w.condition || "").replace("partlycloudy", "partly cloudy").replace(/-/g, " "))}</div>
          </div>
          <div class="wx-meta muted">${meta.join("")}</div>
        </div>
        ${removable.length
          ? `<div class="banner"><ha-icon icon="mdi:layers-triple-outline"></ha-icon>
             Big swing today. Start layered, shed the ${removable.map((i) => esc(i.name)).join(" and ")} by the afternoon.</div>`
          : ""}
        ${t.items && t.items.length
          ? `<div class="lay">
              <div class="row layers">${layers.map((s) => this._tile(by[s], cats)).join('<span class="plus">+</span>')}</div>
              <div class="row">${lower.map((s) => this._tile(by[s], cats)).join("")}${extras.map((s) => this._tile(by[s], cats)).join("")}</div>
              ${basics.length ? `<div class="basics muted">${basics.map((s) => `<span class="chip"><span class="dot" style="background:${esc(by[s].color)}"></span>${esc(by[s].name)}</span>`).join("")}</div>` : ""}
            </div>`
          : `<div class="empty muted">${esc((t.notes || [])[0] || "No outfit yet. Add clothes in the Manage Closet card.")}</div>`}
        ${this._showWhy && t.notes && t.notes.length ? `<ul class="why">${t.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        ${this._toast ? `<div class="err small-err">${esc(this._toast)}</div>` : ""}
        <div class="actions">
          <button class="small" data-action="randomize" ${this._busy ? "disabled" : ""} title="Pick a different outfit">
            <ha-icon icon="mdi:dice-multiple"></ha-icon>Randomize</button>
          ${t.notes && t.notes.length ? `<button class="small" data-action="why"><ha-icon icon="mdi:information-outline"></ha-icon>${this._showWhy ? "Hide" : "Why this?"}</button>` : ""}
          <span style="flex:1"></span>
          ${t.items && t.items.length
            ? t.worn
              ? `<button class="small" disabled><ha-icon icon="mdi:check"></ha-icon>Worn today</button>`
              : `<button class="small primary" data-action="wear" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:hanger"></ha-icon>Wear this</button>`
            : ""}
        </div>`;
    }
    this._toast = null;
    this.shadowRoot.innerHTML = `<style>${SHARED_CSS}${TODAY_CSS}</style>
      <ha-card>${title ? `<div class="title">${esc(title)}</div>` : ""}${body}</ha-card>`;
  }
}

const TODAY_CSS = `
  .title { font-size:1.2em; font-weight:500; margin-bottom:8px; }
  .wx { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  .wx-icon { --mdc-icon-size:44px; color:var(--state-icon-color, var(--primary-color)); }
  .temps .hi { font-size:2em; font-weight:500; }
  .temps .lo { font-size:1.3em; color:var(--secondary-text-color); }
  .cond { text-transform:capitalize; font-size:.85em; }
  .wx-meta { margin-left:auto; display:flex; flex-direction:column; align-items:flex-end; gap:2px; font-size:.85em; }
  .wx-meta span { display:inline-flex; align-items:center; gap:3px; }
  .wx-meta ha-icon { --mdc-icon-size:16px; }
  .banner { display:flex; gap:8px; align-items:flex-start; padding:8px 12px; border-radius:10px; margin-bottom:12px; font-size:.9em;
    background:color-mix(in srgb, var(--primary-color) 12%, transparent); }
  .banner ha-icon { --mdc-icon-size:18px; flex:none; }
  .lay { display:flex; flex-direction:column; gap:10px; }
  .row { display:flex; gap:8px; align-items:flex-start; justify-content:center; flex-wrap:wrap; }
  .plus { align-self:center; color:var(--secondary-text-color); font-size:1.3em; margin-top:-24px; }
  .tile { position:relative; width:min(30%, 140px); text-align:center; }
  .tile.removable .img { outline:2px dashed var(--primary-color); outline-offset:-2px; }
  .tile .badge { position:absolute; top:6px; left:50%; transform:translateX(-50%); font-size:.7em; white-space:nowrap;
    background:var(--primary-color); color:var(--text-primary-color, #fff); padding:1px 7px; border-radius:999px; }
  .tile .cap { font-size:.85em; margin-top:4px; line-height:1.2; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
  .tile .slot { font-size:.72em; color:var(--secondary-text-color); }
  .basics { display:flex; gap:8px; justify-content:center; flex-wrap:wrap; font-size:.8em; }
  .chip { display:inline-flex; align-items:center; gap:5px; padding:2px 8px; border-radius:999px; background:var(--secondary-background-color); }
  .dot { width:9px; height:9px; border-radius:50%; border:1px solid var(--divider-color); }
  .why { margin:12px 0 0; padding-left:18px; font-size:.85em; color:var(--secondary-text-color); }
  .why li { margin-bottom:3px; }
  .empty { padding:24px 8px; text-align:center; }
  .actions { display:flex; gap:6px; align-items:center; margin-top:14px; }
  .small-err { padding:8px 0 0; font-size:.85em; }
`;

/* ================================================================== MANAGE CLOSET */
const RATING_FIELDS = [
  ["warmth", "Warmth", "Thin", "Very warm"],
  ["waterproof", "Waterproof", "None", "Storm-proof"],
  ["form_fit", "Form fit", "Loose / oversized", "Tight / fitted"],
  ["uv", "UV protection", "Sheer", "UPF 50+"],
  ["structure", "Structure", "Fluid / drapey", "Rigid / tailored"],
];

class ClosetAssistantClosetCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._filter = "all";
    this._search = "";
    this._dirtyOnly = false;
    this._draft = null;
    this._confirm = null;
    this._menu = false;
    this._busy = false;
    this.shadowRoot.innerHTML = `<style>${SHARED_CSS}${CLOSET_CSS}</style>
      <ha-card><div id="main"></div></ha-card><div id="modal"></div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <input type="file" id="imageFile" accept="image/*" hidden>`;
    this.$main = this.shadowRoot.getElementById("main");
    this.$modal = this.shadowRoot.getElementById("modal");
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this.shadowRoot.addEventListener("input", (e) => this._onInput(e));
    this.shadowRoot.addEventListener("change", (e) => this._onChange(e));
  }
  setConfig(config) {
    this._config = config || {};
  }
  set hass(hass) {
    this._hass = hass;
    caStore.connect(hass);
  }
  connectedCallback() {
    this._off = caStore.on(() => this._renderMain());
    this._renderMain();
  }
  disconnectedCallback() {
    if (this._off) this._off();
  }
  getCardSize() {
    return 10;
  }
  static getStubConfig() {
    return {};
  }

  /* ---------------------------------------------------------- list */
  _renderMain() {
    const d = caStore.data;
    if (caStore.error) {
      this.$main.innerHTML = `<div class="err">${esc(caStore.error)}</div>`;
      return;
    }
    if (!d) {
      this.$main.innerHTML = `<div class="muted" style="padding:24px;text-align:center">Opening the closet...</div>`;
      return;
    }
    const cats = d.categories;
    const counts = {};
    for (const it of d.items) counts[it.category] = (counts[it.category] || 0) + 1;
    const q = this._search.trim().toLowerCase();
    const items = d.items
      .filter((i) => this._filter === "all" || i.category === this._filter)
      .filter((i) => !this._dirtyOnly || !i.clean)
      .filter((i) => !q || `${i.name} ${i.color_name} ${i.pattern} ${i.fabric || ""}`.toLowerCase().includes(q))
      .sort((a, b) => Object.keys(cats).indexOf(a.category) - Object.keys(cats).indexOf(b.category) || a.name.localeCompare(b.name));
    const title = (this._config && this._config.title) || "Closet";

    this.$main.innerHTML = `
      <div class="head">
        <div>
          <div class="title">${esc(title)}</div>
          <div class="muted stats">${d.counts.total} items · ${d.counts.clean} clean · ${d.counts.dirty} in the hamper · laundry ${esc(weekdayName(d.next_laundry))}</div>
        </div>
        <div class="tools">
          <button class="small primary" data-action="add"><ha-icon icon="mdi:plus"></ha-icon>Add</button>
          <button class="small" data-action="wash-all"><ha-icon icon="mdi:washing-machine"></ha-icon>Wash closet</button>
          <div class="menu-wrap">
            <button class="small" data-action="menu" title="More"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
            ${this._menu ? `<div class="menu">
              <button data-action="import"><ha-icon icon="mdi:upload"></ha-icon>Import JSON</button>
              <button data-action="export"><ha-icon icon="mdi:download"></ha-icon>Export JSON</button>
              <button data-action="scan"><ha-icon icon="mdi:folder-image"></ha-icon>Scan image folder</button>
            </div>` : ""}
          </div>
        </div>
      </div>
      <div class="filters">
        <input class="search" type="search" placeholder="Search name, colour, fabric..." value="${esc(this._search)}" data-ui="search">
        <label class="toggle"><input type="checkbox" data-ui="dirty" ${this._dirtyOnly ? "checked" : ""}> In hamper only</label>
      </div>
      <div class="chips">
        <button class="chip ${this._filter === "all" ? "sel" : ""}" data-action="filter" data-cat="all">All ${d.items.length}</button>
        ${Object.entries(cats).filter(([k]) => counts[k]).map(([k, m]) =>
          `<button class="chip ${this._filter === k ? "sel" : ""}" data-action="filter" data-cat="${k}">${esc(m.label.split(" (")[0])} ${counts[k]}</button>`).join("")}
      </div>
      ${this._toast ? `<div class="toast">${esc(this._toast)}</div>` : ""}
      ${items.length
        ? `<div class="grid">${items.map((i) => `
            <div class="item ${i.clean ? "" : "dirty"}" data-action="edit" data-id="${esc(i.id)}">
              ${itemVisual(i, cats)}
              ${i.needs_review ? `<span class="flag">review</span>` : !i.clean ? `<span class="flag hamper">hamper</span>` : ""}
              <div class="name">${esc(i.name)}</div>
              <div class="sub muted">${pips(i)}<span>${esc(daysAgo(i.last_worn))}</span></div>
            </div>`).join("")}</div>`
        : `<div class="empty muted">${d.items.length ? "Nothing matches that filter." : "Your closet is empty. Add an item, import a JSON file, or drop images into config/closet_assistant/images and scan."}</div>`}
    `;
    this._toast = null;
    const search = this.$main.querySelector(".search");
    if (this._refocusSearch && search) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
      this._refocusSearch = false;
    }
  }

  /* ---------------------------------------------------------- modal */
  _defaultMax(draft) {
    const d = caStore.data;
    const meta = d.categories[draft.category] || {};
    if (!meta.tracks) return null;
    if (meta.fixed_max) return meta.fixed_max;
    return d.settings.wears_per_wash * (meta.multiplier || 1);
  }

  _renderModal() {
    if (this._confirm) {
      const c = this._confirm;
      this.$modal.innerHTML = `<div class="overlay" data-action="close-confirm"><div class="dialog small" data-stop>
          <div class="dlg-title">${esc(c.title)}</div><p>${esc(c.text)}</p>
          <div class="dlg-actions"><button data-action="close-confirm">Cancel</button>
          ${c.buttons.map((b, i) => `<button class="${b.cls || "primary"}" data-action="confirm" data-i="${i}">${esc(b.label)}</button>`).join("")}</div>
        </div></div>`;
      return;
    }
    const dr = this._draft;
    if (!dr) {
      this.$modal.innerHTML = "";
      return;
    }
    const d = caStore.data;
    const cats = d.categories;
    const solid = dr.pattern === "solid";
    const defMax = this._defaultMax(dr);
    this.$modal.innerHTML = `<div class="overlay" data-action="close"><div class="dialog" data-stop>
      <div class="dlg-title">${dr.id ? "Edit item" : "Add item"}</div>
      <div class="editor">
        <div class="left">
          <div class="preview" data-action="pick-image" title="Upload image">
            ${itemVisual({ ...dr, image_url: dr.image_url }, cats)}
            <div class="upl">${this._uploading ? "Uploading..." : dr.image_url ? "Replace image" : "Upload image"}</div>
          </div>
          <div class="muted hint">Square or portrait photos with a transparent background look best. The main colour is detected automatically.</div>
          ${dr.image_url ? `<button class="small" data-action="clear-image"><ha-icon icon="mdi:image-remove"></ha-icon>Remove image</button>` : ""}
        </div>
        <div class="right">
          <label>Name<input data-field="name" value="${esc(dr.name)}" placeholder="Navy oxford shirt"></label>
          <label>Category<select data-field="category" data-rerender>
            ${Object.entries(cats).map(([k, m]) => `<option value="${k}" ${k === dr.category ? "selected" : ""}>${esc(m.label)}</option>`).join("")}
          </select></label>
          <div class="two">
            <label>Main colour<input type="color" data-field="color" value="${esc(dr.color)}"></label>
            <div class="accents"><span>Accent colours</span><div class="acc-row">
              ${(dr.accent_colors || []).map((c, i) => `<span class="acc"><input type="color" data-accent="${i}" value="${esc(c)}"><button class="x" data-action="rm-accent" data-i="${i}">×</button></span>`).join("")}
              ${(dr.accent_colors || []).length < 4 ? `<button class="small" data-action="add-accent">+</button>` : ""}
            </div></div>
          </div>
          <div class="two">
            <label>Pattern<select data-field="pattern" data-rerender>
              ${Object.entries(d.patterns).map(([k, l]) => `<option value="${k}" ${k === dr.pattern ? "selected" : ""}>${esc(l)}</option>`).join("")}
            </select></label>
            ${solid ? `<span></span>` : `<label>Pattern scale<select data-field="pattern_scale">
              ${d.pattern_scales.map((s) => `<option value="${s}" ${s === dr.pattern_scale ? "selected" : ""}>${s}</option>`).join("")}
            </select></label>`}
          </div>
          <label>Fabric<select data-field="fabric">
            <option value="">Not set</option>
            ${d.fabrics.map((f) => `<option value="${f}" ${f === dr.fabric ? "selected" : ""}>${f}</option>`).join("")}
          </select></label>
          ${RATING_FIELDS.map(([f, label, lo, hi]) => `
            <div class="rating"><div class="rl"><span>${label}</span><b data-val="${f}">${dr[f]}</b></div>
              <input type="range" min="1" max="10" step="1" data-field="${f}" data-num value="${dr[f]}">
              <div class="ends muted"><span>${lo}</span><span>${hi}</span></div></div>`).join("")}
          ${defMax !== null ? `
          <div class="two">
            <label>Wears between washes<input type="number" min="1" max="30" data-field="max_wears" data-num value="${dr.max_wears ?? ""}" placeholder="Default ${defMax}"></label>
            <label>Last worn<input type="date" data-field="last_worn" value="${esc(dr.last_worn || "")}"></label>
          </div>
          ${dr.id ? `<div class="clean-row muted">${pips(dr)} ${dr.cleanliness ?? "-"} of ${dr.max_wears_effective ?? defMax} wears left</div>` : ""}`
          : `<label>Last worn<input type="date" data-field="last_worn" value="${esc(dr.last_worn || "")}"></label>`}
          <label>Notes<input data-field="notes" value="${esc(dr.notes || "")}" placeholder="Optional"></label>
        </div>
      </div>
      <div class="dlg-actions">
        ${dr.id ? `<button class="danger" data-action="delete"><ha-icon icon="mdi:delete-outline"></ha-icon>Delete</button>` : ""}
        ${dr.id && dr.tracks_cleanliness ? `<button data-action="wash-one"><ha-icon icon="mdi:washing-machine"></ha-icon>Mark clean</button>` : ""}
        ${dr.id ? `<button data-action="wear-one"><ha-icon icon="mdi:hanger"></ha-icon>Wore it today</button>` : ""}
        <span style="flex:1"></span>
        <button data-action="close">Cancel</button>
        <button class="primary" data-action="save" ${this._busy || this._uploading ? "disabled" : ""}>Save</button>
      </div>
    </div></div>`;
  }

  _newDraft() {
    return {
      name: "", category: this._filter !== "all" ? this._filter : "short_sleeve_shirt", color: "#808080",
      accent_colors: [], pattern: "solid", pattern_scale: null, fabric: "", warmth: 3, waterproof: 1,
      form_fit: 5, uv: 3, structure: 5, max_wears: null, last_worn: null, notes: "", image: null, image_url: null,
      _colorTouched: false,
    };
  }

  /* ---------------------------------------------------------- events */
  _onInput(e) {
    const t = e.target;
    if (t.dataset.ui === "search") {
      this._search = t.value;
      this._refocusSearch = true;
      return this._renderMain();
    }
    if (!this._draft) return;
    if (t.dataset.accent !== undefined) {
      this._draft.accent_colors[Number(t.dataset.accent)] = t.value;
      return;
    }
    const f = t.dataset.field;
    if (!f) return;
    let v = t.value;
    if (t.dataset.num !== undefined) v = v === "" ? null : Number(v);
    this._draft[f] = v;
    if (f === "color") this._draft._colorTouched = true;
    const label = this.$modal.querySelector(`[data-val="${f}"]`);
    if (label) label.textContent = v;
  }

  async _onChange(e) {
    const t = e.target;
    if (t.dataset.ui === "dirty") {
      this._dirtyOnly = t.checked;
      return this._renderMain();
    }
    if (t.id === "importFile") return this._importFile(t);
    if (t.id === "imageFile") return this._uploadImage(t);
    if (this._draft && t.dataset.rerender !== undefined) {
      this._draft[t.dataset.field] = t.value;
      if (t.dataset.field === "pattern" && t.value !== "solid" && !this._draft.pattern_scale) this._draft.pattern_scale = "medium";
      this._renderModal();
    }
  }

  async _onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) {
      if (this._menu && !e.target.closest(".menu-wrap")) {
        this._menu = false;
        this._renderMain();
      }
      return;
    }
    const a = el.dataset.action;
    // clicks inside the dialog shouldn't trigger the overlay's close action
    if ((a === "close" || a === "close-confirm") && el.classList.contains("overlay") && e.target.closest("[data-stop]")) return;
    const d = caStore.data;
    switch (a) {
      case "menu":
        this._menu = !this._menu;
        return this._renderMain();
      case "filter":
        this._filter = el.dataset.cat;
        return this._renderMain();
      case "add":
        this._draft = this._newDraft();
        return this._renderModal();
      case "edit": {
        const item = d.items.find((i) => i.id === el.dataset.id);
        if (!item) return;
        this._draft = JSON.parse(JSON.stringify({ ...item, fabric: item.fabric || "", _colorTouched: true }));
        return this._renderModal();
      }
      case "close":
        this._draft = null;
        return this._renderModal();
      case "close-confirm":
        this._confirm = null;
        return this._renderModal();
      case "confirm": {
        const btn = this._confirm.buttons[Number(el.dataset.i)];
        this._confirm = null;
        this._renderModal();
        return this._run(btn.run);
      }
      case "pick-image":
        return this.shadowRoot.getElementById("imageFile").click();
      case "clear-image":
        this._draft.image = null;
        this._draft.image_url = null;
        return this._renderModal();
      case "add-accent":
        this._draft.accent_colors = [...(this._draft.accent_colors || []), "#ffffff"];
        return this._renderModal();
      case "rm-accent":
        this._draft.accent_colors.splice(Number(el.dataset.i), 1);
        return this._renderModal();
      case "save":
        return this._save();
      case "delete":
        return this._ask("Delete item?", `Remove "${this._draft.name}" from your closet? This also deletes its uploaded image.`, [
          { label: "Delete", cls: "danger", run: async () => { await ws(this._hass, "item/delete", { item_id: this._draft.id }); this._draft = null; this._renderModal(); } },
        ]);
      case "wash-one":
        return this._run(async () => { await ws(this._hass, "wash", { item_ids: [this._draft.id] }); this._draft = null; this._renderModal(); }, "Marked clean.");
      case "wear-one":
        return this._run(async () => { await ws(this._hass, "wear", { item_ids: [this._draft.id] }); this._draft = null; this._renderModal(); }, "Logged as worn today.");
      case "wash-all":
        return this._ask("Wash the whole closet?", `Every item (${d.counts.dirty} in the hamper) goes back to fully clean.`, [
          { label: "Wash closet", run: async () => { const r = await ws(this._hass, "wash"); this._toast = `Washed ${r.washed} items.`; } },
        ]);
      case "import":
        this._menu = false;
        this._renderMain();
        return this.shadowRoot.getElementById("importFile").click();
      case "export":
        this._menu = false;
        return this._run(async () => {
          const data = await ws(this._hass, "export");
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = `closet-${new Date().toISOString().slice(0, 10)}.json`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 2000);
        });
      case "scan":
        this._menu = false;
        return this._run(async () => {
          const r = await ws(this._hass, "scan_images");
          this._toast = r.added ? `Added ${r.added} draft items. Tap the ones marked "review" to fill in details.` : "No new images found in config/closet_assistant/images.";
        });
    }
  }

  _ask(title, text, buttons) {
    this._confirm = { title, text, buttons };
    this._renderModal();
  }

  async _run(fn, okMsg) {
    this._busy = true;
    try {
      await fn();
      if (okMsg) this._toast = okMsg;
    } catch (err) {
      this._toast = (err && err.message) || String(err);
    }
    this._busy = false;
    this._renderMain();
  }

  async _save() {
    const dr = this._draft;
    if (!dr.name.trim()) {
      this._draft.name = (caStore.data.categories[dr.category] || {}).label || "Item";
    }
    const payload = {};
    for (const k of ["id", "name", "category", "color", "accent_colors", "pattern", "pattern_scale", "fabric",
      "warmth", "waterproof", "form_fit", "uv", "structure", "max_wears", "last_worn", "notes", "image"]) {
      if (dr[k] !== undefined) payload[k] = dr[k];
    }
    if (!payload.id) delete payload.id;
    if (!payload.fabric) payload.fabric = null;
    payload.needs_review = false;
    this._busy = true;
    this._renderModal();
    try {
      await ws(this._hass, "item/save", { item: payload });
      this._draft = null;
    } catch (err) {
      this._toast = err.message || String(err);
    }
    this._busy = false;
    this._renderModal();
    this._renderMain();
  }

  async _uploadImage(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file || !this._draft) return;
    this._uploading = true;
    this._renderModal();
    try {
      const { dataUrl, color } = await prepareImage(file);
      const res = await ws(this._hass, "image/upload", { data: dataUrl });
      this._draft.image = res.image;
      this._draft.image_url = res.url;
      if (color && (!this._draft._colorTouched || !this._draft.id)) this._draft.color = color;
      if (!this._draft.name) this._draft.name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    } catch (err) {
      this._toast = `Image upload failed: ${err.message || err}`;
      this._renderMain();
    }
    this._uploading = false;
    this._renderModal();
  }

  async _importFile(input) {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      this._toast = "That file isn't valid JSON.";
      return this._renderMain();
    }
    const n = Array.isArray(data) ? data.length : (data.items || []).length;
    this._ask("Import closet", `Found ${n} items in ${file.name}. Merge them with your closet, or replace everything?`, [
      { label: "Replace", cls: "danger", run: async () => { const r = await ws(this._hass, "import", { data, replace: true }); this._toast = `Imported ${r.imported} items.`; } },
      { label: "Merge", run: async () => { const r = await ws(this._hass, "import", { data, replace: false }); this._toast = `Imported ${r.imported} items.`; } },
    ]);
  }
}

const CLOSET_CSS = `
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; }
  .title { font-size:1.2em; font-weight:500; }
  .stats { font-size:.82em; margin-top:2px; }
  .tools { display:flex; gap:6px; align-items:center; }
  .menu-wrap { position:relative; }
  .menu { position:absolute; right:0; top:110%; z-index:5; background:var(--card-background-color); border-radius:12px;
    box-shadow:0 6px 24px rgba(0,0,0,.2); padding:6px; display:flex; flex-direction:column; min-width:190px; }
  .menu button { background:none; border-radius:8px; justify-content:flex-start; }
  .menu button:hover { background:var(--secondary-background-color); }
  .filters { display:flex; gap:10px; align-items:center; margin:12px 0 8px; flex-wrap:wrap; }
  .search { flex:1; min-width:160px; padding:8px 12px; border-radius:999px; border:1px solid var(--divider-color);
    background:var(--card-background-color); color:var(--primary-text-color); font:inherit; }
  .toggle { font-size:.85em; display:flex; align-items:center; gap:4px; color:var(--secondary-text-color); }
  .chips { display:flex; gap:6px; overflow-x:auto; padding-bottom:6px; }
  .chip { padding:4px 10px; font-size:.82em; white-space:nowrap; }
  .chip.sel { background:var(--primary-color); color:var(--text-primary-color, #fff); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:10px; margin-top:8px; }
  .item { position:relative; cursor:pointer; border-radius:12px; padding:4px; }
  .item:hover { background:var(--secondary-background-color); }
  .item.dirty .img { opacity:.45; filter:grayscale(.6); }
  .item .name { font-size:.85em; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .item .sub { font-size:.72em; display:flex; justify-content:space-between; align-items:center; gap:4px; }
  .flag { position:absolute; top:8px; right:8px; font-size:.68em; padding:1px 6px; border-radius:999px;
    background:var(--warning-color, #ffa600); color:#fff; }
  .flag.hamper { background:var(--secondary-text-color); }
  .empty { padding:24px 8px; text-align:center; }
  .toast { margin:8px 0; padding:8px 12px; border-radius:10px; font-size:.88em;
    background:color-mix(in srgb, var(--primary-color) 12%, transparent); }
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:999; display:flex; align-items:center; justify-content:center; padding:16px; }
  .dialog { background:var(--card-background-color); color:var(--primary-text-color); border-radius:18px; width:min(760px, 100%);
    max-height:92vh; overflow:auto; padding:18px; box-shadow:0 10px 40px rgba(0,0,0,.35); }
  .dialog.small { width:min(420px, 100%); }
  .dlg-title { font-size:1.15em; font-weight:500; margin-bottom:12px; }
  .editor { display:grid; grid-template-columns:220px 1fr; gap:18px; }
  @media (max-width:640px) { .editor { grid-template-columns:1fr; } .left { max-width:240px; margin:0 auto; } }
  .preview { cursor:pointer; position:relative; }
  .preview .upl { position:absolute; bottom:8px; left:50%; transform:translateX(-50%); font-size:.78em; white-space:nowrap;
    background:rgba(0,0,0,.55); color:#fff; padding:3px 10px; border-radius:999px; }
  .hint { font-size:.75em; margin:8px 0; }
  .right { display:flex; flex-direction:column; gap:10px; }
  label { display:flex; flex-direction:column; gap:4px; font-size:.82em; color:var(--secondary-text-color); }
  label input, label select { font:inherit; font-size:1rem; padding:7px 10px; border-radius:8px; border:1px solid var(--divider-color);
    background:var(--card-background-color); color:var(--primary-text-color); }
  input[type=color] { padding:2px; height:38px; width:100%; cursor:pointer; }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .accents { font-size:.82em; color:var(--secondary-text-color); display:flex; flex-direction:column; gap:4px; }
  .acc-row { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .acc { position:relative; }
  .acc input { width:38px; height:38px; padding:1px; border-radius:8px; border:1px solid var(--divider-color); }
  .acc .x { position:absolute; top:-6px; right:-6px; padding:0 5px; font-size:.8em; line-height:1.4; }
  .rating .rl { display:flex; justify-content:space-between; font-size:.85em; }
  .rating input { width:100%; accent-color:var(--primary-color); }
  .rating .ends { display:flex; justify-content:space-between; font-size:.7em; }
  .clean-row { font-size:.82em; display:flex; gap:8px; align-items:center; }
  .dlg-actions { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; align-items:center; }
`;

customElements.get("closet-assistant-today-card") || customElements.define("closet-assistant-today-card", ClosetAssistantTodayCard);
customElements.get("closet-assistant-closet-card") || customElements.define("closet-assistant-closet-card", ClosetAssistantClosetCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "closet-assistant-today-card")) {
  window.customCards.push(
    { type: "closet-assistant-today-card", name: "Closet Assistant: Wear Today", description: "Today's weather and a suggested outfit with layering and randomize." },
    { type: "closet-assistant-closet-card", name: "Closet Assistant: Manage Closet", description: "Add, edit, remove and wash the clothes in your closet." }
  );
}
console.info(`%c CLOSET ASSISTANT %c v${CA_VERSION} `, "background:#6b3fa0;color:#fff;border-radius:3px 0 0 3px", "background:#ddd;color:#333;border-radius:0 3px 3px 0");
