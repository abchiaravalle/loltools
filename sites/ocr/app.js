/*
  imgtotext.lol app. Runs entirely in your browser.

  Your image is decoded by the browser, drawn onto a canvas (upright, on white,
  scaled down if it's huge) and handed to Tesseract.js. Tesseract runs in a Web
  Worker loaded from this site: /vendor/tesseract/worker.min.js pulls in one
  engine build from /vendor/tesseract/core/ and the language file you picked
  from /vendor/tesseract/lang/. Those three are the only network requests, and
  they all go to this same site. Your image never leaves the tab.
*/
import Tesseract from './vendor/tesseract/tesseract.esm.min.js';

const lol = window.lol;
const $ = (id) => document.getElementById(id);

const tool = $('tool');
const statusEl = $('status');
const progress = $('progress');
const result = $('result');
const out = $('out');
const count = $('count');
const confNote = $('confNote');
const confText = $('confText');
const langSel = $('lang');
const joinBox = $('joinLines');
const figure = $('figure');
const copyBtn = $('copyBtn');
const dlBtn = $('dlBtn');
const pasteBtn = $('pasteBtn');

const VENDOR = '/vendor/tesseract/';
const MAX_PIXELS = 16000000;  // phones cap canvases near 16.7 MP
const SMALL_SIDE = 900;       // tiny images get scaled up so small letters are big enough to read
const LOW_CONF = 70;          // Tesseract's mean word confidence (0-100) below which we warn
const LANG_NAMES = { eng: 'English', spa: 'Spanish', fra: 'French', deu: 'German', por: 'Portuguese' };
const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif)$/i;

let worker = null;        // Tesseract worker, created on first use
let workerLang = null;    // language currently loaded in it
let workerBusy = Promise.resolve();
let runId = 0;
let current = null;       // { blob, url, width, height, name, scaled }
let rawText = '';         // text exactly as Tesseract returned it
let shownText = '';       // what we last put in the textarea (to spot user edits)
const loadedLangs = new Set();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
$('pasteKey').textContent = isMac ? '⌘V' : 'Ctrl+V';
if (navigator.clipboard && typeof navigator.clipboard.read === 'function' && window.isSecureContext) pasteBtn.hidden = false;

function setState(s) { tool.dataset.state = s; }

function say(text, kind) { lol.setStatus(statusEl, text, kind); }

function joinLines(text) {
  // Keep blank-line paragraph breaks, glue the lines inside each paragraph.
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n');
}

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function updateCount() {
  const t = out.value.trim();
  const words = t ? t.split(/\s+/).length : 0;
  count.textContent = t ? `${words.toLocaleString()} word${words === 1 ? '' : 's'}, ${t.length.toLocaleString()} characters` : '';
  copyBtn.disabled = !t;
  dlBtn.disabled = !t;
}

function render() {
  shownText = joinBox.checked ? joinLines(rawText) : rawText;
  out.value = shownText;
  updateCount();
}

// ---------------------------------------------------------------------------
// Image loading: any format the browser can show -> upright PNG on white
// ---------------------------------------------------------------------------
function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  const n = file.name || '';
  if (t === 'application/pdf' || /\.pdf$/i.test(n)) return 'pdf';
  if (t.startsWith('image/') || IMAGE_EXT.test(n)) return 'image';
  if (t.startsWith('video/')) return 'video';
  return 'other';
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    // Some formats (SVG, a few GIFs) only decode through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('no size');
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

const toBlob = (canvas) => new Promise((res) => canvas.toBlob(res, 'image/png'));

