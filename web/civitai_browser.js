// ComfyUI Civitai Browser — frontend
// Adds a "Civitai" sidebar tab + full-screen browser (like Templates).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const EXT = "Civitai.Browser";
const ROUTE = "/civitai_browser";
const SETTING_KEY = "CivitaiBrowser.ApiKey";
const SETTING_NSFW = "CivitaiBrowser.ShowNSFW";

// ------------------------------------------------------------------ css
(() => {
  try {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./civitai_browser.css", import.meta.url).href;
    document.head.appendChild(link);
  } catch (e) { console.warn("[Civitai] css", e); }
})();

// ------------------------------------------------------------------ helpers
const CATEGORIES = [
  { id: "Workflows", label: "Workflows", icon: "pi pi-sitemap", types: ["Workflows"] },
  { id: "Checkpoint", label: "Checkpoint", icon: "pi pi-box", types: ["Checkpoint"] },
  { id: "LORA", label: "LoRA", icon: "pi pi-sliders-h", types: ["LORA", "LoCon", "DoRA"] },
  { id: "TextualInversion", label: "Embedding", icon: "pi pi-tag", types: ["TextualInversion"] },
  { id: "Controlnet", label: "ControlNet", icon: "pi pi-sitemap", types: ["Controlnet"] },
  { id: "VAE", label: "VAE", icon: "pi pi-palette", types: ["VAE"] },
  { id: "Upscaler", label: "Upscaler", icon: "pi pi-expand", types: ["Upscaler"] },
  { id: "MotionModule", label: "Motion", icon: "pi pi-video", types: ["MotionModule"] },
  { id: "All", label: "All", icon: "pi pi-th-large", types: [] },
];
const SORTS = ["Most Downloaded", "Highest Rated", "Newest"];
const SORT_LABELS = { "Most Downloaded": "Most downloaded", "Highest Rated": "Highest rated", "Newest": "Newest" };
const PERIODS = { AllTime: "All time", Year: "This year", Month: "This month", Week: "This week", Day: "Today" };
const BASE_MODELS = ["", "SD 1.5", "SDXL 1.0", "Pony", "Illustrious", "NoobAI", "Flux.1 D", "Flux.1 S", "SD 3.5", "Wan Video", "Hunyuan Video", "Qwen"];
const TYPE_TO_FOLDER = {
  checkpoint: "checkpoints", lora: "loras", locon: "loras", dora: "loras", lycoris: "loras",
  textualinversion: "embeddings", vae: "vae", controlnet: "controlnet", upscaler: "upscale_models",
  hypernetwork: "hypernetworks", motionmodule: "animatediff_models", detection: "ultralytics",
};
const IGNORE_NODE_TYPES = new Set(["Reroute", "Note", "MarkdownNote", "PrimitiveNode", "PrimitiveString", "PrimitiveInt", "PrimitiveFloat", "PrimitiveBoolean"]);

const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
};

const getSetting = (id, def) => {
  try {
    const v = app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id);
    return v ?? def;
  } catch { return def; }
};

const toast = (severity, summary, detail, life = 4000) => {
  try {
    if (app.extensionManager?.toast) return app.extensionManager.toast.add({ severity, summary, detail, life });
  } catch {}
  console.log(`[Civitai] ${summary}: ${detail || ""}`);
};

const fmtNum = (n) => {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};
const fmtSize = (kb) => {
  const b = Number(kb || 0) * 1024;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + " GB";
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + " MB";
  return (b / 1024).toFixed(0) + " KB";
};
const fmtBytes = (b) => fmtSize(Number(b || 0) / 1024);

const imgUrl = (url, width = 450) => {
  if (!url) return "";
  if (/\/(width|original)=[^/]+\//.test(url)) return url.replace(/\/(width|original)=[^/]+\//, `/width=${width}/`);
  return url.replace(/\/([^/]+)$/, `/width=${width}/$1`);
};

async function callApi(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const key = getSetting(SETTING_KEY, "");
  if (key) headers["X-Civitai-Key"] = key;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const res = await api.fetchApi(ROUTE + path, { ...opts, headers });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok) {
    let msg = data?.error;
    if (msg && typeof msg !== "string") msg = msg.message || JSON.stringify(msg).slice(0, 300);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return data;
}

function sanitizeHtml(html) {
  if (!html) return "";
  try {
    const r = app.extensionManager?.renderMarkdownToHtml;
    if (typeof r === "function") return r.call(app.extensionManager, html);
  } catch {}
  // fallback: plain text only
  const d = new DOMParser().parseFromString(html, "text/html");
  const div = document.createElement("div");
  div.textContent = d.body.textContent || "";
  div.style.whiteSpace = "pre-wrap";
  return div.outerHTML;
}

const pickImage = (model, nsfwOk) => {
  for (const v of model.modelVersions || []) {
    for (const im of v.images || []) {
      if (nsfwOk || !im.nsfwLevel || im.nsfwLevel <= 1) return { im, blur: false };
    }
  }
  const first = model.modelVersions?.[0]?.images?.[0];
  return first ? { im: first, blur: true } : null;
};

const mediaEl = (im, width, autoplay = false) => {
  if (!im) return el("div");
  if (im.type === "video") {
    const v = el("video", { src: imgUrl(im.url, width), muted: true, loop: true, playsinline: true, preload: "metadata" });
    v.muted = true;
    if (autoplay) v.autoplay = true;
    return v;
  }
  return el("img", { src: imgUrl(im.url, width), loading: "lazy", alt: "" });
};

const primaryFile = (version) => (version?.files || []).find((f) => f.primary) || version?.files?.[0];
const folderForType = (type) => TYPE_TO_FOLDER[(type || "").toLowerCase()] || "checkpoints";

// ------------------------------------------------------------------ downloads store
const downloads = {
  list: [],
  listeners: new Set(),
  timer: null,
  known: new Map(), // id -> status
  async refresh() {
    try {
      const d = await callApi("/downloads");
      this.list = d.downloads || [];
      let finished = false;
      for (const t of this.list) {
        const prev = this.known.get(t.id);
        if (prev && prev !== t.status && (t.status === "done")) {
          finished = true;
          toast("success", "Download complete", t.filename || t.name);
        }
        if (prev && prev !== t.status && t.status === "error") toast("error", "Download failed", `${t.name}: ${t.error}`, 8000);
        this.known.set(t.id, t.status);
      }
      if (finished) {
        try { await app.refreshComboInNodes?.(); } catch {}
      }
      this.listeners.forEach((fn) => { try { fn(this.list); } catch {} });
      const active = this.list.some((t) => t.status === "downloading" || t.status === "queued");
      if (active) this.schedule();
    } catch (e) { /* server not ready */ }
  },
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 1200);
  },
  async start({ url, folder, filename, name, workflow_file }) {
    const t = await callApi("/download", { method: "POST", json: { url, folder, filename, name, workflow_file } });
    this.known.set(t.id, t.status);
    await this.refresh();
    return t;
  },
  find(id) { return this.list.find((t) => t.id === id); },
  activeCount() { return this.list.filter((t) => t.status === "downloading").length; },
};

