"use strict";
// ── Ingredient detail, add-ingredient wizard, image picker, add-to-grocery ──


function meter(st) {
  const segs = [];
  for (let i = 1; i <= LMAX; i++) {
    segs.push(`<button class="${i <= st.level ? "on" : ""}" data-lvl="${i}" data-sid="${st.id ?? ""}" title="${i * 10}%"></button>`);
  }
  return `<div class="meter ${lvlClass(st.level)}"><button class="zero" data-lvl="0" data-sid="${st.id ?? ""}" title="Empty">0</button>
    ${segs.join("")}<span class="pct">${st.level === 0 ? "Empty" : st.level * 10 + "%"}</span></div>`;
}

// ── detail modal ────────────────────────────────────────────────────────────
ACT.ing = el => showIngredient(+el.dataset.id);

function showIngredient(id) {
  // Re-use an open detail modal for the same ingredient.
  const existing = modalStack.find(m => m.ingId === id);
  if (existing) return;
  const m = openModal("", { wide: true });
  m.ingId = id;
  let hist = null;
  const loadHist = async () => {
    try { hist = await api("GET", `/api/ingredients/${id}/history`); } catch (_) { hist = { purchases: [], recipes: [] }; }
    const box = $("#ing-hist", m.el);
    if (box) box.innerHTML = histHtml(hist);
  };
  m.rerender = () => { draw(); loadHist(); };

  function stockRow(st) {
    const isP = st.space === "pantry";
    const ing = IX.ing.get(id);
    const jar = jarSvg(st.container, { level: st.level, sid: st.id, img: ing.image,
      title: `${st.container}, ${st.level * 10}% full. Tap to set the level.` });
    const label = jar ? st.container_qty : [st.container, st.container_qty].filter(Boolean).join(" · ");
    return `<div class="stock-row ${lvlClass(st.level)}">
      ${jar || label ? `<div class="stock-jar ${jar ? "" : "text"}">${jar}${label ? `<div class="jar-size">${esc(label)}</div>` : ""}</div>` : ""}
      <div class="stock-main">
        <div class="where">📍 <select data-f="location_id" data-sid="${st.id}">${locOptions(st.space, st.location_id)}</select></div>
        ${meter(st)}
        <div class="stock-btns">
          <button class="btn small green" data-full="${st.id}">Full</button>
          <button class="btn small red" data-empty="${st.id}">Empty</button>
          <span class="spacer"></span>
          <button class="btn small" data-delstock="${st.id}" title="Remove this spot">✕ Remove spot</button>
        </div>
        ${isP ? `<div class="grid2">
          <label class="field">Refill qty<input data-f="refill_qty" data-sid="${st.id}" value="${esc(st.refill_qty)}" placeholder="2 bags"></label>
          <label class="field">Price to replace<input data-f="price" data-sid="${st.id}" value="${st.price ?? ""}" placeholder="$" inputmode="decimal"></label>
        </div>` : ""}
      </div></div>`;
  }

  function draw() {
    const ing = IX.ing.get(id);
    if (!ing) { closeModal(m); return; }
    const block = (space, label, emoji) => {
      const rows = ing.stock.filter(s => s.space === space);
      return `<div class="space-block"><h3>${emoji} ${label}
          <span class="spacer" style="flex:1"></span>
          <button class="btn small" data-addstock="${space}">+ ${rows.length ? "Another spot" : `Keep in ${label.toLowerCase()}`}</button></h3>
        ${rows.length ? rows.map(stockRow).join("") : `<span class="muted" style="font-size:.85rem">Not kept in the ${label.toLowerCase()}.</span>`}
        ${rows.length > 1 ? `<span class="muted" style="font-size:.8rem">🔁 In ${rows.length} spots, could be consolidated (see Duplicates).</span>` : ""}</div>`;
    };
    const onList = activeLists().filter(l => l.items.some(i => i.ingredient_id === id && !i.checked));
    const inPutaway = S.putaway.some(p => p.ingredient_id === id);
    m.el.innerHTML = `
      <div class="ing-top"><div class="pic">${pic(ing)}</div>
        <div style="flex:1;min-width:0"><h2>${esc(ing.name)}</h2>
          <div class="meta">${[ing.brand, ing.category].filter(Boolean).map(esc).join(" · ")}${ing.archived ? ' · <span class="src">archived</span>' : ""}</div>
          ${ing.description ? `<div class="desc">${esc(ing.description)}</div>` : ""}
          ${ing.notes ? `<div class="desc">📝 ${esc(ing.notes)}</div>` : ""}
          ${onList.length ? `<div class="desc" style="color:#8bbcf0">🛒 On ${onList.map(l => `<a href="#/grocery/${l.id}" data-close-go>${esc(l.name)}</a>`).join(", ")}</div>` : ""}
          ${inPutaway ? `<div class="desc" style="color:#ffc65c">📦 Waiting to be put away</div>` : ""}
        </div></div>
      <div class="toolbar">
        <button class="btn blue" data-grocery>🛒 Add to grocery list</button></div>
      ${block("kitchen", "Kitchen", "🍳")}
      ${block("pantry", "Pantry", "🥫")}
      <div id="ing-hist">${hist ? histHtml(hist) : `<div class="spinner small"></div>`}</div>
      <div class="toolbar" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn small" data-edit>✏️ Edit details</button>
        <button class="btn small" data-archive>${ing.archived ? "♻️ Restore" : "🗃️ Archive"}</button>
        <span class="spacer"></span>
        <button class="btn red small" data-delete>🗑️ Delete</button></div>`;
  }

  function histHtml(h) {
    const rows = h.purchases.map(p => `<div class="log-row"><span class="d">${fmtDate(p.bought_at)}</span>
      <span>${esc(p.qty || "")}${p.price != null ? ` · $${p.price.toFixed(2)}` : ""}${p.store ? ` · ${esc(p.store)}` : ""}</span>
      <span class="gap">${p.days_since_prev != null ? `${p.days_since_prev} days after previous` : "first logged"}</span>
      <button class="icon-btn" data-delpurchase="${p.id}" title="Delete">✕</button></div>`).join("");
    return `<div class="space-block"><h3>🧾 Purchase history<span style="flex:1"></span>
        <button class="btn small" data-logbuy>+ Log a purchase</button></h3>
      <div class="stat-row">
        <span>Last bought: <b>${h.days_since_last == null ? "never logged" : h.days_since_last === 0 ? "today" : `${h.days_since_last} days ago`}</b></span>
        <span>Usually every: <b>${h.avg_days_between == null ? "–" : `${h.avg_days_between} days`}</b></span>
        <span>Times bought: <b>${h.purchases.length}</b></span>
        <span title="Counted when a spot's level goes up by 30% or more">Times refilled: <b>${IX.ing.get(id)?.refills || 0}</b></span></div>
      <div class="log">${rows || `<span class="muted">Ticking it off a grocery list logs a purchase here.</span>`}</div></div>
      <div class="space-block"><h3>📖 Used in recipes</h3>
      ${h.recipes.length ? `<div class="chips">${h.recipes.map(r => `<a class="chip" href="#/recipes/${r.id}" data-close-go>${esc(r.title)}${r.rating ? ` ${"★".repeat(r.rating)}` : ""}</a>`).join("")}</div>`
        : `<span class="muted" style="font-size:.85rem">Not in any saved recipe yet.</span>`}</div>`;
  }

  const patchStock = (sid, body) => act(() => api("PATCH", `/api/stock/${sid}`, body));

  m.el.addEventListener("click", async e => {
    const jarEl = e.target.closest("svg.jar[data-sid]");
    if (jarEl) return patchStock(jarEl.dataset.sid, { level: jarLevelAt(jarEl, e.clientY) });
    const t = e.target.closest("button, a");
    if (!t) return;
    const d = t.dataset;
    if ("closeGo" in d) { closeModal(m); return; }       // let the link navigate
    if (d.lvl !== undefined && d.sid) return patchStock(d.sid, { level: +d.lvl });
    if (d.full) return patchStock(d.full, { level: LMAX });
    if (d.empty) {
      await patchStock(d.empty, { level: 0 });
      const ing = IX.ing.get(id);
      if (!onAnyList(id)) toast(`${ing.name} is empty.`, { actions: [{ label: "🛒 Add to list", cls: "blue", run: () => addToGrocery([{ ingredient_id: id, source: ing.stock.find(s => s.id === +d.empty)?.space }]) }] });
      return;
    }
    if (d.delstock) {
      if (await confirmBox("Remove this spot? (The ingredient stays, just not here.)", { yes: "Remove", danger: true }))
        act(() => api("DELETE", `/api/stock/${d.delstock}`));
      return;
    }
    if (d.addstock) return act(() => api("POST", `/api/ingredients/${id}/stock`, { space: d.addstock, level: LMAX }));
    if ("grocery" in d) {
      const ing = IX.ing.get(id);
      const space = ing.stock.find(s => s.space === "pantry") ? "pantry" : ing.stock.length ? "kitchen" : "manual";
      return addToGrocery([{ ingredient_id: id, source: space }]);
    }
    if ("archive" in d) {
      const ing = IX.ing.get(id);
      return act(() => api("PATCH", `/api/ingredients/${id}`, { archived: !ing.archived }),
        { ok: ing.archived ? "Restored" : "Archived. Find it under Pantry › Archived." });
    }
    if ("edit" in d) return editIngredient(id);
    if ("delete" in d) {
      const ing = IX.ing.get(id);
      if (await confirmBox(`Delete “${ing.name}” for good, with its purchase history? (Archive instead to just hide it.)`, { yes: "Delete", danger: true })) {
        await act(() => api("DELETE", `/api/ingredients/${id}`));
        closeModal(m);
      }
      return;
    }
    if ("logbuy" in d) {
      const v = await promptBox("Log a purchase", [
        { name: "bought_at", label: "Date", value: new Date().toISOString().slice(0, 10) },
        { name: "qty", label: "Quantity", placeholder: "e.g. 2 bags" },
        { name: "price", label: "Price", placeholder: "$" },
        { name: "store", label: "Store", placeholder: "Costco" }]);
      if (v) { hist = await act(() => api("POST", `/api/ingredients/${id}/purchases`, v), { reload: false }); $("#ing-hist", m.el).innerHTML = histHtml(hist); }
      return;
    }
    if (d.delpurchase) {
      await act(() => api("DELETE", `/api/purchases/${d.delpurchase}`), { reload: false });
      loadHist();
    }
  });
  m.el.addEventListener("change", e => {
    const t = e.target;
    if (t.dataset.f && t.dataset.sid) patchStock(t.dataset.sid, { [t.dataset.f]: t.value });
  });

  draw();
  loadHist();
}

