"use strict";
// ── Kitchen (areas → shelves) and Pantry (shelves → bins), plus location editing ──

const KIND_LABEL = { area: "area", shelf: "shelf", bin: "bin" };

// <option>s for every place in a space ("Area › Shelf", "Shelf › Bin").
function locOptions(space, selected, { none = "Not placed yet" } = {}) {
  const opts = [`<option value="">${esc(none)}</option>`];
  const tops = space === "kitchen" ? topLocs("kitchen", "area") : topLocs("pantry", "shelf");
  for (const t of tops) {
    opts.push(`<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${esc(t.name)}${space === "kitchen" ? " (anywhere)" : ""}</option>`);
    for (const c of children(t.id)) {
      opts.push(`<option value="${c.id}" ${c.id === selected ? "selected" : ""}>${esc(t.name)} › ${esc(c.name)}</option>`);
    }
  }
  return opts.join("");
}

function lowCountIn(locId) {
  return stockAt(locId, { deep: true }).filter(x => x.st.level <= 2).length;
}

function locVisual(loc, cls = "big-emoji") {
  return loc.image ? `<img src="${imgSrc(loc.image)}" alt="">` : `<div class="${cls}">${esc(loc.icon || (loc.kind === "area" ? "🗄️" : "📦"))}</div>`;
}

function editTools(loc, { vertical = false } = {}) {
  const [prev, next] = vertical ? ["↑", "↓"] : ["◀", "▶"];
  return `<button class="icon-btn" data-act="loc-move" data-id="${loc.id}" data-dir="-1" title="Move">${prev}</button>
    <button class="icon-btn" data-act="loc-move" data-id="${loc.id}" data-dir="1" title="Move">${next}</button>
    <button class="icon-btn" data-act="loc-edit" data-id="${loc.id}" title="Edit">✏️</button>
    <button class="icon-btn" data-act="loc-del" data-id="${loc.id}" title="Delete">🗑️</button>`;
}

// Mini pictures sitting on a shelf; ``limit`` caps how many (rest becomes "+N").
function shelfMinis(list, limit) {
  const shown = limit ? list.slice(0, limit) : list;
  return shown.map(({ ing, st }) =>
    `<div class="mini ${lvlClass(st.level)}" title="${esc(ing.name)} · ${st.level * 10}%">${pic(ing)}</div>`).join("")
    + (limit && list.length > limit ? `<span class="more">+${list.length - limit} more</span>` : "");
}

// ── Kitchen ─────────────────────────────────────────────────────────────────
route(/^\/kitchen$/, () => {
  const areas = topLocs("kitchen", "area");
  const loose = unplaced("kitchen");
  const ed = UI.editKitchen;
  return `
  <div class="toolbar">${backBtn("#/", "‹ Home")}<span class="spacer"></span>${shelfSortControl()}
    <button class="btn ${ed ? "on" : ""}" data-act="toggle" data-key="editKitchen">${ed ? "✓ Done editing" : "✏️ Edit areas"}</button>
    <button class="btn primary" data-act="add-ing" data-space="kitchen">+ Ingredient</button></div>
  <header class="page"><h1>🍳 Kitchen</h1><p>${areas.length ? "Tap an area to look inside" : "Set up the areas of your kitchen"}</p></header>
  ${searchBox({ space: "kitchen" })}
  <div class="areas">
    ${areas.map(a => {
      const n = stockAt(a.id, { deep: true }).length, low = lowCountIn(a.id);
      return `<div style="position:relative">
        ${ed ? `<div class="edit-bar">${editTools(a)}</div>` : ""}
        <button class="area-card" data-act="open-area" data-id="${a.id}" style="width:100%">
          ${locVisual(a)}${low ? `<span class="alert">⚠ ${low}</span>` : ""}
          <div class="cap"><b>${esc(a.name)}</b><span>${esc(a.subtitle || plural(n, "item"))}</span></div></button></div>`;
    }).join("")}
    ${ed || !areas.length ? `<button class="area-card add" data-act="loc-new" data-space="kitchen" data-kind="area">
      <span style="font-size:2rem">+</span>New area</button>` : ""}
  </div>
  ${loose.length ? `<div class="section-title"><h2>Not placed yet</h2><span class="sub">In the kitchen, but no area chosen</span></div>
    <div class="tiles">${loose.map(x => tile(x.ing, x.st)).join("")}</div>` : ""}`;
});

