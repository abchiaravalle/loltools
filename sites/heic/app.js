/*
  heic.lol app. Runs entirely in your browser.
  heic-to (libheif compiled to JavaScript) decodes each photo inside a Web
  Worker; a canvas re-encodes it as JPG or PNG; fflate builds the ZIP.
  Nothing here makes a network request.
*/
import { heicTo, isHeic } from './heic-to.min.js';

const lol = window.lol;
const $ = (id) => document.getElementById(id);

const list = $('list');
const statusEl = $('status');
const progress = $('progress');
const bulk = $('bulk');
const zipBtn = $('zipBtn');
const quality = $('quality');
const qualityVal = $('qualityVal');

const items = [];
let queue = Promise.resolve();
let pending = 0;
let seq = 0;

const fmt = () => document.querySelector('input[name="fmt"]:checked').value;
function syncQuality() {
  qualityVal.textContent = quality.value;
  $('qualityField').style.opacity = fmt() === 'jpg' ? '' : '0.4';
  quality.disabled = fmt() !== 'jpg';
  $('keepDate').disabled = fmt() !== 'jpg';
}
quality.addEventListener('input', syncQuality);
document.querySelectorAll('input[name="fmt"]').forEach((r) => r.addEventListener('change', syncQuality));
syncQuality();

// ---------------------------------------------------------------------------
// Date taken: read it out of the HEIC's EXIF block, write it into the JPG.
// Only DateTimeOriginal and its time-zone offset are carried over. GPS,
// camera model and everything else stay behind.
// ---------------------------------------------------------------------------
function findTiff(bytes) {
  // HEIC stores EXIF as "Exif\0\0" followed by a TIFF header (MM or II).
  const n = bytes.length - 10;
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66 &&
        bytes[i + 4] === 0 && bytes[i + 5] === 0) {
      const a = bytes[i + 6], b = bytes[i + 7];
      if ((a === 0x4D && b === 0x4D && bytes[i + 9] === 0x2A) || (a === 0x49 && b === 0x49 && bytes[i + 8] === 0x2A)) return i + 6;
    }
  }
  return -1;
}

function readDateTaken(bytes) {
  try {
    const t = findTiff(bytes);
    if (t < 0) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset + t, Math.min(bytes.length - t, 1 << 20));
    const le = v.getUint16(0) === 0x4949;
    const ascii = (off, count) => {
      let s = '';
      for (let k = 0; k < count; k++) { const c = v.getUint8(off + k); if (!c) break; s += String.fromCharCode(c); }
      return s;
    };
    const readIfd = (off) => {
      const out = {};
      const count = v.getUint16(off, le);
      for (let k = 0; k < count; k++) {
        const e = off + 2 + k * 12;
        const tag = v.getUint16(e, le), type = v.getUint16(e + 2, le), cnt = v.getUint32(e + 4, le);
        if (type === 2) out[tag] = ascii(cnt <= 4 ? e + 8 : v.getUint32(e + 8, le), cnt);
        else if (type === 4 || type === 3) out[tag] = type === 4 ? v.getUint32(e + 8, le) : v.getUint16(e + 8, le);
      }
      return out;
    };
    const ifd0 = readIfd(v.getUint32(4, le));
    const exifPtr = ifd0[0x8769];
    const exif = exifPtr ? readIfd(exifPtr) : {};
    const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
    if (!dt || !/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(dt)) return null;
    const off = exif[0x9011];
    return { dt, offset: off && /^[+-]\d\d:\d\d$/.test(off) ? off : null };
  } catch (_) {
    return null;
  }
}

