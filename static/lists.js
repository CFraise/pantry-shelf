"use strict";
// ── Running low, put-away, duplicates, grocery lists ────────────────────────

// ── running low ─────────────────────────────────────────────────────────────
route(/^\/low$/, () => {
  const sp = UI.lowSpace;
  const all = lowStock(sp);
  const groups = [
    ["Empty", "Nothing left", all.filter(x => x.st.level === 0)],
    ["10% or less", "Almost gone", all.filter(x => x.st.level === 1)],
    ["20% or less", "Getting low", all.filter(x => x.st.level === 2)],
  ];
  const row = ({ ing, st }) => `<div class="row clickable ${lvlClass(st.level)}" data-act="ing" data-id="${ing.id}">
      <div class="thumb">${ing.image ? `<img src="${imgSrc(ing.image)}" alt="">` : emojiFor(ing)}</div>
      <div class="main"><b>${esc(ing.name)}</b><small>${esc(locPath(st.location_id))}${st.refill_qty ? ` · refill ${esc(st.refill_qty)}` : ""}</small></div>
      ${pctTag(st.level)}
      <div class="acts">${onAnyList(ing.id) ? `<span class="src">on list</span>`
        : `<button class="btn small blue" data-act="low-add" data-id="${ing.id}" data-space="${st.space}">🛒</button>`}
        <button class="btn small green" data-act="stock-full" data-sid="${st.id}">Full</button></div></div>`;
  return `<div class="toolbar">${backBtn("#/", "‹ Home")}</div>
  <header class="page"><h1>⚠️ Running Low</h1><p>Everything at 20% or less</p></header>
  <div class="chips" style="justify-content:center">
    ${[["all", "Everywhere"], ["kitchen", "🍳 Kitchen"], ["pantry", "🥫 Pantry"]].map(([k, l]) =>
      `<button class="chip ${sp === k ? "on" : ""}" data-act="low-space" data-k="${k}">${l} (${lowStock(k).length})</button>`).join("")}</div>
  ${all.length ? groups.map(([t, sub, list]) => list.length ? `
    <div class="section-title"><h2>${t}</h2><span class="sub">${sub} · ${list.length}</span></div>
    <div class="toolbar"><span class="spacer"></span>
      <button class="btn small blue" data-act="low-add-all" data-lvl="${list[0].st.level}">🛒 Add all ${list.length} to a list</button></div>
    <div class="rows">${list.map(row).join("")}</div>` : "").join("")
    : `<div class="empty-note">🎉 Nothing is running low${sp !== "all" ? ` in the ${sp}` : ""}.</div>`}`;
});

ACT["low-space"] = el => { UI.lowSpace = el.dataset.k; render(); };
ACT["low-add"] = el => addToGrocery([{ ingredient_id: +el.dataset.id, source: el.dataset.space }]);
ACT["low-add-all"] = el => {
  const items = lowStock(UI.lowSpace).filter(x => x.st.level === +el.dataset.lvl && !onAnyList(x.ing.id));
  const seen = new Set();
  const uniq = items.filter(x => !seen.has(x.ing.id) && seen.add(x.ing.id));
  if (!uniq.length) { toast("They're all on a list already"); return; }
  addToGrocery(uniq.map(x => ({ ingredient_id: x.ing.id, source: x.st.space })));
};
ACT["stock-full"] = el => act(() => api("PATCH", `/api/stock/${el.dataset.sid}`, { level: LMAX }));