async function prepare(file) {
  const src = await decode(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  let scale = 1;
  if (w0 * h0 > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w0 * h0));
  else if (Math.max(w0, h0) < SMALL_SIDE) scale = Math.min(2, SMALL_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await toBlob(canvas);
  canvas.width = canvas.height = 1;
  if (!blob) throw new Error('canvas');
  return { blob, width: w, height: h, origW: w0, origH: h0, shrunk: scale < 1 };
}

// ---------------------------------------------------------------------------
// Tesseract worker
// ---------------------------------------------------------------------------
let onProgress = () => {};
let onStartupError = null;

// Passed with every recognize() call, because switching language resets the
// engine's settings. PSM 6 reads the image as one block of text, which copes
// far better with tilted photos and receipts than full page-layout analysis.
const RECOGNIZE_OPTS = {
  rotateAuto: true,                                  // straighten slightly tilted photos
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
  debug_file: '/dev/null',                           // keep Tesseract's debug chatter out of the console
};

async function getWorker(lang) {
  if (!worker) {
    // createWorker never settles if a language file fails to download, so
    // catch that through errorHandler and give up instead of hanging.
    const failed = new Promise((_, reject) => { onStartupError = reject; });
    const w = await Promise.race([
      Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
        workerPath: VENDOR + 'worker.min.js',
        corePath: VENDOR + 'core/',     // the worker picks relaxed-SIMD, SIMD or plain
        langPath: VENDOR + 'lang',
        workerBlobURL: false,           // load the worker straight from this site, no blob: wrapper
        cacheMethod: 'none',            // don't copy language files into IndexedDB
        gzip: true,
        logger: (m) => onProgress(m),
        errorHandler: (e) => {
          console.warn('Tesseract:', e);
          if (onStartupError) onStartupError(new Error(String(e)));
        },
      }),
      failed,
    ]);
    onStartupError = null;
    worker = w;
    workerLang = lang;
  } else if (workerLang !== lang) {
    await worker.reinitialize(lang, Tesseract.OEM.LSTM_ONLY);
    workerLang = lang;
  }
  loadedLangs.add(lang);
  return worker;
}

function progressFor(lang, firstLoad) {
  const name = LANG_NAMES[lang] || lang;
  return (m) => {
    const p = typeof m.progress === 'number' ? m.progress : 0;
    switch (m.status) {
      case 'loading tesseract core':
        say('Loading the text reader (first time only)…');
        lol.setProgress(progress, 0.05 + p * 0.25);
        break;
      case 'initializing tesseract':
        say('Starting the text reader…');
        lol.setProgress(progress, 0.3);
        break;
      case 'loading language traineddata':
        say(`Loading the ${name} language file${firstLoad ? ' (first time only)' : ''}…`);
        lol.setProgress(progress, 0.3 + p * 0.25);
        break;
      case 'initializing api':
        say(`Getting ${name} ready…`);
        lol.setProgress(progress, 0.55);
        break;
      case 'recognizing text': {
        const pct = Math.round(p * 100);
        say(`Reading text… ${pct}%`);
        lol.setProgress(progress, firstLoad ? 0.6 + p * 0.4 : p);
        break;
      }
      default:
        break;
    }
  };
}

// ---------------------------------------------------------------------------
// Run OCR on the current image
// ---------------------------------------------------------------------------
async function recognize() {
  if (!current) return;
  const id = ++runId;
  const lang = langSel.value;
  const firstLoad = !loadedLangs.has(lang) || !worker;
  setState('working');
  confNote.hidden = true;
  lol.setProgress(progress, 0.02);
  say(firstLoad ? 'Loading the text reader…' : 'Reading text…');

  const job = workerBusy.then(async () => {
    onProgress = progressFor(lang, firstLoad);
    const t0 = performance.now();
    let w;
    try {
      w = await getWorker(lang);
    } catch (e) {
      console.warn(e);
      // Throw away a half-started worker so the next try starts clean.
      try { if (worker) await worker.terminate(); } catch (_) { /* ignore */ }
      worker = null; workerLang = null; loadedLangs.clear();
      const netFail = navigator.onLine === false || /network|fetch|load/i.test(String((e && e.message) || e));
      const err = new Error(netFail
        ? `The ${LANG_NAMES[lang]} language file didn't download. Check your connection and try again.`
        : 'Your browser couldn\'t start the text reader. Try reloading the page, or use an up-to-date Chrome, Edge, Firefox or Safari.');
      err.friendly = true;
      throw err;
    }
    if (id !== runId) return null;
    onProgress = progressFor(lang, firstLoad);
    const { data } = await w.recognize(current.blob, RECOGNIZE_OPTS, { text: true, blocks: true });
    return { data, ms: performance.now() - t0 };
  });
  workerBusy = job.catch(() => {});

  let res;
  try {
    res = await job;
  } catch (e) {
    if (id !== runId) return;
    if (e && e.friendly) console.warn(e.message); else console.error(e);
    lol.setProgress(progress, null);
    setState(rawText ? 'done' : 'idle');
    say(e && e.friendly ? e.message : 'Something went wrong while reading this image. Try again, or try a different image.', 'err');
    return;
  }
  if (!res || id !== runId) return;   // a newer image or language took over
  const { data, ms } = res;
  lol.setProgress(progress, null);

  rawText = cleanText(data.text);
  render();
  drawBoxes(data);
  result.hidden = false;
  setState('done');

  const conf = Math.round(data.confidence || 0);
  window.__ocrLast = { text: rawText, confidence: conf, ms: Math.round(ms), lang, rotateRadians: data.rotateRadians };
  const secs = (ms / 1000).toFixed(1);
  const scaledNote = current.shrunk ? ` It was a very large image, so it was scaled down to ${current.width}×${current.height} first.` : '';

  if (!rawText) {
    say(`No text found.${scaledNote}`, 'err');
    showNote('It couldn\'t find any text. Try a sharper image, get closer to the text, or check the language setting.');
    return;
  }
  say(`Done in ${secs} s.${scaledNote}`, 'ok');
  if (conf < LOW_CONF) {
    showNote(conf < 45
      ? 'A lot of this is probably wrong. A sharper, straighter or closer image will read much better.'
      : 'Some of this may be wrong, so check it before you use it.');
  }
}

