"use strict";
// ── Recipe book: browse/import, collections, ratings, have/missing ingredients ──

const RCACHE = new Map();          // recipe id -> full recipe (lines, directions)
const RSEL = new Map();
const RFETCHED = new Set();            // recipe id -> Set of selected line indexes

// Status of one recipe line given its matched ingredient id.
function lineStatus(iid) {
  if (!iid) return { cls: "untracked", label: "not tracked" };
  const ing = IX.ing.get(iid);
  if (!ing) return { cls: "untracked", label: "not tracked" };
  const lvl = bestLevel(ing);
  const where = ing.stock.length ? locPath(ing.stock.reduce((a, b) => (b.level > a.level ? b : a)).location_id) : "";
  if (lvl == null) return { cls: "out", label: `${ing.name}: not stocked`, ing };
  if (lvl === 0) return { cls: "out", label: `${ing.name}: out · ${where}`, ing };
  if (lvl <= 2) return { cls: "low", label: `${ing.name}: ${lvl * 10}% left · ${where}`, ing };
  return { cls: "have", label: `${ing.name}: ${lvl * 10}% · ${where}`, ing };
}

function haveBar(lineIds) {
  const n = lineIds.length || 1;
  const c = { have: 0, low: 0, out: 0 };
  for (const id of lineIds) { const s = lineStatus(id).cls; if (s in c) c[s]++; }
  return `<div class="have-bar" title="${c.have} in stock · ${c.low} low · ${c.out} missing">
    <i style="width:${c.have / n * 100}%;background:var(--green)"></i><i style="width:${c.low / n * 100}%;background:var(--amber)"></i>
    <i style="width:${c.out / n * 100}%;background:var(--red)"></i></div>`;
}
const stars = (n, big) => `<span class="stars ${big ? "big" : ""}">${[1, 2, 3, 4, 5].map(i =>
  big ? `<button data-act="rate" data-n="${i}" class="${i <= n ? "" : "off"}">★</button>` : `<span class="${i <= n ? "" : "off"}">★</span>`).join("")}</span>`;

