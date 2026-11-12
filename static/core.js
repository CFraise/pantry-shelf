"use strict";
// ── Pantry Shelf: shared state, helpers, router, modals, home & search ──────

let S = null;                     // snapshot from /api/snapshot
const IX = { ing: new Map(), loc: new Map(), list: new Map(), recipe: new Map() };
const UI = {                       // view state that survives re-renders
  editKitchen: false, editArea: false, editPantry: false,
  openShelves: new Set(), lowSpace: "all", recipeCol: 0, recipeSort: "name", recipeQ: "",
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LMAX = 10;

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["Content-Type"] = "application/json"; }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch (_) { /* empty body */ }
  if (!r.ok || (data && data.error)) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}

// Run an action, toast any error, then reload the snapshot.
async function act(fn, { reload = true, ok } = {}) {
  try {
    const out = await fn();
    if (reload) await refresh();
    if (ok) toast(ok);
    return out;
  } catch (e) {
    toast(e.message, { err: true });
    throw e;
  }
}

// ── snapshot & indices ──────────────────────────────────────────────────────
async function refresh(rerender = true) {
  S = await api("GET", "/api/snapshot");
  IX.ing = new Map(S.ingredients.map(i => [i.id, i]));
  IX.loc = new Map(S.locations.map(l => [l.id, l]));
  IX.list = new Map(S.lists.map(l => [l.id, l]));
  IX.recipe = new Map(S.recipes.map(r => [r.id, r]));
  if (rerender) {
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
    for (const m of modalStack) if (m.rerender) m.rerender();
  }
}

const children = (pid, kind) => S.locations.filter(l => l.parent_id === pid && (!kind || l.kind === kind));
const topLocs = (space, kind) => S.locations.filter(l => l.space === space && !l.parent_id && l.kind === kind);

function locPath(id, { space = true } = {}) {
  const parts = [];
  let l = IX.loc.get(id), guard = 0;
  if (!l) return "Not placed yet";
  const sp = l.space;
  while (l && guard++ < 10) { parts.unshift(l.name); l = IX.loc.get(l.parent_id); }
  if (space) parts.unshift(sp === "kitchen" ? "Kitchen" : "Pantry");
  return parts.join(" › ");
}

// All location ids inside (and including) ``id``.
function subtree(id) {
  const out = [id];
  for (const c of S.locations.filter(l => l.parent_id === id)) out.push(...subtree(c.id));
  return out;
}

// [{ing, stock}] placed in exactly ``locId`` (or anywhere under it with deep=true); archived hidden.
function stockAt(locId, { deep = false, archived = false } = {}) {
  const ids = new Set(deep ? subtree(locId) : [locId]);
  const out = [];
  for (const ing of S.ingredients) {
    if (ing.archived && !archived) continue;
    for (const st of ing.stock) if (ids.has(st.location_id)) out.push({ ing, st });
  }
  return out.sort((a, b) => a.ing.name.localeCompare(b.ing.name));
}

function unplaced(space) {
  const out = [];
  for (const ing of S.ingredients) {
    if (ing.archived) continue;
    for (const st of ing.stock) if (st.space === space && !IX.loc.has(st.location_id)) out.push({ ing, st });
  }
  return out;
}

// ── levels ──────────────────────────────────────────────────────────────────
const lvlClass = l => l <= 1 ? "crit" : l <= 2 ? "low" : "";
const lvlFlag = l => l === 0 ? "EMPTY" : l <= 1 ? "10%" : l <= 2 ? "LOW" : "";
const lvlBar = l => `<div class="lvl ${lvlClass(l)}"><i style="width:${l * 10}%"></i></div>`;
const pctTag = l => `<span class="pct-tag ${lvlClass(l)}">${l === 0 ? "Empty" : l * 10 + "%"}</span>`;
// Best level across an ingredient's spots (what "do we have it" means for recipes).
const bestLevel = ing => ing.stock.length ? Math.max(...ing.stock.map(s => s.level)) : null;

// ── pictures ────────────────────────────────────────────────────────────────
const CAT_EMOJI = [
  [/spice|herb|season|pepper|salt/i, "🧂"], [/oil|vinegar|sauce|condiment|dressing/i, "🫙"],
  [/flour|baking|sugar|grain|rice|pasta|cereal|bread/i, "🌾"], [/fruit|apple|berry/i, "🍎"],
  [/veg|onion|garlic|potato|tomato/i, "🥕"], [/dairy|milk|cheese|butter|yog/i, "🧀"],
  [/meat|chicken|beef|pork|fish|seafood/i, "🍖"], [/drink|beverage|coffee|tea|juice/i, "☕"],
  [/snack|chip|cookie|chocolate|candy/i, "🍪"], [/can|tin|soup|bean/i, "🥫"], [/nut|seed/i, "🥜"],
];
function emojiFor(ing) {
  const s = `${ing.category || ""} ${ing.name || ""}`;
  for (const [re, e] of CAT_EMOJI) if (re.test(s)) return e;
  return "🥫";
}
const imgSrc = name => name ? `/img/${encodeURIComponent(name)}` : "";
function pic(ing) {
  return ing.image ? `<img src="${imgSrc(ing.image)}" alt="" loading="lazy">` : `<div class="ph">${emojiFor(ing)}</div>`;
}