function exifSegment(date) {
  // Big-endian TIFF: IFD0 {Orientation=1, ExifIFD ptr} -> ExifIFD {DateTimeOriginal, OffsetTimeOriginal?}
  const enc = (s) => Array.from(s + '\0', (c) => c.charCodeAt(0));
  const dtBytes = enc(date.dt);                 // 20 bytes
  const offBytes = date.offset ? enc(date.offset) : null; // 7 bytes
  const exifCount = offBytes ? 2 : 1;
  const ifd0At = 8, ifd0Size = 2 + 2 * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = 2 + exifCount * 12 + 4;
  const dtAt = exifAt + exifSize;
  const offAt = dtAt + dtBytes.length;
  const total = offAt + (offBytes ? offBytes.length : 0);
  const b = new Uint8Array(total);
  const v = new DataView(b.buffer);
  b.set([0x4D, 0x4D, 0x00, 0x2A]); v.setUint32(4, ifd0At);
  let p = ifd0At;
  v.setUint16(p, 2); p += 2;
  v.setUint16(p, 0x0112); v.setUint16(p + 2, 3); v.setUint32(p + 4, 1); v.setUint16(p + 8, 1); p += 12;
  v.setUint16(p, 0x8769); v.setUint16(p + 2, 4); v.setUint32(p + 4, 1); v.setUint32(p + 8, exifAt); p += 12;
  v.setUint32(p, 0);
  p = exifAt;
  v.setUint16(p, exifCount); p += 2;
  v.setUint16(p, 0x9003); v.setUint16(p + 2, 2); v.setUint32(p + 4, dtBytes.length); v.setUint32(p + 8, dtAt); p += 12;
  if (offBytes) { v.setUint16(p, 0x9011); v.setUint16(p + 2, 2); v.setUint32(p + 4, offBytes.length); v.setUint32(p + 8, offAt); p += 12; }
  v.setUint32(p, 0);
  b.set(dtBytes, dtAt);
  if (offBytes) b.set(offBytes, offAt);

  const head = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"
  const len = 2 + head.length + b.length;
  const seg = new Uint8Array(2 + len);
  seg.set([0xFF, 0xE1, len >> 8, len & 0xFF]);
  seg.set(head, 4);
  seg.set(b, 4 + head.length);
  return seg;
}

function withExif(jpeg, seg) {
  // Insert right after SOI, or after a JFIF APP0 if the encoder wrote one.
  let at = 2;
  if (jpeg[2] === 0xFF && jpeg[3] === 0xE0) at = 4 + ((jpeg[4] << 8) | jpeg[5]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, at), 0);
  out.set(seg, at);
  out.set(jpeg.subarray(at), at + seg.length);
  return out;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

async function encode(bitmap, maxDim, type, q) {
  let w = bitmap.width, h = bitmap.height;
  const fit = (limit) => {
    const s = Math.min(1, limit / Math.max(w, h));
    return [Math.round(w * s), Math.round(h * s)];
  };
  if (maxDim) [w, h] = fit(maxDim);
  const draw = async (W, H) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, W, H);
    const blob = await toBlob(c, type, q);
    c.width = c.height = 1;
    return blob;
  };
  let blob = await draw(w, h);
  let shrunk = false;
  if (!blob && w * h > 16777216) {
    // Phone browsers cap canvas size near 16.7 megapixels.
    const s = Math.sqrt(16000000 / (w * h));
    w = Math.floor(w * s); h = Math.floor(h * s);
    blob = await draw(w, h);
    shrunk = true;
  }
  if (!blob) throw new Error('Your browser ran out of room for an image this large.');
  return { blob, w, h, shrunk };
}

async function convert(item) {
  const file = item.file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const looksHeic = await isHeic(file).catch(() => false);
  if (!looksHeic && !/\.(heic|heif)$/i.test(file.name)) throw new Error('This isn\'t a HEIC photo.');
  const bitmap = await heicTo({ blob: file, type: 'bitmap' });
  try {
    const f = fmt();
    const type = f === 'png' ? 'image/png' : 'image/jpeg';
    const out = await encode(bitmap, parseInt($('maxSize').value, 10), type, f === 'jpg' ? parseInt(quality.value, 10) / 100 : undefined);
    let blob = out.blob;
    let dated = false;
    if (f === 'jpg' && $('keepDate').checked) {
      const date = readDateTaken(bytes);
      if (date) {
        const jpg = new Uint8Array(await blob.arrayBuffer());
        blob = new Blob([withExif(jpg, exifSegment(date))], { type: 'image/jpeg' });
        dated = date.dt;
      }
    }
    return { blob, name: `${lol.baseName(file.name)}.${f}`, w: out.w, h: out.h, shrunk: out.shrunk, dated };
  } finally {
    bitmap.close && bitmap.close();
  }
}