// ── book ────────────────────────────────────────────────────────────────────
route(/^\/recipes$/, () => {
  let list = S.recipes.filter(r => !UI.recipeCol || r.collections.includes(UI.recipeCol));
  const q = UI.recipeQ.trim().toLowerCase();
  if (q) list = list.filter(r => r.title.toLowerCase().includes(q));
  const sorters = {
    name: (a, b) => a.title.localeCompare(b.title),
    rating: (a, b) => b.rating - a.rating || a.title.localeCompare(b.title),
    recent: (a, b) => b.created_at.localeCompare(a.created_at),
    ready: (a, b) => missing(a) - missing(b) || a.title.localeCompare(b.title),
  };
  list.sort(sorters[UI.recipeSort]);
  window.afterRender = () => {
    const i = $("#rq");
    if (i) i.oninput = () => { UI.recipeQ = i.value; const pos = i.selectionStart; render(); const j = $("#rq"); j.focus(); j.setSelectionRange(pos, pos); };
  };
  return `<div class="toolbar">${backBtn("#/", "‹ Home")}<span class="spacer"></span>
    <button class="btn primary" data-act="recipe-add">+ Add recipe</button></div>
  <header class="page"><h1>📖 Recipes</h1><p>Your recipe book</p></header>
  <div class="chips">
    <button class="chip ${!UI.recipeCol ? "on" : ""}" data-act="rcol" data-id="0">All (${S.recipes.length})</button>
    ${S.recipe_collections.map(c => `<button class="chip ${UI.recipeCol === c.id ? "on" : ""}" data-act="rcol" data-id="${c.id}">${esc(c.name)} (${S.recipes.filter(r => r.collections.includes(c.id)).length})</button>`).join("")}
    <button class="chip" data-act="rcol-manage" title="Add, rename or remove collections">⚙️</button></div>
  <div class="toolbar"><input id="rq" type="search" placeholder="Filter recipes…" value="${esc(UI.recipeQ)}" style="flex:1;min-width:150px">
    <select id="rsort" data-act-change="rsort" style="width:auto">
      ${[["name", "A–Z"], ["rating", "Top rated"], ["recent", "Recently added"], ["ready", "Fewest missing"]].map(([k, l]) =>
        `<option value="${k}" ${UI.recipeSort === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
  ${list.length ? `<div class="recipe-grid">${list.map(r => `<button class="recipe-card" data-go="#/recipes/${r.id}">
      <div class="img">${r.image ? `<img src="${imgSrc(r.image)}" alt="" loading="lazy">` : "🍽️"}</div>
      <div class="body"><b>${esc(r.title)}</b>${stars(r.rating)}
        ${haveBar(r.line_ids)}<small>${haveText(r)}${r.total_time ? ` · ${esc(r.total_time)}` : ""}</small></div></button>`).join("")}</div>`
    : `<div class="empty-note">${S.recipes.length ? "No recipes match." : "No recipes yet. Add one from a website, paste one in, or browse TheMealDB."}</div>`}`;
});

function haveText(r) {
  const tracked = r.line_ids.filter(Boolean).length, miss = missing(r);
  if (!tracked) return "No ingredients tracked";
  return miss ? `${miss} of ${tracked} tracked missing` : `Have all ${tracked} tracked`;
}
const missing = r => r.line_ids.filter(id => ["out", "low"].includes(lineStatus(id).cls)).length;

ACT.rcol = el => { UI.recipeCol = +el.dataset.id; render(); };
document.addEventListener("change", e => {
  if (e.target.id === "rsort") { UI.recipeSort = e.target.value; render(); }
});

ACT["rcol-manage"] = () => {
  const m = openModal("");
  const draw = () => {
    m.el.innerHTML = `<h2>Recipe collections</h2>
      <div class="rows">${S.recipe_collections.map(c => `<div class="row"><div class="main"><b>${esc(c.name)}</b></div>
        <button class="icon-btn" data-ren="${c.id}">✏️</button><button class="icon-btn" data-del="${c.id}">🗑️</button></div>`).join("")}</div>
      <form class="add-item"><input placeholder="New collection, e.g. Soups"><button class="btn primary">Add</button></form>`;
  };
  m.rerender = draw;
  m.el.addEventListener("submit", e => {
    e.preventDefault();
    const name = $("input", e.target).value.trim();
    if (name) act(() => api("POST", "/api/recipe-collections", { name }));
  });
  m.el.addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.ren) {
      const c = S.recipe_collections.find(c => c.id === +t.dataset.ren);
      const v = await promptBox("Rename collection", [{ name: "name", label: "Name", value: c.name }]);
      if (v) act(() => api("PATCH", `/api/recipe-collections/${c.id}`, v));
    }
    if (t.dataset.del && await confirmBox("Delete this collection? (Its recipes stay in the book.)", { yes: "Delete", danger: true })) {
      if (UI.recipeCol === +t.dataset.del) UI.recipeCol = 0;
      act(() => api("DELETE", `/api/recipe-collections/${t.dataset.del}`));
    }
  });
  draw();
};

// ── one recipe ──────────────────────────────────────────────────────────────
async function loadRecipe(id) {
  const r = await api("GET", `/api/recipes/${id}`);
  RCACHE.set(id, r);
  return r;
}

route(/^\/recipes\/(\d+)$/, (p, idStr) => {
  const id = +idStr;
  const summary = IX.recipe.get(id);
  if (!summary) return `<div class="empty-note">That recipe is gone. ${backBtn("#/recipes")}</div>`;
  const r = RCACHE.get(id);
  // Line matches can change when ingredients are added, so refetch if the snapshot disagrees.
  const sig = id + ":" + JSON.stringify(summary.line_ids);
  if ((!r || JSON.stringify(r.line_ids) !== JSON.stringify(summary.line_ids)) && !RFETCHED.has(sig)) {
    RFETCHED.add(sig);   // fetch once per change, never loop
    loadRecipe(id).then(() => { if (location.hash === `#/recipes/${id}`) render(); }).catch(e => toast(e.message, { err: true }));
  }
  if (!r) return `<div class="spinner"></div>`;
  const sel = RSEL.get(id) || new Set();
  RSEL.set(id, sel);
  const lines = r.ingredients.map((text, i) => {
    const s = lineStatus(summary.line_ids[i] ?? r.line_ids[i]);
    return `<label class="ing-line ${s.cls}"><input type="checkbox" data-line="${i}" ${sel.has(i) ? "checked" : ""}>
      <span class="txt">${esc(text)}<span class="st">${esc(s.label)}</span></span>
      <button class="icon-btn" data-act="rlink" data-i="${i}" title="Link to an ingredient">🔗</button></label>`;
  }).join("");
  window.afterRender = () => {
    $$("[data-line]").forEach(cb => cb.onchange = () => { cb.checked ? sel.add(+cb.dataset.line) : sel.delete(+cb.dataset.line); render(); });
    $$(".directions li").forEach(li => li.onclick = () => li.classList.toggle("done"));
  };
  return `<div class="toolbar">${backBtn("#/recipes", "‹ Recipes")}<span class="spacer"></span>
    <button class="btn small" data-act="recipe-edit" data-id="${id}">✏️ Edit</button>
    <button class="btn small red" data-act="recipe-del" data-id="${id}">🗑️</button></div>
  <div class="recipe-hero"><div class="img">${r.image ? `<img src="${imgSrc(r.image)}" alt="">` : "🍽️"}</div>
    <div><h1>${esc(r.title)}</h1>${stars(r.rating, true)}
      <div class="meta">${[["Serves", r.servings], ["Prep", r.prep_time], ["Cook", r.cook_time], ["Total", r.total_time]]
        .filter(([, v]) => v).map(([k, v]) => `<span>${k}: <b style="color:var(--text)">${esc(v)}</b></span>`).join("")}</div>
      ${r.description ? `<p style="font-size:.9rem;line-height:1.45;color:#c8c8d8">${esc(r.description)}</p>` : ""}
      ${r.source_url ? `<p style="margin-top:6px;font-size:.82rem"><a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(new URL(r.source_url, location.href).hostname)} ↗</a></p>` : ""}
      <div class="chips" style="margin-top:10px">${S.recipe_collections.map(c =>
        `<button class="chip ${r.collections.includes(c.id) ? "on" : ""}" data-act="rtogglecol" data-id="${c.id}">${esc(c.name)}</button>`).join("")}</div>
    </div></div>
  <div class="recipe-cols">
    <div><div class="section-title"><h2>Ingredients</h2></div>
      <div class="legend" style="margin:8px 0"><span><i style="background:var(--green)"></i>have</span><span><i style="background:var(--amber)"></i>low</span>
        <span><i style="background:var(--red)"></i>out</span><span><i style="background:var(--border)"></i>not tracked</span></div>
      <div class="toolbar" style="margin-bottom:8px">
        <button class="btn small" data-act="rsel-missing">Select missing</button>
        <button class="btn small" data-act="rsel-none" ${sel.size ? "" : "disabled"}>Clear</button>
        <button class="btn small blue" data-act="rsel-add" ${sel.size ? "" : "disabled"}>🛒 Add ${sel.size || ""} to list</button></div>
      ${lines || `<p class="muted">No ingredients listed.</p>`}</div>
    <div><div class="section-title"><h2>Directions</h2><span class="sub">tap a step to cross it off</span></div>
      <ol class="directions" style="margin-top:10px">${r.directions.map(d => `<li><span>${esc(d)}</span></li>`).join("")}</ol>
      ${r.notes ? `<div class="section-title" style="margin-top:16px"><h2>Notes</h2></div><p style="white-space:pre-wrap;line-height:1.5;margin-top:8px">${esc(r.notes)}</p>` : ""}</div>
  </div>`;
});