// An ingredient tile. ``st`` = the stock row whose level to show (else the lowest).
function tile(ing, st, extra = "") {
  const lvl = st ? st.level : (ing.stock.length ? Math.min(...ing.stock.map(s => s.level)) : null);
  const cls = lvl == null ? "" : `${lvlClass(lvl)}${lvl === 0 ? " out" : ""}`;
  const flag = lvl == null ? "" : lvlFlag(lvl);
  return `<button class="tile ${cls} ${ing.archived ? "archived" : ""}" data-act="ing" data-id="${ing.id}" ${extra}>
    <div class="pic">${pic(ing)}${flag ? `<span class="flag">${flag}</span>` : ""}</div>
    ${lvl == null ? "" : lvlBar(lvl)}
    <span class="name">${esc(ing.name)}</span></button>`;
}

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ── toasts ──────────────────────────────────────────────────────────────────
function toast(msg, { err = false, actions = [], ms = 3500 } = {}) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.innerHTML = `<span class="msg">${esc(msg)}</span>`;
  const close = () => t.remove();
  for (const a of actions) {
    const b = document.createElement("button");
    b.className = "btn small " + (a.cls || "");
    b.textContent = a.label;
    b.onclick = () => { close(); a.run && a.run(); };
    t.appendChild(b);
  }
  $("#toasts").appendChild(t);
  setTimeout(close, actions.length ? Math.max(ms, 9000) : ms);
}

// ── modals ──────────────────────────────────────────────────────────────────
const modalStack = [];
function openModal(html, { wide = false, onClose } = {}) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal ${wide ? "wide" : ""}"><button class="x" data-close>✕</button><div class="mbody"></div></div>`;
  const m = { back, el: $(".mbody", back), onClose, rerender: null };
  m.el.innerHTML = html;
  back.addEventListener("mousedown", e => { if (e.target === back) closeModal(m); });
  $("[data-close]", back).onclick = () => closeModal(m);
  $("#modals").appendChild(back);
  modalStack.push(m);
  document.body.style.overflow = "hidden";
  return m;
}
function closeModal(m = modalStack[modalStack.length - 1]) {
  if (!m) return;
  const i = modalStack.indexOf(m);
  if (i >= 0) modalStack.splice(i, 1);
  m.back.remove();
  if (!modalStack.length) document.body.style.overflow = "";
  if (m.onClose) m.onClose();
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && modalStack.length) closeModal(); });

function confirmBox(msg, { yes = "OK", no = "Cancel", danger = false } = {}) {
  return new Promise(res => {
    const m = openModal(`<h2>${esc(msg)}</h2><div class="actions">
      <button class="btn" data-no>${esc(no)}</button>
      <button class="btn ${danger ? "red" : "primary"}" data-yes>${esc(yes)}</button></div>`,
      { onClose: () => res(false) });
    $("[data-yes]", m.el).onclick = () => { m.onClose = null; closeModal(m); res(true); };
    $("[data-no]", m.el).onclick = () => closeModal(m);
  });
}

function promptBox(title, fields, { submit = "Save" } = {}) {
  // fields: [{name, label, value, placeholder, type}]
  return new Promise(res => {
    const m = openModal(`<h2>${esc(title)}</h2><form class="grid1" style="display:flex;flex-direction:column;gap:10px">
      ${fields.map(f => f.type === "checkbox"
        ? `<label class="place-toggle"><input type="checkbox" name="${f.name}" ${f.value ? "checked" : ""}> ${esc(f.label)}</label>`
        : `<label class="field">${esc(f.label)}<input name="${f.name}" value="${esc(f.value || "")}" placeholder="${esc(f.placeholder || "")}"></label>`).join("")}
      <div class="actions"><button type="button" class="btn" data-no>Cancel</button><button class="btn primary">${esc(submit)}</button></div></form>`,
      { onClose: () => res(null) });
    const form = $("form", m.el);
    setTimeout(() => { const i = $("input:not([type=checkbox])", form); if (i) i.focus(); }, 50);
    $("[data-no]", m.el).onclick = () => closeModal(m);
    form.onsubmit = e => {
      e.preventDefault();
      const out = {};
      for (const f of fields) {
        const el = form.elements[f.name];
        out[f.name] = f.type === "checkbox" ? el.checked : el.value.trim();
      }
      m.onClose = null; closeModal(m); res(out);
    };
  });
}