const onAnyList = iid => activeLists().some(l => l.items.some(i => i.ingredient_id === iid && !i.checked));

// ── image picker (choices from lookups + upload + URL) ──────────────────────
// choices: [{src, remote}] where remote=true means a URL still to download.
function imagePicker(el, { choices = [], selected = null }) {
  let sel = selected;
  const all = [...choices];
  const draw = () => {
    el.innerHTML = `<div class="pic-choices">
      <button class="pic-choice ${sel == null ? "sel" : ""}" data-pick="-1" title="No picture"><div class="ph" style="display:flex;align-items:center;justify-content:center;height:100%;color:#999">none</div></button>
      ${all.map((c, i) => `<button class="pic-choice ${sel === i ? "sel" : ""}" data-pick="${i}"><img src="${esc(c.remote ? c.src : imgSrc(c.src))}" alt="" loading="lazy" onerror="this.parentNode.style.display='none'"></button>`).join("")}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        <label class="btn small">📷 Upload / take photo<input type="file" accept="image/*" hidden data-file></label>
        <input data-url placeholder="…or paste an image URL" style="flex:1;min-width:160px"><button class="btn small" data-urlgo>Use</button></div>`;
  };
  el.addEventListener("click", e => {
    const b = e.target.closest("[data-pick]");
    if (b) { e.preventDefault(); sel = +b.dataset.pick < 0 ? null : +b.dataset.pick; draw(); }
    if (e.target.closest("[data-urlgo]")) {
      e.preventDefault();
      const u = $("[data-url]", el).value.trim();
      if (u) { all.push({ src: u, remote: true }); sel = all.length - 1; draw(); }
    }
  });
  el.addEventListener("change", async e => {
    if (!e.target.matches("[data-file]") || !e.target.files[0]) return;
    try {
      const name = await uploadImage(e.target.files[0]);
      all.push({ src: name, remote: false }); sel = all.length - 1; draw();
    } catch (err) { toast(err.message, { err: true }); }
  });
  draw();
  return {
    // Resolve to a stored image name (downloads a remote pick).
    async value() {
      if (sel == null) return null;
      const c = all[sel];
      return c.remote ? await fetchImage(c.src) : c.src;
    },
    setChoices(list, s) { all.splice(0, all.length, ...list); sel = s; draw(); },
  };
}

