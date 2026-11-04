// Object split demo. Plain ES modules, no build step. Every number comes from assets/data.json or parts/manifest.json.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const int = (n) => Math.round(n).toLocaleString('en-US');
const mb = (n) => `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} MB`;
const sizeOf = (n) => (n >= 1e6 ? mb(n) : `${Math.max(1, Math.round(n / 1e3))} KB`);
const mag = (v) => Math.hypot(v[0], v[1]);
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`could not load ${src}`)); i.src = src; });
const getJson = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); };
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') n.className = v; else if (k === 'html') n.innerHTML = v; else n.setAttribute(k, v); } n.append(...kids); return n; };
const svgEl = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

const [data, manifest] = await Promise.all([getJson('assets/data.json'), getJson('parts/manifest.json')]);
const em = data.eyeMetrics; // version -> eye -> metrics
const sharpPct = (v, e) => (100 * em[v][e].sharpness) / em[v][e].photoSharpness;
const faceRatio = data.modelInput.faceShareHead / data.modelInput.faceShareWhole;
window.__demo = { data, manifest };

/* ------------------------------------------------------------------ reveal + nav */
function initChrome() {
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), io.unobserve(e.target))), { rootMargin: '0px 0px -8% 0px' });
  $$('.rv').forEach((n) => io.observe(n));
  const links = new Map($$('#nav-links a').map((a) => [a.getAttribute('href').slice(1), a]));
  const spy = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { links.forEach((a) => a.classList.remove('on')); links.get(e.target.id)?.classList.add('on'); }
  }, { rootMargin: '-45% 0px -50% 0px' });
  links.forEach((_, id) => { const s = document.getElementById(id); if (s) spy.observe(s); });
}

/* ------------------------------------------------------------------ before / after slider (+ optional loupe) */
class Compare {
  constructor(root, { pos = 0.5 } = {}) {
    this.root = root; this.handle = $('.cmp-handle', root); this.pos = pos; this.onMove = null;
    let dragging = false;
    const move = (e) => { const r = root.getBoundingClientRect(); this.set((e.clientX - r.left) / r.width); };
    root.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dragging = true; root.setPointerCapture(e.pointerId); root.classList.add('touched'); move(e); });
    root.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    const stop = (e) => { dragging = false; if (root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId); };
    root.addEventListener('pointerup', stop); root.addEventListener('pointercancel', stop);
    this.handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') this.set(this.pos - step); else if (e.key === 'ArrowRight') this.set(this.pos + step);
      else if (e.key === 'Home') this.set(0.02); else if (e.key === 'End') this.set(0.98); else return;
      root.classList.add('touched'); e.preventDefault();
    });
    this.set(pos);
  }
  set(p) {
    this.pos = clamp(p, 0.02, 0.98);
    this.root.style.setProperty('--pos', `${(this.pos * 100).toFixed(2)}%`);
    this.handle.setAttribute('aria-valuenow', String(Math.round(this.pos * 100)));
    this.onMove?.(this.pos);
  }
}

// `natural` = [width, height] of the pictures when the box crops them (object-fit: cover); `position` = their object-position as fractions
function attachLens(cmp, { before, after, zoom = 2.2, natural = null, position = [0.5, 0.5] }) {
  const root = cmp.root, lens = $('.cmp-lens', root), lb = $('.lens-before', lens), la = $('.lens-after', lens), cut = $('.lens-cut', lens);
  lb.style.backgroundImage = `url(${before})`; la.style.backgroundImage = `url(${after})`;
  const hide = () => { lens.hidden = true; root.classList.remove('lens-on'); };
  root.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = root.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return hide();
    lens.hidden = false; root.classList.add('lens-on');
    const size = lens.offsetWidth || 176;
    lens.style.left = `${x - size / 2}px`; lens.style.top = `${y - size / 2}px`;
    // where the picture sits in the box: its cover scale k and its top-left corner (ox, oy), in box pixels
    let bw = r.width * zoom, bh = r.height * zoom, ox = 0, oy = 0;
    if (natural) { const k = Math.max(r.width / natural[0], r.height / natural[1]); bw = natural[0] * k * zoom; bh = natural[1] * k * zoom; ox = (r.width - natural[0] * k) * position[0]; oy = (r.height - natural[1] * k) * position[1]; }
    for (const layer of [la, lb]) { layer.style.backgroundSize = `${bw}px ${bh}px`; layer.style.backgroundPosition = `${size / 2 - (x - ox) * zoom}px ${size / 2 - (y - oy) * zoom}px`; }
    const edge = size / 2 + (cmp.pos * r.width - x) * zoom; // where the divider falls inside the loupe
    lb.style.clipPath = `inset(0 ${clamp(size - edge, 0, size)}px 0 0)`;
    cut.style.left = `${edge}px`; cut.style.display = edge > 0 && edge < size ? 'block' : 'none';
  });
  root.addEventListener('pointerleave', hide);
}