let zoomOrigin = null;
function zoomStyle() {
  const z = zoomOrigin ? `--zx:${zoomOrigin[0]};--zy:${zoomOrigin[1]}` : "";
  zoomOrigin = null;
  return z;
}
ACT["open-area"] = el => {
  const r = el.getBoundingClientRect();
  zoomOrigin = [`${r.left + r.width / 2}px`, `${r.top + r.height / 2 + window.scrollY}px`];
  go(`/kitchen/area/${el.dataset.id}`);
};

route(/^\/kitchen\/area\/(\d+)$/, (p, id) => {
  const area = IX.loc.get(+id);
  if (!area) return `<div class="empty-note">That area no longer exists. ${backBtn("#/kitchen")}</div>`;
  const shelves = children(area.id, "shelf");
  const loose = stockAt(area.id);
  const ed = UI.editArea;
  const z = zoomStyle();
  return `<div class="zoom-in" style="display:flex;flex-direction:column;gap:16px;${z}">
  <div class="toolbar">${backBtn("#/kitchen", "‹ Kitchen")}<span class="spacer"></span>${shelfSortControl()}
    <button class="btn ${ed ? "on" : ""}" data-act="toggle" data-key="editArea">${ed ? "✓ Done editing" : "✏️ Edit shelves"}</button>
    <button class="btn" data-act="loc-edit" data-id="${area.id}">🖼️ Area</button>
    <button class="btn primary" data-act="add-ing" data-space="kitchen" data-loc="${area.id}">+ Ingredient</button></div>
  <div class="area-hero">${locVisual(area)}<h1>${esc(area.name)}</h1></div>
  ${area.subtitle ? `<p class="muted">${esc(area.subtitle)}</p>` : ""}
  ${searchBox({ space: "kitchen" })}
  <div class="shelves">
    ${shelves.map(s => shelfBlock(s, ed)).join("")}
    ${!shelves.length && !ed ? `<div class="empty-note">No shelves yet. Use <b>Edit shelves</b> to add some, or add ingredients straight to this area.</div>` : ""}
    ${ed ? `<button class="btn" data-act="loc-new" data-space="kitchen" data-kind="shelf" data-parent="${area.id}" style="align-self:flex-start">+ New shelf</button>` : ""}
    ${loose.length ? `<div class="shelf"><div class="shelf-head"><h3>Elsewhere in ${esc(area.name)}</h3><span class="sub">Not on a shelf</span></div>
      <div class="tiles">${loose.map(x => tile(x.ing, x.st)).join("")}</div></div>` : ""}
  </div></div>`;
});

// A kitchen shelf: name + subtitle, a plank with a preview of what's on it; tap to open.
function shelfBlock(s, ed) {
  const items = stockAt(s.id);
  const open = UI.openShelves.has(s.id);
  return `<div class="shelf clickable ${open ? "" : "collapsed"}">
    <div class="shelf-head"><h3>${esc(s.name)}</h3><span class="sub">${esc(s.subtitle)}</span>
      <span class="tools">${ed ? editTools(s, { vertical: true }) : `<span class="muted" style="font-size:.8rem">${plural(items.length, "item")}</span>`}</span></div>
    ${open ? `<div class="shelf-open"><div class="tiles">${items.map(x => tile(x.ing, x.st)).join("")}
        <button class="tile" data-act="add-ing" data-space="kitchen" data-loc="${s.id}"><div class="pic" style="background:none;border:2px dashed var(--border)"><div class="ph" style="color:var(--muted)">+</div></div><span class="name muted">Add here</span></button></div>
        <div style="text-align:center;margin-top:8px"><button class="btn small" data-act="shelf-toggle" data-id="${s.id}">Close shelf ▴</button></div></div>`
      : `<div class="shelf-body" data-act="shelf-toggle" data-id="${s.id}">
        ${items.length ? shelfMinis(items, 9) : `<span class="hint">Empty shelf, tap to add things</span>`}</div>
      <div class="shelf-plank"></div>`}
  </div>`;
}