// ── edit details ────────────────────────────────────────────────────────────
function editIngredient(id) {
  const ing = IX.ing.get(id);
  const m = openModal(`<h2>Edit ${esc(ing.name)}</h2>
    <div class="grid2"><label class="field">Name<input name="name" value="${esc(ing.name)}"></label>
      <label class="field">Brand<input name="brand" value="${esc(ing.brand)}"></label></div>
    ${categoryField(ing.category)}
    <label class="field">Description<textarea name="description" rows="3">${esc(ing.description)}</textarea></label>
    <div style="margin-top:-4px"><button class="btn small" data-wiki>📖 Fill from Wikipedia</button></div>
    <label class="field">Notes<textarea name="notes" rows="2" placeholder="e.g. Buy the big Costco bag">${esc(ing.notes)}</textarea></label>
    ${ing.stock.length ? `<div class="edit-spots"><div class="clabel">Containers</div>${ing.stock.map(st => `
      <div class="edit-spot" data-spot="${st.id}">
        <div class="spot-name">${st.space === "kitchen" ? "🍳" : "🥫"} ${esc(st.location_id ? locPath(st.location_id) : `${st.space === "kitchen" ? "Kitchen" : "Pantry"} · not placed yet`)}</div>
        ${containerPicker(st.container, "data-ec")}
        <label class="field spot-size">Container size<input data-ec-qty value="${esc(st.container_qty)}" placeholder="500 g"></label>
      </div>`).join("")}</div>` : ""}
    <div><div class="field" style="margin-bottom:6px">Picture <button class="btn small" data-findpics style="margin-left:8px">🔍 Find pictures</button></div><div id="pp"></div></div>
    <div class="actions"><button class="btn" data-cancel>Cancel</button><button class="btn primary" data-save>Save</button></div>`, { wide: true });
  const picker = imagePicker($("#pp", m.el), { choices: ing.image ? [{ src: ing.image, remote: false }] : [], selected: ing.image ? 0 : null });
  $("[data-findpics]", m.el).onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await api("GET", `/api/lookup?q=${encodeURIComponent($("[name=name]", m.el).value)}`);
      const list = [...(ing.image ? [{ src: ing.image, remote: false }] : []),
        ...[...r.generic, ...r.products].filter(x => x.image).map(x => ({ src: x.image, remote: true }))];
      picker.setChoices(list, ing.image ? 0 : null);
    } catch (err) { toast(err.message, { err: true }); }
    e.target.disabled = false;
  };
  $("[data-wiki]", m.el).onclick = async e => {
    const btn = e.target, q = $("[name=name]", m.el).value.trim();
    if (!q) return;
    btn.disabled = true;
    try {
      const w = await api("GET", `/api/describe?q=${encodeURIComponent(q)}`);
      if (w.description) { $("[name=description]", m.el).value = w.description; toast(`From Wikipedia: ${w.title}`); }
      else toast(`No Wikipedia article found for “${q}”`, { err: true });
    } catch (err) { toast(err.message, { err: true }); }
    btn.disabled = false;
  };
  // Container buttons: picking a jar selects it and fills in its size.
  m.el.addEventListener("click", e => {
    const b = e.target.closest("[data-cpick]");
    if (!b) return;
    const spot = b.closest("[data-spot]"), qty = $("[data-ec-qty]", spot);
    cpickClick(b, qty.value, (kind, size) => {
      spot.querySelectorAll(".cbtn").forEach(x => x.classList.toggle("sel", x === b));
      $(".cother", spot).hidden = true;
      qty.value = size;
    });
  });
  const spotChanges = () => [...m.el.querySelectorAll("[data-spot]")].map(spot => {
    const sel = $(".cbtn.sel", spot), st = ing.stock.find(s => s.id === +spot.dataset.spot);
    const container = !sel ? "" : sel.dataset.cpick || $(".cother", spot).value.trim();
    const container_qty = $("[data-ec-qty]", spot).value.trim();
    return st && (container !== st.container || container_qty !== st.container_qty) ? [st.id, { container, container_qty }] : null;
  }).filter(Boolean);
  $("[data-cancel]", m.el).onclick = () => closeModal(m);
  $("[data-save]", m.el).onclick = async () => {
    const body = {};
    for (const k of ["name", "brand", "category", "description", "notes"]) body[k] = $(`[name=${k}]`, m.el).value;
    try { body.image = await picker.value(); } catch (e) { toast(e.message, { err: true }); return; }
    const spots = spotChanges();
    await act(async () => {
      await api("PATCH", `/api/ingredients/${id}`, body);
      for (const [sid, b] of spots) await api("PATCH", `/api/stock/${sid}`, b);
    });
    closeModal(m);
  };
}