function renderDownloadItem(t) {
  const statusTxt = {
    downloading: `${Math.round((t.progress || 0) * 100)}% · ${fmtBytes(t.downloaded)}${t.total ? " / " + fmtBytes(t.total) : ""}${t.speed ? " · " + fmtBytes(t.speed) + "/s" : ""}`,
    done: "Done ✓", exists: "Already exists ✓", error: "Error: " + (t.error || ""), cancelled: "Cancelled",
  }[t.status] || t.status;
  const cls = { done: "ok", exists: "ok", error: "err", cancelled: "warn" }[t.status] || "";
  return el("div", { class: "cvb-dl" },
    el("div", { class: "cvb-dl-top" },
      el("div", { class: "cvb-dl-name" }, t.filename || t.name),
      t.status === "downloading" ? el("button", { class: "cvb-btn small", onclick: async () => { await callApi(`/downloads/${t.id}/cancel`, { method: "POST" }); downloads.refresh(); } }, "Cancel") : null),
    el("div", { class: "cvb-dl-sub" }, `📁 ${t.folder} · `, el("span", { class: "cvb-status " + cls }, statusTxt)),
    t.status === "downloading" ? el("div", { class: "cvb-progress" }, el("div", { style: { width: `${(t.progress || 0) * 100}%` } })) : null,
  );
}

// ------------------------------------------------------------------ canvas helpers
function addLoaderNode(type, filename) {
  try {
    const nodeType = { checkpoint: "CheckpointLoaderSimple", lora: "LoraLoader", locon: "LoraLoader", dora: "LoraLoader", vae: "VAELoader", controlnet: "ControlNetLoader", upscaler: "UpscaleModelLoader" }[(type || "").toLowerCase()];
    if (!nodeType || !window.LiteGraph) return false;
    const node = window.LiteGraph.createNode(nodeType);
    if (!node) return false;
    const w = node.widgets?.find((w) => w.type === "combo" || w.name?.includes("name"));
    if (w) w.value = filename;
    const c = app.canvas;
    const ds = c?.ds;
    if (ds && c.canvas) {
      node.pos = [(-ds.offset[0] + c.canvas.width / 2 / ds.scale) - 150, (-ds.offset[1] + c.canvas.height / 2 / ds.scale) - 50];
    }
    (c?.graph || app.graph).add(node);
    c?.setDirty?.(true, true);
    return true;
  } catch (e) { console.warn(e); return false; }
}

const normModel = (v) => String(v || "").replace(/\\/g, "/").toLowerCase();

// Re-point every widget in the loaded graph (incl. subgraphs) from one model name to another.
function replaceModelInGraph(fromName, toName) {
  const root = app.rootGraph || app.graph;
  const graphs = [root];
  try {
    const sg = root?.subgraphs;
    if (sg) for (const g of (typeof sg.values === "function" ? sg.values() : Object.values(sg))) graphs.push(g);
  } catch {}
  const from = normModel(fromName);
  let count = 0;
  for (const g of graphs) {
    for (const node of (g?._nodes || g?.nodes || [])) {
      for (const w of node.widgets || []) {
        if (typeof w.value === "string" && normModel(w.value) === from) {
          w.value = toName;
          try { w.callback?.(w.value, app.canvas, node); } catch {}
          count++;
        } else if (w.value && typeof w.value === "object") {
          for (const k of Object.keys(w.value)) {
            if (typeof w.value[k] === "string" && normModel(w.value[k]) === from) { w.value[k] = toName; count++; }
          }
        }
      }
    }
  }
  try { (app.canvas || {}).setDirty?.(true, true); root?.setDirtyCanvas?.(true, true); } catch {}
  return count;
}

const FOLDER_TYPES = {
  checkpoints: ["Checkpoint"], loras: ["LORA", "LoCon", "DoRA", "LyCORIS"], vae: ["VAE"],
  controlnet: ["Controlnet"], upscale_models: ["Upscaler"], embeddings: ["TextualInversion"],
};

function missingNodeTypes(wf) {
  const reg = window.LiteGraph?.registered_node_types || {};
  const out = new Set();
  const subIds = new Set(((wf?.definitions || {}).subgraphs || []).map((s) => s.id));
  const scan = (nodes) => (nodes || []).forEach((n) => {
    const t = n.type || n.class_type;
    if (!t || IGNORE_NODE_TYPES.has(t) || subIds.has(t) || reg[t]) return;
    out.add(t);
  });
  if (Array.isArray(wf?.nodes)) {
    scan(wf.nodes);
    ((wf.definitions || {}).subgraphs || []).forEach((s) => scan(s.nodes));
  } else if (wf && typeof wf === "object") {
    scan(Object.values(wf));
  }
  return [...out];
}

// ------------------------------------------------------------------ browser modal
class CivitaiBrowser {
  constructor() {
    this.state = {
      category: "Workflows", query: "", sort: "Most Downloaded", period: "AllTime", baseModel: "",
      items: [], cursor: null, loading: false, error: null, done: false, view: "grid", reqId: 0,
    };
    this.overlay = null;
    this.folders = null;
  }

  get nsfw() { return !!getSetting(SETTING_NSFW, false); }

  async ensureFolders() {
    if (this.folders) return this.folders;
    try { this.folders = (await callApi("/folders")).folders; } catch { this.folders = ["checkpoints", "loras", "vae", "controlnet", "embeddings", "upscale_models", "text_encoders", "diffusion_models", "clip_vision"]; }
    return this.folders;
  }

  folderSelect(value) {
    const s = el("select", { class: "cvb-select" });
    const list = [...new Set([...(this.folders || []), value])];
    for (const f of list) s.appendChild(el("option", { value: f, selected: f === value }, f));
    s.value = value;
    return s;
  }

  open(category) {
    if (category) this.state.category = category;
    if (this.overlay) { this.overlay.style.display = "flex"; return; }
    this.build();
    this.ensureFolders();
    downloads.refresh();
    this.reload();
  }

  close() { if (this.overlay) this.overlay.style.display = "none"; }

