/*
  nobg.lol app. Runs entirely in your browser.
  worker.js runs the AI model on a background thread and sends back a
  see-through PNG. This file shows it, puts it on a color if you ask, and
  saves it to your disk. Nothing here sends your photo anywhere.
*/
import { encodePNG } from './png.js';

const lol = window.lol;
const $ = (id) => document.getElementById(id);

const MODEL = 'isnet_fp16';
const MAX_BYTES = 80 * 1024 * 1024;   // a photo file this big is almost certainly a mistake
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const statusEl = $('status');
const progress = $('progress');
const viewer = $('viewer');
const stage = $('stage');
const beforeImg = $('beforeImg');
const afterImg = $('afterImg');
const compare = $('compare');
const caption = $('caption');
const saveBtn = $('saveBtn');
const saveLabel = $('saveLabel');
const list = $('list');
const zipBtn = $('zipBtn');
const bgColor = $('bgColor');

const items = [];
let current = null;
let seq = 0;
let busy = false;
let modelReady = false;
let modelTotal = 0;
const timings = { modelMs: null, runs: [] };
window.__nobg = timings; // read by the test suite

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
let worker = null;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/worker.js', { type: 'module' });
  worker.onmessage = (ev) => onWorker(ev.data);
  worker.onerror = (ev) => {
    ev.preventDefault && ev.preventDefault();
    failAll('model', String(ev.message || 'worker failed'));
  };
  return worker;
}

function failAll(code, message) {
  for (const [, w] of waiting) w.reject(Object.assign(new Error(message), { code }));
  waiting.clear();
  if (worker) { worker.terminate(); worker = null; }
  modelReady = false;
}

function onWorker(m) {
  if (m.type === 'model-start') {
    modelTotal = m.total || modelTotal;
    if (!modelReady) {
      lol.setStatus(statusEl, `Loading the AI model (${lol.formatBytes(modelTotal)}). It's only a big download the first time.`);
      lol.setProgress(progress, 0);
    }
  } else if (m.type === 'fetch') {
    if (!modelReady && modelTotal) {
      const frac = Math.min(1, m.sum / modelTotal);
      lol.setStatus(statusEl, `Loading the AI model: ${lol.formatBytes(m.sum)} of ${lol.formatBytes(modelTotal)}. It's only a big download the first time.`);
      lol.setProgress(progress, frac * 0.9);
    }
  } else if (m.type === 'model-ready') {
    modelReady = true;
    timings.modelMs = m.ms;
    timings.threads = m.threads;
    timings.isolated = m.isolated;
    lol.setProgress(progress, 0.92);
  } else if (m.type === 'stage') {
    const w = waiting.get(m.id);
    if (w && w.onStage) w.onStage(m.stage);
  } else if (m.type === 'done') {
    const w = waiting.get(m.id);
    if (w) { waiting.delete(m.id); w.resolve(m); }
  } else if (m.type === 'error') {
    const w = waiting.get(m.id);
    const err = Object.assign(new Error(m.message), { code: m.code });
    if (w) { waiting.delete(m.id); w.reject(err); }
    else failAll(m.code, m.message);
  } else if (m.type === 'probe') {
    const w = waiting.get('probe' + m.id);
    if (w) { waiting.delete('probe' + m.id); w.resolve(m); }
  } else if (m.type === 'net') {
    const w = waiting.get('net' + m.id);
    if (w) { waiting.delete('net' + m.id); w.resolve(m.list); }
  }
}

function cutOut(file, id, onStage) {
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onStage });
    getWorker().postMessage({ type: 'run', id, model: MODEL, file });
  });
}

// For the test suite: can the worker reach another site? (It can't.)
window.__nobgProbe = (url) => new Promise((resolve) => {
  const id = ++seq;
  waiting.set('probe' + id, { resolve, reject: resolve });
  getWorker().postMessage({ type: 'probe', id, url });
});
window.__nobgNet = () => new Promise((resolve) => {
  const id = ++seq;
  waiting.set('net' + id, { resolve, reject: resolve });
  getWorker().postMessage({ type: 'net', id });
});

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const brand = String.fromCharCode(...b.slice(8, 12));
  if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'heic';
  if (/^(avif|avis)$/.test(brand)) return 'avif';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  return null;
}