// ── put away ────────────────────────────────────────────────────────────────
route(/^\/putaway$/, () => {
  const rows = S.putaway.map(p => {
    const ing = IX.ing.get(p.ingredient_id);
    if (!ing) return "";
    const spots = ing.stock;
    return `<div class="row" style="align-items:flex-start;flex-wrap:wrap">
      <div class="thumb" data-act="ing" data-id="${ing.id}" style="cursor:pointer">${ing.image ? `<img src="${imgSrc(ing.image)}" alt="">` : emojiFor(ing)}</div>
      <div class="main"><b>${esc(ing.name)}${p.qty ? ` <span class="muted" style="font-weight:400">· ${esc(p.qty)}</span>` : ""}</b>
        ${spots.length ? spots.map(s => `<small>📍 ${esc(locPath(s.location_id))} ${pctTag(s.level)}</small>`).join("")
          : `<small>Doesn't have a home yet</small>`}</div>
      <div class="acts" style="flex-direction:column;align-items:stretch">
        ${spots.length ? spots.map(s => `<button class="btn small green" data-act="put-done" data-pid="${p.id}" data-sid="${s.id}">✓ Put away${spots.length > 1 ? ` in ${esc(IX.loc.get(s.location_id)?.name || s.space)}` : ""}</button>`).join("")
          : `<select data-place="${p.id}" style="font-size:.85rem;padding:4px">
              <optgroup label="Kitchen">${locOptions("kitchen", null, { none: "Kitchen (no spot)" }).replace(/value="(\d*)"/g, 'value="kitchen:$1"')}</optgroup>
              <optgroup label="Pantry">${locOptions("pantry", null, { none: "Pantry (no spot)" }).replace(/value="(\d*)"/g, 'value="pantry:$1"')}</optgroup></select>
            <button class="btn small green" data-act="put-place" data-pid="${p.id}">✓ Put it here</button>`}
        <button class="btn small" data-act="put-skip" data-pid="${p.id}">Skip</button></div></div>`;
  }).join("");
  return `<div class="toolbar">${backBtn("#/", "‹ Home")}</div>
  <header class="page"><h1>📦 Put Away</h1><p>Groceries you bought, and where each one lives</p></header>
  ${S.putaway.length ? `<div class="rows">${rows}</div>
    <p class="muted" style="font-size:.8rem;text-align:center">“Put away” marks that spot full again.</p>`
    : `<div class="empty-note">Nothing to put away. When you tick off a grocery item or finish a list, you'll be asked whether to add it here.</div>`}`;
});

ACT["put-done"] = el => act(() => api("POST", `/api/putaway/${el.dataset.pid}/done`, { stock_id: +el.dataset.sid }), { ok: "Put away ✓" });
ACT["put-skip"] = el => act(() => api("DELETE", `/api/putaway/${el.dataset.pid}`));
ACT["put-place"] = el => {
  const v = $(`[data-place="${el.dataset.pid}"]`).value;
  const [space, lid] = v.split(":");
  act(() => api("POST", `/api/putaway/${el.dataset.pid}/done`, { new_location: { space, location_id: lid ? +lid : null } }), { ok: "Put away ✓" });
};

// ── duplicates ──────────────────────────────────────────────────────────────
route(/^\/duplicates$/, () => {
  window.afterRender = async () => {
    const box = $("#dupes");
    try {
      const d = await api("GET", "/api/duplicates");
      box.innerHTML = dupesHtml(d);
    } catch (e) { box.innerHTML = `<div class="empty-note">${esc(e.message)}</div>`; }
  };
  return `<div class="toolbar">${backBtn("#/", "‹ Home")}</div>
  <header class="page"><h1>🔁 Duplicates</h1><p>Things kept in more than one spot, or added twice under similar names</p></header>
  <div id="dupes"><div class="spinner"></div></div>`;
});

function dupesHtml(d) {
  const spread = d.spread.map(g => `<div class="card" style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:10px;align-items:center"><div class="thumb">${g.ingredient.image ? `<img src="${imgSrc(g.ingredient.image)}">` : "🥫"}</div>
        <b style="flex:1">${esc(g.ingredient.name)}</b><span class="muted">${g.stock.length} spots in the ${g.space}</span></div>
      ${g.stock.map(s => `<div class="row"><div class="main"><b style="font-weight:500">📍 ${esc(locPath(s.location_id))}</b>
          <small>${esc([s.container_qty, s.container].filter(Boolean).join(" "))}</small></div>${pctTag(s.level)}
          <button class="btn small green" data-act="consolidate" data-keep="${s.id}" data-others="${g.stock.filter(o => o.id !== s.id).map(o => o.id).join(",")}">Combine here</button></div>`).join("")}
    </div>`).join("");
  const similar = d.similar.map(g => `<div class="card" style="display:flex;flex-direction:column;gap:8px">
      <span class="muted" style="font-size:.85rem">These look like the same thing:</span>
      ${g.map(i => `<div class="row"><div class="thumb">${i.image ? `<img src="${imgSrc(i.image)}">` : "🥫"}</div>
          <div class="main clickable" data-act="ing" data-id="${i.id}"><b>${esc(i.name)}</b><small>${esc(i.brand || "")}${i.archived ? " · archived" : ""}</small></div>
          <button class="btn small green" data-act="merge" data-keep="${i.id}" data-others="${g.filter(o => o.id !== i.id).map(o => o.id).join(",")}">Keep this one</button></div>`).join("")}
    </div>`).join("");
  return `<div class="section-title"><h2>Same thing, several spots</h2><span class="sub">Combining adds the levels together</span></div>
    ${spread || `<div class="empty-note">Nothing is kept in two spots of the same space.</div>`}
    <div class="section-title" style="margin-top:20px"><h2>Similar names</h2><span class="sub">Merging moves stock, history and list entries onto the one you keep</span></div>
    ${similar || `<div class="empty-note">No look-alike ingredients.</div>`}`;
}

ACT.consolidate = async el => {
  if (!await confirmBox("Combine these spots into this one? The other spots are removed and their levels added here.", { yes: "Combine" })) return;
  await act(async () => { for (const o of el.dataset.others.split(",")) await api("POST", "/api/stock/consolidate", { keep_id: +el.dataset.keep, other_id: +o }); },
    { ok: "Combined" });
};
ACT.merge = async el => {
  const keep = IX.ing.get(+el.dataset.keep);
  if (!await confirmBox(`Merge the others into “${keep.name}”? They'll be deleted after their stock and history move over.`, { yes: "Merge" })) return;
  await act(async () => { for (const o of el.dataset.others.split(",")) await api("POST", "/api/ingredients/merge", { keep_id: keep.id, other_id: +o }); },
    { ok: "Merged" });
};

// ── grocery lists ───────────────────────────────────────────────────────────
function listCard(l) {
  const total = l.items.length, done = l.items.filter(i => i.checked).length;
  return `<button class="list-card ${l.pinned ? "pinned" : ""}" data-go="#/grocery/${l.id}">
    <b>${l.pinned ? "📌 " : ""}${esc(l.name)}</b>
    <small>${esc(l.store ? l.store + " · " : "")}${l.done_at ? `finished ${fmtDate(l.done_at)}` : `started ${fmtDate(l.created_at)}`}</small>
    <div class="progress"><i style="width:${total ? done / total * 100 : 0}%"></i></div>
    <small>${done}/${total} checked</small></button>`;
}

route(/^\/grocery$/, () => {
  const pinned = S.lists.filter(l => l.pinned && !l.done_at);
  const active = S.lists.filter(l => !l.pinned && !l.done_at);
  const finished = S.lists.filter(l => l.done_at);
  return `<div class="toolbar">${backBtn("#/", "‹ Home")}<span class="spacer"></span>
    <button class="btn amber" data-go="#/putaway">📦 Put away (${S.putaway.length})</button>
    <button class="btn primary" data-act="new-list">+ New list</button></div>
  <header class="page"><h1>🛒 Grocery Lists</h1><p>Tick things off as you shop</p></header>
  ${pinned.length ? `<div class="section-title"><h2>📌 Staples</h2><span class="sub">Pinned lists you reuse</span></div>
    <div class="list-cards">${pinned.map(listCard).join("")}</div>` : ""}
  <div class="section-title"><h2>Lists</h2></div>
  ${active.length ? `<div class="list-cards">${active.map(listCard).join("")}</div>`
    : `<div class="empty-note">No open lists. Start one, or add things from the pantry, Running Low or a recipe.</div>`}
  <div style="text-align:center;margin-top:20px"><button class="btn" data-go="#/grocery/finished">🧾 Finished lists (${finished.length})</button></div>`;
});

route(/^\/grocery\/finished$/, () => {
  const finished = S.lists.filter(l => l.done_at);
  return `<div class="toolbar">${backBtn("#/grocery", "‹ Grocery lists")}</div>
  <header class="page"><h1>🧾 Finished Lists</h1><p>What you bought on past trips</p></header>
  ${finished.length ? `<div class="list-cards">${finished.map(listCard).join("")}</div>` : `<div class="empty-note">No finished lists yet.</div>`}`;
});

ACT["new-list"] = async () => { const l = await newListPrompt(); if (l) go(`/grocery/${l.id}`); };

route(/^\/grocery\/(\d+)$/, (p, id) => {
  const l = IX.list.get(+id);
  if (!l) return `<div class="empty-note">That list is gone. ${backBtn("#/grocery")}</div>`;
  const open = l.items.filter(i => !i.checked), done = l.items.filter(i => i.checked);
  const fin = !!l.done_at;
  window.afterRender = () => wireAddItem(l);
  const lowNotOn = lowStock().filter(x => !onAnyList(x.ing.id));
  const lowCount = new Set(lowNotOn.map(x => x.ing.id)).size;
  return `<div class="toolbar">${backBtn(fin ? "#/grocery/finished" : "#/grocery", "‹ Lists")}<span class="spacer"></span>
    <button class="btn small" data-act="list-edit" data-id="${l.id}">✏️ Rename</button>
    ${!fin ? `<button class="btn small ${l.pinned ? "on" : ""}" data-act="list-pin" data-id="${l.id}">📌 ${l.pinned ? "Pinned" : "Pin"}</button>` : ""}
    <button class="btn small red" data-act="list-del" data-id="${l.id}">🗑️</button></div>
  <header class="page"><h1>${l.pinned ? "📌 " : ""}${esc(l.name)}</h1>
    <p>${esc(l.store ? l.store + " · " : "")}Started ${fmtDate(l.created_at)}${fin ? ` · Finished ${fmtDate(l.done_at)}` : ""}</p></header>
  ${!fin ? `<form class="add-item" id="add-item">
      <input id="ai-text" list="ing-names" placeholder="Add an item…" autocomplete="off">
      <input id="ai-qty" class="qty" placeholder="Qty">
      <button class="btn primary">Add</button>
      <datalist id="ing-names">${S.ingredients.filter(i => !i.archived).map(i => `<option value="${esc(i.name)}">`).join("")}</datalist></form>
    ${lowCount ? `<div><button class="btn small red" data-act="list-add-low" data-id="${l.id}">⚠️ Add ${plural(lowCount, "low item")} not on a list yet</button></div>` : ""}` : ""}
  <div class="rows">${open.map(checkRow).join("")}</div>
  ${!open.length && !fin ? `<div class="empty-note">${done.length ? "All done! 🎉" : "Empty list."}</div>` : ""}
  ${done.length ? `<div class="section-title"><h2 style="font-size:.95rem">In the cart</h2><span class="sub">${done.length}</span></div>
    <div class="rows">${done.map(checkRow).join("")}</div>` : ""}
  <div class="toolbar" style="justify-content:center;margin-top:10px">
    ${fin ? `<button class="btn" data-act="list-reopen" data-id="${l.id}">↩️ Reopen list</button>`
      : l.pinned ? `<button class="btn" data-act="list-reset" data-id="${l.id}" ${done.length ? "" : "disabled"}>↺ Uncheck all for next trip</button>
                    <button class="btn" data-act="list-putaway" data-id="${l.id}" ${done.length ? "" : "disabled"}>📦 Put away checked items</button>`
      : `<button class="btn primary" data-act="list-done" data-id="${l.id}">✓ Done shopping</button>`}</div>`;
});

function checkRow(it) {
  const ing = it.ingredient_id ? IX.ing.get(it.ingredient_id) : null;
  const where = ing && ing.stock.length ? ing.stock.map(s => locPath(s.location_id, { space: true })).join(" · ") : "";
  const recipe = it.recipe_id ? IX.recipe.get(it.recipe_id) : null;
  return `<div class="check-row ${it.checked ? "done" : ""}">
    <button class="box" data-act="check" data-id="${it.id}" data-checked="${it.checked}">${it.checked ? "✓" : ""}</button>
    ${ing ? `<div class="thumb" data-act="ing" data-id="${ing.id}" style="cursor:pointer">${ing.image ? `<img src="${imgSrc(ing.image)}">` : emojiFor(ing)}</div>` : ""}
    <div class="main"><b>${esc(it.text)}</b>${it.qty ? ` <span class="muted">· ${esc(it.qty)}</span>` : ""}
      <small style="display:block">${it.source !== "manual" ? `<span class="src ${esc(it.source)}">${esc(it.source)}</span> ` : ""}${recipe ? `for ${esc(recipe.title)} ` : ""}${esc(where)}</small></div>
    <button class="icon-btn" data-act="item-del" data-id="${it.id}" title="Remove">✕</button></div>`;
}

function wireAddItem(l) {
  const f = $("#add-item");
  if (!f) return;
  f.onsubmit = async e => {
    e.preventDefault();
    const text = $("#ai-text").value.trim(), qty = $("#ai-qty").value.trim();
    if (!text) return;
    const ing = S.ingredients.find(i => i.name.toLowerCase() === text.toLowerCase());
    const src = ing ? (ing.stock.some(s => s.space === "pantry") ? "pantry" : ing.stock.length ? "kitchen" : "manual") : "manual";
    await act(() => api("POST", `/api/lists/${l.id}/items`, { text, qty, ingredient_id: ing ? ing.id : null, source: src }));
    $("#ai-text").focus();
  };
}

ACT.check = async el => {
  const r = await act(() => api("PATCH", `/api/items/${el.dataset.id}`, { checked: el.dataset.checked !== "1" }));
  if (r && r.ask_putaway && r.ingredient_id) {
    const ing = IX.ing.get(r.ingredient_id);
    toast(`Got ${ing ? ing.name : r.text}. Add it to the put-away list?`, {
      actions: [{ label: "📦 Yes", cls: "amber", run: () => act(() => api("POST", "/api/putaway", { entries: [{ ingredient_id: r.ingredient_id, qty: r.qty, list_id: r.list_id }] }), { ok: "Added to put-away" }) },
                { label: "No" }] });
  }
};
ACT["item-del"] = el => act(() => api("DELETE", `/api/items/${el.dataset.id}`));
ACT["list-pin"] = el => act(() => api("PATCH", `/api/lists/${el.dataset.id}`, { pinned: !IX.list.get(+el.dataset.id).pinned }));
ACT["list-reset"] = el => act(() => api("POST", `/api/lists/${el.dataset.id}/reset`));
ACT["list-reopen"] = el => act(() => api("PATCH", `/api/lists/${el.dataset.id}`, { done: false }));
ACT["list-edit"] = async el => {
  const l = IX.list.get(+el.dataset.id);
  const v = await promptBox("Rename list", [{ name: "name", label: "Name", value: l.name }, { name: "store", label: "Store", value: l.store }]);
  if (v) act(() => api("PATCH", `/api/lists/${l.id}`, v));
};
ACT["list-del"] = async el => {
  const l = IX.list.get(+el.dataset.id);
  if (!await confirmBox(`Delete “${l.name}”? Purchases already logged from it stay in each ingredient's history.`, { yes: "Delete", danger: true })) return;
  await act(() => api("DELETE", `/api/lists/${l.id}`));
  go(l.done_at ? "/grocery/finished" : "/grocery");
};
ACT["list-add-low"] = el => {
  const seen = new Set();
  const items = lowStock().filter(x => !onAnyList(x.ing.id) && !seen.has(x.ing.id) && seen.add(x.ing.id))
    .map(x => ({ ingredient_id: x.ing.id, source: x.st.space }));
  act(async () => { for (const it of items) await api("POST", `/api/lists/${el.dataset.id}/items`, it); }, { ok: `Added ${plural(items.length, "item")}` });
};

async function offerPutaway(candidates, listId) {
  if (!candidates.length) return;
  const names = candidates.map(c => IX.ing.get(c.ingredient_id)?.name || c.text);
  if (await confirmBox(`Add ${plural(candidates.length, "item")} to the put-away list? (${names.slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""})`, { yes: "📦 Add to put-away", no: "Not now" })) {
    await act(() => api("POST", "/api/putaway", { entries: candidates.map(c => ({ ingredient_id: c.ingredient_id, qty: c.qty, list_id: listId })) }),
      { ok: "Added to put-away" });
  }
}

ACT["list-done"] = async el => {
  const l = IX.list.get(+el.dataset.id);
  const left = l.items.filter(i => !i.checked).length;
  if (!await confirmBox(left ? `${plural(left, "item")} not checked. Finish the list anyway?` : `Finish “${l.name}”?`, { yes: "✓ Finish" })) return;
  const r = await act(() => api("PATCH", `/api/lists/${l.id}`, { done: true }));
  await offerPutaway(r.putaway_candidates || [], l.id);
  go("/grocery");
};
ACT["list-putaway"] = el => {
  const l = IX.list.get(+el.dataset.id);
  const queued = new Set(S.putaway.map(p => p.ingredient_id));
  offerPutaway(l.items.filter(i => i.checked && i.ingredient_id && !queued.has(i.ingredient_id))
    .map(i => ({ ingredient_id: i.ingredient_id, qty: i.qty, text: i.text })), l.id);
};