const curRecipeId = () => +(location.hash.match(/recipes\/(\d+)/) || [])[1];

ACT.rate = el => {
  const id = curRecipeId(), r = RCACHE.get(id);
  const n = +el.dataset.n === r.rating ? 0 : +el.dataset.n;     // tap the same star again to clear
  act(async () => { RCACHE.set(id, await api("PATCH", `/api/recipes/${id}`, { rating: n })); });
};
ACT.rtogglecol = el => {
  const id = curRecipeId(), r = RCACHE.get(id), c = +el.dataset.id;
  const cols = r.collections.includes(c) ? r.collections.filter(x => x !== c) : [...r.collections, c];
  act(async () => { RCACHE.set(id, await api("PATCH", `/api/recipes/${id}`, { collections: cols })); });
};
ACT["rsel-missing"] = () => {
  const id = curRecipeId(), r = RCACHE.get(id), sel = RSEL.get(id);
  r.line_ids.forEach((iid, i) => { if (["out", "low"].includes(lineStatus(iid).cls)) sel.add(i); });
  if (!sel.size) toast("Nothing tracked is missing. Untracked lines can be ticked by hand.");
  render();
};
ACT["rsel-none"] = () => { RSEL.get(curRecipeId()).clear(); render(); };
ACT["rsel-add"] = () => {
  const id = curRecipeId(), r = RCACHE.get(id), sel = RSEL.get(id);
  const items = [...sel].sort((a, b) => a - b).map(i => {
    const iid = r.line_ids[i];
    return iid ? { ingredient_id: iid, source: "recipe", recipe_id: id } : { text: r.ingredients[i], source: "recipe", recipe_id: id };
  });
  addToGrocery(items, { title: `Add ${plural(items.length, "ingredient")} from ${r.title} to…` });
  sel.clear();
};