/* ------------------------------------------------------------------ hero */
async function initHero() {
  const place = (v) => [em[v].right.shiftPx, em[v].left.shiftPx];
  const [a, b] = place('one'), c = Math.max(...place('aligned')); // the worse of the two eyes
  $('#st-place').innerHTML = `${c.toFixed(1)} <small>px</small>`;
  $('#st-place-l').innerHTML = `where her eyes land, off the photo's. <s>One object: ${Math.round(Math.min(a, b))}–${Math.round(Math.max(a, b))} px.</s>`;
  $('#st-sharp').innerHTML = `${Math.round(sharpPct('eyes', 'right'))}% <small>·</small> ${Math.round(sharpPct('eyes', 'left'))}%`;
  $('#st-sharp-l').innerHTML = `of the photo's eye sharpness, right · left. <s>One object: ${Math.round(sharpPct('one', 'right'))}% · ${Math.round(sharpPct('one', 'left'))}%.</s>`;
  $('#st-face').innerHTML = `${faceRatio.toFixed(1)}<small>×</small>`;
  $('#st-face-l').textContent = "larger face in the 3D model's input, for the same budget of Gaussians.";
  $('#st-cost').innerHTML = `+$${data.cost.extraUsd.toFixed(3)}`;
  $('#st-cost-l').textContent = `for this person: one more 3D job ($${data.cost.idolJobUsd.toFixed(2)}) and ${data.split.sam.requests} SAM requests ($${data.cost.samUsd.toFixed(3)}).`;
  // the animated story above the numbers
  const { createHero } = await import('./hero.js');
  window.__demo.hero = await createHero({ data, Compare, attachLens, sharpPct });
}