ACT["shelf-toggle"] = el => {
  const id = +el.dataset.id;
  UI.openShelves.has(id) ? UI.openShelves.delete(id) : UI.openShelves.add(id);
  render();
};

ACT.toggle = el => { UI[el.dataset.key] = !UI[el.dataset.key]; render(); };

// ── Pantry ──────────────────────────────────────────────────────────────────
route(/^\/pantry$/, () => {
  const shelves = topLocs("pantry", "shelf");
  const ed = UI.editPantry;
  const archived = S.ingredients.filter(i => i.archived).length;
  const loose = unplaced("pantry");
  return `
  <div class="toolbar">${backBtn("#/", "‹ Home")}<span class="spacer"></span>${shelfSortControl()}
    <button class="btn" data-go="#/pantry/archived">🗃️ Archived (${archived})</button>
    <button class="btn ${ed ? "on" : ""}" data-act="toggle" data-key="editPantry">${ed ? "✓ Done editing" : "✏️ Edit shelves & bins"}</button>
    <button class="btn primary" data-act="add-ing" data-space="pantry">+ Ingredient</button></div>
  <header class="page"><h1>🥫 Pantry</h1><p>${shelves.length ? "Tap a bin to see what's in it" : "Add your pantry shelves to get started"}</p></header>
  ${searchBox({ space: "pantry" })}
  <div class="shelves">
    ${shelves.map(s => pantryShelf(s, ed)).join("")}
    ${ed || !shelves.length ? `<button class="btn" data-act="loc-new" data-space="pantry" data-kind="shelf" style="align-self:flex-start">+ New shelf</button>` : ""}
  </div>
  ${loose.length ? `<div class="section-title"><h2>Not placed yet</h2><span class="sub">In the pantry, but no shelf chosen</span></div>
    <div class="tiles">${loose.map(x => tile(x.ing, x.st)).join("")}</div>` : ""}`;
});

function pantryShelf(s, ed) {
  const bins = children(s.id, "bin");
  const loose = stockAt(s.id);
  return `<div class="shelf">
    <div class="shelf-head"><h3>${esc(s.name)}</h3><span class="sub">${esc(s.subtitle)}</span>
      <span class="tools">${ed ? editTools(s, { vertical: true }) : ""}</span></div>
    <div class="shelf-body" style="cursor:default">
      ${bins.map(b => binBox(b, ed)).join("")}
      ${ed ? `<button class="bin add" data-act="loc-new" data-space="pantry" data-kind="bin" data-parent="${s.id}">+ Bin</button>` : ""}
      <div class="pantry-loose">${loose.map(x => tile(x.ing, x.st)).join("")}</div>
      ${!bins.length && !loose.length && !ed ? `<span class="hint">Empty shelf</span>` : ""}
      <button class="icon-btn" data-act="add-ing" data-space="pantry" data-loc="${s.id}" title="Add an ingredient to this shelf" style="align-self:center;font-size:1.2rem">+</button>
    </div>
    <div class="shelf-plank"></div></div>`;
}

function binBox(b, ed) {
  const items = stockAt(b.id);
  const low = items.filter(x => x.st.level <= 2).length;
  const sample = items.slice(0, 4);
  return `<div style="position:relative">
    ${ed ? `<div class="edit-bar" style="top:-12px;left:-4px">${editTools(b)}</div>` : ""}
    <button class="bin" data-act="open-bin" data-id="${b.id}" title="${esc(b.subtitle || b.name)}">
      ${low ? `<span class="alert">⚠ ${low}</span>` : ""}
      ${sample.length ? `<div class="mosaic">${sample.map(x => `<div>${pic(x.ing)}</div>`).join("")}</div>`
        : `<div class="mosaic empty">${b.image ? `<img src="${imgSrc(b.image)}" style="width:100%;height:100%;object-fit:cover">` : "empty"}</div>`}
      <div class="label">${esc(b.name)}${items.length > 4 ? ` · ${items.length}` : ""}</div></button></div>`;
}