// Link a recipe line to an ingredient (or mark it untracked / back to automatic).
ACT.rlink = el => {
  const id = curRecipeId(), r = RCACHE.get(id), i = +el.dataset.i;
  const m = openModal(`<h2>Link “${esc(r.ingredients[i])}”</h2>
    <input id="lq" type="search" placeholder="Search your ingredients…" autocomplete="off">
    <div class="rows" id="lres" style="max-height:45vh;overflow:auto"></div>
    <div class="actions"><button class="btn small" data-auto>Auto-match</button><button class="btn small" data-none>Don't track this line</button></div>`);
  const save = links => act(async () => { RCACHE.set(id, await api("PATCH", `/api/recipes/${id}`, { links })); closeModal(m); });
  const draw = () => {
    const q = $("#lq", m.el).value.trim().toLowerCase();
    const list = S.ingredients.filter(x => !q || x.name.toLowerCase().includes(q)).slice(0, 40);
    $("#lres", m.el).innerHTML = list.map(x => `<button class="row clickable" data-pick="${x.id}" style="text-align:left">
      <div class="thumb">${x.image ? `<img src="${imgSrc(x.image)}">` : emojiFor(x)}</div><div class="main"><b>${esc(x.name)}</b></div></button>`).join("");
  };
  $("#lq", m.el).oninput = draw;
  // Pre-fill the search with the last word of the line, which is usually the ingredient.
  $("#lq", m.el).value = (r.ingredients[i].replace(/\(.*?\)|,.*$/g, "").trim().split(/\s+/).pop() || "").toLowerCase();
  draw();
  m.el.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.pick) save({ ...r.links, [i]: +t.dataset.pick });
    if ("none" in t.dataset) save({ ...r.links, [i]: 0 });
    if ("auto" in t.dataset) { const l = { ...r.links }; delete l[i]; save(l); }
  });
};

ACT["recipe-del"] = async el => {
  const r = IX.recipe.get(+el.dataset.id);
  if (!await confirmBox(`Delete “${r.title}”?`, { yes: "Delete", danger: true })) return;
  await act(() => api("DELETE", `/api/recipes/${r.id}`));
  go("/recipes");
};
ACT["recipe-edit"] = el => recipeEditor(RCACHE.get(+el.dataset.id));

