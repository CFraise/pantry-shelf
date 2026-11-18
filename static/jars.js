"use strict";
// ── Container presets: flat jar graphics + the container picker ─────────────
// The three jars in rotation are drawn to scale with each other (100 viewBox
// units = a 1 L mason jar's height). The contents fill to the stock level and
// take their colour from the ingredient's photo.

const JARS = {
  "Spice Jar":       { size: "120 ml", w: 30 },
  "Small Mason Jar": { size: "500 ml", w: 46 },
  "Large Mason Jar": { size: "1 L",    w: 52 },
};
const PRESET_SIZES = new Set(Object.values(JARS).map(j => j.size));

// Per-jar geometry: glass body path, lid box, and the fillable span (top → bottom).
const JAR_SHAPES = {
  "Spice Jar": {
    body: "M5,46 L5,44 L25,44 L25,46 Q28,46 28,50 L28,96 Q28,99 25,99 L5,99 Q2,99 2,96 L2,50 Q2,46 5,46 Z",
    lid: { x: 3, y: 36.5, w: 24, h: 8, rx: 1.5 }, ridges: "v", top: 47, bottom: 98,
  },
  "Small Mason Jar": {
    body: "M8,33 L38,33 L38,37 C38,40 43,42 43,48 L43,93 Q43,99 37,99 L9,99 Q3,99 3,93 L3,48 C3,42 8,40 8,37 Z",
    lid: { x: 7, y: 25.5, w: 32, h: 8, rx: 1.5 }, ridges: "h", top: 39, bottom: 98,
    threads: [34.5, 36.5],
  },
  "Large Mason Jar": {
    body: "M10,8 L42,8 L42,13 C42,17 49,19 49,26 L49,92 Q49,99 42,99 L10,99 Q3,99 3,92 L3,26 C3,19 10,17 10,13 Z",
    lid: { x: 9, y: 1, w: 34, h: 8, rx: 1.5 }, ridges: "h", top: 15, bottom: 98,
    threads: [10, 12],
  },
};

let _jarSeq = 0;

// scale = CSS px per viewBox unit. Returns "" for containers that aren't presets.
function jarSvg(kind, { level = 0, scale = 1.15, sid = null, img = null, title = "" } = {}) {
  const J = JARS[kind], S = JAR_SHAPES[kind];
  if (!J) return "";
  const id = `jar${++_jarSeq}`, L = S.lid;
  const fillY = S.bottom - (S.bottom - S.top) * Math.max(0, Math.min(LMAX, level)) / LMAX;
  const color = img ? jarColorCached(img) : null;
  const ridges = S.ridges === "v"
    ? Array.from({ length: 11 }, (_, i) => `<line x1="${L.x + 2 + i * (L.w - 4) / 10}" y1="${L.y + 1}" x2="${L.x + 2 + i * (L.w - 4) / 10}" y2="${L.y + L.h - 2.2}"/>`).join("")
    : `<line x1="${L.x + 1}" y1="${L.y + 2.5}" x2="${L.x + L.w - 1}" y2="${L.y + 2.5}"/><line x1="${L.x + 1}" y1="${L.y + 5}" x2="${L.x + L.w - 1}" y2="${L.y + 5}"/>`;
  return `<svg class="jar" viewBox="0 0 ${J.w} 100" width="${J.w * scale}" height="${100 * scale}"
      ${sid != null ? `data-sid="${sid}" data-top="${S.top}" data-bottom="${S.bottom}"` : ""}
      ${img ? `data-img="${esc(img)}"` : ""} style="${color ? `--jar-fill:${color}` : ""}" role="img" aria-label="${esc(title || kind)}">
    ${title ? `<title>${esc(title)}</title>` : ""}
    <defs>
      <clipPath id="${id}c"><path d="${S.body}"/></clipPath>
      <linearGradient id="${id}l" x1="0" x2="1"><stop offset="0" stop-color="#eef1f4"/><stop offset=".45" stop-color="#b9c0c8"/><stop offset=".75" stop-color="#8d96a0"/><stop offset="1" stop-color="#d7dbe0"/></linearGradient>
      <pattern id="${id}g" width="3" height="3" patternUnits="userSpaceOnUse"><circle cx=".8" cy=".8" r=".35"/><circle cx="2.3" cy="2.1" r=".3"/></pattern>
    </defs>
    <path class="jar-glass" d="${S.body}"/>
    ${level > 0 ? `<g clip-path="url(#${id}c)">
      <rect class="jar-c" x="0" y="${fillY}" width="${J.w}" height="${100 - fillY}"/>
      <rect class="jar-grain" x="0" y="${fillY}" width="${J.w}" height="${100 - fillY}" fill="url(#${id}g)"/>
      <rect class="jar-surface" x="0" y="${fillY}" width="${J.w}" height="1.2"/></g>` : ""}
    ${(S.threads || []).map(y => `<line class="jar-thread" x1="${L.x + 1.5}" y1="${y}" x2="${L.x + L.w - 1.5}" y2="${y}"/>`).join("")}
    <path class="jar-shine" d="M${shineFor(kind)}"/>
    <path class="jar-edge" d="${S.body}"/>
    <rect x="${L.x}" y="${L.y}" width="${L.w}" height="${L.h}" rx="${L.rx}" fill="url(#${id}l)" class="jar-lid"/>
    <g class="jar-ridges">${ridges}</g>
  </svg>`;
}