  build() {
    const st = this.state;
    this.search = el("input", { class: "cvb-input cvb-search", placeholder: "Search Civitai… (Enter)", value: st.query });
    this.search.addEventListener("keydown", (e) => { if (e.key === "Enter") { st.query = this.search.value.trim(); this.reload(); } });
    const sortSel = el("select", { class: "cvb-select" }, SORTS.map((s) => el("option", { value: s }, SORT_LABELS[s])));
    sortSel.value = st.sort;
    sortSel.onchange = () => { st.sort = sortSel.value; this.reload(); };
    const perSel = el("select", { class: "cvb-select" }, Object.entries(PERIODS).map(([k, v]) => el("option", { value: k }, v)));
    perSel.value = st.period;
    perSel.onchange = () => { st.period = perSel.value; this.reload(); };
    const baseSel = el("select", { class: "cvb-select" }, BASE_MODELS.map((b) => el("option", { value: b }, b || "All base models")));
    baseSel.onchange = () => { st.baseModel = baseSel.value; this.reload(); };
    const nsfwCb = el("input", { type: "checkbox" });
    nsfwCb.checked = this.nsfw;
    nsfwCb.onchange = () => {
      try { app.extensionManager?.setting?.set?.(SETTING_NSFW, nsfwCb.checked); } catch {}
      this._nsfwOverride = nsfwCb.checked;
      this.reload();
    };

    this.navEl = el("div", { class: "cvb-nav" });
    this.contentEl = el("div", { class: "cvb-content" });
    this.contentEl.addEventListener("scroll", () => {
      if (st.view !== "grid") return;
      const c = this.contentEl;
      if (c.scrollTop + c.clientHeight > c.scrollHeight - 600) this.loadMore();
    });

    const modal = el("div", { class: "cvb-modal" },
      el("div", { class: "cvb-header" },
        el("div", { class: "cvb-title" }, el("span", { class: "cvb-logo" }, "C"), "Civitai"),
        this.search, sortSel, perSel, baseSel,
        el("label", { class: "cvb-check" }, nsfwCb, "NSFW"),
        el("button", { class: "cvb-btn icon", title: "Close (Esc)", onclick: () => this.close() }, "✕")),
      el("div", { class: "cvb-body" }, this.navEl, this.contentEl));

    this.overlay = el("div", { class: "cvb-overlay" }, modal);
    this.overlay.addEventListener("mousedown", (e) => { if (e.target === this.overlay) this.close(); });
    this.overlay.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") this.close();
    });
    document.body.appendChild(this.overlay);
    downloads.listeners.add(() => this.renderNav());
    this.renderNav();
  }

  get showNsfw() { return this._nsfwOverride ?? this.nsfw; }

  renderNav() {
    if (!this.navEl) return;
    const st = this.state;
    this.navEl.innerHTML = "";
    this.navEl.appendChild(el("div", { class: "cvb-nav-label" }, "Categories"));
    for (const c of CATEGORIES) {
      this.navEl.appendChild(el("div", {
        class: "cvb-nav-item" + ((st.view === "grid" || st.view === "detail") && st.category === c.id ? " active" : ""),
        onclick: () => { st.category = c.id; this.reload(); },
      }, el("i", { class: c.icon }), c.label));
    }
    this.navEl.appendChild(el("div", { class: "cvb-nav-sep" }));
    this.navEl.appendChild(el("div", {
      class: "cvb-nav-item" + (st.view === "library" ? " active" : ""),
      onclick: () => this.showLibrary(),
    }, el("i", { class: "pi pi-bookmark" }), "My Library"));
    const active = downloads.activeCount();
    this.navEl.appendChild(el("div", {
      class: "cvb-nav-item" + (st.view === "downloads" ? " active" : ""),
      onclick: () => this.showDownloads(),
    }, el("i", { class: "pi pi-download" }), "Downloads", active ? el("span", { class: "cvb-count" }, active) : null));
    if (this._prep) {
      this.navEl.appendChild(el("div", {
        class: "cvb-nav-item" + (st.view === "prep" ? " active" : ""),
        onclick: () => this.renderPrep(),
      }, el("i", { class: "pi pi-check-square" }), "Setup"));
    }
    if (!getSetting(SETTING_KEY, "")) {
      this.navEl.appendChild(el("div", { class: "cvb-nav-sep" }));
      this.navEl.appendChild(el("p", { style: { fontSize: "11.5px", color: "var(--cvb-muted)", padding: "0 10px", lineHeight: "1.5" } },
        "Tip: some files require a Civitai API key. Add yours in Settings → Civitai."));
    }
  }

  // ---------------- list
  reload() {
    const st = this.state;
    st.view = "grid"; st.items = []; st.cursor = null; st.done = false; st.error = null;
    st.reqId++;
    st.loading = false; // a request still in flight for the old list must not block the new one
    this.renderNav();
    this.contentEl.innerHTML = "";
    this.gridEl = el("div", { class: "cvb-grid" });
    this.footEl = el("div", { class: "cvb-more" });
    this.contentEl.append(this.gridEl, this.footEl);
    this.contentEl.scrollTop = 0;
    this.loadMore();
  }

  async loadMore() {
    const st = this.state;
    if (st.loading || st.done || st.view !== "grid") return;
    st.loading = true;
    const myReq = st.reqId;
    this.footEl.innerHTML = "";
    this.footEl.appendChild(el("div", { class: "cvb-loading" }, el("span", { class: "cvb-spinner" }), "  Loading…"));
    const cat = CATEGORIES.find((c) => c.id === st.category) || CATEGORIES[0];
    const p = new URLSearchParams();
    p.set("limit", "24");
    for (const t of cat.types) p.append("types", t);
    if (st.query) p.set("query", st.query);
    p.set("sort", st.sort);
    p.set("period", st.period);
    if (st.baseModel) p.set("baseModels", st.baseModel);
    p.set("nsfw", this.showNsfw ? "true" : "false");
    if (st.cursor) p.set("cursor", st.cursor);
    try {
      const data = await callApi("/models?" + p.toString());
      if (myReq !== st.reqId) return;
      const items = data.items || [];
      st.items.push(...items);
      let next = data.metadata?.nextCursor;
      if (!next && data.metadata?.nextPage) {
        try { next = new URL(data.metadata.nextPage).searchParams.get("cursor"); } catch {}
      }
      st.cursor = next || null;
      st.done = !next || items.length === 0;
      items.forEach((m) => this.gridEl.appendChild(this.card(m)));
      this.footEl.innerHTML = "";
      if (!st.items.length) this.footEl.appendChild(el("div", { class: "cvb-empty" }, "No results."));
      else if (!st.done) this.footEl.appendChild(el("button", { class: "cvb-btn", onclick: () => this.loadMore() }, "Load more"));
    } catch (e) {
      if (myReq !== st.reqId) return;
      this.footEl.innerHTML = "";
      this.footEl.appendChild(el("div", { class: "cvb-empty cvb-error" }, "Error: " + e.message,
        el("div", { style: { marginTop: "10px" } }, el("button", { class: "cvb-btn", onclick: () => { st.loading = false; this.loadMore(); } }, "Retry"))));
    } finally {
      if (myReq === st.reqId) st.loading = false;
    }
  }

  card(m) {
    const pic = pickImage(m, this.showNsfw);
    const v0 = m.modelVersions?.[0];
    const thumb = el("div", { class: "cvb-thumb" + (pic?.blur ? " blur" : "") },
      pic ? mediaEl(pic.im, 450) : null,
      el("div", { class: "cvb-badges" },
        el("span", { class: "cvb-badge type" }, m.type === "Workflows" ? "Workflow" : m.type),
        v0?.baseModel ? el("span", { class: "cvb-badge" }, v0.baseModel) : null,
        m.nsfw ? el("span", { class: "cvb-badge nsfw" }, "NSFW") : null));
    const video = thumb.querySelector("video");
    const card = el("div", { class: "cvb-card", onclick: () => this.showDetail(m) },
      thumb,
      el("div", { class: "cvb-card-info" },
        el("div", { class: "cvb-card-name", title: m.name }, m.name),
        el("div", { class: "cvb-card-meta" },
          el("span", {}, "👤 " + (m.creator?.username || "?")),
          el("span", {}, "⬇ " + fmtNum(m.stats?.downloadCount)),
          el("span", {}, "👍 " + fmtNum(m.stats?.thumbsUpCount)))));
    if (video) {
      card.addEventListener("mouseenter", () => video.play().catch(() => {}));
      card.addEventListener("mouseleave", () => video.pause());
    }
    return card;
  }

  // ---------------- detail
  async showDetail(model, versionIndex = 0) {
    const st = this.state;
    const scroll = this.contentEl.scrollTop;
    st.view = "detail";
    this.renderNav();
    const c = this.contentEl;
    c.innerHTML = "";
    c.scrollTop = 0;
    const back = () => {
      st.view = "grid";
      c.innerHTML = "";
      c.append(this.gridEl, this.footEl);
      c.scrollTop = scroll;
      this.renderNav();
    };
    await this.ensureFolders();
    const versions = model.modelVersions || [];
    const ver = versions[versionIndex] || versions[0];
    const images = (ver?.images || []).filter((im) => this.showNsfw || !im.nsfwLevel || im.nsfwLevel <= 1);
    const main = el("div", { class: "cvb-gallery-main" }, images[0] ? mediaEl(images[0], 900, true) : el("div", { class: "cvb-empty" }, "No preview"));
    const thumbs = el("div", { class: "cvb-gallery-thumbs" });
    images.slice(0, 20).forEach((im, i) => {
      const t = el("img", { src: imgUrl(im.url, 120), class: i === 0 ? "active" : "", loading: "lazy" });
      t.onclick = () => {
        main.innerHTML = ""; main.appendChild(mediaEl(im, 900, true));
        thumbs.querySelectorAll("img").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
      };
      thumbs.appendChild(t);
    });

    const isWorkflow = model.type === "Workflows";
    const right = el("div", {});
    right.appendChild(el("h2", { class: "cvb-d-title" }, model.name));
    right.appendChild(el("div", { class: "cvb-d-sub" },
      el("span", {}, "👤 " + (model.creator?.username || "?")),
      el("span", {}, "⬇ " + fmtNum(model.stats?.downloadCount)),
      el("span", {}, "👍 " + fmtNum(model.stats?.thumbsUpCount)),
      el("span", {}, "🏷 " + (isWorkflow ? "Workflow" : model.type)),
      ver?.baseModel ? el("span", {}, "🧬 " + ver.baseModel) : null));

    if (versions.length > 1) {
      right.appendChild(el("div", { class: "cvb-section" }, el("h4", {}, "Version"),
        el("div", { class: "cvb-pills" }, versions.slice(0, 30).map((v, i) =>
          el("span", { class: "cvb-pill" + (v === ver ? " active" : ""), onclick: () => this.showDetail(model, i) }, v.name)))));
    }

    // primary actions
    const actions = el("div", { class: "cvb-actions" });
    if (isWorkflow) {
      const f = primaryFile(ver);
      const prepBtn = el("button", { class: "cvb-btn primary", onclick: () => this.prepareWorkflow(model, ver, f, true) }, "⚡ Load & Set Up");
      const loadBtn = el("button", { class: "cvb-btn", onclick: () => this.prepareWorkflow(model, ver, f, false) }, "Load only");
      if (!f) { prepBtn.disabled = true; loadBtn.disabled = true; }
      actions.append(prepBtn, loadBtn);
    }
    actions.appendChild(el("a", { class: "cvb-btn", href: `https://civitai.com/models/${model.id}${ver ? "?modelVersionId=" + ver.id : ""}`, target: "_blank", rel: "noopener" }, "Open on Civitai ↗"));
    right.appendChild(actions);

    if (ver?.trainedWords?.length) {
      right.appendChild(el("div", { class: "cvb-section" }, el("h4", {}, "Trigger words (click to copy)"),
        el("div", { class: "cvb-pills" }, ver.trainedWords.map((w) => el("span", {
          class: "cvb-tag", title: "Copy",
          onclick: () => { navigator.clipboard?.writeText(w); toast("info", "Copied", w, 1500); },
        }, w)))));
    }

    // files
    const filesSec = el("div", { class: "cvb-section" }, el("h4", {}, "Files"));
    for (const f of ver?.files || []) {
      const folder = isWorkflow ? null : this.folderSelect(folderForType(model.type));
      const meta = [fmtSize(f.sizeKB), f.metadata?.format, f.metadata?.fp, f.metadata?.size, f.type].filter(Boolean).join(" · ");
      const row = el("div", { class: "cvb-file" },
        el("div", { class: "cvb-file-grow" }, el("div", { class: "cvb-file-name" }, f.name, f.primary ? "  ★" : ""), el("div", { class: "cvb-file-meta" }, meta)));
      if (!isWorkflow) {
        const status = el("span", { class: "cvb-status" });
        const dlBtn = el("button", { class: "cvb-btn primary small" }, "⬇ Download");
        const addBtn = el("button", { class: "cvb-btn small", style: { display: "none" } }, "＋ Add to canvas");
        dlBtn.onclick = async () => {
          dlBtn.disabled = true;
          try {
            const t = await downloads.start({ url: f.downloadUrl, folder: folder.value, filename: f.name, name: `${model.name} — ${f.name}` });
            const upd = () => {
              const cur = downloads.find(t.id);
              if (!cur) return;
              if (cur.status === "downloading") status.textContent = `${Math.round((cur.progress || 0) * 100)}%`;
              else if (cur.status === "done" || cur.status === "exists") {
                status.textContent = cur.status === "done" ? "Downloaded ✓" : "Already exists ✓";
                status.className = "cvb-status ok";
                if (["checkpoint", "lora", "locon", "dora", "vae", "controlnet", "upscaler"].includes((model.type || "").toLowerCase())) {
                  addBtn.style.display = "";
                  addBtn.onclick = () => { if (addLoaderNode(model.type, cur.filename)) { toast("success", "Added", cur.filename, 2000); this.close(); } };
                }
                downloads.listeners.delete(upd);
              } else if (cur.status === "error" || cur.status === "cancelled") {
                status.textContent = cur.status === "error" ? "Error" : "Cancel";
                status.className = "cvb-status err";
                status.title = cur.error || "";
                dlBtn.disabled = false;
                downloads.listeners.delete(upd);
              }
            };
            downloads.listeners.add(upd);
            upd();
          } catch (e) {
            toast("error", "Could not start download", e.message);
            dlBtn.disabled = false;
          }
        };
        row.append(el("span", { class: "cvb-file-meta" }, "📁"), folder, dlBtn, status, addBtn);
      }
      filesSec.appendChild(row);
    }
    right.appendChild(filesSec);

    if (model.tags?.length) {
      right.appendChild(el("div", { class: "cvb-section" }, el("h4", {}, "Tags"),
        el("div", { class: "cvb-pills" }, model.tags.slice(0, 25).map((t) => el("span", {
          class: "cvb-tag", onclick: () => { this.search.value = t; this.state.query = t; this.reload(); },
        }, t)))));
    }
    if (model.description || ver?.description) {
      right.appendChild(el("div", { class: "cvb-section" }, el("h4", {}, "Description"),
        el("div", { class: "cvb-desc", html: sanitizeHtml((ver?.description ? ver.description + "<hr>" : "") + (model.description || "")) })));
    }

    c.appendChild(el("button", { class: "cvb-btn cvb-back", onclick: back }, "← Back"));
    c.appendChild(el("div", { class: "cvb-detail" }, el("div", {}, main, thumbs), right));
  }

  // ---------------- workflow: load + prepare
  async prepareWorkflow(model, ver, file, prepare) {
    if (!file?.downloadUrl) return toast("error", "No file", "This version has no downloadable file.");
    const c = this.contentEl;
    const prevChildren = [...c.childNodes];
    const overlay = el("div", { class: "cvb-loading" }, el("span", { class: "cvb-spinner" }), "  Downloading workflow…");
    c.prepend(overlay);
    let data;
    try {
      const pic = pickImage(model, this.showNsfw);
      data = await callApi("/workflow/fetch", { method: "POST", json: {
        url: file.downloadUrl,
        name: `${model.name}${ver?.name ? " - " + ver.name : ""}`,
        model_id: model.id, version_id: ver?.id, base_model: ver?.baseModel,
        image: pic && !pic.blur ? imgUrl(pic.im.url, 450) : null,
      } });
    } catch (e) {
      overlay.remove();
      return toast("error", "Could not fetch workflow", e.message, 9000);
    }
    overlay.remove();
    let chosen = data.workflows[0];
    if (data.workflows.length > 1) {
      chosen = await this.chooseWorkflow(data.workflows, prevChildren);
      if (!chosen) return;
    }
    const wf = chosen.workflow;
    const name = `${model.name}${ver?.name ? " - " + ver.name : ""}`.replace(/[\\/:*?"<>|]/g, "_");
    if (chosen.saved_as) toast("info", "Saved", `Workflows panel → ${chosen.saved_as} (also in Civitai → My Library)`, 6000);
    const libFile = chosen.saved_as ? chosen.saved_as.split("/").pop() : null;
    await this.openWorkflow(wf, name, prepare, libFile);
  }

  async openWorkflow(wf, name, prepare, libFile = null) {
    try {
      if (Array.isArray(wf.nodes)) await app.loadGraphData(wf, true, true, name);
      else if (typeof app.loadApiJson === "function") await app.loadApiJson(wf, name);
      else throw new Error("API-format workflows cannot be loaded in this ComfyUI version.");
    } catch (e) {
      return toast("error", "Could not load workflow", e.message, 9000);
    }
    toast("success", "Workflow loaded", name, 2500);
    if (!prepare) { this.close(); return; }
    await this.analyze(wf, name, libFile);
  }

  chooseWorkflow(list, restore) {
    return new Promise((resolve) => {
      const c = this.contentEl;
      c.innerHTML = "";
      c.appendChild(el("h3", {}, "This package contains several workflows — pick one:"));
      const done = (v) => { c.innerHTML = ""; restore.forEach((n) => c.appendChild(n)); resolve(v); };
      list.forEach((w) => c.appendChild(el("div", { class: "cvb-file" },
        el("div", { class: "cvb-file-grow" }, el("div", { class: "cvb-file-name" }, w.name),
          el("div", { class: "cvb-file-meta" }, Array.isArray(w.workflow.nodes) ? `${w.workflow.nodes.length} node` : "API format")),
        el("button", { class: "cvb-btn primary small", onclick: () => done(w) }, "Select"))));
      c.appendChild(el("button", { class: "cvb-btn", onclick: () => done(null) }, "Cancel"));
    });
  }

  async analyze(wf, name, libFile = null) {
    await this.ensureFolders();
    const c = this.contentEl;
    c.innerHTML = "";
    c.appendChild(el("div", { class: "cvb-loading" }, el("span", { class: "cvb-spinner" }), "  Checking for missing models…"));
    let res;
    try { res = await callApi("/analyze", { method: "POST", json: { workflow: wf } }); }
    catch (e) { c.innerHTML = ""; return toast("error", "Analysis failed", e.message); }
    this._prep = {
      name, wf, libFile,
      missing: res.missing.map((m) => ({ ...m, status: m.url ? "url" : "searching", candidates: [], taskId: null })),
      present: res.present,
      nodes: missingNodeTypes(wf),
    };
    this.renderPrep();
    // look up models without a URL on Civitai
    const queue = this._prep.missing.filter((m) => !m.url);
    const prep = this._prep;
    const worker = async () => {
      while (queue.length) {
        const m = queue.shift();
        await this.searchCandidates(m);
        if (this._prep === prep && this.state.view === "prep") this.renderPrep();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  async searchCandidates(m) {
    const stem = m.basename.replace(/\.[^.]+$/, "");
    const queries = [stem, stem.replace(/[_\-.]+/g, " ").replace(/\s*v?\d+(\.\d+)*\s*$/i, "").trim()].filter((q, i, a) => q && a.indexOf(q) === i);
    const target = m.basename.toLowerCase();
    const found = [];
    for (const q of queries) {
      try {
        const p = new URLSearchParams({ query: q, limit: "10", nsfw: "true" });
        const data = await callApi("/models?" + p.toString());
        for (const it of data.items || []) {
          for (const v of it.modelVersions || []) {
            for (const f of v.files || []) {
              const exact = (f.name || "").toLowerCase() === target;
              const allowed = FOLDER_TYPES[m.folder];
              if (!exact && allowed && !allowed.includes(it.type)) continue; // e.g. don't suggest checkpoints for a VAE
              if (exact || f.primary) {
                if (!found.some((x) => x.file.id === f.id)) found.push({ model: it, version: v, file: f, exact });
              }
            }
          }
        }
        if (found.some((x) => x.exact)) break;
      } catch (e) { m.searchError = e.message; }
    }
    found.sort((a, b) => (b.exact - a.exact));
    m.candidates = found.slice(0, 4);
    const exact = found.find((x) => x.exact);
    if (exact) { m.status = "match"; m.url = exact.file.downloadUrl; m.match = exact; }
    else m.status = found.length ? "candidates" : "notfound";
  }

  downloadMissing(m, url, altName) {
    url = url || m.url;
    if (!url) return;
    m.url = url;
    let filename = m.name;
    const ext = (n) => (n || "").toLowerCase().split(".").pop();
    if (altName && ext(altName) !== ext(m.name)) {
      // different format (e.g. .ckpt vs .safetensors): keep the real name, user re-selects it in the node
      filename = altName;
      toast("warn", "Different file name", `Will be saved as ${altName} — you'll need to select it in the node.`, 7000);
    }
    return downloads.start({ url, folder: m.folder, filename, name: m.name, workflow_file: this._prep?.libFile || null })
      .then((t) => { m.taskId = t.id; this.renderPrep(); })
      .catch((e) => toast("error", "Could not start download", e.message));
  }

  renderPrep() {
    const P = this._prep;
    if (!P) return;
    const st = this.state;
    st.view = "prep";
    this.renderNav();
    const c = this.contentEl;
    c.innerHTML = "";
    const wrap = el("div", { class: "cvb-prep" });
    const downloadable = P.missing.filter((m) => m.url && !m.taskId && !m.usedLocal);
    const allDone = P.missing.every((m) => {
      if (m.usedLocal) return true;
      const t = m.taskId && downloads.find(m.taskId);
      return t && (t.status === "done" || t.status === "exists");
    });

    wrap.appendChild(el("div", { class: "cvb-prep-head" },
      el("h3", {}, "Setup: " + P.name),
      downloadable.length ? el("button", { class: "cvb-btn primary", onclick: async () => { for (const m of downloadable) await this.downloadMissing(m); } }, `⬇ Download found models (${downloadable.length})`) : null,
      el("button", { class: "cvb-btn", onclick: () => this.analyze(P.wf, P.name, P.libFile) }, "↻ Re-check"),
      el("button", { class: "cvb-btn ok", onclick: () => this.close() }, "Back to canvas")));

    wrap.appendChild(el("div", { class: "cvb-summary" },
      el("div", { class: "cvb-stat" }, el("b", { style: { color: "var(--cvb-ok)" } }, P.present.length), el("span", {}, "Models ready")),
      el("div", { class: "cvb-stat" }, el("b", { style: { color: P.missing.length ? "var(--cvb-warn)" : "var(--cvb-ok)" } }, P.missing.length), el("span", {}, "Missing models")),
      el("div", { class: "cvb-stat" }, el("b", { style: { color: P.nodes.length ? "var(--cvb-err)" : "var(--cvb-ok)" } }, P.nodes.length), el("span", {}, "Missing custom nodes"))));

    if (!P.missing.length && !P.nodes.length) {
      wrap.appendChild(el("div", { class: "cvb-empty" }, "🎉 Everything is ready! The workflow can be run."));
    } else if (P.missing.length && allDone && !P.nodes.length) {
      wrap.appendChild(el("div", { class: "cvb-empty", style: { padding: "14px" } }, "🎉 All missing models downloaded. The workflow is ready!"));
    }

    if (P.missing.length) {
      wrap.appendChild(el("h4", { style: { margin: "18px 0 8px", color: "var(--cvb-muted)", fontSize: "12px", textTransform: "uppercase" } }, "Missing models"));
      for (const m of P.missing) wrap.appendChild(this.prepRow(m));
    }

    if (P.nodes.length) {
      wrap.appendChild(el("h4", { style: { margin: "18px 0 8px", color: "var(--cvb-muted)", fontSize: "12px", textTransform: "uppercase" } }, "Missing custom nodes"));
      const hasManager = !!document.querySelector("[id*='manager'], .comfyui-manager-menu-btn") || !!app.extensionManager?.command?.commands?.some?.((x) => /manager/i.test(x.id || ""));
      wrap.appendChild(el("div", { class: "cvb-row" },
        el("div", { class: "cvb-row-sub", style: { marginTop: 0, marginBottom: "8px" } },
          hasManager
            ? "Install them all at once with ComfyUI-Manager → \"Install Missing Custom Nodes\", then restart ComfyUI."
            : "ComfyUI-Manager is recommended for installing these (Manager → \"Install Missing Custom Nodes\"). Restart ComfyUI afterwards."),
        el("div", { class: "cvb-pills" }, P.nodes.map((n) => el("a", {
          class: "cvb-tag", target: "_blank", rel: "noopener",
          href: "https://github.com/search?type=code&q=" + encodeURIComponent(`"${n}" NODE_CLASS_MAPPINGS`),
          title: "Search on GitHub",
        }, n)))));
    }
    c.appendChild(wrap);
  }

  prepRow(m) {
    const t = m.taskId && downloads.find(m.taskId);
    const folder = this.folderSelect(m.folder);
    folder.onchange = () => { m.folder = folder.value; };
    const top = el("div", { class: "cvb-row-top" }, el("div", { class: "cvb-row-name" }, m.name), el("span", { class: "cvb-file-meta" }, "📁"), folder);
    const row = el("div", { class: "cvb-row" }, top);
    let statusEl;
    if (t) {
      folder.disabled = true;
      if (t.status === "downloading") {
        statusEl = el("span", { class: "cvb-status" }, `${Math.round((t.progress || 0) * 100)}%`);
        top.appendChild(statusEl);
        row.appendChild(el("div", { class: "cvb-progress" }, el("div", { style: { width: `${(t.progress || 0) * 100}%` } })));
        const upd = () => {
          if (this.state.view !== "prep") { downloads.listeners.delete(upd); return; }
          const cur = downloads.find(m.taskId);
          if (!cur || cur.status !== "downloading") { downloads.listeners.delete(upd); this.renderPrep(); return; }
          statusEl.textContent = `${Math.round((cur.progress || 0) * 100)}% · ${fmtBytes(cur.downloaded)}${cur.total ? " / " + fmtBytes(cur.total) : ""}`;
          row.querySelector(".cvb-progress > div").style.width = `${(cur.progress || 0) * 100}%`;
        };
        downloads.listeners.add(upd);
      } else if (t.status === "done" || t.status === "exists") {
        top.appendChild(el("span", { class: "cvb-status ok" }, "✓ Downloaded"));
      } else {
        top.appendChild(el("span", { class: "cvb-status err", title: t.error || "" }, t.status === "error" ? "Error" : "Cancel"));
        top.appendChild(el("button", { class: "cvb-btn small", onclick: () => { m.taskId = null; this.downloadMissing(m); } }, "Retry"));
        if (t.error) row.appendChild(el("div", { class: "cvb-row-sub cvb-error" }, t.error));
      }
      return row;
    }

    if (m.usedLocal) {
      folder.disabled = true;
      top.appendChild(el("span", { class: "cvb-status ok" }, "✓ Using your file"));
      row.appendChild(el("div", { class: "cvb-row-sub" }, `Node now points to: ${m.usedLocal}`,
        " · ", el("a", { href: "#", style: { color: "var(--cvb-accent)" }, onclick: (e) => {
          e.preventDefault();
          replaceModelInGraph(m.usedLocal, m.name);
          m.usedLocal = null;
          this.renderPrep();
        } }, "undo")));
      return row;
    }

    row.appendChild(el("div", { class: "cvb-row-sub" }, `Node: ${m.node_type}`));
    if (m.similar?.length) {
      const box = el("div", { class: "cvb-match cvb-similar" },
        el("div", { class: "cvb-file-meta" }, "💡 You already have something similar — use it instead of downloading:"));
      for (const s of m.similar) {
        box.appendChild(el("div", { class: "cvb-match-item" },
          el("div", { class: "grow" }, el("b", {}, s.name), el("span", { class: "cvb-file-meta" }, `  📁 ${s.folder}${s.same_folder ? "" : " (different folder — the node may not see it)"}`)),
          el("button", { class: "cvb-btn ok small", onclick: () => {
            const n = replaceModelInGraph(m.name, s.name);
            if (!n) return toast("warn", "Nothing changed", "Couldn't find this model in the loaded workflow. Is the workflow still open on the canvas?", 6000);
            m.usedLocal = s.name;
            toast("success", "Using your model", `${n} node input${n > 1 ? "s" : ""} → ${s.name}`, 3000);
            this.renderPrep();
          } }, "✓ Use mine")));
      }
      row.appendChild(box);
    }
    if (m.status === "url") {
      top.appendChild(el("span", { class: "cvb-status ok" }, "Source known"));
      top.appendChild(el("button", { class: "cvb-btn primary small", onclick: () => this.downloadMissing(m) }, "⬇ Download"));
    } else if (m.status === "searching") {
      top.appendChild(el("span", { class: "cvb-status" }, el("span", { class: "cvb-spinner" }), " Searching Civitai…"));
    } else if (m.status === "match") {
      top.appendChild(el("span", { class: "cvb-status ok" }, "✓ Exact match on Civitai"));
      top.appendChild(el("button", { class: "cvb-btn primary small", onclick: () => this.downloadMissing(m) }, "⬇ Download"));
      row.appendChild(this.candidateList([m.match], m, false));
    } else if (m.status === "candidates") {
      top.appendChild(el("span", { class: "cvb-status warn" }, "No exact match — possible models:"));
      row.appendChild(this.candidateList(m.candidates, m, true));
    } else {
      top.appendChild(el("span", { class: "cvb-status err" }, "Not found on Civitai"));
    }
    // manual URL
    const urlIn = el("input", { class: "cvb-input", placeholder: "…or paste a download link (Civitai / Hugging Face)", style: { flex: "1", minWidth: "220px" } });
    row.appendChild(el("div", { class: "cvb-row-top", style: { marginTop: "8px" } }, urlIn,
      el("button", { class: "cvb-btn small", onclick: () => { const u = urlIn.value.trim(); if (/^https?:\/\//.test(u)) this.downloadMissing(m, u); else toast("warn", "Invalid link", u); } }, "Download from link"),
      el("button", { class: "cvb-btn small", onclick: () => { this.search.value = m.basename.replace(/\.[^.]+$/, ""); this.state.query = this.search.value; this.state.category = "All"; this.reload(); } }, "Search in browser")));
    return row;
  }

  candidateList(list, m, choose) {
    const box = el("div", { class: "cvb-match" });
    for (const c of list) {
      const im = c.version.images?.find((i) => i.type !== "video") || null;
      box.appendChild(el("div", { class: "cvb-match-item" },
        im ? el("img", { src: imgUrl(im.url, 80), loading: "lazy" }) : null,
        el("div", { class: "grow" },
          el("div", {}, el("b", {}, c.model.name), " — ", c.version.name),
          el("div", { class: "cvb-file-meta" }, `${c.file.name} · ${fmtSize(c.file.sizeKB)} · ${c.version.baseModel || ""}`)),
        el("a", { class: "cvb-btn small", href: `https://civitai.com/models/${c.model.id}?modelVersionId=${c.version.id}`, target: "_blank", rel: "noopener" }, "↗"),
        choose ? el("button", { class: "cvb-btn small", title: `The file is saved under the name the workflow expects (${m.name})`, onclick: () => this.downloadMissing(m, c.file.downloadUrl, c.file.name) }, "Use this") : null));
    }
    return box;
  }

  async showLibrary() {
    const st = this.state;
    st.view = "library";
    this.renderNav();
    const c = this.contentEl;
    c.innerHTML = "";
    c.appendChild(el("div", { class: "cvb-loading" }, el("span", { class: "cvb-spinner" }), "  Loading…"));
    let data;
    try { data = await callApi("/library"); }
    catch (e) { c.innerHTML = ""; c.appendChild(el("div", { class: "cvb-empty cvb-error" }, "Error: " + e.message)); return; }
    if (st.view !== "library") return;
    c.innerHTML = "";
    c.appendChild(el("div", { class: "cvb-prep-head" }, el("h3", {}, "My Library — your downloaded workflows"),
      el("button", { class: "cvb-btn", onclick: () => this.showLibrary() }, "↻ Refresh")));
    c.appendChild(el("p", { class: "cvb-file-meta", style: { margin: "0 0 14px" } },
      "Every workflow you get from Civitai is saved automatically. It also appears in ComfyUI's own Workflows panel, in the \"Civitai\" folder. Folder: " + data.folder));
    if (!data.items.length) {
      c.appendChild(el("div", { class: "cvb-empty" }, "No saved workflows yet. Workflows you open with \"Load & Set Up\" will show up here."));
      return;
    }
    const grid = el("div", { class: "cvb-grid" });
    const delBtn = (it) => el("button", { class: "cvb-btn small cvb-del", title: "Remove from library", onclick: () => this.confirmDelete(it) }, "🗑");
    for (const it of data.items) {
      const open = async (prepare) => {
        try {
          const r = await callApi("/library/file?file=" + encodeURIComponent(it.file));
          await this.openWorkflow(r.workflow, it.title, prepare, it.file);
        } catch (e) { toast("error", "Could not open", e.message); }
      };
      grid.appendChild(el("div", { class: "cvb-card", style: { cursor: "default" } },
        el("div", { class: "cvb-thumb", style: { aspectRatio: "4 / 3" } },
          it.image ? el("img", { src: it.image, loading: "lazy" }) : el("div", { class: "cvb-empty", style: { padding: "40px 0" } }, "🗂"),
          el("div", { class: "cvb-badges" }, el("span", { class: "cvb-badge type" }, "Workflow"),
            it.base_model ? el("span", { class: "cvb-badge" }, it.base_model) : null)),
        el("div", { class: "cvb-card-info" },
          el("div", { class: "cvb-card-name", title: it.title }, it.title),
          el("div", { class: "cvb-card-meta" }, new Date(it.mtime * 1000).toLocaleString()),
          el("div", { style: { display: "flex", gap: "6px", marginTop: "4px", flexWrap: "wrap" } },
            el("button", { class: "cvb-btn primary small", onclick: () => open(true) }, "⚡ Open & Set Up"),
            el("button", { class: "cvb-btn small", onclick: () => open(false) }, "Open"),
            it.model_id ? el("a", { class: "cvb-btn small", target: "_blank", rel: "noopener", href: `https://civitai.com/models/${it.model_id}` }, "↗") : null,
            delBtn(it)))));
    }
    c.appendChild(grid);
  }

  async confirmDelete(it) {
    const st = this.state;
    st.view = "library-delete";
    this.renderNav();
    const c = this.contentEl;
    c.innerHTML = "";
    c.appendChild(el("div", { class: "cvb-loading" }, el("span", { class: "cvb-spinner" }), "  Checking models downloaded for this workflow…"));
    let models = [];
    try { models = (await callApi("/library/models?file=" + encodeURIComponent(it.file))).models || []; }
    catch (e) { toast("error", "Check failed", e.message); }
    if (st.view !== "library-delete") return;
    c.innerHTML = "";
    const wrap = el("div", { class: "cvb-prep" });
    wrap.appendChild(el("div", { class: "cvb-prep-head" }, el("h3", {}, "Delete: " + it.title)));
    wrap.appendChild(el("div", { class: "cvb-row" },
      el("div", { class: "cvb-row-name" }, "🗂 Workflow file"),
      el("div", { class: "cvb-row-sub" }, "Will be removed from My Library and from the \"Civitai\" folder in the Workflows panel.")));

    const checks = [];
    wrap.appendChild(el("h4", { style: { margin: "18px 0 6px", color: "var(--cvb-muted)", fontSize: "12px", textTransform: "uppercase" } }, "Models downloaded by this extension"));
    wrap.appendChild(el("p", { class: "cvb-file-meta", style: { margin: "0 0 10px", lineHeight: "1.5" } },
      "Only files this extension downloaded are listed. Models you already had, files that were skipped because they already existed, and models used by any of your other workflows are never deleted."));
    if (!models.length) {
      wrap.appendChild(el("div", { class: "cvb-row" }, el("div", { class: "cvb-row-sub", style: { marginTop: 0 } }, "No models were downloaded for this workflow — only the workflow will be deleted.")));
    }
    for (const m of models) {
      const cb = el("input", { type: "checkbox" });
      const protectedBy = m.used_by && m.used_by.length;
      cb.checked = m.linked && !protectedBy;
      cb.disabled = !!protectedBy;
      if (!cb.disabled) checks.push({ cb, m });
      wrap.appendChild(el("label", { class: "cvb-row", style: { display: "block", cursor: protectedBy ? "default" : "pointer", opacity: protectedBy ? 0.7 : 1 } },
        el("div", { class: "cvb-row-top" }, cb,
          el("div", { class: "cvb-row-name" }, m.filename),
          el("span", { class: "cvb-file-meta" }, `📁 ${m.folder} · ${fmtBytes(m.size)}`)),
        protectedBy
          ? el("div", { class: "cvb-row-sub cvb-status ok" }, "🔒 Protected — also used by: " + m.used_by.join(", "))
          : el("div", { class: "cvb-row-sub" }, m.linked ? "Downloaded while setting up this workflow." : "Downloaded by this extension and used by this workflow (matched by file name — leave unchecked if unsure).")));
    }
    const total = () => checks.filter((x) => x.cb.checked).reduce((a, x) => a + x.m.size, 0);
    const delBtn = el("button", { class: "cvb-btn cvb-del armed" });
    const upd = () => {
      const n = checks.filter((x) => x.cb.checked).length;
      delBtn.textContent = n ? `🗑 Delete workflow + ${n} model${n > 1 ? "s" : ""} (${fmtBytes(total())})` : "🗑 Delete workflow only";
    };
    checks.forEach((x) => x.cb.addEventListener("change", upd));
    upd();
    delBtn.onclick = async () => {
      delBtn.disabled = true;
      try {
        const r = await callApi("/library/delete", { method: "POST", json: { file: it.file, delete_models: checks.filter((x) => x.cb.checked).map((x) => x.m.id) } });
        const n = (r.deleted_models || []).length;
        toast("success", "Deleted", it.title + (n ? ` + ${n} model${n > 1 ? "s" : ""}` : ""), 3500);
        (r.skipped || []).forEach((s) => toast("warn", "Not deleted", `${s.filename || s.id}: ${s.reason}`, 7000));
        if (n) { try { await app.refreshComboInNodes?.(); } catch {} }
        downloads.refresh();
        this.showLibrary();
      } catch (e) { delBtn.disabled = false; toast("error", "Could not delete", e.message); }
    };
    wrap.appendChild(el("div", { class: "cvb-actions", style: { marginTop: "18px" } }, delBtn,
      el("button", { class: "cvb-btn", onclick: () => this.showLibrary() }, "Cancel")));
    c.appendChild(wrap);
  }

  showDownloads() {
    const st = this.state;
    st.view = "downloads";
    this.renderNav();
    const c = this.contentEl;
    const render = () => {
      if (st.view !== "downloads") { downloads.listeners.delete(render); return; }
      c.innerHTML = "";
      c.appendChild(el("div", { class: "cvb-prep-head" }, el("h3", {}, "Downloads"),
        el("button", { class: "cvb-btn", onclick: async () => { await callApi("/downloads/clear", { method: "POST" }); downloads.refresh(); } }, "Clear finished")));
      if (!downloads.list.length) c.appendChild(el("div", { class: "cvb-empty" }, "No downloads yet."));
      downloads.list.forEach((t) => c.appendChild(renderDownloadItem(t)));
    };
    downloads.listeners.add(render);
    render();
    downloads.refresh();
  }
}

const browser = new CivitaiBrowser();
let setupAt = 0;

// ------------------------------------------------------------------ sidebar panel
function renderSidebar(container) {
  container.innerHTML = "";
  const list = el("div");
  const side = el("div", { class: "cvb-side" },
    el("h3", {}, "Civitai"),
    el("p", {}, "Browse Civitai workflows and models, load them in one click and download missing models automatically."),
    el("button", { class: "cvb-btn primary", onclick: () => browser.open() }, "🔎 Open Civitai Browser"),
    el("button", { class: "cvb-btn", onclick: () => { browser.open(); browser.showLibrary(); } }, "📚 My Library"),
    el("div", { class: "cvb-side-cats" }, CATEGORIES.slice(0, 6).map((cat) =>
      el("button", { class: "cvb-btn small", onclick: () => { browser.open(); browser.state.category = cat.id; browser.reload(); } }, cat.label))),
    el("h3", { style: { marginTop: "6px" } }, "Downloads"),
    list);
  const update = () => {
    if (!container.isConnected) { downloads.listeners.delete(update); return; }
    list.innerHTML = "";
    if (!downloads.list.length) list.appendChild(el("p", {}, "No downloads yet."));
    downloads.list.slice(0, 15).forEach((t) => list.appendChild(renderDownloadItem(t)));
  };
  downloads.listeners.add(update);
  container.appendChild(side);
  update();
  downloads.refresh();
}

// ------------------------------------------------------------------ register
app.registerExtension({
  name: EXT,
  settings: [
    {
      id: SETTING_KEY,
      category: ["Civitai", "General", "API key"],
      name: "Civitai API key (required for some downloads)",
      tooltip: "Create one at civitai.com → Account Settings → Security & Apps → API Keys.",
      type: "text",
      defaultValue: "",
    },
    {
      id: SETTING_NSFW,
      category: ["Civitai", "General", "NSFW"],
      name: "Show NSFW content",
      type: "boolean",
      defaultValue: false,
    },
  ],
  commands: [
    { id: "CivitaiBrowser.Open", label: "Open Civitai Browser", icon: "pi pi-globe", function: () => browser.open() },
  ],
  menuCommands: [
    { path: ["Workflow"], commands: ["CivitaiBrowser.Open"] },
  ],
  async setup() {
    setupAt = performance.now();
    try {
      const em = app.extensionManager;
      if (em?.registerSidebarTab) {
        em.registerSidebarTab({
          id: "civitai-browser",
          icon: "pi pi-globe",
          title: "Civitai",
          label: "Civitai",
          tooltip: "Civitai — workflow & model browser",
          type: "custom",
          render: (container) => {
            renderSidebar(container);
            // don't pop the browser up automatically if the tab was restored at startup
            if (performance.now() - setupAt > 2500) browser.open();
          },
        });
      } else {
        // legacy UI fallback: floating button
        document.body.appendChild(el("button", { class: "cvb-fab", onclick: () => browser.open() }, "Civitai"));
      }
    } catch (e) {
      console.warn("[Civitai] sidebar registration failed", e);
      try { document.body.appendChild(el("button", { class: "cvb-fab", onclick: () => browser.open() }, "Civitai")); } catch {}
    }
  },
});