// Image picker used by location / recipe editors: upload, URL, or keep.
async function uploadImage(file) {
  const fd = new FormData();
  fd.append("file", file);
  return (await api("POST", "/api/images/upload", fd)).image;
}
const fetchImage = async url => (await api("POST", "/api/images/fetch", { url })).image;

// ── router ──────────────────────────────────────────────────────────────────
const ROUTES = [];
const route = (re, fn) => ROUTES.push([re, fn]);
const go = h => { location.hash = h; };

function render() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      $("#app").innerHTML = fn(params, ...m.slice(1)) || "";
      document.body.dataset.route = path.split("/")[1] || "home";
      $("#banner").classList.toggle("hidden", path !== "/" || !bannerReady);
      if (window.afterRender) { const f = window.afterRender; window.afterRender = null; f(); }
      return;
    }
  }
  go("/");
}
window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

// Delegated clicks: data-go="#/x" navigates, data-act="name" runs ACT[name](el, event).
const ACT = {};
document.addEventListener("click", e => {
  const g = e.target.closest("[data-go]");
  if (g) { e.preventDefault(); go(g.dataset.go); return; }
  const a = e.target.closest("[data-act]");
  if (a && ACT[a.dataset.act]) { e.preventDefault(); e.stopPropagation(); ACT[a.dataset.act](a, e); }
});

const backBtn = (to, label = "‹ Back") => `<button class="back" data-go="${to}">${esc(label)}</button>`;

// ── banner ──────────────────────────────────────────────────────────────────
let bannerReady = false;
function buildBanner() {
  const withPics = S.ingredients.filter(i => i.image && !i.archived);
  if (withPics.length < 4) return;
  const pick = withPics.sort(() => Math.random() - .5).slice(0, 40);
  const track = $("#banner-track");
  track.innerHTML = [...pick, ...pick].map(i =>
    `<button data-act="ing" data-id="${i.id}" title="${esc(i.name)}"><img src="${imgSrc(i.image)}" alt=""></button>`).join("");
  track.style.animationDuration = Math.round(pick.length * 96 / 35) + "s";
  bannerReady = true;
}

// ── home ────────────────────────────────────────────────────────────────────
function lowStock(space = "all") {
  const out = [];
  for (const ing of S.ingredients) {
    if (ing.archived) continue;
    for (const st of ing.stock) {
      if (st.level <= 2 && (space === "all" || st.space === space)) out.push({ ing, st });
    }
  }
  return out;
}
const activeLists = () => S.lists.filter(l => !l.done_at);

route(/^\/$/, () => {
  const live = S.ingredients.filter(i => !i.archived);
  const inK = live.filter(i => i.stock.some(s => s.space === "kitchen")).length;
  const inP = live.filter(i => i.stock.some(s => s.space === "pantry")).length;
  const toBuy = activeLists().reduce((n, l) => n + l.items.filter(i => !i.checked).length, 0);
  const low = lowStock();
  const crit = low.filter(x => x.st.level <= 1).length;
  const k = S.koillection;
  window.afterRender = wireSearch;
  return `
  <header class="page"><h1>🥫 Pantry Shelf</h1><p>What's in the cupboard?</p></header>
  <div class="searchbox"><input id="search" type="search" placeholder="Find an ingredient or recipe…" autocomplete="off">
    <div class="search-results" id="search-results"></div></div>
  <div class="big-grid">
    <button class="big-btn kitchen" data-go="#/kitchen"><span class="emoji">🍳</span>
      <span><span class="label">Kitchen</span><br><span class="sub">${plural(topLocs("kitchen", "area").length, "area")} · ${plural(inK, "item")}</span></span>
      ${lowStock("kitchen").length ? `<span class="badge">⚠ ${lowStock("kitchen").length}</span>` : ""}</button>
    <button class="big-btn pantry" data-go="#/pantry"><span class="emoji">🥫</span>
      <span><span class="label">Pantry</span><br><span class="sub">${plural(topLocs("pantry", "shelf").length, "shelf").replace("shelfs", "shelves")} · ${plural(inP, "item")}</span></span>
      ${lowStock("pantry").length ? `<span class="badge">⚠ ${lowStock("pantry").length}</span>` : ""}</button>
    <button class="big-btn grocery" data-go="#/grocery"><span class="emoji">🛒</span>
      <span><span class="label">Grocery List</span><br><span class="sub">${plural(activeLists().length, "list")} · ${toBuy} to buy</span></span></button>
    <button class="big-btn recipes" data-go="#/recipes"><span class="emoji">📖</span>
      <span><span class="label">Recipes</span><br><span class="sub">${plural(S.recipes.length, "recipe")}</span></span></button>
  </div>
  <div class="quick-row">
    <button class="btn primary" data-act="add-ing">+ Add ingredient</button>
    <button class="btn red" data-go="#/low">⚠️ Running low <span class="count ${low.length ? "" : "zero"}">${low.length}</span></button>
    <button class="btn amber" data-go="#/putaway">📦 Put away <span class="count ${S.putaway.length ? "" : "zero"}">${S.putaway.length}</span></button>
    <button class="btn" data-go="#/duplicates">🔁 Duplicates</button>
  </div>
  ${crit ? `<p class="muted" style="text-align:center;font-size:.85rem">${plural(crit, "thing")} empty or nearly empty.</p>` : ""}
  ${!S.ingredients.length ? `<div class="card empty-note">Start by creating your <a href="#/kitchen">kitchen areas</a> and
    <a href="#/pantry">pantry shelves</a>, then add ingredients.</div>` : ""}
  <footer class="status">${S.ingredients.length} ingredients ·
    Koillection mirror: ${k.enabled ? (k.error ? `<span style="color:var(--red)" title="${esc(k.error)}">error</span>`
      : `on (“${esc(k.collection)}”)${k.pending ? `, ${k.pending} pending` : ""}`) : "off"}</footer>`;
});