// A soft vertical highlight down the left side of the glass.
function shineFor(kind) {
  const S = JAR_SHAPES[kind];
  const x = kind === "Spice Jar" ? 5 : 7.5;
  return `${x},${S.top + 4} L${x + 2.6},${S.top + 4} L${x + 2.6},${S.bottom - 6} L${x},${S.bottom - 6} Z`;
}

// ── contents colour, sampled from the ingredient photo ──────────────────────
const _jarColors = new Map();   // image -> colour string, or a pending Promise

function jarColorCached(img) {
  const c = _jarColors.get(img);
  if (typeof c === "string") return c;
  if (!c) _jarColors.set(img, sampleColor(imgSrc(img)).then(col => {
    _jarColors.set(img, col);
    document.querySelectorAll(`svg.jar[data-img="${CSS.escape(img)}"]`).forEach(s => s.style.setProperty("--jar-fill", col));
    return col;
  }));
  return null;
}

// Average of the photo's "subject" pixels: skips transparency and the white
// studio background, and leans towards saturated pixels so a red spice reads
// red rather than the beige of its shading. Mostly-white photos (salt, flour)
// come out pale.
function sampleColor(src) {
  return new Promise(resolve => {
    const im = new Image();
    im.onload = () => {
      try {
        const N = 48, cv = document.createElement("canvas");
        cv.width = cv.height = N;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(im, 0, 0, N, N);
        const px = cx.getImageData(0, 0, N, N).data;
        let r = 0, g = 0, b = 0, w = 0, kept = 0, seen = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 200) continue;
          seen++;
          const R = px[i], G = px[i + 1], B = px[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          if (mn > 228) continue;                       // white background
          const sat = mx ? (mx - mn) / mx : 0, wt = 0.15 + sat * 2;
          r += R * wt; g += G * wt; b += B * wt; w += wt; kept++;
        }
        if (!seen || kept / seen < 0.03) return resolve("#ece6da");
        resolve(`rgb(${Math.round(r / w)},${Math.round(g / w)},${Math.round(b / w)})`);
      } catch (_) { resolve(null); }
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

// Tap on a jar → level at that height (detail screen).
function jarLevelAt(svg, clientY) {
  const r = svg.getBoundingClientRect();
  const y = (clientY - r.top) / r.height * 100, top = +svg.dataset.top, bot = +svg.dataset.bottom;
  return Math.max(0, Math.min(LMAX, Math.round((bot - y) / (bot - top) * LMAX)));
}

// ── picker: the three jars + "Other…" free text ──────────────────────────────
// inputAttrs go on the free-text input so the existing change handlers save it.
function containerPicker(value, inputAttrs) {
  const other = !!value && !JARS[value];
  return `<div class="cpick">
    ${Object.keys(JARS).map(k => `<button type="button" class="cbtn ${k === value ? "sel" : ""}" data-cpick="${k}" title="${k} (${JARS[k].size})">
      <span class="cicon">${jarSvg(k, { level: 7, scale: 0.4 })}</span><span>${k.replace(" Jar", "")}<small>${JARS[k].size}</small></span></button>`).join("")}
    <button type="button" class="cbtn ${other ? "sel" : ""}" data-cpick=""><span class="cicon cother-ic">✎</span><span>Other<small>type it</small></span></button>
    <input class="cother" ${inputAttrs} value="${esc(other ? value : "")}" placeholder="Bag, Box, Bottle…" ${other ? "" : "hidden"}>
  </div>`;
}

// Size to use after picking ``kind``: the preset's, unless a custom size was typed.
const jarSizeFor = (kind, currentQty) =>
  JARS[kind] && (!currentQty || PRESET_SIZES.has(currentQty.trim())) ? JARS[kind].size : currentQty;

// Shared click handling; returns true if it handled the click.
// onPick(container, qty) saves; "Other…" just reveals the text box.
function cpickClick(btn, qtyNow, onPick) {
  const k = btn.dataset.cpick, box = btn.closest(".cpick");
  if (k) { onPick(k, jarSizeFor(k, qtyNow)); return true; }
  box.querySelectorAll(".cbtn").forEach(b => b.classList.toggle("sel", b === btn));
  const inp = box.querySelector(".cother");
  inp.hidden = false; inp.focus();
  return true;
}