// ── adding: URL / paste / browse / blank ────────────────────────────────────
ACT["recipe-add"] = () => {
  const m = openModal(`<h2>Add a recipe</h2>
    <form id="rurl" class="add-item"><input type="url" placeholder="Paste a recipe link: https://…" required><button class="btn primary">Import</button></form>
    <div class="rows">
      <button class="row clickable" data-browse style="text-align:left"><div class="thumb">🌍</div><div class="main"><b>Browse recipes</b><small>Search TheMealDB's free recipe collection</small></div></button>
      <button class="row clickable" data-paste style="text-align:left"><div class="thumb">📋</div><div class="main"><b>Paste recipe text</b><small>For sites that block importing: copy the recipe from your browser</small></div></button>
      <button class="row clickable" data-blank style="text-align:left"><div class="thumb">✍️</div><div class="main"><b>Type it in</b><small>Start from a blank recipe</small></div></button>
    </div>`);
  $("#rurl", m.el).onsubmit = async e => {
    e.preventDefault();
    const btn = $("button", e.target), url = $("input", e.target).value.trim();
    btn.disabled = true; btn.innerHTML = `<span class="spinner small"></span>`;
    try {
      const draft = await api("POST", "/api/recipes/parse-url", { url });
      closeModal(m);
      recipeEditor(draft);
    } catch (err) {
      toast(err.message, { err: true, ms: 7000 });
      btn.disabled = false; btn.textContent = "Import";
    }
  };
  m.el.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    if ("browse" in t.dataset) { closeModal(m); browseRecipes(); }
    if ("paste" in t.dataset) { closeModal(m); pasteRecipe(); }
    if ("blank" in t.dataset) { closeModal(m); recipeEditor({ title: "", ingredients: [], directions: [], collections: UI.recipeCol ? [UI.recipeCol] : [] }); }
  });
  setTimeout(() => $("#rurl input", m.el).focus(), 50);
};

function pasteRecipe() {
  const m = openModal(`<h2>Paste a recipe</h2>
    <p class="muted" style="font-size:.85rem">Copy the whole recipe (title, ingredients and steps) from the page and paste it here. Headings like “Ingredients” and “Instructions” help it split things up; you can fix anything on the next screen.</p>
    <label class="field">Recipe URL (optional, kept as the source)<input id="psrc" type="url" placeholder="https://…"></label>
    <textarea id="ptext" rows="14" placeholder="Banana Bread&#10;Ingredients&#10;3 ripe bananas&#10;…&#10;Instructions&#10;1. Preheat the oven…"></textarea>
    <div class="actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-go-parse>Next ›</button></div>`, { wide: true });
  $("[data-cancel]", m.el).onclick = () => closeModal(m);
  $("[data-go-parse]", m.el).onclick = async () => {
    try {
      const draft = await api("POST", "/api/recipes/parse-text", { text: $("#ptext", m.el).value });
      draft.source_url = $("#psrc", m.el).value.trim();
      closeModal(m);
      recipeEditor(draft);
    } catch (e) { toast(e.message, { err: true }); }
  };
}

function browseRecipes() {
  const m = openModal(`<h2>Browse recipes</h2>
    <form class="add-item"><input type="search" placeholder="e.g. curry, pancakes, salmon" required><button class="btn primary">Search</button></form>
    <div id="bres"></div>`, { wide: true });
  let results = [];
  $("form", m.el).onsubmit = async e => {
    e.preventDefault();
    const box = $("#bres", m.el);
    box.innerHTML = `<div class="spinner"></div>`;
    try {
      results = await api("GET", `/api/recipes/browse?q=${encodeURIComponent($("input", e.target).value)}`);
      box.innerHTML = results.length ? `<div class="recipe-grid">${results.map((r, i) => `<button class="recipe-card" data-i="${i}">
          <div class="img">${r.image_url ? `<img src="${esc(r.image_url)}/preview" alt="" loading="lazy">` : "🍽️"}</div>
          <div class="body"><b>${esc(r.title)}</b><small>${esc(r.description)} · ${r.ingredients.length} ingredients</small></div></button>`).join("")}</div>`
        : `<div class="empty-note">Nothing found. TheMealDB is small, so try a broader word.</div>`;
    } catch (err) { box.innerHTML = `<div class="empty-note">${esc(err.message)}</div>`; }
  };
  m.el.addEventListener("click", e => {
    const c = e.target.closest("[data-i]");
    if (!c) return;
    const d = results[+c.dataset.i];
    const col = S.recipe_collections.find(x => x.name.toLowerCase() === (d.category || "").toLowerCase());
    closeModal(m);
    recipeEditor({ ...d, collections: col ? [col.id] : [] });
  });
  setTimeout(() => $("input", m.el).focus(), 50);
}