// ── add-ingredient wizard ───────────────────────────────────────────────────
ACT["add-ing"] = el => addIngredient({ name: el.dataset.name || "", space: el.dataset.space, loc: el.dataset.loc ? +el.dataset.loc : null });

function addIngredient({ name = "", space = null, loc = null } = {}) {
  const st = {
    step: 1, q: name, results: { generic: [], products: [] }, pick: null,
    d: { name, brand: "", category: "", description: "", source: "manual", source_ref: "" },
    places: {
      kitchen: { on: space === "kitchen" || !space, location_id: space === "kitchen" ? loc : null, level: LMAX, container: "", container_qty: "" },
      pantry: { on: space === "pantry", location_id: space === "pantry" ? loc : null, level: LMAX, container: "", container_qty: "", refill_qty: "", price: "" },
    },
  };
  if (!space) st.places.kitchen.on = true;
  const m = openModal("", { wide: true });
  let picker = null, timer = null, seq = 0;

  const stepsBar = () => `<div class="steps">${["1 Find it", "2 Details & picture", "3 Where it lives"].map((s, i) =>
    `<span class="${st.step === i + 1 ? "on" : ""}">${s}</span>${i < 2 ? "<span>›</span>" : ""}`).join("")}</div>`;

  function resultCard(r, i, kind) {
    return `<button class="result ${st.pick && st.pick.kind === kind && st.pick.i === i ? "sel" : ""}" data-pick="${kind}:${i}">
      <div class="pic">${r.thumb || r.image ? `<img src="${esc(r.thumb || r.image)}" alt="" loading="lazy">` : ""}</div>
      <span class="src-tag">${kind === "generic" ? "Ingredient" : "Product"}</span>
      <b>${esc(r.name)}</b>${r.brand ? `<small>${esc(r.brand)}</small>` : ""}${r.quantity ? `<small>${esc(r.quantity)}</small>` : ""}</button>`;
  }

  function step1() {
    const q = st.q.trim().toLowerCase();
    const mine = q ? S.ingredients.filter(i => i.name.toLowerCase().includes(q)).slice(0, 6) : [];
    m.el.innerHTML = `<h2>Add an ingredient</h2>${stepsBar()}
      <input id="wq" type="search" placeholder="Type a name: cinnamon, Kirkland maple syrup…" value="${esc(st.q)}" autocomplete="off">
      ${mine.length ? `<div><div class="sr-head" style="padding-left:0">Already have</div><div class="rows">${mine.map(i => ingRow(i)).join("")}</div></div>` : ""}
      <div id="wres">${resultsHtml()}</div>
      <div class="actions"><button class="btn" data-cancel>Cancel</button>
        <button class="btn primary" data-plain ${st.q.trim() ? "" : "disabled"}>${st.pick ? "Next ›" : `Just use “${esc(st.q.trim() || "…")}” ›`}</button></div>`;
    const inp = $("#wq", m.el);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.oninput = () => {
      st.q = inp.value; st.pick = null;
      clearTimeout(timer);
      timer = setTimeout(() => { search(); step1(); }, 450);
    };
  }

  function resultsHtml() {
    if (st.loading) return `<div class="spinner"></div>`;
    const { generic, products } = st.results;
    if (!st.q.trim()) return `<p class="muted" style="font-size:.85rem">Searches TheMealDB's ingredient list (generic items with a photo) and Open Food Facts (packaged products and brands). Descriptions come from Wikipedia.</p>`;
    return `${generic.length ? `<div class="sr-head" style="padding-left:0">Ingredients</div><div class="results">${generic.map((r, i) => resultCard(r, i, "generic")).join("")}</div>` : ""}
      ${products.length ? `<div class="sr-head" style="padding-left:0;margin-top:8px">Products</div><div class="results">${products.map((r, i) => resultCard(r, i, "products")).join("")}</div>` : ""}
      ${!generic.length && !products.length && st.searched ? `<p class="muted">No matches online, which is fine. Use the name as typed.</p>` : ""}`;
  }

  async function search() {
    const q = st.q.trim();
    if (q.length < 2) { st.results = { generic: [], products: [] }; return; }
    const my = ++seq;
    st.loading = true; $("#wres", m.el) && ($("#wres", m.el).innerHTML = resultsHtml());
    try {
      const r = await api("GET", `/api/lookup?q=${encodeURIComponent(q)}`);
      if (my !== seq) return;
      st.results = r; st.searched = true;
    } catch (e) { toast(e.message, { err: true }); }
    st.loading = false;
    if (st.step === 1 && my === seq) step1();
  }

  function choose(kind, i) {
    const r = st.results[kind][i];
    st.pick = { kind, i };
    st.picker = st.pickerEl = null;
    st.d = { name: r.name, brand: r.brand || "", category: normCategory(r.category) || normCategory(r.description) || normCategory(r.name),
             description: r.description || "",
             source: r.source, source_ref: r.source_ref };
    if (r.quantity) st.places.pantry.container_qty = st.places.kitchen.container_qty = r.quantity;
    st.step = 2; step2(); wikiFill(r);
  }

  // Swap in Wikipedia's opening paragraph (TheMealDB and Open Food Facts often
  // have none), unless the description was edited while the lookup ran.
  function wikiFill(r) {
    const q = ((r && r.source === "off" ? (r.description || r.category) : "") || st.d.name).trim();
    if (q.length < 2) return;
    st.wikiQ = q;
    const before = st.d.description.trim();
    const ta = () => $("textarea[name=description]", m.el);
    if (ta()) ta().placeholder = "Looking up Wikipedia…";
    api("GET", `/api/describe?q=${encodeURIComponent(q)}`).catch(() => ({})).then(w => {
      if (st.wikiQ !== q) return;
      const t = ta();
      if (t) t.placeholder = "optional";
      if (!w.description || (t ? t.value.trim() : st.d.description.trim()) !== before) return;
      st.d.description = w.description;
      if (t) t.value = w.description;
    });
  }

  function step2() {
    m.el.innerHTML = `<h2>Add an ingredient</h2>${stepsBar()}
      <div class="grid2"><label class="field">Name<input name="name" value="${esc(st.d.name)}"></label>
        <label class="field">Brand<input name="brand" value="${esc(st.d.brand)}" placeholder="optional"></label></div>
      ${categoryField(st.d.category)}
      <label class="field">Description<textarea name="description" rows="2" placeholder="optional">${esc(st.d.description)}</textarea></label>
      <div><div class="field" style="margin-bottom:6px">Picture</div><div id="wpic"></div></div>
      <div class="actions"><button class="btn" data-back>‹ Back</button><button class="btn primary" data-next>Next ›</button></div>`;
    // Picked result's photo first, then every other photo from the search.
    const all = [...st.results.generic.map((r, i) => ["generic", i, r]), ...st.results.products.map((r, i) => ["products", i, r])]
      .filter(([, , r]) => r.image);
    let selected = null;
    const choices = all.map(([k, i, r], n) => { if (st.pick && st.pick.kind === k && st.pick.i === i) selected = n; return { src: r.image, remote: true }; });
    if (selected != null) choices.unshift(...choices.splice(selected, 1));
    picker = st.picker || imagePicker($("#wpic", m.el), { choices, selected: selected != null ? 0 : null });
    if (st.picker) { $("#wpic", m.el).replaceWith(st.pickerEl); }
    st.picker = picker; st.pickerEl = st.pickerEl || $("#wpic", m.el);
  }

  function saveStep2() {
    for (const k of ["name", "brand", "category", "description"]) st.d[k] = $(`[name=${k}]`, m.el).value.trim();
    if (!st.d.name) { toast("Name is required", { err: true }); return false; }
    return true;
  }

  function placeBlock(space) {
    const p = st.places[space], isP = space === "pantry";
    return `<div class="place-block ${p.on ? "" : "off"}" data-space="${space}">
      <label class="place-toggle"><input type="checkbox" data-on ${p.on ? "checked" : ""}> ${isP ? "🥫 In the pantry" : "🍳 In the kitchen"}</label>
      <label class="field">Where<select data-k="location_id">${locOptions(space, p.location_id)}</select></label>
      <div><div class="field" style="margin-bottom:4px">How full</div>${meter({ level: p.level })}</div>
      <div><div class="clabel">Container</div>${containerPicker(p.container, `data-k="container"`)}</div>
      <div class="grid2">
        <label class="field">Container size<input data-k="container_qty" value="${esc(p.container_qty)}" placeholder="500 g"></label>
        ${isP ? `<label class="field">Refill qty<input data-k="refill_qty" value="${esc(p.refill_qty)}" placeholder="1 bag"></label>
        <label class="field">Price to replace<input data-k="price" value="${esc(p.price)}" placeholder="$" inputmode="decimal"></label>` : ""}
      </div></div>`;
  }

  function step3() {
    m.el.innerHTML = `<h2>Where does ${esc(st.d.name)} live?</h2>${stepsBar()}
      ${placeBlock("kitchen")}${placeBlock("pantry")}
      <p class="muted" style="font-size:.8rem">Pick one, both, or neither (you can place it later).</p>
      <div class="actions"><button class="btn" data-back>‹ Back</button><button class="btn primary" data-save>✓ Add ${esc(st.d.name)}</button></div>`;
  }

  async function save(btn) {
    btn.disabled = true; btn.innerHTML = `<span class="spinner small"></span> Saving…`;
    try {
      const image = picker ? await picker.value() : null;
      const stock = ["kitchen", "pantry"].filter(s => st.places[s].on).map(s => ({ space: s, ...st.places[s] }));
      const ing = await api("POST", "/api/ingredients", { ...st.d, image, stock });
      await refresh();
      closeModal(m);
      toast(`Added ${ing.name}`, { actions: [{ label: "Open", run: () => showIngredient(ing.id) }, { label: "+ Another", run: () => addIngredient({ space, loc }) }] });
    } catch (e) {
      toast(e.message, { err: true });
      btn.disabled = false; btn.textContent = "✓ Try again";
    }
  }

  m.el.addEventListener("click", e => {
    const t = e.target.closest("button");
    if (!t) return;
    const d = t.dataset;
    if ("cancel" in d) return closeModal(m);
    if (d.pick) { const [k, i] = d.pick.split(":"); return choose(k, +i); }
    if ("plain" in d) {
      if (st.pick) { st.step = 2; return step2(); }
      st.d = { name: st.q.trim(), brand: "", category: normCategory(st.q), description: "", source: "manual", source_ref: "" };
      st.picker = st.pickerEl = null;
      st.step = 2; step2(); return wikiFill(null);
    }
    if ("back" in d) {
      if (st.step === 2) { saveStep2(); st.step = 1; step1(); }
      else if (st.step === 3) { st.step = 2; step2(); }
      return;
    }
    if ("next" in d) { if (saveStep2()) { st.step = 3; step3(); } return; }
    if ("save" in d) return save(t);
    if (d.cpick !== undefined) {
      const p = st.places[t.closest("[data-space]").dataset.space];
      return cpickClick(t, p.container_qty, (c, q) => { p.container = c; p.container_qty = q; step3(); });
    }
    if (d.lvl !== undefined) {
      const sp = t.closest("[data-space]").dataset.space;
      st.places[sp].level = +d.lvl; step3();
    }
  });
  m.el.addEventListener("change", e => {
    const blk = e.target.closest("[data-space]");
    if (!blk) return;
    const p = st.places[blk.dataset.space];
    if (e.target.matches("[data-on]")) { p.on = e.target.checked; blk.classList.toggle("off", !p.on); }
    else if (e.target.dataset.k) p[e.target.dataset.k] = e.target.dataset.k === "location_id" ? (+e.target.value || null) : e.target.value;
  });

  step1();
  if (name) search();
}

