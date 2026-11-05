/*
 * Closet Assistant cards
 *   custom:closet-assistant-today-card   - "Wear Today"
 *   custom:closet-assistant-closet-card  - "Manage Closet"
 * Served and auto-loaded by the closet_assistant integration. No build step.
 */
const CA_VERSION = "0.5.0";
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

function spanText(days) {
  if (days < 45) return `${days} days`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months`;
  return `${Math.floor(months / 12)} years`;
}

function unwornText(item) {
  return item.never_worn ? `Never worn · added ${spanText(item.unworn_days)} ago` : `Not worn in ${spanText(item.unworn_days)}`;
}

function weekdayName(iso) {
  if (!iso) return "-";
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function fmtTemp(v) {
  return v === null || v === undefined ? "--" : `${Math.round(v)}°`;
}

/* ------------------------------------------------------------------ garment silhouettes
 * Items without a photo are drawn as a clothing shape in their own colour and pattern.
 * `shape` is used as a CSS mask over the pattern fill, `detail` adds seams/hems on top.
 * All paths use a 100x100 viewBox.
 */
const GARMENTS = {
  short_sleeve_shirt: {
    shape: "M36 10 Q50 18 64 10 L82 18 L92 36 L78 43 L72 37 L72 90 Q50 94 28 90 L28 37 L22 43 L8 36 L18 18 Z",
    detail: "M36 10 Q50 22 64 10 M28 37 L28 39 M72 37 L72 39 M22 43 L18 37 M78 43 L82 37",
  },
  long_sleeve_shirt: {
    shape: "M37 9 Q50 16 63 9 L80 15 Q88 19 89 30 L93 84 L82 86 L75 38 L72 36 L72 92 Q50 95 28 92 L28 36 L25 38 L18 86 L7 84 L11 30 Q12 19 20 15 Z",
    detail: "M37 9 L44 17 L50 13 L56 17 L63 9 M50 14 L50 90 M82 80 L93 79 M7 79 L18 80",
  },
  sweater: {
    shape: "M38 9 Q50 15 62 9 L80 15 Q88 19 89 30 L93 84 L82 86 L75 38 L72 36 L72 92 Q50 95 28 92 L28 36 L25 38 L18 86 L7 84 L11 30 Q12 19 20 15 Z",
    detail: "M38 9 Q50 20 62 9 M29 86 Q50 89 71 86 M82 80 L93 79 M7 79 L18 80 M28 38 L28 86 M72 38 L72 86",
  },
  jacket: {
    shape: "M36 8 L50 14 L64 8 L80 14 Q88 18 89 30 L93 86 L82 88 L75 40 L73 38 L73 93 L27 93 L27 38 L25 40 L18 88 L7 86 L11 30 Q12 18 20 14 Z",
    detail: "M50 14 L50 93 M36 8 L44 30 L50 14 M64 8 L56 30 L50 14 M32 60 L42 60 M58 60 L68 60",
  },
  coat: {
    shape: "M36 6 L50 12 L64 6 L80 12 Q88 16 89 28 L93 84 L82 86 L75 36 L74 34 L76 97 L24 97 L26 34 L25 36 L18 86 L7 84 L11 28 Q12 16 20 12 Z",
    detail: "M36 6 L45 32 L50 12 M64 6 L55 32 L50 12 M50 32 L50 97 M45 44 h0.1 M55 44 h0.1 M45 58 h0.1 M55 58 h0.1 M45 72 h0.1 M55 72 h0.1",
  },
  pants: {
    shape: "M27 6 L73 6 L78 95 L56 95 L50 32 L44 95 L22 95 Z",
    detail: "M27 13 L73 13 M50 13 L50 32 M34 13 Q36 22 30 24 M66 13 Q64 22 70 24",
  },
  shorts: {
    shape: "M22 20 L78 20 L84 72 L55 76 L50 44 L45 76 L16 72 Z",
    detail: "M22 28 L78 28 M50 28 L50 44 M30 28 Q32 36 26 38 M70 28 Q68 36 74 38",
  },
  skirt: {
    shape: "M32 16 L68 16 L86 84 Q50 92 14 84 Z",
    detail: "M32 23 L68 23 M42 23 L36 86 M58 23 L64 86 M50 23 L50 88",
  },
  shoes: {
    shape: "M8 66 Q8 46 22 44 L36 42 Q42 54 56 56 L80 61 Q93 64 93 74 L93 78 L8 78 Z",
    detail: "M8 71 L93 71 M36 42 L32 56 M44 50 L40 58 M52 54 L49 60",
  },
  belt: {
    shape: "M4 42 L96 42 L96 58 L4 58 Z",
    detail: "M14 39 L30 39 L30 61 L14 61 Z M22 50 L36 50 M60 50 h0.1 M70 50 h0.1 M80 50 h0.1",
  },
  hat: {
    shape: "M18 66 Q18 30 50 28 Q82 30 82 66 Q92 66 96 72 L60 74 Q40 74 18 70 Z",
    detail: "M50 28 L50 66 M30 40 Q50 50 70 40 M50 27 h0.1",
  },
  socks: {
    shape: "M36 8 L60 8 L60 54 Q60 60 66 64 L82 72 Q91 78 85 88 Q80 94 70 91 L42 78 Q34 74 36 62 Z",
    detail: "M36 18 L60 18 M36 13 L60 13 M70 74 Q64 82 72 90",
  },
  underwear: {
    shape: "M14 26 L86 26 L84 42 Q68 48 60 74 L40 74 Q32 48 16 42 Z",
    detail: "M14 34 L86 34 M40 74 Q50 66 60 74",
  },
  accessory: {
    shape: "M28 10 Q50 22 72 10 L74 26 Q50 38 26 26 Z M54 28 L68 88 L54 90 L46 32 Z",
    detail: "M56 86 L56 94 M60 86 L60 94 M64 86 L64 93",
  },
};
const _maskCache = new Map();
function garmentMask(category) {
  if (!_maskCache.has(category)) {
    const g = GARMENTS[category] || GARMENTS.short_sleeve_shirt;
    // double quotes inside the SVG (percent-encoded) + single-quoted url() so it can sit in a style="" attribute
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${g.shape}"/></svg>`;
    _maskCache.set(category, `url('data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}')`);
  }
  return _maskCache.get(category);
}
function garmentArt(item) {
  const g = GARMENTS[item.category] || GARMENTS.short_sleeve_shirt;
  const mask = garmentMask(item.category);
  const ink = isLight(item.color) ? "rgba(0,0,0,.28)" : "rgba(255,255,255,.28)";
  const edge = isLight(item.color) ? "rgba(0,0,0,.18)" : "rgba(0,0,0,.25)";
  return `<div class="garment">
      <div class="g-fill" style="background:${patternFill(item)};-webkit-mask-image:${mask};mask-image:${mask}"></div>
      <svg class="g-lines" viewBox="0 0 100 100" aria-hidden="true">
        <path d="${g.shape}" fill="none" stroke="${edge}" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="${g.detail}" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
}

function itemVisual(item, categories) {
  if (item.image_url) {
    const fit = caImageFit.get(item.image_url) || "";
    return `<div class="img ${fit}" style="--c:${esc(item.color)}">
        <img src="${esc(item.image_url)}" alt="${esc(item.name)}" loading="lazy" data-fit>
      </div>`;
  }
  return `<div class="img drawn" style="--c:${esc(item.color)}">${garmentArt(item)}</div>`;
}

/* Photos with a transparent background float on a tinted tile; photos with a
   solid background fill the tile edge to edge. Detected once per image. */
const caImageFit = new Map();
function detectFit(img) {
  try {
    const n = 24;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    let edge = 0, clear = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (x > 0 && y > 0 && x < n - 1 && y < n - 1) continue;
      edge++;
      if (d[(y * n + x) * 4 + 3] < 240) clear++;
    }
    return clear / edge > 0.25 ? "transparent" : "opaque";
  } catch (err) {
    return "transparent";
  }
}
function caFitImages(root) {
  root.querySelectorAll("img[data-fit]").forEach((img) => {
    const apply = () => {
      const key = img.getAttribute("src");
      let fit = caImageFit.get(key);
      if (!fit) {
        fit = detectFit(img);
        caImageFit.set(key, fit);
      }
      const box = img.closest(".img");
      if (box) {
        box.classList.remove("opaque", "transparent");
        box.classList.add(fit);
      }
    };
    if (img.complete && img.naturalWidth) apply();
    else img.addEventListener("load", apply, { once: true });
  });
}

function isLight(hex) {
  const h = String(hex || "#888888").replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

function pips(item) {
  if (!item.tracks_cleanliness) return "";
  const max = item.max_wears_effective || 1;
  const left = item.cleanliness ?? max;
  let out = "";
  if (max > 5) {
    // long-wear items (jackets, coats): one dot + a count keeps the row tidy
    return `<span class="pips" title="${left} of ${max} wears left"><i class="${left ? "on" : ""}"></i><span class="pip-count">${left}/${max}</span></span>`;
  }
  for (let i = 0; i < max; i++) out += `<i class="${i < left ? "on" : ""}"></i>`;
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
  :host {
    display:block;
    --ca-surface: color-mix(in srgb, var(--primary-text-color) 3%, var(--card-background-color));
    --ca-surface-2: color-mix(in srgb, var(--primary-text-color) 6.5%, var(--card-background-color));
    --ca-line: color-mix(in srgb, var(--primary-text-color) 11%, transparent);
    --ca-accent: var(--primary-color);
    --ca-shadow: 0 1px 2px rgba(0,0,0,.05), 0 4px 14px rgba(0,0,0,.06);
  }
  ha-card { padding:18px; overflow:hidden; color:var(--primary-text-color); }
  button { font:inherit; font-size:14px; cursor:pointer; border:1px solid transparent; border-radius:999px; padding:7px 14px;
    background:transparent; color:var(--primary-text-color); display:inline-flex; align-items:center; gap:6px;
    transition:background .15s, border-color .15s, transform .1s, box-shadow .15s; -webkit-tap-highlight-color:transparent; }
  button:hover { background:var(--ca-surface-2); }
  button:active { transform:scale(.97); }
  button.outline { border-color:var(--ca-line); }
  button.primary { background:var(--ca-accent); color:var(--text-primary-color, #fff);
    box-shadow:0 2px 10px color-mix(in srgb, var(--ca-accent) 35%, transparent); }
  button.primary:hover { background:color-mix(in srgb, var(--ca-accent) 88%, #000); }
  button.danger { color:var(--error-color, #db4437); }
  button.small { padding:6px 12px; font-size:13.5px; }
  button[disabled] { opacity:.5; cursor:default; transform:none; }
  button ha-icon { --mdc-icon-size:18px; }
  .muted { color:var(--secondary-text-color); }
  .img { position:relative; aspect-ratio:1/1; border-radius:14px; display:flex; align-items:center; justify-content:center; overflow:hidden;
    background:radial-gradient(130% 100% at 50% 15%, var(--card-background-color) 0%, var(--ca-surface-2) 100%); }
  .img img { width:80%; height:80%; object-fit:contain; filter:drop-shadow(0 6px 10px rgba(0,0,0,.15)); }
  .img.opaque img { width:100%; height:100%; object-fit:cover; filter:none; }
  .garment { position:relative; width:70%; height:70%; filter:drop-shadow(0 6px 10px rgba(0,0,0,.15)); }
  .g-fill, .g-lines { position:absolute; inset:0; width:100%; height:100%; }
  .g-fill { -webkit-mask-size:100% 100%; mask-size:100% 100%; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; }
  .pips { display:inline-flex; gap:3px; align-items:center; flex:none; }
  .pip-count { font-size:11px; margin-left:2px; font-variant-numeric:tabular-nums; }
  .pips i { width:6px; height:6px; border-radius:50%; background:var(--ca-line); }
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
    this.shadowRoot.innerHTML = `<style>${SHARED_CSS}${TODAY_CSS}</style>
      <ha-card id="main"></ha-card><div id="closetModal"></div>`;
    this.$main = this.shadowRoot.getElementById("main");
    this.$closet = this.shadowRoot.getElementById("closetModal");
    this.shadowRoot.addEventListener("click", (e) => this._onClick(e));
    this._onKey = (e) => {
      if (e.key === "Escape" && this._closetEl && !(typeof this._closetEl.hasOpenDialog === "function" && this._closetEl.hasOpenDialog())) this._closeCloset();
    };
  }
  setConfig(config) {
    this._config = config || {};
    this._render();
  }
  set hass(hass) {
    this._hass = hass;
    caStore.connect(hass);
    if (this._closetEl) this._closetEl.hass = hass;
  }
  connectedCallback() {
    this._off = caStore.on(() => this._render());
    this._render();
  }
  disconnectedCallback() {
    if (this._off) this._off();
    this._closeCloset();
  }
  getCardSize() {
    return 8;
  }
  static getStubConfig() {
    return {};
  }

  /* ---------------------------------------------------------- closet modal */
  _openCloset() {
    if (this._closetEl) return;
    const card = document.createElement("closet-assistant-closet-card");
    card.setConfig({ title: "Closet", in_dialog: true });
    card.hass = this._hass;
    this._closetEl = card;
    this.$closet.innerHTML = `<div class="overlay closet-overlay" data-action="close-closet">
        <div class="closet-dialog" data-stop>
          <button class="small close-x" data-action="close-closet" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
      </div>`;
    this.$closet.querySelector(".closet-dialog").appendChild(card);
    window.addEventListener("keydown", this._onKey);
  }
  _closeCloset() {
    if (!this._closetEl) return;
    this._closetEl = null;
    this.$closet.innerHTML = "";
    window.removeEventListener("keydown", this._onKey);
  }

  async _onClick(e) {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "close-closet") {
      // ignore clicks that land inside the dialog but bubble to the overlay
      if (btn.classList.contains("overlay") && e.composedPath().some((n) => n.dataset && n.dataset.stop !== undefined)) return;
      return this._closeCloset();
    }
    if (action === "open-closet") return this._openCloset();
    if (action === "why") {
      this._showWhy = !this._showWhy;
      return this._render();
    }
    if (this._busy) return;
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

  _tile(item, cats) {
    return `<div class="tile ${item.removable ? "removable" : ""}" style="--c:${esc(item.color)}" title="${esc(item.name)}">
      ${itemVisual(item, cats)}
      ${item.removable ? `<span class="badge">Shed later</span>` : ""}
      <div class="label"><span class="name">${esc(item.name)}</span><span class="slot">${esc(SLOT_LABELS[item.slot] || "")}</span></div>
    </div>`;
  }

  _render() {
    if (!this.$main) return;
    const d = caStore.data;
    const cfg = this._config || {};
    const showClosetBtn = cfg.closet_button !== false;
    let body;
    if (caStore.error) {
      body = `<div class="err">${esc(caStore.error)}</div>`;
    } else if (!d) {
      body = `<div class="muted loading">Opening the closet...</div>`;
    } else {
      const w = d.weather || {};
      const t = d.today || { items: [], notes: [] };
      const items = t.items || [];
      const cats = d.categories;
      const by = {};
      for (const it of items) by[it.slot] = it;
      const tiles = BOARD_ORDER.filter((s) => by[s]);
      const basics = ["underwear", "socks"].filter((s) => by[s]);
      const removable = items.filter((i) => i.removable);
      const theme = WEATHER_THEMES[w.condition] || WEATHER_THEMES.partlycloudy;
      const pills = [];
      if (w.precip_prob !== null && w.precip_prob !== undefined) pills.push(`<span class="pill"><ha-icon icon="mdi:umbrella-outline"></ha-icon>${Math.round(w.precip_prob)}%</span>`);
      if (w.uv !== null && w.uv !== undefined) pills.push(`<span class="pill"><ha-icon icon="mdi:sun-wireless-outline"></ha-icon>UV ${Math.round(Number(w.uv))}</span>`);
      if (w.wind_mph) pills.push(`<span class="pill"><ha-icon icon="mdi:weather-windy"></ha-icon>${Math.round(w.wind_mph)} mph</span>`);
      const dateText = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

      body = `
        <div class="sky" style="--sky:${theme.bg};--ink:${theme.ink}">
          <div class="sky-main">
            <ha-icon class="sky-icon" icon="${WEATHER_ICONS[w.condition] || "mdi:weather-partly-cloudy"}"></ha-icon>
            <div class="sky-text">
              <div class="eyebrow">${esc(cfg.title || "Wear today")} · ${esc(dateText)}</div>
              <div class="temps"><span class="hi">${fmtTemp(w.high)}</span><span class="lo">${fmtTemp(w.low)}</span></div>
              <div class="cond">${esc((w.condition || "").replace("partlycloudy", "partly cloudy").replace("clear-night", "clear").replace(/-/g, " "))}</div>
            </div>
          </div>
          ${pills.length ? `<div class="pills">${pills.join("")}</div>` : ""}
        </div>
        ${removable.length
          ? `<div class="banner"><ha-icon icon="mdi:layers-triple-outline"></ha-icon>
             <span>Big temperature swing. Start layered, then shed the ${removable.map((i) => `<b>${esc(i.name)}</b>`).join(" and ")} as it warms up.</span></div>`
          : ""}
        ${items.length
          ? `<div class="board">${tiles.map((s) => this._tile(by[s], cats)).join("")}</div>
             ${basics.length ? `<div class="basics"><span class="muted">Plus</span>${basics.map((s) => `<span class="basic"><span class="dot" style="background:${esc(by[s].color)}"></span>${esc(by[s].name)}</span>`).join("")}</div>` : ""}`
          : `<div class="empty"><ha-icon icon="mdi:hanger"></ha-icon><div>${esc((t.notes || [])[0] || "No outfit yet. Add a few clothes to your closet to get started.")}</div></div>`}
        ${this._showWhy && t.notes && t.notes.length ? `<ul class="why">${t.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
        ${this._toast ? `<div class="err small-err">${esc(this._toast)}</div>` : ""}
        <div class="actions">
          <button class="small" data-action="randomize" ${this._busy ? "disabled" : ""} title="Pick a different outfit">
            <ha-icon icon="mdi:dice-multiple-outline"></ha-icon>Randomize</button>
          ${t.notes && t.notes.length ? `<button class="small ${this._showWhy ? "on" : ""}" data-action="why" title="Why this outfit?"><ha-icon icon="mdi:lightbulb-on-outline"></ha-icon>Why?</button>` : ""}
          ${showClosetBtn ? `<button class="small" data-action="open-closet" title="Manage your closet"><ha-icon icon="mdi:wardrobe-outline"></ha-icon>Closet</button>` : ""}
          <span class="spacer"></span>
          ${items.length
            ? t.worn
              ? `<span class="worn"><ha-icon icon="mdi:check-circle"></ha-icon>Worn today</span>`
              : `<button class="small primary" data-action="wear" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:check"></ha-icon>Wear this</button>`
            : ""}
        </div>`;
    }
    this._toast = null;
    this.$main.innerHTML = body;
    caFitImages(this.$main);
  }
}

const BOARD_ORDER = ["outer", "mid", "top", "bottom", "shoes", "belt", "hat", "accessory"];

/* Soft sky gradients behind the weather, by condition. `ink` is the text colour on top. */
const WEATHER_THEMES = {
  sunny: { bg: "linear-gradient(135deg, #ffe29a 0%, #ffb37c 100%)", ink: "#4a2a08" },
  "clear-night": { bg: "linear-gradient(135deg, #2c3e70 0%, #5a4e8c 100%)", ink: "#f1f0ff" },
  partlycloudy: { bg: "linear-gradient(135deg, #cfe6ff 0%, #f3e7d3 100%)", ink: "#1e3550" },
  cloudy: { bg: "linear-gradient(135deg, #dfe4ea 0%, #b8c2cc 100%)", ink: "#26323d" },
  fog: { bg: "linear-gradient(135deg, #e6e9ec 0%, #c9ced4 100%)", ink: "#2b333b" },
  rainy: { bg: "linear-gradient(135deg, #7aa0c4 0%, #46607d 100%)", ink: "#f2f7fc" },
  pouring: { bg: "linear-gradient(135deg, #5d7f9f 0%, #2f4359 100%)", ink: "#f2f7fc" },
  lightning: { bg: "linear-gradient(135deg, #6b6f8f 0%, #343650 100%)", ink: "#f4f3ff" },
  "lightning-rainy": { bg: "linear-gradient(135deg, #6b6f8f 0%, #2e3247 100%)", ink: "#f4f3ff" },
  snowy: { bg: "linear-gradient(135deg, #f4f8ff 0%, #c9daf2 100%)", ink: "#1f3454" },
  "snowy-rainy": { bg: "linear-gradient(135deg, #e3ecf7 0%, #a9bfd9 100%)", ink: "#1f3454" },
  hail: { bg: "linear-gradient(135deg, #e3ecf7 0%, #9fb3cc 100%)", ink: "#1f3454" },
  windy: { bg: "linear-gradient(135deg, #d9efe9 0%, #c7d6e8 100%)", ink: "#1f3a3a" },
  "windy-variant": { bg: "linear-gradient(135deg, #d9efe9 0%, #c7d6e8 100%)", ink: "#1f3a3a" },
  exceptional: { bg: "linear-gradient(135deg, #ffd6c9 0%, #f2a69a 100%)", ink: "#4a1a10" },
};

/* CSS background approximating the item's pattern, for items without a photo */
function patternFill(item) {
  const c = item.color || "#888888";
  const a = (item.accent_colors && item.accent_colors[0]) || `color-mix(in srgb, ${c} 55%, #000)`;
  const soft = `color-mix(in srgb, ${a} 55%, transparent)`;
  const scale = { micro: 3, small: 6, medium: 9, large: 15 }[item.pattern_scale] || 9;
  switch (item.pattern) {
    case "stripe": return `repeating-linear-gradient(0deg, ${c} 0 ${scale}px, ${a} ${scale}px ${scale * 1.6}px)`;
    case "pinstripe": return `repeating-linear-gradient(90deg, ${c} 0 ${scale * 2}px, ${a} ${scale * 2}px ${scale * 2 + 1}px)`;
    case "check":
    case "houndstooth":
      return `repeating-linear-gradient(0deg, transparent 0 ${scale}px, ${soft} ${scale}px ${scale * 2}px), repeating-linear-gradient(90deg, transparent 0 ${scale}px, ${soft} ${scale}px ${scale * 2}px), ${c}`;
    case "plaid":
      return `repeating-linear-gradient(0deg, transparent 0 ${scale}px, ${soft} ${scale}px ${scale * 1.6}px, transparent ${scale * 1.6}px ${scale * 2}px, ${a} ${scale * 2}px ${scale * 2 + 2}px), repeating-linear-gradient(90deg, transparent 0 ${scale}px, ${soft} ${scale}px ${scale * 1.6}px, transparent ${scale * 1.6}px ${scale * 2}px, ${a} ${scale * 2}px ${scale * 2 + 2}px), ${c}`;
    case "polka_dot": return `radial-gradient(${a} 22%, transparent 25%) 0 0 / ${scale * 1.4}px ${scale * 1.4}px, ${c}`;
    case "solid": return c;
    default:
      return `radial-gradient(circle at 30% 30%, ${soft} 0 18%, transparent 19%) 0 0 / ${scale * 2.5}px ${scale * 2.5}px, radial-gradient(circle at 70% 70%, ${soft} 0 12%, transparent 13%) 0 0 / ${scale * 2}px ${scale * 2}px, ${c}`;
  }
}

const TODAY_CSS = `
  #main { container-type:inline-size; }
  .loading { padding:28px; text-align:center; }

  /* weather "sky" panel */
  .sky { background:var(--sky); color:var(--ink); border-radius:20px; padding:16px 18px; display:flex; align-items:center;
    justify-content:space-between; gap:14px; flex-wrap:wrap; position:relative; overflow:hidden; }
  .sky::after { content:""; position:absolute; right:-40px; top:-60px; width:200px; height:200px; border-radius:50%;
    background:radial-gradient(circle, rgba(255,255,255,.35), transparent 70%); pointer-events:none; }
  .sky-main { display:flex; align-items:center; gap:14px; min-width:0; }
  .sky-icon { --mdc-icon-size:54px; color:var(--ink); opacity:.9; flex:none; }
  .eyebrow { font-size:12px; letter-spacing:.06em; text-transform:uppercase; opacity:.75; font-weight:500; }
  .temps { display:flex; align-items:baseline; gap:10px; line-height:1.05; margin-top:2px; }
  .temps .hi { font-size:40px; font-weight:600; letter-spacing:-.02em; }
  .temps .lo { font-size:22px; opacity:.65; font-weight:500; }
  .cond { font-size:14px; text-transform:capitalize; opacity:.85; margin-top:2px; }
  .pills { display:flex; gap:6px; flex-wrap:wrap; position:relative; z-index:1; }
  .pill { display:inline-flex; align-items:center; gap:5px; font-size:13px; font-weight:500; padding:5px 11px; border-radius:999px;
    background:color-mix(in srgb, var(--ink) 12%, transparent); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); }
  .pill ha-icon { --mdc-icon-size:16px; }

  .banner { display:flex; gap:10px; align-items:flex-start; padding:10px 14px; border-radius:14px; margin-top:12px; font-size:13.5px;
    background:color-mix(in srgb, var(--ca-accent) 9%, transparent); line-height:1.4; }
  .banner ha-icon { --mdc-icon-size:18px; flex:none; color:var(--ca-accent); margin-top:1px; }

  /* outfit tiles: one even, centred row that wraps */
  .board { display:grid; grid-template-columns:repeat(auto-fit, minmax(128px, 180px)); justify-content:center; gap:12px; margin-top:16px; }
  .tile { position:relative; display:flex; flex-direction:column; border-radius:18px; overflow:hidden;
    background:var(--card-background-color); border:1px solid var(--ca-line); box-shadow:var(--ca-shadow);
    transition:transform .2s ease, box-shadow .2s ease; }
  .tile:hover { transform:translateY(-2px); box-shadow:0 2px 4px rgba(0,0,0,.06), 0 10px 24px rgba(0,0,0,.09); }
  .tile .img { border-radius:0; }
  .tile .badge { position:absolute; top:8px; left:8px; font-size:11px; font-weight:600; letter-spacing:.02em;
    background:color-mix(in srgb, var(--card-background-color) 85%, transparent); color:var(--ca-accent);
    border:1px solid color-mix(in srgb, var(--ca-accent) 40%, transparent); padding:2px 8px; border-radius:999px;
    backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); }
  .tile.removable { border-color:color-mix(in srgb, var(--ca-accent) 45%, var(--ca-line)); }
  .tile .label { display:flex; flex-direction:column; gap:2px; padding:9px 12px 11px; min-width:0;
    border-top:1px solid var(--ca-line); }
  .tile .name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tile .slot { font-size:11px; color:var(--secondary-text-color); text-transform:uppercase; letter-spacing:.06em; }

  .basics { display:flex; gap:14px; justify-content:center; align-items:center; flex-wrap:wrap; font-size:13px; margin-top:12px; }
  .basic { display:inline-flex; align-items:center; gap:6px; }
  .dot { width:10px; height:10px; border-radius:50%; box-shadow:inset 0 0 0 1px rgba(0,0,0,.15); flex:none; }

  .why { margin:14px 0 0; padding:12px 14px 12px 32px; font-size:13.5px; line-height:1.45; color:var(--secondary-text-color);
    background:var(--ca-surface); border-radius:14px; }
  .why li { margin-bottom:4px; }
  .empty { padding:30px 12px; text-align:center; color:var(--secondary-text-color); display:flex; flex-direction:column; align-items:center; gap:8px; }
  .empty ha-icon { --mdc-icon-size:36px; opacity:.5; }

  .actions { display:flex; gap:4px; align-items:center; margin-top:16px; padding-top:12px; border-top:1px solid var(--ca-line); flex-wrap:wrap; }
  .actions button:not(.primary) { color:var(--secondary-text-color); }
  .actions button:not(.primary):hover { color:var(--primary-text-color); }
  .actions button.on { color:var(--ca-accent); background:color-mix(in srgb, var(--ca-accent) 10%, transparent); }
  .spacer { flex:1; }
  .worn { display:inline-flex; align-items:center; gap:6px; font-size:14px; font-weight:500; color:var(--success-color, #43a047); padding:0 6px; }
  .worn ha-icon { --mdc-icon-size:20px; }
  .small-err { padding:8px 0 0; font-size:13px; }

  /* closet popup */
  .closet-overlay { position:fixed; inset:0; z-index:998; background:rgba(15,18,24,.5); backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px);
    display:flex; align-items:center; justify-content:center; padding:16px; }
  .closet-dialog { position:relative; width:min(980px, 100%); max-height:92vh; overflow:auto; border-radius:24px;
    box-shadow:0 20px 60px rgba(0,0,0,.35); background:var(--card-background-color); }
  .closet-dialog closet-assistant-closet-card { display:block; }
  .close-x { position:absolute; top:16px; right:16px; z-index:2; padding:7px; background:var(--ca-surface-2); }

  /* sizes */
  @container (max-width: 400px) {
    .board { grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
    .actions { justify-content:center; }
    .actions .spacer { display:none; }
    .actions .primary, .actions .worn { order:-1; width:100%; justify-content:center; margin-bottom:6px; padding:10px 14px; }
    .temps .hi { font-size:34px; }
    .sky-icon { --mdc-icon-size:44px; }
    .actions button.small { padding:6px 9px; }
  }
  @container (min-width: 900px) {
    .board { grid-template-columns:repeat(auto-fit, minmax(150px, 200px)); gap:16px; }
    .sky { padding:20px 24px; }
    .temps .hi { font-size:46px; }
  }
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
  hasOpenDialog() {
    return Boolean(this._draft || this._confirm);
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
    const reviewing = this._filter === "unworn";
    const unworn = d.items.filter((i) => i.declutter).sort((a, b) => b.unworn_days - a.unworn_days);
    if (reviewing && !unworn.length) this._filter = "all";
    const items = d.items
      .filter((i) => this._filter === "all" || i.category === this._filter)
      .filter((i) => !this._dirtyOnly || !i.clean)
      .filter((i) => !q || `${i.name} ${i.color_name} ${i.pattern} ${i.fabric || ""}`.toLowerCase().includes(q))
      .sort((a, b) => Object.keys(cats).indexOf(a.category) - Object.keys(cats).indexOf(b.category) || a.name.localeCompare(b.name));
    const title = (this._config && this._config.title) || "Closet";

    this.$main.innerHTML = `
      <div class="head ${this._config && this._config.in_dialog ? "in-dialog" : ""}">
        <div>
          <div class="title">${esc(title)}</div>
          <div class="stats muted">
            <span><b>${d.counts.total}</b> items</span><span><b>${d.counts.clean}</b> clean</span><span><b>${d.counts.dirty}</b> in the hamper</span>
            <span><ha-icon icon="mdi:washing-machine"></ha-icon>${esc(weekdayName(d.next_laundry))}</span>
          </div>
        </div>
        <div class="tools">
          <button class="small primary" data-action="add"><ha-icon icon="mdi:plus"></ha-icon>Add</button>
          <button class="small outline" data-action="wash-all"><ha-icon icon="mdi:washing-machine"></ha-icon>Wash closet</button>
          <div class="menu-wrap">
            <button class="small outline icon-only" data-action="menu" title="More"><ha-icon icon="mdi:dots-vertical"></ha-icon></button>
            ${this._menu ? `<div class="menu">
              <button data-action="import"><ha-icon icon="mdi:upload"></ha-icon>Import JSON</button>
              <button data-action="export"><ha-icon icon="mdi:download"></ha-icon>Export JSON</button>
              <button data-action="scan"><ha-icon icon="mdi:folder-image"></ha-icon>Scan image folder</button>
            </div>` : ""}
          </div>
        </div>
      </div>
      <div class="filters">
        <div class="search-wrap"><ha-icon icon="mdi:magnify"></ha-icon><input class="search" type="search" placeholder="Search name, colour, fabric..." value="${esc(this._search)}" data-ui="search"></div>
        <button class="small outline toggle-chip ${this._dirtyOnly ? "sel" : ""}" data-action="toggle-dirty"><ha-icon icon="mdi:basket-outline"></ha-icon>In hamper${d.counts.dirty ? ` ${d.counts.dirty}` : ""}</button>
      </div>
      ${unworn.length && !reviewing && !this._hideNudge
        ? `<div class="nudge">
            <ha-icon icon="mdi:hanger-off"></ha-icon>
            <div class="nudge-text"><b>${unworn.length} ${unworn.length === 1 ? "item hasn't" : "items haven't"} been worn in ${spanText(d.settings.declutter_days)}+.</b>
              <span class="muted">Time to let some go? Donating what you don't wear makes the rest easier to choose from.</span></div>
            <button class="small primary" data-action="filter" data-cat="unworn">Review</button>
            <button class="small icon-only" data-action="hide-nudge" title="Not now"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>`
        : ""}
      <div class="chips">
        <button class="chip ${this._filter === "all" ? "sel" : ""}" data-action="filter" data-cat="all">All ${d.items.length}</button>
        ${unworn.length ? `<button class="chip unworn-chip ${reviewing ? "sel" : ""}" data-action="filter" data-cat="unworn"><ha-icon icon="mdi:hanger-off"></ha-icon>Unworn ${unworn.length}</button>` : ""}
        ${Object.entries(cats).filter(([k]) => counts[k]).map(([k, m]) =>
          `<button class="chip ${this._filter === k ? "sel" : ""}" data-action="filter" data-cat="${k}">${esc(m.label.split(" (")[0])} ${counts[k]}</button>`).join("")}
      </div>
      ${this._toast ? `<div class="toast">${esc(this._toast)}</div>` : ""}
      ${reviewing
        ? `<div class="review">
            <div class="review-intro muted">Not worn in ${spanText(d.settings.declutter_days)} or more${d.settings.declutter_days < 365 ? " (seasonal pieces like coats and shorts get a full year)" : ""}. <b>Keep</b> hides an item for another ${spanText(d.settings.declutter_days || 180)}; <b>Let go</b> removes it from your closet.</div>
            ${unworn.map((i) => `
              <div class="review-row">
                <div class="thumb" data-action="edit" data-id="${esc(i.id)}">${itemVisual(i, cats)}</div>
                <div class="review-info" data-action="edit" data-id="${esc(i.id)}">
                  <div class="name">${esc(i.name)}</div>
                  <div class="muted small-text">${esc(unwornText(i))}${i.times_worn ? ` · worn ${i.times_worn}× total` : ""}${i.seasonal ? " · seasonal" : ""}</div>
                </div>
                <button class="small" data-action="keep" data-id="${esc(i.id)}"><ha-icon icon="mdi:heart-outline"></ha-icon>Keep</button>
                <button class="small danger" data-action="let-go" data-id="${esc(i.id)}"><ha-icon icon="mdi:hand-heart-outline"></ha-icon>Let go</button>
              </div>`).join("")}
          </div>`
        : items.length
        ? `<div class="grid">${items.map((i) => `
            <div class="item ${i.clean ? "" : "dirty"}" data-action="edit" data-id="${esc(i.id)}">
              ${itemVisual(i, cats)}
              ${i.needs_review ? `<span class="flag">review</span>` : !i.clean ? `<span class="flag hamper">hamper</span>` : i.declutter ? `<span class="flag unworn" title="${esc(unwornText(i))}">unworn</span>` : ""}
              <div class="meta">
                <div class="name">${esc(i.name)}</div>
                <div class="sub muted">${pips(i)}<span>${esc(daysAgo(i.last_worn))}</span></div>
              </div>
            </div>`).join("")}</div>`
        : `<div class="empty muted">${d.items.length ? "Nothing matches that filter." : "Your closet is empty. Add an item, import a JSON file, or drop images into config/closet_assistant/images and scan."}</div>`}
    `;
    this._toast = null;
    caFitImages(this.$main);
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
          ${dr.id ? `<div class="history muted">${dr.declutter ? `<ha-icon icon="mdi:hanger-off"></ha-icon>` : ""}${esc(unwornText(dr))} · worn ${dr.times_worn || 0}× total${dr.added ? ` · added ${esc(weekdayName(dr.added))}` : ""}</div>` : ""}
        </div>
      </div>
      <div class="dlg-actions">
        ${dr.id ? `<button class="danger" data-action="delete"><ha-icon icon="mdi:delete-outline"></ha-icon>Delete</button>` : ""}
        ${dr.id && dr.tracks_cleanliness ? `<button data-action="wash-one"><ha-icon icon="mdi:washing-machine"></ha-icon>Mark clean</button>` : ""}
        ${dr.id ? `<button data-action="wear-one"><ha-icon icon="mdi:hanger"></ha-icon>Wore it today</button>` : ""}
        ${dr.id && dr.declutter ? `<button data-action="keep" data-id="${esc(dr.id)}"><ha-icon icon="mdi:heart-outline"></ha-icon>Keep</button>` : ""}
        <span style="flex:1"></span>
        <button data-action="close">Cancel</button>
        <button class="primary" data-action="save" ${this._busy || this._uploading ? "disabled" : ""}>Save</button>
      </div>
    </div></div>`;
    caFitImages(this.$modal);
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
      case "toggle-dirty":
        this._dirtyOnly = !this._dirtyOnly;
        return this._renderMain();
      case "hide-nudge":
        this._hideNudge = true;
        return this._renderMain();
      case "keep": {
        const item = d.items.find((i) => i.id === el.dataset.id);
        return this._run(async () => {
          await ws(this._hass, "keep", { item_ids: [el.dataset.id] });
          if (this._draft) { this._draft = null; this._renderModal(); }
        }, item ? `Keeping ${item.name}. Wear it soon!` : "Kept.");
      }
      case "let-go": {
        const item = d.items.find((i) => i.id === el.dataset.id);
        if (!item) return;
        return this._ask("Let it go?", `Remove "${item.name}" from your closet? ${unwornText(item)}. This also deletes its photo.`, [
          { label: "Let go", cls: "danger", run: async () => {
            await ws(this._hass, "item/delete", { item_id: item.id });
            if (this._draft) { this._draft = null; this._renderModal(); }
            this._toast = `Removed ${item.name}.`;
          } },
        ]);
      }
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
  .head.in-dialog { padding-right:44px; }
  .item .img { border:1px solid color-mix(in srgb, var(--c, #888) 18%, var(--divider-color)); }
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
  .dialog label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--secondary-text-color); }
  .dialog label input, .dialog label select { font:inherit; font-size:1rem; padding:7px 10px; border-radius:8px; border:1px solid var(--divider-color);
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

  .nudge { display:flex; align-items:center; gap:10px; margin:12px 0 4px; padding:10px 12px; border-radius:14px;
    background:color-mix(in srgb, var(--warning-color, #ffa600) 13%, transparent); }
  .nudge > ha-icon { color:var(--warning-color, #ffa600); flex:none; }
  .nudge-text { flex:1; display:flex; flex-direction:column; gap:2px; font-size:13px; min-width:0; }
  .icon-only { padding:6px; }
  .unworn-chip { display:inline-flex; align-items:center; gap:4px; }
  .unworn-chip ha-icon { --mdc-icon-size:15px; }
  .flag.unworn { background:var(--warning-color, #ffa600); }
  .review { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
  .review-intro { font-size:13px; margin-bottom:4px; }
  .review-row { display:flex; align-items:center; gap:12px; padding:8px; border-radius:14px; border:1px solid var(--divider-color); }
  .review-row .thumb { width:64px; flex:none; cursor:pointer; }
  .review-info { flex:1; min-width:0; cursor:pointer; }
  .review-info .name { font-size:14px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .small-text { font-size:12px; }
  .history { font-size:12px; display:flex; align-items:center; gap:4px; }
  .history ha-icon { --mdc-icon-size:15px; color:var(--warning-color, #ffa600); }
  @container (max-width: 420px) {
    .review-row { flex-wrap:wrap; }
    .review-info { flex-basis:calc(100% - 80px); }
    .review-row button { flex:1; justify-content:center; }
    .nudge { flex-wrap:wrap; }
  }

  /* ---- Responsive scaling ---- */
  #main { container-type:inline-size; }
  .item .name { font-size:13px; }
  .item .sub, .flag { font-size:11px; }
  .stats, .chip, .toggle { font-size:13px; }
  @container (max-width: 380px) {
    .grid { grid-template-columns:repeat(auto-fill, minmax(92px, 1fr)); gap:8px; }
  }
  @container (min-width: 700px) {
    .grid { grid-template-columns:repeat(auto-fill, minmax(132px, 1fr)); gap:12px; }
    .item .name { font-size:14px; }
    .item .sub { font-size:12px; }
  }
  @container (min-width: 1100px) {
    .grid { grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); }
  }

  /* ---- visual refresh ---- */
  .title { font-size:22px; font-weight:600; letter-spacing:-.01em; }
  .stats { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:13px; margin-top:4px; align-items:center; }
  .stats b { color:var(--primary-text-color); font-weight:600; }
  .stats ha-icon { --mdc-icon-size:15px; margin-right:3px; vertical-align:-2px; }
  .tools { gap:8px; }
  .icon-only { padding:7px; }
  .menu { border:1px solid var(--ca-line); border-radius:14px; box-shadow:0 12px 32px rgba(0,0,0,.18); }
  .filters { margin:16px 0 10px; gap:8px; }
  .search-wrap { flex:1; min-width:180px; position:relative; display:flex; align-items:center; }
  .search-wrap ha-icon { position:absolute; left:12px; --mdc-icon-size:19px; color:var(--secondary-text-color); pointer-events:none; }
  .search { width:100%; padding:9px 14px 9px 38px; border-radius:999px; border:1px solid var(--ca-line); background:var(--ca-surface);
    color:var(--primary-text-color); font:inherit; font-size:14px; outline:none; transition:border-color .15s, background .15s; }
  .search:focus { border-color:var(--ca-accent); background:var(--card-background-color); }
  .toggle-chip.sel, .chip.sel { background:var(--primary-text-color); color:var(--card-background-color); border-color:transparent; }
  .chips { gap:6px; padding-bottom:8px; scrollbar-width:none; }
  .chips::-webkit-scrollbar { display:none; }
  .chip { padding:5px 12px; font-size:13px; border:1px solid var(--ca-line); color:var(--secondary-text-color); }
  .chip:hover { color:var(--primary-text-color); }
  .grid { gap:14px; margin-top:10px; }
  .item { padding:0; border-radius:16px; overflow:hidden; background:var(--card-background-color); border:1px solid var(--ca-line);
    box-shadow:var(--ca-shadow); transition:transform .2s ease, box-shadow .2s ease; }
  .item:hover { background:var(--card-background-color); transform:translateY(-2px); box-shadow:0 2px 4px rgba(0,0,0,.06), 0 10px 24px rgba(0,0,0,.09); }
  .item .img { border-radius:0; border:none; }
  .item.dirty .img > * { opacity:.4; filter:grayscale(.7); }
  .item .meta { padding:8px 11px 10px; border-top:1px solid var(--ca-line); }
  .item .name { margin:0; font-weight:500; }
  .item .sub { margin-top:3px; flex-wrap:nowrap; white-space:nowrap; }
  .item .sub > span:last-child { overflow:hidden; text-overflow:ellipsis; }
  .flag { top:8px; left:8px; right:auto; font-weight:600; letter-spacing:.02em; padding:2px 8px; color:#fff; }
  .flag.hamper { background:color-mix(in srgb, var(--primary-text-color) 55%, transparent); }
  .toast { border-radius:12px; font-size:13.5px; }
  .nudge { border-radius:16px; padding:12px 14px; }
  .review-row { border-radius:16px; background:var(--card-background-color); box-shadow:var(--ca-shadow); border-color:var(--ca-line); }
  .review-row .thumb .img { border-radius:12px; }
  .empty { padding:36px 12px; }
  .overlay { background:rgba(15,18,24,.5); backdrop-filter:blur(3px); -webkit-backdrop-filter:blur(3px); }
  .dialog { border-radius:24px; padding:22px; box-shadow:0 20px 60px rgba(0,0,0,.35); }
  .dlg-title { font-size:19px; font-weight:600; }
  .preview .img { border-radius:18px; border:1px solid var(--ca-line); }
  .dialog label input, .dialog label select { border-radius:10px; border-color:var(--ca-line); background:var(--ca-surface); font-size:15px; }
  .dialog label input:focus, .dialog label select:focus { outline:none; border-color:var(--ca-accent); }
  .dlg-actions { border-top:1px solid var(--ca-line); padding-top:14px; }
  .dlg-actions button:not(.primary):not(.danger) { border-color:var(--ca-line); }
`;

/*
 * Registration. Home Assistant can swap in its own custom-element registry
 * after startup; a card defined before that is invisible to the dashboard,
 * which then waits on it forever. So keep (re)registering every 500 ms for
 * the first minute. Each attempt defines a fresh subclass, because one
 * constructor can't be registered under two registries.
 */
const CA_ELEMENTS = {
  "closet-assistant-today-card": ClosetAssistantTodayCard,
  "closet-assistant-closet-card": ClosetAssistantClosetCard,
};
function caRegister() {
  const registry = window.customElements;
  for (const [tag, Base] of Object.entries(CA_ELEMENTS)) {
    if (registry.get(tag)) continue;
    try {
      registry.define(tag, class extends Base {});
    } catch (err) {
      /* already defined in this registry, or the registry isn't ready yet */
    }
  }
}
caRegister();
let caTries = 0;
const caTimer = setInterval(() => {
  caRegister();
  if (++caTries >= 120) clearInterval(caTimer);
}, 500);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "closet-assistant-today-card")) {
  window.customCards.push(
    { type: "closet-assistant-today-card", name: "Closet Assistant: Wear Today", description: "Today's weather and a suggested outfit with layering and randomize." },
    { type: "closet-assistant-closet-card", name: "Closet Assistant: Manage Closet", description: "Add, edit, remove and wash the clothes in your closet." }
  );
}
console.info(`%c CLOSET ASSISTANT %c v${CA_VERSION} `, "background:#6b3fa0;color:#fff;border-radius:3px 0 0 3px", "background:#ddd;color:#333;border-radius:0 3px 3px 0");