function showNote(text) {
  confText.textContent = text;
  confNote.hidden = false;
}

// ---------------------------------------------------------------------------
// Preview with line boxes
// ---------------------------------------------------------------------------
function drawBoxes(data) {
  figure.textContent = '';
  if (!current) return;
  const img = lol.el('img', { src: current.url, alt: 'Your image', class: 'ocr-img' });
  const layer = lol.el('div', { class: 'ocr-boxes', 'aria-hidden': 'true' });
  // Tesseract straightened the image by rotateRadians before finding lines,
  // so turn the box layer back the same amount to sit on the original.
  const rad = data.rotateRadians || 0;
  if (rad) layer.style.transform = `rotate(${-rad}rad)`;
  const W = current.width, H = current.height;
  let n = 0;
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        if (!l.text || !l.text.trim()) continue;
        const { x0, y0, x1, y1 } = l.bbox;
        const box = lol.el('span', { class: 'ocr-box' + (l.confidence < LOW_CONF ? ' low' : '') });
        box.style.left = (x0 / W) * 100 + '%';
        box.style.top = (y0 / H) * 100 + '%';
        box.style.width = ((x1 - x0) / W) * 100 + '%';
        box.style.height = ((y1 - y0) / H) * 100 + '%';
        box.title = `${Math.round(l.confidence)}% sure: ${l.text.trim()}`;
        layer.append(box);
        n++;
      }
    }
  }
  figure.append(img, layer);
  $('previewBox').hidden = n === 0;
}

// ---------------------------------------------------------------------------
// Input: drop, pick, paste
// ---------------------------------------------------------------------------
async function useFile(file, how) {
  const kind = kindOf(file);
  if (kind === 'pdf') { say('That\'s a PDF, not an image. Take a screenshot of the page and drop that in instead.', 'err'); return; }
  if (kind === 'video') { say('That\'s a video. Pause it where the text shows, take a screenshot, and drop that in.', 'err'); return; }
  if (kind !== 'image') { say('That file isn\'t an image. Pick a JPG, PNG, WebP or GIF, or paste a screenshot.', 'err'); return; }
  if (!file.size) { say('That image file is empty.', 'err'); return; }

  const id = ++runId;
  setState('working');
  say('Opening your image…');
  lol.setProgress(progress, 0.02);
  let prepared;
  try {
    prepared = await prepare(file);
  } catch (e) {
    console.warn(e);
    if (id !== runId) return;
    lol.setProgress(progress, null);
    setState(rawText ? 'done' : 'idle');
    say(/\.(heic|heif)$/i.test(file.name || '') || /hei[cf]/i.test(file.type)
      ? 'Your browser can\'t open HEIC photos. Turn it into a JPG first (heic.lol does it in your browser too), then drop it in here.'
      : 'Your browser couldn\'t open this image. It may be damaged, or saved in a format your browser can\'t show.', 'err');
    return;
  }
  if (id !== runId) return;
  if (current && current.url) URL.revokeObjectURL(current.url);
  const name = how === 'paste' ? `pasted-image-${new Date().toISOString().slice(0, 10)}` : lol.baseName(file.name || 'image');
  current = { ...prepared, url: URL.createObjectURL(prepared.blob), name };
  await recognize();
}