// ── add to a grocery list ───────────────────────────────────────────────────
// items: [{ingredient_id?, text?, qty?, source, recipe_id?}]
function addToGrocery(items, { title } = {}) {
  const lists = activeLists();
  const last = +localStorage.getItem("lastList") || null;
  const m = openModal(`<h2>${esc(title || (items.length === 1 ? `Add ${items[0].text || IX.ing.get(items[0].ingredient_id)?.name || "item"} to…` : `Add ${items.length} items to…`))}</h2>
    <div class="rows">${lists.map(l => `<button class="row clickable" data-list="${l.id}" style="text-align:left;${l.id === last ? "border-color:var(--gold)" : ""}">
        <div class="main"><b>${l.pinned ? "📌 " : ""}${esc(l.name)}</b><small>${esc(l.store || "")} ${plural(l.items.filter(i => !i.checked).length, "item")} to buy</small></div></button>`).join("")}
      <button class="row clickable" data-newlist style="text-align:left;border-style:dashed"><div class="main"><b>+ New list</b><small>Named after today's date unless you rename it</small></div></button></div>`);
  m.el.addEventListener("click", async e => {
    const t = e.target.closest("button");
    if (!t) return;
    let lid = t.dataset.list ? +t.dataset.list : null;
    if ("newlist" in t.dataset) {
      const v = await newListPrompt();
      if (!v) return;
      lid = v.id;
    }
    if (!lid) return;
    closeModal(m);
    localStorage.setItem("lastList", lid);
    let added = 0, dup = 0;
    await act(async () => {
      for (const it of items) {
        const r = await api("POST", `/api/lists/${lid}/items`, it);
        r.already ? dup++ : added++;
      }
    });
    const l = IX.list.get(lid);
    toast(`${added ? `Added ${plural(added, "item")}` : ""}${dup ? `${added ? ", " : ""}${dup} already on it` : ""} · ${l ? l.name : ""}`,
      { actions: [{ label: "Open list", run: () => go(`/grocery/${lid}`) }] });
  });
}

async function newListPrompt() {
  const v = await promptBox("New grocery list", [
    { name: "name", label: "Name", placeholder: new Date().toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) + " (default)" },
    { name: "store", label: "Store", placeholder: "e.g. Costco, Superstore" },
    { name: "pinned", label: "📌 Pin it (a staples list you reuse)", type: "checkbox" }], { submit: "Create" });
  if (!v) return null;
  return act(() => api("POST", "/api/lists", v));
}