// ── editor (new, imported draft, or existing) ───────────────────────────────
function recipeEditor(r) {
  const isNew = !r.id;
  const m = openModal(`<h2>${isNew ? (r.title ? "Check the import" : "New recipe") : "Edit recipe"}</h2>
    <label class="field">Title<input name="title" value="${esc(r.title)}"></label>
    <div class="grid2"><label class="field">Serves<input name="servings" value="${esc(r.servings || "")}"></label>
      <label class="field">Total time<input name="total_time" value="${esc(r.total_time || "")}" placeholder="45 min"></label>
      <label class="field">Prep<input name="prep_time" value="${esc(r.prep_time || "")}"></label>
      <label class="field">Cook<input name="cook_time" value="${esc(r.cook_time || "")}"></label></div>
    <label class="field">Description<textarea name="description" rows="2">${esc(r.description || "")}</textarea></label>
    <label class="field">Ingredients (one per line)<textarea name="ingredients" rows="10">${esc((r.ingredients || []).join("\n"))}</textarea></label>
    <label class="field">Directions (one step per line)<textarea name="directions" rows="10">${esc((r.directions || []).join("\n"))}</textarea></label>
    <label class="field">Notes<textarea name="notes" rows="3" placeholder="Your tweaks, e.g. half the sugar">${esc(r.notes || "")}</textarea></label>
    <label class="field">Source URL<input name="source_url" value="${esc(r.source_url || "")}"></label>
    <div><div class="field" style="margin-bottom:6px">Collections</div><div class="chips" id="ecols">${S.recipe_collections.map(c =>
      `<button class="chip ${(r.collections || []).includes(c.id) ? "on" : ""}" data-col="${c.id}">${esc(c.name)}</button>`).join("")}</div></div>
    <div><div class="field" style="margin-bottom:6px">Picture</div><div id="epic"></div></div>
    <div class="actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>${isNew ? "Save to recipe book" : "Save"}</button></div>`, { wide: true });
  const choices = r.image ? [{ src: r.image, remote: false }] : r.image_url ? [{ src: r.image_url, remote: true }] : [];
  const picker = imagePicker($("#epic", m.el), { choices, selected: choices.length ? 0 : null });
  $("#ecols", m.el).onclick = e => { const c = e.target.closest("[data-col]"); if (c) { e.preventDefault(); c.classList.toggle("on"); } };
  $("[data-cancel]", m.el).onclick = () => closeModal(m);
  $("[data-save]", m.el).onclick = async e => {
    const btn = e.target;
    const f = n => $(`[name=${n}]`, m.el).value;
    const body = {
      title: f("title"), servings: f("servings"), total_time: f("total_time"), prep_time: f("prep_time"), cook_time: f("cook_time"),
      description: f("description"), notes: f("notes"), source_url: f("source_url"),
      ingredients: f("ingredients").split("\n").map(s => s.trim()).filter(Boolean),
      directions: f("directions").split("\n").map(s => s.trim()).filter(Boolean),
      collections: $$("#ecols .chip.on", m.el).map(c => +c.dataset.col),
    };
    if (!body.title.trim()) { toast("Give it a title", { err: true }); return; }
    // Manual line links are by line number, so drop them if the lines changed.
    if (!isNew && JSON.stringify(body.ingredients) !== JSON.stringify(r.ingredients)) body.links = {};
    btn.disabled = true; btn.innerHTML = `<span class="spinner small"></span> Saving…`;
    try {
      body.image = await picker.value();
    } catch (err) { toast(`Picture couldn't be saved: ${err.message}`, { err: true }); body.image = null; }
    try {
      const saved = await api(isNew ? "POST" : "PATCH", isNew ? "/api/recipes" : `/api/recipes/${r.id}`, body);
      RCACHE.set(saved.id, saved);
      closeModal(m);
      await refresh();
      go(`/recipes/${saved.id}`);
    } catch (err) {
      toast(err.message, { err: true });
      btn.disabled = false; btn.textContent = "Save";
    }
  };
}