/* ------------------------------------------------------------------ 01 split explorer */
async function initSplit() {
  const root = $('#explorer'), canvas = $('canvas', root), tip = $('.ex-tip', root), legend = $('#ex-legend'), note = $('#ex-note');
  const ctx = canvas.getContext('2d');
  const CROP = { x: 470, y: -40, w: 790, h: 800 }; // photo pixels shown (a margin above the photo lets the head lift out)
  const FW = data.photo.w, FH = data.photo.h, MW = 850, MH = 463;
  const A = data.masks;
  const PARTS = [ // order = who wins where masks overlap
    { id: 'ear', label: 'Ear', color: '#f7e86b', group: 'head', blurb: 'Goes with the head, and so does the pearl earring SAM did not find.' },
    { id: 'headband', label: 'Headband', color: '#ff5ea8', group: 'head', blurb: 'The pink bow.' },
    { id: 'hand', label: 'Hand', color: '#4cc2bb', group: 'body', blurb: 'On her cheek. Stays with the body, so it can sit in front of the jaw.' },
    { id: 'face', label: 'Face', color: '#ff8b78', group: 'head', blurb: 'Brows, eyes, nose, mouth.' },
    { id: 'neck', label: 'Neck', color: '#c792ea', group: 'head', blurb: "SAM's neck runs down into the V of the dress; the head keeps it down to the cut." },
    { id: 'hair', label: 'Hair', color: '#f2b85b', group: 'head', blurb: 'The curls, the largest part of the head.' },
    { id: 'arm-left', label: 'Arm, raised', color: '#63d49c', group: 'body', blurb: 'Up to the hand on her cheek.' },
    { id: 'arm-right', label: 'Arm, on the counter', color: '#a8e86b', group: 'body', blurb: 'Along the counter.' },
    { id: 'dress', label: 'Dress', color: '#5aa9ff', group: 'body', blurb: 'Collar, sleeves, brooch.' },
  ];
  const SPLIT = [
    { id: 'seam', label: 'Overlap at the neck', color: '#ffe066', blurb: 'In both masks, so the seam can not open.' },
    { id: 'jaw', label: 'Jaw behind the hand', color: '#ff5555', blurb: 'Filled with skin in the head only; the hand covers it from the photo.' },
    { id: 'head', label: 'Head', color: '#ff8b78', blurb: 'Hair, face, ear, headband, neck, pearl earring.' },
    { id: 'body', label: 'Body', color: '#4cc2bb', blurb: 'Torso, both arms, the hand in front of the jaw.' },
  ];
  const ids = [...PARTS.map((p) => p.id), 'head', 'body', 'seam', 'jaw'];
  const imgs = await Promise.all([loadImg('assets/img/full-photo.webp'), ...ids.map((id) => loadImg(`assets/img/masks/${id}.png`))]);
  const photo = imgs[0];
  const M = {};
  ids.forEach((id, i) => {
    const c = el('canvas'); c.width = MW; c.height = MH; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(imgs[i + 1], 0, 0, MW, MH);
    const px = g.getImageData(0, 0, MW, MH).data, alpha = new Uint8Array(MW * MH);
    for (let k = 0; k < alpha.length; k++) alpha[k] = px[k * 4];
    M[id] = { alpha, tints: new Map(), alphaCanvas: null };
  });
  const tintOf = (id, color) => { // the mask as a coloured, translucent layer
    const m = M[id]; if (m.tints.has(color)) return m.tints.get(color);
    const c = el('canvas'); c.width = MW; c.height = MH; const g = c.getContext('2d'); const out = g.createImageData(MW, MH);
    const r = parseInt(color.slice(1, 3), 16), gr = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
    for (let k = 0; k < m.alpha.length; k++) { out.data[k * 4] = r; out.data[k * 4 + 1] = gr; out.data[k * 4 + 2] = b; out.data[k * 4 + 3] = m.alpha[k]; }
    g.putImageData(out, 0, 0); m.tints.set(color, c); return c;
  };
  const alphaCanvas = (id) => { // white where the mask is, transparent elsewhere (for cutting the photo)
    const m = M[id]; if (m.alphaCanvas) return m.alphaCanvas;
    const c = el('canvas'); c.width = MW; c.height = MH; const g = c.getContext('2d'); const out = g.createImageData(MW, MH);
    for (let k = 0; k < m.alpha.length; k++) { out.data[k * 4] = out.data[k * 4 + 1] = out.data[k * 4 + 2] = 255; out.data[k * 4 + 3] = m.alpha[k]; }
    g.putImageData(out, 0, 0); return (m.alphaCanvas = c);
  };

  let mode = 'parts', hover = null, pull = 0, cuts = null, scale = 1;
  const NOTES = {
    parts: `SAM 3.1 returns a mask per part from a short prompt (“hair”, “face”, “neck”, “hand”…), about a quarter of a cent a request. ${data.split.sam.requests} requests found these nine parts.`,
    split: `Head: everything above the cut at the neckline that no body part claims, ${int(A.head.area)} px. Body: the rest of her mask, ${int(A.body.area)} px. They overlap by ${int(A.seam.area)} px, and ${int(data.split.leftOverPx)} px of her are left over.`,
    one: `The original: a single mask of ${int(A.whole.area)} px, one cutout, one 3D job. Everything the 3D model does, it does for the whole figure at once.`,
  };
  function legendItems() {
    if (mode === 'parts') return PARTS.map((p) => ({ ...p, area: A[p.id].area }));
    if (mode === 'split') return SPLIT.map((p) => ({ ...p, area: A[p.id].area }));
    return [{ id: 'whole', label: 'The whole figure', color: '#f5eeea', blurb: 'One mask, one cutout, one 3D model.', area: A.whole.area }];
  }
  function renderLegend() {
    legend.replaceChildren(...legendItems().map((p) => {
      const li = el('li', { 'data-id': p.id }, el('i', { style: `background:${p.color}` }), el('span', {}, p.label, el('small', {}, p.blurb)), el('em', {}, `${int(p.area)} px`));
      li.addEventListener('pointerenter', () => { hover = p.id; draw(); }); li.addEventListener('pointerleave', () => { hover = null; draw(); });
      return li;
    }));
    note.textContent = NOTES[mode];
    $('#ex-pull-wrap').hidden = mode !== 'split';
  }
  function resize() {
    const cssW = root.clientWidth, cssH = (cssW * CROP.h) / CROP.w, dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr); canvas.style.height = `${cssH}px`;
    scale = canvas.width / CROP.w; cuts = null;
  }
  const destRect = () => [(0 - CROP.x) * scale, (0 - CROP.y) * scale, FW * scale, FH * scale];
  function cutout(id, tint) {
    const c = el('canvas'); c.width = canvas.width; c.height = canvas.height; const g = c.getContext('2d'); const [dx, dy, dw, dh] = destRect();
    g.drawImage(photo, dx, dy, dw, dh);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(alphaCanvas(id), 0, 0, MW, MH, dx, dy, dw, dh);
    g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.2; g.fillStyle = tint; g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function draw() {
    const [dx, dy, dw, dh] = destRect();
    ctx.globalAlpha = 1; ctx.fillStyle = '#0b0809'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(photo, dx, dy, dw, dh);
    if (mode === 'split' && pull > 0.001) {
      ctx.fillStyle = `rgba(11,8,9,${0.82 * pull})`; ctx.fillRect(0, 0, canvas.width, canvas.height);
      cuts ??= { head: cutout('head', '#ff8b78'), body: cutout('body', '#4cc2bb') };
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 26 * scale * 0.7;
      ctx.drawImage(cuts.body, 0, pull * 0.075 * canvas.height); ctx.drawImage(cuts.head, 0, -pull * 0.045 * canvas.height);
      ctx.restore();
      return;
    }
    const layers = mode === 'parts' ? PARTS.map((p) => [p.id, p.color]) : mode === 'split' ? [['body', '#4cc2bb'], ['head', '#ff8b78'], ['seam', '#ffe066'], ['jaw', '#ff5555']] : [['head', '#f5eeea'], ['body', '#f5eeea']];
    const active = hover && (mode === 'one' ? ['head', 'body'] : [hover]);
    for (const [id, color] of layers) {
      const on = active ? active.includes(id) || (mode === 'one') : false;
      ctx.globalAlpha = active ? (on ? 0.72 : 0.16) : mode === 'one' ? 0.32 : id === 'seam' || id === 'jaw' ? 0.85 : 0.42;
      ctx.drawImage(tintOf(id, color), 0, 0, MW, MH, dx, dy, dw, dh);
    }
    ctx.globalAlpha = 1;
  }
  function partAt(px, py) {
    const mx = Math.floor(px / 2), my = Math.floor(py / 2); if (mx < 0 || my < 0 || mx >= MW || my >= MH) return null;
    const i = my * MW + mx, on = (id) => M[id].alpha[i] > 127;
    if (mode === 'parts') return PARTS.find((p) => on(p.id)) ?? null;
    if (mode === 'split') return SPLIT.find((p) => on(p.id)) ?? null;
    return on('head') || on('body') ? { id: 'whole', label: 'The whole figure', blurb: 'One mask, one 3D model.' } : null;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (mode === 'split' && pull > 0.001) { tip.hidden = true; return; }
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const part = partAt(CROP.x + (x / r.width) * CROP.w, CROP.y + (y / r.height) * CROP.h);
    const id = part?.id ?? null; if (id !== hover) { hover = id; draw(); legend.querySelectorAll('li').forEach((li) => li.classList.toggle('on', li.dataset.id === id)); }
    if (!part) { tip.hidden = true; return; }
    tip.hidden = false; tip.replaceChildren(el('span', {}, part.label), el('small', {}, part.blurb)); tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    if (x > r.width * 0.62) tip.style.transform = 'translate(calc(-100% - 14px), 14px)'; else tip.style.transform = 'translate(14px, 14px)';
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; legend.querySelectorAll('li').forEach((li) => li.classList.remove('on')); draw(); });
  $$('#ex-mode button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.mode; hover = null; tip.hidden = true;
    $$('#ex-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    if (mode !== 'split') { pull = 0; $('#ex-pull').value = '0'; }
    renderLegend(); draw();
  }));
  $('#ex-pull').addEventListener('input', (e) => { pull = Number(e.target.value) / 100; draw(); });
  new ResizeObserver(() => { resize(); draw(); }).observe(root);
  resize(); renderLegend(); draw();
  window.__demo.explorer = { setMode: (m) => $(`#ex-mode [data-mode=${m}]`).click(), setPull: (v) => { $('#ex-pull').value = String(v); pull = v / 100; draw(); }, crop: CROP };

  // what the 3D model receives
  const mi = data.modelInput, pct = (v) => `${Math.round(v * 100)}%`;
  $('#cap-one').textContent = `Her face is ${pct(mi.faceShareWhole)} of the width. ${int(data.gaussians.oneObject)} Gaussians.`;
  $('#cap-head').textContent = `Her face is ${pct(mi.faceShareHead)} of the width. ${int(data.gaussians.head)} Gaussians.`;
  $('#cap-body').textContent = `Torso, arms and the hand in front of her jaw. ${int(data.gaussians.body)} Gaussians.`;
  $('#share-whole').textContent = pct(mi.faceShareWhole);
  $('#share-head').textContent = pct(mi.faceShareHead);
  $('#share-head-l').textContent = `of the width is her face, as a head alone: ${faceRatio.toFixed(1)}× larger`;
  const t = data.test1m, g = data.gaussians;
  $('#seam-note').textContent = ` in a band up to ${data.seamBandPx} px tall`;
  $('#split-aside').textContent = `We tried the obvious fix first: ${t.gaussians / g.oneObject} times the Gaussians (${int(t.gaussians)} instead of ${int(g.oneObject)}) for the whole figure. The eyes stayed smeared. Looking closer worked; spending more did not. The split adds one 3D job and the SAM calls: $${data.cost.splitUsd.toFixed(3)} in all, against $${data.cost.oneObjectUsd.toFixed(2)} for one object.`;
  $('#t1m-a').textContent = `${int(g.oneObject)} Gaussians`;
  $('#t1m-b').textContent = `${int(t.gaussians)} Gaussians`;
  $('#test1m-cap').textContent = `The right eye at 6×, rendered from the photo's own camera. The test cost $${t.usd.toFixed(2)} and its file was ${mb(t.plyBytes)}. The ledger entry is in the saved parts.`;
}