ACT["open-bin"] = el => {
  const r = el.getBoundingClientRect();
  zoomOrigin = [`${r.left + r.width / 2}px`, `${r.top + r.height / 2 + window.scrollY}px`];
  go(`/pantry/bin/${el.dataset.id}`);
};

route(/^\/pantry\/bin\/(\d+)$/, (p, id) => {
  const bin = IX.loc.get(+id);
  if (!bin) return `<div class="empty-note">That bin no longer exists. ${backBtn("#/pantry")}</div>`;
  const shelf = IX.loc.get(bin.parent_id);
  const items = stockAt(bin.id);
  const z = zoomStyle();
  return `<div class="zoom-in" style="display:flex;flex-direction:column;gap:16px;${z}">
  <div class="toolbar">${backBtn("#/pantry", "‹ Pantry")}<span class="spacer"></span>${shelfSortControl()}
    <button class="btn" data-act="loc-edit" data-id="${bin.id}">✏️ Edit bin</button>
    <button class="btn primary" data-act="add-ing" data-space="pantry" data-loc="${bin.id}">+ Ingredient</button></div>
  <header class="page"><h1>📦 ${esc(bin.name)}</h1><p>${esc(shelf ? shelf.name : "")}${bin.subtitle ? " · " + esc(bin.subtitle) : ""}</p></header>
  ${searchBox({ space: "pantry" })}
  ${items.length ? `<div class="tiles">${items.map(x => tile(x.ing, x.st)).join("")}</div>`
    : `<div class="empty-note">This bin is empty.</div>`}</div>`;
});

route(/^\/pantry\/archived$/, () => {
  const arch = S.ingredients.filter(i => i.archived);
  return `<div class="toolbar">${backBtn("#/pantry", "‹ Pantry")}</div>
  <header class="page"><h1>🗃️ Archived</h1><p>Hidden from the kitchen and pantry because you don't plan to restock them</p></header>
  ${arch.length ? `<div class="rows">${arch.map(i => ingRow(i,
      `<button class="btn small green" data-act="unarchive" data-id="${i.id}">Restore</button>`)).join("")}</div>`
    : `<div class="empty-note">Nothing archived.</div>`}`;
});

ACT.unarchive = el => act(() => api("PATCH", `/api/ingredients/${el.dataset.id}`, { archived: false }), { ok: "Restored" });

// ── location create / edit / delete / reorder ───────────────────────────────
ACT["loc-new"] = el => locEditor({
  space: el.dataset.space, kind: el.dataset.kind, parent_id: el.dataset.parent ? +el.dataset.parent : null,
});
ACT["loc-edit"] = el => locEditor(IX.loc.get(+el.dataset.id));

ACT["loc-del"] = async el => {
  const loc = IX.loc.get(+el.dataset.id);
  const n = stockAt(loc.id, { deep: true, archived: true }).length;
  const kids = children(loc.id).length;
  const ok = await confirmBox(`Delete ${KIND_LABEL[loc.kind]} “${loc.name}”?`
    + (kids ? ` Its ${plural(kids, loc.kind === "area" ? "shelf" : "bin").replace("shelfs", "shelves")} go too.` : "")
    + (n ? ` ${plural(n, "item")} inside will be kept as “not placed”.` : ""), { yes: "Delete", danger: true });
  if (ok) act(() => api("DELETE", `/api/locations/${loc.id}`));
};