async function checkFile(file) {
  if (!file.size) return 'This file is empty.';
  if (file.size > MAX_BYTES) return `This file is ${lol.formatBytes(file.size)}. nobg.lol takes photos up to ${lol.formatBytes(MAX_BYTES)}.`;
  const kind = await sniff(file);
  if (TYPES.includes(kind)) return null;
  if (kind === 'heic' || /\.(heic|heif)$/i.test(file.name)) return 'This is an iPhone HEIC photo. Turn it into a JPG with heic.lol first, then drop the JPG here.';
  if (kind === 'pdf') return "This is a PDF, not a photo. nobg.lol takes JPG, PNG or WebP images.";
  return "This isn't a JPG, PNG or WebP photo, so nobg.lol can't open it.";
}

function friendly(e) {
  const code = e && e.code;
  if (code === 'decode') return "Your browser couldn't read this image. It may be damaged.";
  if (code === 'memory') return 'Your browser ran out of memory. Try a smaller photo, close other tabs, or use a computer.';
  if (code === 'model') return "The AI model didn't load. Check your connection and reload the page to try again.";
  return 'Something went wrong cutting out this photo. Try another one, or reload the page.';
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const bgMode = () => document.querySelector('input[name="bg"]:checked').value;
const fmt = () => (bgMode() === 'none' ? 'png' : document.querySelector('input[name="fmt"]:checked').value);
const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));

async function flatten(item, color) {
  // Put the cutout on a solid color: paint the color, then draw the cutout over it.
  const bmp = await createImageBitmap(item.png, { colorSpaceConversion: 'none' });
  const c = document.createElement('canvas');
  c.width = item.w; c.height = item.h;
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, item.w, item.h);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { c, ctx };
}

async function render(item, kind, color) {
  if (kind === 'png-alpha') return item.png;
  const { c, ctx } = await flatten(item, color);
  try {
    if (kind === 'png') return await encodePNG(ctx.getImageData(0, 0, item.w, item.h).data, item.w, item.h, 3);
    const blob = await toBlob(c, 'image/jpeg', 0.92);
    if (!blob) throw Object.assign(new Error('jpeg'), { code: 'memory' });
    return blob;
  } finally {
    c.width = c.height = 1;
  }
}

function outName(item) {
  const base = lol.baseName(item.file.name);
  if (bgMode() === 'none') return `${base}-nobg.png`;
  return `${base}-${bgColor.value.slice(1)}.${fmt()}`;
}