/* ------------------------------------------------------------------ 02 placement */
function initPlace() {
  const cmp = new Compare($('#place-cmp'));
  const render = $('#place-render'), edges = $('#place-edges-img'), tag = $('#place-tag'), svg = $('#place-svg'), tbody = $('#place-table tbody');
  const NAME = { one: 'One object', fit: 'Split · silhouette fit', aligned: 'Split · pixel-aligned' };
  let method = 'aligned', active = null;
  ['one', 'fit', 'aligned'].forEach((m) => { new Image().src = `assets/img/full-${m}.webp`; });
  const tone = (px) => (px < 2 ? 'good' : px < 10 ? 'mid' : 'bad');
  const COLOR = { good: '#63d49c', mid: '#f2b85b', bad: '#ff6b6b' };
  function markers() {
    svg.replaceChildren();
    for (const f of data.features) {
      const s = f.shift[method], m = mag(s), c = COLOR[tone(m)], g = svgEl('g', { class: f.id === active ? 'on' : '' });
      if (m >= 1) g.append(svgEl('line', { x1: f.x, y1: f.y, x2: f.x + s[0], y2: f.y + s[1], stroke: c }), svgEl('circle', { class: 'dot', cx: f.x + s[0], cy: f.y + s[1], r: 5, fill: c }));
      g.append(svgEl('circle', { class: 'ring', cx: f.x, cy: f.y, r: f.id === active ? 20 : 13, stroke: c, 'stroke-opacity': f.id === active ? 1 : 0.85 }));
      svg.append(g);
    }
  }
  function table() {
    tbody.replaceChildren(...data.features.map((f) => {
      const tr = el('tr', { 'data-id': f.id, class: f.id === active ? 'on' : '' }, el('td', {}, f.label));
      for (const m of ['one', 'fit', 'aligned']) {
        const v = mag(f.shift[m]), t = tone(v);
        tr.append(el('td', { class: `num ${t} ${m === method ? 'sel' : ''}` }, `${v < 10 ? v.toFixed(1) : Math.round(v)} px`, el('span', { class: `bar ${t}`, style: `width:${Math.max(2, (Math.min(v, 40) / 40) * 44)}px` })));
      }
      tr.addEventListener('pointerenter', () => { active = f.id; markers(); table(); }); tr.addEventListener('pointerleave', () => { active = null; markers(); table(); });
      return tr;
    }));
  }
  function setMethod(m) {
    method = m; render.src = `assets/img/full-${m}.webp`; tag.textContent = NAME[m];
    $$('#place-method button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === m)));
    markers(); table();
  }
  $$('#place-method button').forEach((b) => b.addEventListener('click', () => setMethod(b.dataset.m)));
  $('#place-edges').addEventListener('change', (e) => { edges.style.display = e.target.checked ? '' : 'none'; });
  $('#iou-fit').textContent = data.placement.fit.silhouetteIoU.toFixed(3);
  $('#iou-aligned').textContent = data.placement.aligned.silhouetteIoU.toFixed(3);
  const h = data.alignment.head, b = data.alignment.body;
  $('#place-note').innerHTML = `Moving a Gaussian sideways in the photo's view leaves its depth alone. The median Gaussian moved <b>${h.p50Mm.toFixed(1)} mm</b> in the head and <b>${b.p50Mm.toFixed(1)} mm</b> in the body; the farthest moved ${Math.max(h.maxMm, b.maxMm).toFixed(1)} mm.`;
  setMethod('aligned');
  window.__demo.place = { setMethod, get method() { return method; } };
}

/* ------------------------------------------------------------------ 03 eyes */
function initEyes() {
  const lab = $('#eyelab'), WIN = data.photo.eyeWindow, SHOW = { w: 150, h: 96 };
  const VARS = [['photo', 'Photo', 'Ground truth.'], ['one', 'One object', ''], ['aligned', 'Split', ''], ['eyes', 'Split + eye corrector', '']];
  let align = true;
  const rows = [];
  for (const e of data.eyes) {
    const head = el('div', { class: 'eye-row-head' }, el('b', {}, e.name), el('span', {}, `${WIN.w}×${WIN.h} photo pixels around the eye, shown ${WIN.zoom}× sharper`));
    const row = el('div', { class: 'eye-row' });
    const tiles = VARS.map(([v, label]) => {
      const m = em[v]?.[e.id];
      const img = el('img', { src: `assets/img/eye-${e.id}-${v}.webp`, alt: `${e.name}, ${label}`, loading: 'lazy', width: WIN.w * WIN.zoom, height: WIN.h * WIN.zoom });
      Object.assign(img.style, { width: `${(WIN.w / SHOW.w) * 100}%`, left: `${(-(WIN.w - SHOW.w) / 2 / SHOW.w) * 100}%`, top: `${(-(WIN.h - SHOW.h) / 2 / SHOW.h) * 100}%`, height: 'auto' });
      const lens = el('div', { class: 'tile-lens', hidden: '' });
      const box = el('div', { class: 'tile-img' }, img, lens);
      const cap = el('div', { class: 'cap' }, el('b', {}, label));
      if (m) cap.append(el('div', { class: 'kv' }, el('span', {}, 'lands'), el('b', {}, `${m.shiftPx < 1 ? m.shiftPx.toFixed(2) : m.shiftPx.toFixed(1)} px off`), el('span', {}, 'sharpness'), el('b', {}, `${Math.round(sharpPct(v, e.id))}% of the photo's`)));
      else cap.append(el('div', { class: 'kv' }, el('span', {}, 'lands'), el('b', {}, 'where it is'), el('span', {}, 'sharpness'), el('b', {}, '100%')));
      const tile = el('div', { class: `tile ${v === 'eyes' ? 'hero-tile' : ''}` }, box, cap);
      return { v, img, lens, box, m };
    });
    tiles.forEach((t) => row.append(t.box.parentElement));
    lab.append(head, row); rows.push(tiles);
  }
  const shiftOf = (t) => (align && t.m ? t.m.shift : [0, 0]);
  function applyAlign() {
    for (const tiles of rows) for (const t of tiles) { const [dx, dy] = shiftOf(t); t.img.style.transform = `translate(${(-dx / WIN.w) * 100}%, ${(-dy / WIN.h) * 100}%)`; }
  }
  $('#eye-align').addEventListener('change', (e) => { align = e.target.checked; applyAlign(); });
  applyAlign();
  const ZOOM = 2.3;
  for (const tiles of rows) for (const src of tiles) {
    src.box.addEventListener('pointermove', (ev) => {
      if (ev.pointerType === 'touch') return;
      const r = src.box.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top, s = r.width / SHOW.w;
      for (const t of tiles) {
        const [dx, dy] = shiftOf(t), left = -((WIN.w - SHOW.w) / 2) * s - dx * s, top = -((WIN.h - SHOW.h) / 2) * s - dy * s, L = t.lens.offsetWidth || 96;
        t.lens.hidden = false; t.lens.style.left = `${x - L / 2}px`; t.lens.style.top = `${y - L / 2}px`;
        t.lens.style.backgroundImage = `url(${t.img.src})`; t.lens.style.backgroundSize = `${WIN.w * s * ZOOM}px ${WIN.h * s * ZOOM}px`;
        t.lens.style.backgroundPosition = `${L / 2 - (x - left) * ZOOM}px ${L / 2 - (y - top) * ZOOM}px`;
      }
    });
    src.box.addEventListener('pointerleave', () => tiles.forEach((t) => { t.lens.hidden = true; }));
  }
  const st = data.eyeCorrector.seeThrough, ec = data.eyeCorrector;
  const HEAD_FEATURES = ['right-eye', 'left-eye', 'right-brow', 'left-brow', 'mouth', 'nose', 'pearl'];
  const worstHead = Math.max(...data.features.filter((f) => HEAD_FEATURES.includes(f.id)).map((f) => mag(f.shift.aligned)));
  $('#head-within').textContent = `${worstHead.toFixed(2)} px`;
  $('#outside-lead').textContent = `Everywhere else the picture is left alone: no pixel of it changes by more than ${ec.outside.maxChange} in 255.`;
  $('#corr-facts').replaceChildren(
    el('div', { class: 'fact' }, el('span', { class: 'n' }, `${st.right.before}% → ${st.right.after}%`), el('b', {}, 'See-through, right eye'), el('span', {}, `The share of each pixel that was the wall behind her. Left eye: ${st.left.before}% → ${st.left.after}%.`)),
    el('div', { class: 'fact' }, el('span', { class: 'n' }, int(ec.addedGaussians)), el('b', {}, 'Gaussians added'), el('span', {}, `One per photo pixel, laid ${ec.offsetMm} mm in front of the eye surface, so they sit on it instead of in it.`)),
    el('div', { class: 'fact' }, el('span', { class: 'n' }, int(ec.refitGaussians)), el('b', {}, 'Gaussians refitted'), el('span', {}, `Each one that shows in an eye gets the colour that best reproduces the photo. Checked over the whole picture, outside the eye regions and their ${ec.outside.featherPx} px fade (${int(ec.outside.pixels)} pixels), none changes by more than ${ec.outside.maxChange} in 255.`)),
  );
}

/* ------------------------------------------------------------------ numbers */
function initNumbers() {
  const rows = [['one', 'One object', 'The pipeline as it was'], ['fit', 'Split, silhouette fit', 'Head and body, placed by the pipeline\'s fitter'], ['aligned', 'Split, pixel-aligned', 'Placed to the photo\'s pixels'], ['eyes', 'Split + eye corrector', 'The photo\'s eyes baked in']];
  const t = $('#ntable');
  const px = (v) => (v < 1 ? v.toFixed(2) : v.toFixed(1)); // a 0.04 px shift should not read as 0.0
  t.replaceChildren(
    el('thead', {}, el('tr', {}, ...['Version', 'Eyes land (px off the photo\'s)', 'Eye sharpness (% of the photo\'s)', 'Eye detail match (0–1)', 'Colour error inside her outline (of 255)'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map(([v, name, sub]) => {
      const R = em[v].right, L = em[v].left, fe = data.figureError?.[v];
      const sharp = (m) => Math.round((100 * m.sharpness) / m.photoSharpness);
      return el('tr', { class: v === 'eyes' ? 'final' : '' },
        el('td', {}, el('b', {}, name), el('div', { class: 'dim', style: 'font-size:13px' }, sub)),
        el('td', { class: 'v' }, `${px(R.shiftPx)} / ${px(L.shiftPx)}`, el('small', {}, 'right / left')),
        el('td', { class: 'v' }, el('span', { class: `mini ${v === 'eyes' ? '' : 'dim'}`, style: `width:${Math.max(3, sharp(R) * 0.7)}px` }), `${sharp(R)}% / ${sharp(L)}%`, el('small', {}, 'right / left')),
        el('td', { class: 'v' }, `${R.detailMatch.toFixed(2)} / ${L.detailMatch.toFixed(2)}`, el('small', {}, 'right / left')),
        el('td', { class: 'v' }, fe == null ? '–' : fe.toFixed(1)));
    })));
  // the Placement table and this one both report where the right eye lands, with different instruments; say so
  const winShift = mag(data.features.find((f) => f.id === 'right-eye').shift.aligned), detailShift = em.aligned.right.shiftPx;
  $('#num-reconcile').textContent = `Two instruments, so two figures for the same eye: the Placement table above measures a window around each feature (right eye, ${winShift.toFixed(2)} px), this table measures the fine detail inside the eye itself (${detailShift.toFixed(2)} px).${Math.max(winShift, detailShift) < 1 ? ' Both are under a pixel.' : ''}`;
}

/* ------------------------------------------------------------------ saved parts */
async function initParts() {
  const files = manifest.files, total = files.reduce((a, f) => a + f.bytes, 0), root = $('#parts-groups');
  const by = (p) => files.filter((f) => f.file.startsWith(p));
  const link = (f) => `parts/${f.file}`;
  // A host may leave out the full-quality PLY originals (about 100 MB). Probe once; if they aren't served, list them without dead links.
  const ply = by('splats/ply/'), plyBytes = ply.reduce((a, f) => a + f.bytes, 0);
  const sf = data.spzFidelity.photocam; // measured by tools/spz-fidelity.mjs
  const spzNote = `from the photo's camera a render differs from the PLY's by ${sf.all.mean} in 255 on average and ${sf.eyes.mean} inside the eyes, and the worst pixel by ${sf.all.max}`;
  const plyServed = ply.length > 0 && (await fetch(link(ply[0]), { method: 'HEAD' }).then(async (r) => { await r.arrayBuffer().catch(() => {}); return r.ok; }, () => false));
  $('#parts-sub').innerHTML = `Everything the split produced is in <code>parts/</code>: the masks, the cutouts the 3D model received, the 3D parts, the poses, the measurements and the ledger lines. ${files.length} files, ${mb(total)}, listed with checksums in <a href="parts/manifest.json">manifest.json</a>.${plyServed ? '' : ` This copy of the page leaves out the ${ply.length} full-quality PLY files (${mb(plyBytes)}); their sizes and checksums are in the manifest.`}`;
  const thumbs = (list, maskLike, web) => el('div', { class: 'parts-grid' }, ...list.map((f) => {
    const name = f.file.split('/').pop().replace(/\.\w+$/, '');
    const src = web?.(f) ?? link(f);
    return el('a', { class: 'pcard', href: link(f), title: f.what, download: '' }, el('div', { class: 'th' }, el('img', { src, alt: name, loading: 'lazy' })), el('b', {}, name), el('span', {}, sizeOf(f.bytes)));
  }));
  const table = (list, hrefOf = link) => el('table', { class: 'ptable' }, el('tbody', {}, ...list.map((f) => {
    const href = hrefOf(f), name = f.file.split('/').slice(-1)[0];
    return el('tr', {}, el('td', {}, href ? el('a', { href, download: '' }, name) : el('span', { class: 'nolink' }, name)), el('td', {}, f.what), el('td', { class: 'sz' }, sizeOf(f.bytes)));
  })));
  const group = (title, blurb, ...kids) => el('div', { class: 'pgroup' }, el('h3', {}, title), el('p', {}, blurb), ...kids);
  const spz = Object.entries(data.bytes.spz).map(([k, b]) => ({ file: `assets/splats/${k}.spz`, bytes: b, what: { 'one-object': 'The whole figure, web format.', head: 'The head, aligned, web format.', 'head-eyes': 'The head with the eye corrector, web format.', body: 'The body, aligned, web format.' }[k] ?? '' }));
  root.append(
    group('The nine parts SAM found', 'One mask per part, full photo size.', thumbs(by('sam-parts/'), true, (f) => `assets/img/thumbs/${f.file.split('/').pop().replace('.png', '.webp')}`)),
    group('The split', 'The head and body masks the placement is fitted to, the overlap and jaw patch, and what the 3D model received for each.', thumbs(by('split/').filter((f) => /mask|band|fill/.test(f.file)), true, (f) => `assets/img/thumbs/${f.file.split('/').pop().replace('.png', '.webp')}`), el('div', { style: 'height:12px' }), thumbs([...by('split/').filter((f) => /cutout\.png/.test(f.file)), ...by('one-object/').filter((f) => /cutout/.test(f.file))], false, (f) => `assets/img/cutout-${f.file.includes('head') ? 'head' : f.file.includes('body') ? 'body' : 'one'}.webp`)),
    group('The 3D parts', `Full-quality PLY from the 3D model, before and after alignment, and the smaller web files this page loads (SPZ is lossy: ${spzNote}).`, table(ply, plyServed ? link : () => null), el('div', { style: 'height:10px' }), table(spz, (f) => f.file)),
    group('Placement and measurements', 'Poses, the fit, and the raw feature measurements behind the numbers above.', table(by('placement/'))),
    group('Cost and tests', 'The ledger lines behind every dollar figure, and the picture from the more-Gaussians test.', table([...by('cost/'), ...by('tests/')])),
    group('The photo', 'The original.', table(by('photo/'))),
  );
}

/* ------------------------------------------------------------------ limits */
function initLimits() {
  const h = data.alignment.head, b = data.alignment.body, g = data.sideGaps;
  $('#lim-wedge').textContent = g
    ? `From the side, a thin see-through wedge can open between the hand and the neck. In a test view ${g.angle}° around, the split has ${int(g.split)} see-through pixels inside her outline against ${int(g.one)} for one object (of ${int(g.of)}). Nothing shows near the photo's view.`
    : "From the side, a thin see-through wedge can open between the hand and the neck. Nothing shows near the photo's view.";
  $('#lim-bend').textContent = `To match the photo, Gaussians were moved sideways in its view: ${h.p50Mm.toFixed(1)} mm in the head and ${b.p50Mm.toFixed(1)} mm in the body at the median, ${Math.max(h.maxMm, b.maxMm).toFixed(1)} mm at the farthest. Depth is untouched, but the head is slightly bent in 3D.`;
}

/* ------------------------------------------------------------------ 04 live 3D */
function initViewer() {
  const root = $('#viewer-root'), stage = $('#v-stage'), bar = $('#v-load-bar'), text = $('#v-load-t');
  const total = Object.values(data.bytes.spz).reduce((a, b) => a + b, 0);
  let started = false;
  const io = new IntersectionObserver(async (es) => { if (es.some((e) => e.isIntersecting) && !started) { started = true; io.disconnect(); await start(); } }, { rootMargin: '700px 0px' });
  io.observe(root);
  async function start() {
    text.textContent = `Loading ${mb(total)} of 3D parts…`;
    try {
      const { createViewer } = await import('./viewer.js');
      const api = await createViewer(stage, data, { onProgress: (f) => { bar.style.width = `${Math.round(f * 100)}%`; text.textContent = `Loading ${mb(total)} of 3D parts… ${Math.round(f * 100)}%`; } });
      wire(api);
      window.__demo.viewer = api;
    } catch (err) {
      console.error(err);
      $('#v-load').replaceChildren(el('b', {}, '3D needs WebGL 2'), el('div', { class: 'muted', style: 'font-size:13.5px;margin-top:6px' }, 'This browser could not start it. The pictures above are renders of the same scene.'));
    }
  }
  function wire(api) {
    $('#v-controls').hidden = false; $('#v-note').hidden = false;
    const g = data.gaussians, spz = data.bytes.spz;
    $('#v-note').textContent = `The split is two parts of ${int(g.head)} Gaussians (the head with the eye corrector has ${int(g.headEyes)}) against ${int(g.oneObject)} for one object: twice the splats for the person, ${mb(spz.head + spz.body)} in the web format. Orbit is limited to ±85° so you stay in front of her.`;
    const setPressed = (sel, attr, val) => $$(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === val)));
    const setMode = (m) => { api.setMode(m); setPressed('#v-mode button', 'mode', m); };
    $$('#v-mode button').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.mode); if (b.dataset.mode !== 'split' && api.state().explode > 0) { api.setExplode(0); $('#v-explode').value = '0'; } }));
    $('#v-eyes').addEventListener('change', (e) => api.setEyes(e.target.checked));
    $('#v-explode').addEventListener('input', (e) => { const v = Number(e.target.value) / 100; if (v > 0 && api.state().mode !== 'split') setMode('split'); api.setExplode(v); });
    $$('#v-view button').forEach((b) => b.addEventListener('click', () => { api.view(b.dataset.view); setPressed('#v-view button', 'view', b.dataset.view); }));
    api.on('userMove', () => setPressed('#v-view button', 'view', ''));
    setPressed('#v-view button', 'view', 'face');
  }
}

/* ------------------------------------------------------------------ go */
const steps = [['chrome', initChrome], ['hero', initHero], ['split', initSplit], ['place', initPlace], ['eyes', initEyes], ['numbers', initNumbers], ['parts', initParts], ['limits', initLimits], ['viewer', initViewer]];
for (const [name, fn] of steps) {
  try { await fn(); } catch (err) { console.error(`[demo] ${name} failed:`, err); }
}
window.__demo.ready = true;