function firstImage(files, how) {
  const list = Array.from(files || []);
  if (!list.length) return;
  if (list.length > 1) {
    const img = list.find((f) => kindOf(f) === 'image') || list[0];
    useFile(img, how).then(() => {
      if (tool.dataset.state === 'done') say(`${statusEl.textContent} You picked ${list.length} files, so it read just "${img.name}". Do one at a time.`, statusEl.classList.contains('err') ? 'err' : 'ok');
    });
    return;
  }
  useFile(list[0], how);
}

lol.dropzone($('drop'), (files) => firstImage(files, 'pick'));

function imageFromClipboardData(dt) {
  if (!dt) return null;
  for (const f of Array.from(dt.files || [])) if (kindOf(f) === 'image') return f;
  for (const it of Array.from(dt.items || [])) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) return f; }
  }
  return null;
}

document.addEventListener('paste', (e) => {
  const file = imageFromClipboardData(e.clipboardData);
  if (file) {
    e.preventDefault();
    useFile(file, 'paste');
    return;
  }
  // Plain text pasted into the result box: let the browser handle it.
  if (e.target === out) return;
  const hasFiles = e.clipboardData && Array.from(e.clipboardData.items || []).some((it) => it.kind === 'file');
  if (hasFiles) {
    say('That isn\'t an image. Copy a picture or take a screenshot, then paste again.', 'err');
  } else if (e.clipboardData && e.clipboardData.types && e.clipboardData.types.length) {
    say('Your clipboard has text, not an image. Copy a picture or take a screenshot, then paste.', 'err');
  }
});

pasteBtn.addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        const ext = type.split('/')[1] || 'png';
        await useFile(new File([blob], `pasted.${ext}`, { type }), 'paste');
        return;
      }
    }
    say('There\'s no image on your clipboard. Copy a picture or take a screenshot first.', 'err');
  } catch (e) {
    console.warn(e);
    say(`Your browser didn't allow reading the clipboard. Click the page and press ${isMac ? '⌘V' : 'Ctrl+V'} instead.`, 'err');
  }
});

// ---------------------------------------------------------------------------
// Result actions
// ---------------------------------------------------------------------------
out.addEventListener('input', updateCount);

joinBox.addEventListener('change', () => {
  if (out.value === shownText) { render(); return; }
  // The text was edited. Joining works on the edited text; un-joining can't
  // put line breaks back without losing the edits, so leave it alone.
  if (joinBox.checked) {
    out.value = shownText = joinLines(out.value);
    updateCount();
  } else {
    say('Your edits are kept, so the original line breaks weren\'t put back.', '');
  }
});

copyBtn.addEventListener('click', async () => {
  const text = out.value;
  const label = copyBtn.querySelector('span');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (_) {
    out.focus();
    out.select();
    try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
  }
  if (ok) {
    label.textContent = 'Copied';
    setTimeout(() => { label.textContent = 'Copy text'; }, 1600);
    say('Text copied to your clipboard.', 'ok');
  } else {
    out.focus();
    out.select();
    say(`Your browser blocked copying. The text is selected, so press ${isMac ? '⌘C' : 'Ctrl+C'}.`, 'err');
  }
});

dlBtn.addEventListener('click', () => {
  const text = out.value;
  if (!text.trim()) return;
  const body = text.endsWith('\n') ? text : text + '\n';
  lol.download(new Blob([body], { type: 'text/plain;charset=utf-8' }), `${(current && current.name) || 'image-text'}.txt`);
});

langSel.addEventListener('change', () => {
  const name = LANG_NAMES[langSel.value];
  $('langHint').textContent = loadedLangs.has(langSel.value) || langSel.value === 'eng'
    ? `${name} is selected.`
    : `${name} downloads a small file from this site the first time you use it.`;
  if (current && tool.dataset.state !== 'idle') recognize();
});

updateCount();
window.__ocrReady = true;