async function save(item) {
  const kind = bgMode() === 'none' ? 'png-alpha' : fmt();
  const blob = await render(item, kind, bgColor.value);
  lol.download(blob, outName(item));
  return blob;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function syncControls() {
  const solid = bgMode() === 'color';
  $('colorField').hidden = !solid;
  $('fmtField').style.opacity = solid ? '' : '0.4';
  document.querySelectorAll('input[name="fmt"]').forEach((r) => { r.disabled = !solid; });
  $('fmtHint').hidden = solid;
  saveLabel.textContent = `Download ${fmt().toUpperCase()}`;
  stage.style.setProperty('--nb-bg', solid ? bgColor.value : '');
  stage.classList.toggle('solid', solid);
  document.querySelectorAll('.nb-swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.c === bgColor.value.toLowerCase())));
}
document.querySelectorAll('input[name="bg"], input[name="fmt"]').forEach((r) => r.addEventListener('change', syncControls));
bgColor.addEventListener('input', syncControls);
document.querySelectorAll('.nb-swatch').forEach((s) => s.addEventListener('click', () => {
  bgColor.value = s.dataset.c;
  syncControls();
}));
syncControls();

function setCompare() {
  stage.style.setProperty('--nb-split', compare.value + '%');
}
compare.addEventListener('input', setCompare);
setCompare();

function show(item) {
  current = item;
  for (const it of items) if (it.ui) it.ui.row.classList.toggle('active', it === item);
  if (!item || !item.png) { viewer.hidden = true; saveBtn.disabled = true; return; }
  viewer.hidden = false;
  stage.style.aspectRatio = `${item.w} / ${item.h}`;
  beforeImg.src = item.srcUrl;
  afterImg.src = item.outUrl;
  const bits = [`${item.w}×${item.h}`];
  if (item.scaled) bits.push(`scaled down from ${item.ow}×${item.oh} so your browser can cope`);
  bits.push(`cut out in ${(item.cutMs / 1000).toFixed(1)} s`);
  caption.textContent = bits.join(' · ');
  saveBtn.disabled = false;
}

function rowFor(item) {
  const thumb = lol.el('img', { class: 'fr-thumb', alt: '' });
  const name = lol.el('span', { class: 'fr-name', text: item.file.name });
  const meta = lol.el('span', { class: 'fr-meta', text: 'Waiting…' });
  const actions = lol.el('span', { class: 'fr-actions' });
  const main = lol.el('span', { class: 'fr-main' }, [name, meta]);
  const row = lol.el('li', { class: 'file-row' }, [thumb, main, actions]);
  item.ui = { row, thumb, name, meta, actions };
  return row;
}

function refresh() {
  const done = items.filter((x) => x.png);
  const multi = items.length > 1;
  list.hidden = !multi;
  zipBtn.hidden = !multi;
  zipBtn.disabled = busy || done.length < 2;
  $('clearBtn').disabled = busy;
  $('dzTitle').textContent = items.length ? 'Drop another photo, or click to pick' : 'Drop a photo here, or click to pick one';
}

async function addFiles(files) {
  if (typeof OffscreenCanvas === 'undefined' || typeof CompressionStream === 'undefined' || typeof WebAssembly === 'undefined') {
    lol.setStatus(statusEl, "Your browser is too old for nobg.lol. Update it, or use a current Chrome, Edge, Firefox or Safari.", 'err');
    return;
  }
  // A new pick starts fresh, unless a batch is still running (then it joins the queue).
  if (!busy) clearAll();
  for (const file of files) {
    const item = { id: ++seq, file, png: null, error: null };
    items.push(item);
    list.append(rowFor(item));
  }
  refresh();
  if (!busy) runQueue();
}

async function runQueue() {
  busy = true;
  refresh();
  let next;
  while ((next = items.find((x) => !x.png && !x.error && !x.started))) {
    await runOne(next);
  }
  busy = false;
  lol.setProgress(progress, null);
  const ok = items.filter((x) => x.png).length;
  const bad = items.filter((x) => x.error).length;
  if (items.length > 1) {
    lol.setStatus(statusEl, `${ok} cut out${bad ? `, ${bad} couldn't be done` : ''}.${ok ? ' Pick one in the list to preview it.' : ''}`, ok ? 'ok' : 'err');
  } else if (ok && items[0].warn) {
    lol.setStatus(statusEl, items[0].warn, 'err');
  } else if (ok) {
    lol.setStatus(statusEl, 'Done. Slide across the picture to compare.', 'ok');
  }
  refresh();
}

async function runOne(item) {
  item.started = true;
  const many = items.length > 1;
  const idx = items.indexOf(item) + 1;
  const label = many ? ` (${idx} of ${items.length})` : '';
  item.ui.meta.textContent = 'Working…';
  const problem = await checkFile(item.file);
  if (problem) {
    item.error = problem;
    item.ui.meta.textContent = problem;
    item.ui.meta.classList.add('err');
    if (!many || items.every((x) => x.error)) { lol.setStatus(statusEl, problem, 'err'); lol.setProgress(progress, null); }
    if (!many) viewer.hidden = true;
    return;
  }
  item.srcUrl = URL.createObjectURL(item.file);
  item.ui.thumb.src = item.srcUrl;
  if (modelReady) {
    lol.setStatus(statusEl, `Cutting out ${item.file.name}${label}…`);
    lol.setProgress(progress, 0.3);
  } else {
    lol.setStatus(statusEl, 'Getting the AI model ready…');
    lol.setProgress(progress, 0.02);
  }
  const t0 = performance.now();
  try {
    const r = await cutOut(item.file, item.id, (st) => {
      if (st === 'cut') {
        lol.setStatus(statusEl, `Cutting out ${item.file.name}${label}. This takes a few seconds…`);
        lol.setProgress(progress, 0.95);
      } else if (st === 'edges') {
        lol.setStatus(statusEl, `The subject runs off the edge of the photo, so the AI is taking a second look${label}…`);
        lol.setProgress(progress, 0.97);
      }
    });
    Object.assign(item, { png: r.png, w: r.w, h: r.h, ow: r.ow, oh: r.oh, scaled: r.scaled, cutMs: r.cutMs });
    item.outUrl = URL.createObjectURL(r.png);
    item.ui.thumb.src = item.outUrl;
    item.ui.thumb.classList.add('cut');
    item.ui.meta.textContent = `${r.w}×${r.h} · ${lol.formatBytes(r.png.size)}${r.scaled ? ' · scaled down' : ''}`;
    item.ui.meta.classList.add('ok');
    item.ui.actions.append(
      lol.el('button', { class: 'mini-btn', type: 'button', text: 'View', 'aria-label': `View ${item.file.name}`, onclick: () => show(item) }),
      lol.el('button', { class: 'mini-btn', type: 'button', text: 'Save', 'aria-label': `Save ${item.file.name}`, onclick: () => save(item).catch(onSaveError) }),
    );
    item.ui.row.addEventListener('click', (e) => { if (!e.target.closest('button')) show(item); });
    timings.runs.push({ name: item.file.name, w: r.w, h: r.h, cutMs: r.cutMs, decodeMs: r.decodeMs, pngMs: r.pngMs, totalMs: Math.round(performance.now() - t0), opaqueShare: r.opaqueShare });
    if (!many || !current || !current.png) show(item);
    if (r.opaqueShare < 0.002) {
      item.warn = "The AI couldn't find a clear subject in this photo, so almost everything came out see-through.";
      item.ui.meta.textContent += ' · no clear subject found';
    }
  } catch (e) {
    console.error(e);
    item.error = friendly(e);
    item.ui.meta.textContent = item.error;
    item.ui.meta.classList.add('err');
    lol.setStatus(statusEl, item.error, 'err');
    if (e.code === 'model') {
      for (const it of items) if (!it.png && !it.error) { it.error = item.error; it.ui.meta.textContent = 'Not done: the AI model didn\'t load.'; it.ui.meta.classList.add('err'); }
    }
  }
}

function onSaveError(e) {
  console.error(e);
  lol.setStatus(statusEl, 'Your browser ran out of memory saving this one. Try PNG or a smaller photo.', 'err');
}

saveBtn.addEventListener('click', async () => {
  if (!current || !current.png) return;
  saveBtn.disabled = true;
  try {
    const blob = await save(current);
    lol.setStatus(statusEl, `Saved ${outName(current)} (${lol.formatBytes(blob.size)}).`, 'ok');
  } catch (e) {
    onSaveError(e);
  } finally {
    saveBtn.disabled = false;
  }
});

zipBtn.addEventListener('click', async () => {
  const done = items.filter((x) => x.png);
  if (!done.length) return;
  zipBtn.disabled = true;
  lol.setStatus(statusEl, 'Building the ZIP…');
  try {
    const entries = {};
    const used = new Set();
    const kind = bgMode() === 'none' ? 'png-alpha' : fmt();
    for (const it of done) {
      let n = outName(it), k = 2;
      while (used.has(n.toLowerCase())) n = outName(it).replace(/(\.\w+)$/, `-${k++}$1`);
      used.add(n.toLowerCase());
      const blob = await render(it, kind, bgColor.value);
      entries[n] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
    }
    const zipped = fflate.zipSync(entries);
    lol.download(new Blob([zipped], { type: 'application/zip' }), `nobg-lol-${done.length}-photos.zip`);
    lol.setStatus(statusEl, `ZIP saved with ${done.length} photo${done.length === 1 ? '' : 's'} (${lol.formatBytes(zipped.length)}).`, 'ok');
  } catch (e) {
    console.error(e);
    lol.setStatus(statusEl, 'The ZIP was too big for your browser. Save the photos one at a time.', 'err');
  } finally {
    zipBtn.disabled = busy;
  }
});

function clearAll() {
  for (const it of items) {
    if (it.srcUrl) URL.revokeObjectURL(it.srcUrl);
    if (it.outUrl) URL.revokeObjectURL(it.outUrl);
  }
  items.length = 0;
  list.textContent = '';
  current = null;
  viewer.hidden = true;
  beforeImg.removeAttribute('src');
  afterImg.removeAttribute('src');
  lol.setStatus(statusEl, '');
  refresh();
}
$('clearBtn').addEventListener('click', () => {
  if (!busy) clearAll();
});

lol.dropzone($('drop'), addFiles);
window.__nobgReady = true;