function prettyDate(dt) {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/.exec(dt);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function rowFor(item) {
  const thumb = lol.el('img', { class: 'fr-thumb', alt: '' });
  const name = lol.el('span', { class: 'fr-name', text: item.file.name });
  const meta = lol.el('span', { class: 'fr-meta', text: 'Waiting…' });
  const actions = lol.el('span', { class: 'fr-actions' });
  const row = lol.el('li', { class: 'file-row' }, [thumb, lol.el('span', { class: 'fr-main' }, [name, meta]), actions]);
  item.ui = { row, thumb, name, meta, actions };
  return row;
}

function refreshBulk() {
  const done = items.filter((x) => x.result);
  bulk.hidden = items.length === 0;
  zipBtn.disabled = done.length === 0 || pending > 0;
  if (pending > 0) {
    const finished = items.length - pending;
    lol.setStatus(statusEl, `Converting ${finished + 1} of ${items.length}…`);
    lol.setProgress(progress, finished / items.length);
  } else {
    lol.setProgress(progress, null);
    const failed = items.filter((x) => x.error).length;
    if (items.length) {
      const total = done.reduce((s, x) => s + x.result.blob.size, 0);
      lol.setStatus(statusEl,
        `${done.length} converted (${lol.formatBytes(total)})${failed ? `, ${failed} couldn't be read` : ''}.`,
        done.length ? 'ok' : 'err');
    }
  }
}

function addFiles(files) {
  for (const file of files) {
    const item = { id: ++seq, file, result: null, error: null };
    items.push(item);
    list.append(rowFor(item));
    pending++;
    queue = queue.then(() => run(item));
  }
  refreshBulk();
}

async function run(item) {
  item.ui.meta.textContent = 'Converting…';
  try {
    const r = await convert(item);
    item.result = r;
    item.url = URL.createObjectURL(r.blob);
    item.ui.thumb.src = item.url;
    item.ui.name.textContent = r.name;
    const bits = [`${r.w}×${r.h}`, lol.formatBytes(r.blob.size)];
    if (r.dated) bits.push(`taken ${prettyDate(r.dated)}`);
    if (r.shrunk) bits.push('resized to fit your browser');
    item.ui.meta.textContent = bits.join(' · ');
    item.ui.meta.classList.add('ok');
    item.ui.actions.append(lol.el('button', {
      class: 'mini-btn', type: 'button', text: 'Save', 'aria-label': `Save ${r.name}`,
      onclick: () => lol.download(r.blob, r.name),
    }));
  } catch (e) {
    console.error(e);
    item.error = e;
    const msg = String((e && e.message) || e || '');
    item.ui.meta.textContent = /isn't a HEIC/.test(msg) ? msg
      : /room/.test(msg) ? msg
      : 'heic.lol couldn\'t read this photo. It may be damaged or use a HEIC feature the decoder doesn\'t support.';
    item.ui.meta.classList.add('err');
  } finally {
    pending--;
    refreshBulk();
    await new Promise((r) => setTimeout(r, 0));
  }
}

zipBtn.addEventListener('click', async () => {
  const done = items.filter((x) => x.result);
  if (!done.length) return;
  zipBtn.disabled = true;
  lol.setStatus(statusEl, 'Building the ZIP…');
  try {
    const entries = {};
    const used = new Set();
    for (const it of done) {
      let n = it.result.name, k = 2;
      while (used.has(n.toLowerCase())) n = it.result.name.replace(/(\.\w+)$/, `-${k++}$1`);
      used.add(n.toLowerCase());
      const data = new Uint8Array(await it.result.blob.arrayBuffer());
      entries[n] = [data, { level: 0, mtime: new Date(it.file.lastModified || Date.now()) }];
    }
    const zipped = fflate.zipSync(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    lol.download(new Blob([zipped], { type: 'application/zip' }), `heic-lol-${done.length}-photos-${stamp}.zip`);
    lol.setStatus(statusEl, `ZIP saved with ${done.length} photo${done.length === 1 ? '' : 's'} (${lol.formatBytes(zipped.length)}).`, 'ok');
  } catch (e) {
    console.error(e);
    lol.setStatus(statusEl, 'The ZIP was too big for your browser. Save the photos one at a time, or convert fewer at once.', 'err');
  } finally {
    zipBtn.disabled = false;
  }
});

$('clearBtn').addEventListener('click', () => {
  if (pending > 0) return;
  for (const it of items) if (it.url) URL.revokeObjectURL(it.url);
  items.length = 0;
  list.textContent = '';
  lol.setStatus(statusEl, '');
  refreshBulk();
});

lol.dropzone($('drop'), addFiles);
window.__heicReady = true;