ACT["loc-move"] = el => {
  const loc = IX.loc.get(+el.dataset.id);
  const sibs = S.locations.filter(l => l.space === loc.space && l.parent_id === loc.parent_id && l.kind === loc.kind);
  const i = sibs.indexOf(loc), j = i + +el.dataset.dir;
  if (j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  act(() => api("POST", "/api/locations/reorder", { ids: sibs.map(l => l.id) }));
};

function locEditor(loc) {
  const isNew = !loc.id;
  const what = KIND_LABEL[loc.kind];
  const where = loc.parent_id ? ` in ${IX.loc.get(loc.parent_id)?.name || ""}` : "";
  let image = loc.image || null;
  const subHint = { area: "e.g. Left of the stove", shelf: "What it holds, e.g. Baking & spices", bin: "What's in it, e.g. Pasta & grains" }[loc.kind];
  const m = openModal(`<h2>${isNew ? `New ${what}${esc(where)}` : `Edit ${what}`}</h2>
    <label class="field">Name<input name="name" value="${esc(loc.name || "")}" placeholder="${loc.kind === "area" ? "e.g. Spice drawer" : loc.kind === "shelf" ? "e.g. Top shelf" : "e.g. Baking bin"}"></label>
    <label class="field">Subtitle<input name="subtitle" value="${esc(loc.subtitle || "")}" placeholder="${esc(subHint)}"></label>
    ${loc.kind !== "shelf" ? `
    <label class="field">Emoji (used when there's no picture)<input name="icon" value="${esc(loc.icon || "")}" placeholder="${loc.kind === "area" ? "🗄️" : "📦"}" maxlength="4"></label>
    <div class="field" style="display:flex;flex-direction:column;gap:6px"><span class="field" style="font-size:.78rem">Picture</span>
      <div style="display:flex;gap:10px;align-items:center">
        <div class="pic-choice" id="loc-pic" style="width:110px;height:82px;padding:0;overflow:hidden">${image ? `<img src="${imgSrc(image)}" style="object-fit:cover">` : ""}</div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:1">
          <label class="btn small" style="align-self:flex-start">📷 Upload / take photo<input type="file" accept="image/*" id="loc-file" hidden></label>
          <div style="display:flex;gap:6px"><input id="loc-url" placeholder="…or paste an image URL"><button class="btn small" id="loc-url-go">Use</button></div>
          <button class="btn small red" id="loc-clear" style="align-self:flex-start">Remove picture</button>
        </div></div></div>` : ""}
    <div class="actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>${isNew ? "Create" : "Save"}</button></div>`);
  const showPic = () => { const p = $("#loc-pic", m.el); if (p) p.innerHTML = image ? `<img src="${imgSrc(image)}" style="object-fit:cover">` : ""; };
  const file = $("#loc-file", m.el);
  if (file) {
    file.onchange = async () => {
      if (!file.files[0]) return;
      $("#loc-pic", m.el).innerHTML = `<div class="spinner small"></div>`;
      try { image = await uploadImage(file.files[0]); } catch (e) { toast(e.message, { err: true }); }
      showPic();
    };
    $("#loc-url-go", m.el).onclick = async () => {
      const u = $("#loc-url", m.el).value.trim();
      if (!u) return;
      try { image = await fetchImage(u); showPic(); } catch (e) { toast(e.message, { err: true }); }
    };
    $("#loc-clear", m.el).onclick = () => { image = null; showPic(); };
  }
  setTimeout(() => $("[name=name]", m.el).focus(), 50);
  $("[data-cancel]", m.el).onclick = () => closeModal(m);
  const save = async () => {
    const body = {
      name: $("[name=name]", m.el).value.trim(), subtitle: $("[name=subtitle]", m.el).value.trim(),
      icon: $("[name=icon]", m.el)?.value.trim() || "", image,
    };
    if (!body.name) { toast("Give it a name", { err: true }); return; }
    await act(() => isNew ? api("POST", "/api/locations", { ...body, space: loc.space, kind: loc.kind, parent_id: loc.parent_id })
      : api("PATCH", `/api/locations/${loc.id}`, body));
    closeModal(m);
  };
  $("[data-save]", m.el).onclick = save;
  $("[name=name]", m.el).onkeydown = e => { if (e.key === "Enter") save(); };
}