// ── search ──────────────────────────────────────────────────────────────────
function searchMatches(q) {
  q = q.trim().toLowerCase();
  if (!q) return { ings: [], recipes: [] };
  const words = q.split(/\s+/);
  const hit = s => words.every(w => s.toLowerCase().includes(w));
  const ings = S.ingredients.filter(i => hit(`${i.name} ${i.brand} ${i.category}`))
    .sort((a, b) => (a.archived - b.archived) || (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)));
  const recipes = S.recipes.filter(r => hit(r.title));
  return { ings, recipes };
}

function ingRow(ing, extraActs = "") {
  const spots = ing.stock.length ? ing.stock.map(s => `${esc(locPath(s.location_id))} ${pctTag(s.level)}`).join("<br>")
    : "Not placed anywhere";
  const minL = ing.stock.length ? Math.min(...ing.stock.map(s => s.level)) : 10;
  return `<div class="row clickable ${lvlClass(minL)}" data-act="ing" data-id="${ing.id}">
    <div class="thumb">${ing.image ? `<img src="${imgSrc(ing.image)}" alt="">` : emojiFor(ing)}</div>
    <div class="main"><b>${esc(ing.name)}${ing.archived ? ' <span class="src">archived</span>' : ""}</b><small>${spots}</small></div>
    ${extraActs ? `<div class="acts">${extraActs}</div>` : ""}</div>`;
}

function wireSearch() {
  const input = $("#search"), out = $("#search-results");
  if (!input) return;
  input.oninput = () => {
    const { ings, recipes } = searchMatches(input.value);
    if (!input.value.trim()) { out.innerHTML = ""; return; }
    out.innerHTML = (ings.length ? `<div class="sr-head">Ingredients</div><div class="rows" style="padding:0 8px 8px">${ings.slice(0, 12).map(i => ingRow(i)).join("")}</div>` : "")
      + (recipes.length ? `<div class="sr-head">Recipes</div><div class="rows" style="padding:0 8px 8px">${recipes.slice(0, 6).map(r =>
        `<div class="row clickable" data-go="#/recipes/${r.id}"><div class="thumb">${r.image ? `<img src="${imgSrc(r.image)}" style="object-fit:cover">` : "📖"}</div>
         <div class="main"><b>${esc(r.title)}</b><small>${"★".repeat(r.rating)}</small></div></div>`).join("")}</div>` : "")
      + (!ings.length && !recipes.length ? `<div class="empty-note">Nothing called “${esc(input.value)}”.
         <br><button class="btn primary small" data-act="add-ing" data-name="${esc(input.value)}" style="margin-top:8px">+ Add “${esc(input.value)}”</button></div>` : "");
  };
  input.onkeydown = e => { if (e.key === "Escape") { input.value = ""; out.innerHTML = ""; } };
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    await refresh(false);
  } catch (e) {
    $("#app").innerHTML = `<div class="empty-note">Couldn't load Pantry Shelf: ${esc(e.message)}</div>`;
    return;
  }
  buildBanner();
  render();
  // Pick up changes made on another device (e.g. someone ticking the list at the store).
  setInterval(() => {
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!modalStack.length && !typing && document.visibilityState === "visible") refresh().catch(() => {});
  }, 60000);
}
