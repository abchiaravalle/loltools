/*
  pdf.lol app. Runs entirely in your browser with pdf-lib.
  Nothing here makes a network request, and the page's CSP (connect-src 'none')
  would block one if it tried.
*/
(function () {
  'use strict';

  const {
    PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, PDFStream, PDFNumber,
    decodePDFRawStream,
  } = window.PDFLib;
  const lol = window.lol;
  const N = (s) => PDFName.of(s);

  // ---------------------------------------------------------------------------
  // Mode switch
  // ---------------------------------------------------------------------------
  const panels = { merge: document.getElementById('panel-merge'), compress: document.getElementById('panel-compress') };
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    for (const k in panels) panels[k].hidden = k !== r.value;
  }));
  if (location.hash === '#compress') {
    document.getElementById('mode-compress').checked = true;
    panels.merge.hidden = true; panels.compress.hidden = false;
  }

  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isJpg = (f) => f.type === 'image/jpeg' || /\.jpe?g$/i.test(f.name);
  const isPng = (f) => f.type === 'image/png' || /\.png$/i.test(f.name);

  function friendlyError(e) {
    const msg = String((e && (e.message || e)) || '');
    if (/encrypt/i.test(msg)) return 'This PDF is locked with a password. pdf.lol can\'t open locked PDFs yet.';
    if (/No PDF header|Failed to parse|invalid|expected/i.test(msg)) return 'pdf.lol couldn\'t read this file. It may be damaged or not a real PDF.';
    return 'Something went wrong reading this file (' + msg.slice(0, 120) + ').';
  }

  async function loadPdf(bytes) {
    return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
  }

  // Tiny EXIF reader: returns the JPEG orientation tag (1 = upright).
  function jpegOrientation(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint16(0) !== 0xFFD8) return 1;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {
        const t = off + 10;
        const le = v.getUint16(t) === 0x4949;
        const ifd = t + v.getUint32(t + 4, le);
        const count = v.getUint16(ifd, le);
        for (let i = 0; i < count; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
        }
        return 1;
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + len;
    }
    return 1;
  }

  // ---------------------------------------------------------------------------
  // MERGE
  // ---------------------------------------------------------------------------
  const merge = {
    items: [],
    list: document.getElementById('mergeList'),
    btn: document.getElementById('mergeBtn'),
    clear: document.getElementById('mergeClear'),
    status: document.getElementById('mergeStatus'),
    progress: document.getElementById('mergeProgress'),
    hint: document.getElementById('mergeHint'),
  };
  let seq = 0;

  async function addMergeFiles(files) {
    lol.setStatus(merge.status, '');
    for (const file of files) {
      const item = { id: ++seq, file, kind: null, pages: 0, error: null, doc: null };
      if (isPdf(file)) item.kind = 'pdf';
      else if (isJpg(file) || isPng(file)) item.kind = 'image';
      else item.error = 'Not a PDF, JPG or PNG, so it\'s skipped.';
      merge.items.push(item);
      renderMerge();
      if (item.kind === 'pdf') {
        try {
          item.doc = await loadPdf(new Uint8Array(await file.arrayBuffer()));
          item.pages = item.doc.getPageCount();
        } catch (e) {
          item.error = friendlyError(e);
        }
        renderMerge();
      }
    }
  }

  function moveItem(id, delta) {
    const i = merge.items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= merge.items.length) return;
    const [it] = merge.items.splice(i, 1);
    merge.items.splice(j, 0, it);
    renderMerge();
  }

  function renderMerge() {
    merge.list.textContent = '';
    const n = merge.items.length;
    merge.items.forEach((it, idx) => {
      let meta = lol.formatBytes(it.file.size);
      let cls = 'fr-meta';
      if (it.error) { meta = it.error; cls += ' err'; }
      else if (it.kind === 'pdf') meta = it.doc ? `${it.pages} page${it.pages === 1 ? '' : 's'} · ${meta}` : `Reading… · ${meta}`;
      else meta = `Image, becomes 1 page · ${meta}`;
      const row = lol.el('li', { class: 'file-row', 'data-id': it.id }, [
        lol.el('span', { class: 'fr-thumb', 'aria-hidden': 'true', style: 'display:grid;place-items:center;font-family:var(--font-mono);font-size:.7rem;color:var(--fg-muted)', text: it.kind === 'image' ? 'IMG' : 'PDF' }),
        lol.el('span', { class: 'fr-main' }, [
          lol.el('span', { class: 'fr-name', text: `${idx + 1}. ${it.file.name}` }),
          lol.el('span', { class: cls, text: meta }),
        ]),
        lol.el('span', { class: 'fr-actions' }, [
          lol.el('button', { class: 'mini-btn', type: 'button', 'aria-label': `Move ${it.file.name} up`, title: 'Move up', disabled: idx === 0, onclick: () => moveItem(it.id, -1), text: '↑' }),
          lol.el('button', { class: 'mini-btn', type: 'button', 'aria-label': `Move ${it.file.name} down`, title: 'Move down', disabled: idx === n - 1, onclick: () => moveItem(it.id, 1), text: '↓' }),
          lol.el('button', { class: 'mini-btn', type: 'button', 'aria-label': `Remove ${it.file.name}`, title: 'Remove', onclick: () => { merge.items = merge.items.filter((x) => x.id !== it.id); renderMerge(); }, text: '✕' }),
        ]),
      ]);
      merge.list.append(row);
    });
    const good = merge.items.filter((x) => !x.error && (x.kind === 'image' || x.doc));
    const pending = merge.items.some((x) => x.kind === 'pdf' && !x.doc && !x.error);
    const ready = !pending && (good.length >= 2 || (good.length === 1 && good[0].kind === 'image'));
    merge.btn.disabled = !ready;
    merge.clear.disabled = n === 0;
    merge.hint.hidden = n < 2;
    if (n > 0 && !pending && !ready && !merge.status.classList.contains('ok')) {
      lol.setStatus(merge.status, good.length === 1 ? 'Add one more file to merge.' : 'Add PDFs or images to merge.');
    } else if (ready && !merge.status.classList.contains('ok')) {
      const pages = good.reduce((s, x) => s + (x.kind === 'image' ? 1 : x.pages), 0);
      lol.setStatus(merge.status, `Ready: ${good.length} file${good.length === 1 ? '' : 's'}, ${pages} page${pages === 1 ? '' : 's'} in total.`);
    }
  }

  async function imagePage(out, item) {
    let bytes = new Uint8Array(await item.file.arrayBuffer());
    let img;
    if (isPng(item.file)) {
      img = await out.embedPng(bytes);
    } else {
      // Phones often save photos sideways plus an "orientation" flag.
      // Redraw those upright so the PDF page isn't rotated.
      if (jpegOrientation(bytes) !== 1) {
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
        bytes = new Uint8Array(await blob.arrayBuffer());
      }
      img = await out.embedJpg(bytes);
    }
    // Long side = 11 inches, aspect ratio kept.
    const long = 792;
    const scale = long / Math.max(img.width, img.height);
    const w = img.width * scale, h = img.height * scale;
    const page = out.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }

  merge.btn.addEventListener('click', async () => {
    const good = merge.items.filter((x) => !x.error && (x.kind === 'image' || x.doc));
    merge.btn.disabled = true;
    lol.setStatus(merge.status, 'Merging…');
    lol.setProgress(merge.progress, 0);
    try {
      const out = await PDFDocument.create({ updateMetadata: false });
      out.setProducer('pdf.lol');
      for (let i = 0; i < good.length; i++) {
        const it = good[i];
        if (it.kind === 'pdf') {
          const pages = await out.copyPages(it.doc, it.doc.getPageIndices());
          pages.forEach((p) => out.addPage(p));
        } else {
          await imagePage(out, it);
        }
        lol.setProgress(merge.progress, (i + 1) / (good.length + 1));
        await new Promise((r) => setTimeout(r, 0));
      }
      const bytes = await out.save({ useObjectStreams: true });
      lol.setProgress(merge.progress, 1);
      const name = good.length ? `${lol.baseName(good[0].file.name)}-merged.pdf` : 'merged.pdf';
      lol.download(new Blob([bytes], { type: 'application/pdf' }), name);
      lol.setStatus(merge.status, `Done: ${out.getPageCount()} pages, ${lol.formatBytes(bytes.length)}. Saved as ${name}.`, 'ok');
    } catch (e) {
      console.error(e);
      lol.setStatus(merge.status, friendlyError(e), 'err');
    } finally {
      setTimeout(() => lol.setProgress(merge.progress, null), 800);
      merge.btn.disabled = false;
    }
  });

  merge.clear.addEventListener('click', () => {
    merge.items = [];
    lol.setStatus(merge.status, '');
    renderMerge();
  });

  lol.dropzone(document.getElementById('mergeDrop'), addMergeFiles);

  // ---------------------------------------------------------------------------
  // COMPRESS
  // ---------------------------------------------------------------------------
  const LEVELS = {
    strong:   { maxDim: 1400, quality: 0.5,  hint: 'Photos and scans get small and a little soft. Good for email attachments.' },
    balanced: { maxDim: 2000, quality: 0.68, hint: 'Photos and scans still look sharp on screen and print fine. Good default.' },
    light:    { maxDim: 3000, quality: 0.82, hint: 'Images stay big and crisp. Files shrink less.' },
  };
  const comp = {
    files: [],
    list: document.getElementById('compressList'),
    status: document.getElementById('compressStatus'),
    progress: document.getElementById('compressProgress'),
    levelHint: document.getElementById('levelHint'),
    strip: document.getElementById('stripMeta'),
    running: false,
    rerun: false,
  };
  const level = () => document.querySelector('input[name="level"]:checked').value;
  const showLevelHint = () => { comp.levelHint.textContent = LEVELS[level()].hint; };
  showLevelHint();
  document.querySelectorAll('input[name="level"]').forEach((r) => r.addEventListener('change', () => {
    showLevelHint();
    if (comp.files.length) runCompress();
  }));
  comp.strip.addEventListener('change', () => { if (comp.files.length) runCompress(); });

  // Read the number of colour channels from a JPEG's frame header.
  function jpegComponents(bytes) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xFF) { off++; continue; }
      const m = bytes[off + 1];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { off += 2; continue; }
      const len = (bytes[off + 2] << 8) | bytes[off + 3];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return bytes[off + 9];
      off += 2 + len;
    }
    return 0;
  }

  function colorInfo(dict) {
    const cs = dict.lookup(N('ColorSpace'));
    if (cs === N('DeviceRGB') || cs === N('CalRGB')) return { comps: 3 };
    if (cs === N('DeviceGray') || cs === N('CalGray')) return { comps: 1 };
    if (cs instanceof PDFArray && cs.size() >= 1) {
      const kind = cs.lookup(0);
      if (kind === N('ICCBased')) {
        const s = cs.lookup(1);
        const n = s && s.dict && s.dict.lookup(N('N'));
        const count = n instanceof PDFNumber ? n.asNumber() : 0;
        if (count === 3 || count === 1) return { comps: count };
      }
      if (kind === N('CalRGB')) return { comps: 3 };
      if (kind === N('CalGray')) return { comps: 1 };
    }
    // CMYK is left alone on purpose. Print-ready (Adobe) CMYK JPEGs store
    // inverted values, and browsers and PDF readers disagree on reading
    // them. Tested 2026-10-20: re-encoding came out color-inverted.
    return null; // CMYK, Indexed, Lab, Separation, DeviceN
  }

  function filters(dict) {
    const f = dict.lookup(N('Filter'));
    if (!f) return [];
    if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFRef ? dict.context.lookup(x) : x));
    return [f];
  }

  function pngUnfilter(data, columns, bpp, rowLen) {
    const out = new Uint8Array(rowLen * Math.floor(data.length / (rowLen + 1)));
    const rows = out.length / rowLen;
    for (let y = 0; y < rows; y++) {
      const type = data[y * (rowLen + 1)];
      const src = y * (rowLen + 1) + 1;
      const dst = y * rowLen;
      const prev = dst - rowLen;
      for (let x = 0; x < rowLen; x++) {
        const raw = data[src + x];
        const a = x >= bpp ? out[dst + x - bpp] : 0;
        const b = y > 0 ? out[prev + x] : 0;
        const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
        let v;
        switch (type) {
          case 0: v = raw; break;
          case 1: v = raw + a; break;
          case 2: v = raw + b; break;
          case 3: v = raw + ((a + b) >> 1); break;
          case 4: {
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: throw new Error('bad png filter');
        }
        out[dst + x] = v & 0xFF;
      }
    }
    return out;
  }

  // Decode one image XObject into something we can draw on a canvas,
  // or return null if it's a kind we leave untouched.
  async function decodeImage(stream) {
    const d = stream.dict;
    const w = d.lookup(N('Width')), h = d.lookup(N('Height'));
    const bpc = d.lookup(N('BitsPerComponent'));
    if (!(w instanceof PDFNumber) || !(h instanceof PDFNumber)) return null;
    const W = w.asNumber(), H = h.asNumber();
    if (W * H < 128 * 128) return null;
    if (d.lookup(N('ImageMask'))) return null;
    if (d.lookup(N('Decode'))) return null;
    if (d.lookup(N('Mask')) instanceof PDFArray) return null; // colour-key mask needs exact colours
    const fl = filters(d);
    const isDct = fl.length === 1 && fl[0] === N('DCTDecode');
    // Only 8-bit images. JPEGs sometimes leave BitsPerComponent out.
    if (bpc ? !(bpc instanceof PDFNumber && bpc.asNumber() === 8) : !isDct) return null;
    const color = colorInfo(d);
    if (!color) return null;
    if (isDct) {
      const bytes = stream.contents;
      const comps = jpegComponents(bytes);
      if (comps !== color.comps) return null;
      // colorSpaceConversion 'none': keep the raw values. The PDF keeps its own
      // color profile, so letting the browser convert too would double-apply it.
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'none', colorSpaceConversion: 'none' });
      // A browser that applied an EXIF rotation would hand back swapped sides.
      if (bmp.width !== W || bmp.height !== H) { bmp.close && bmp.close(); return null; }
      return { source: bmp, W, H, comps: color.comps, close: () => bmp.close && bmp.close() };
    }
    const lossless = fl.every((f) => f === N('FlateDecode') || f === N('LZWDecode') || f === N('RunLengthDecode') || f === N('ASCII85Decode') || f === N('ASCIIHexDecode'));
    if (!lossless) return null; // JPX, JBIG2, CCITT: leave alone
    let data = decodePDFRawStream(stream).decode();
    const parms = d.lookup(N('DecodeParms'));
    const pd = parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms;
    if (pd instanceof PDFDict) {
      const pred = pd.lookup(N('Predictor'));
      const p = pred instanceof PDFNumber ? pred.asNumber() : 1;
      if (p === 2) return null;
      if (p >= 10) {
        const colors = (pd.lookup(N('Colors')) || PDFNumber.of(1)).asNumber();
        const pbpc = (pd.lookup(N('BitsPerComponent')) || PDFNumber.of(8)).asNumber();
        const cols = (pd.lookup(N('Columns')) || PDFNumber.of(1)).asNumber();
        const bpp = Math.max(1, Math.ceil(colors * pbpc / 8));
        const rowLen = Math.ceil(cols * colors * pbpc / 8);
        data = pngUnfilter(data, cols, bpp, rowLen);
      }
    }
    const comps = color.comps;
    if (data.length < W * H * comps) return null;
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0, j = 0; i < W * H; i++, j += comps) {
      const o = i * 4;
      if (comps === 3) { rgba[o] = data[j]; rgba[o + 1] = data[j + 1]; rgba[o + 2] = data[j + 2]; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = data[j]; }
      rgba[o + 3] = 255;
    }
    // An ImageBitmap avoids a full-size canvas, which phones cap at ~16 megapixels.
    const bmp = await createImageBitmap(new ImageData(rgba, W, H));
    return { source: bmp, W, H, comps, close: () => bmp.close && bmp.close() };
  }

  async function encodeJpeg(img, maxDim, quality) {
    const scale = Math.min(1, maxDim / Math.max(img.W, img.H));
    const w = Math.max(1, Math.round(img.W * scale));
    const h = Math.max(1, Math.round(img.H * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
    c.width = c.height = 1;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  }

  async function deflate(bytes) {
    const cs = new CompressionStream('deflate');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  }

  const KEEP_OUT = new Set(['/Width', '/Height', '/ColorSpace', '/BitsPerComponent', '/Filter', '/DecodeParms', '/Length', '/Decode', '/DL']);

  // Walk everything reachable from the trailer and drop the rest
  // (old revisions and orphans that a PDF editor left behind).
  function dropUnreachable(ctx) {
    const seen = new Set();
    const stack = [];
    const push = (o) => { if (o) stack.push(o); };
    push(ctx.trailerInfo.Root);
    push(ctx.trailerInfo.Info);
    while (stack.length) {
      const o = stack.pop();
      if (o instanceof PDFRef) {
        const key = o.tag;
        if (seen.has(key)) continue;
        seen.add(key);
        push(ctx.lookup(o));
      } else if (o instanceof PDFDict) {
        for (const [, v] of o.entries()) push(v);
      } else if (o instanceof PDFArray) {
        for (const v of o.asArray()) push(v);
      } else if (o instanceof PDFStream) {
        push(o.dict);
      }
    }
    let dropped = 0;
    for (const [ref] of ctx.enumerateIndirectObjects()) {
      if (!seen.has(ref.tag)) { ctx.delete(ref); dropped++; }
    }
    return dropped;
  }

  async function compressOne(file, onProgress) {
    const orig = new Uint8Array(await file.arrayBuffer());
    const doc = await loadPdf(orig);
    const ctx = doc.context;
    const L = LEVELS[level()];

    // SMask images are transparency masks. Keep them lossless.
    const smaskRefs = new Set();
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream || obj instanceof PDFDict) {
        const d = obj instanceof PDFStream ? obj.dict : obj;
        const sm = d.get(N('SMask'));
        if (sm instanceof PDFRef) smaskRefs.add(sm.tag);
      }
    }

    const objs = ctx.enumerateIndirectObjects();
    const images = objs.filter(([ref, o]) => o instanceof PDFRawStream && o.dict.lookup(N('Subtype')) === N('Image') && !smaskRefs.has(ref.tag));
    let shrunk = 0;
    for (let i = 0; i < images.length; i++) {
      const [ref, stream] = images[i];
      onProgress(`Shrinking images: ${i + 1} of ${images.length}`, images.length ? i / images.length : 0);
      let img = null;
      try {
        img = await decodeImage(stream);
        if (!img) continue;
        const enc = await encodeJpeg(img, L.maxDim, L.quality);
        if (enc.bytes.length >= stream.contents.length * 0.9) continue;
        const nd = ctx.obj({
          Type: 'XObject', Subtype: 'Image', Width: enc.w, Height: enc.h,
          BitsPerComponent: 8, Filter: 'DCTDecode',
        });
        nd.set(N('ColorSpace'), img.comps === 3 ? stream.dict.get(N('ColorSpace')) : N('DeviceRGB'));
        for (const [k, v] of stream.dict.entries()) {
          const ks = k.toString();
          if (!KEEP_OUT.has(ks) && !nd.has(k)) nd.set(k, v);
        }
        ctx.assign(ref, PDFRawStream.of(nd, enc.bytes));
        shrunk++;
      } catch (e) {
        console.warn('left image as-is', e);
      } finally {
        if (img) img.close();
      }
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }

    onProgress('Packing the rest', 0.95);
    // Lossless: compress any stream that was stored raw.
    for (const [ref, o] of ctx.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue;
      if (o.dict.get(N('Filter'))) continue;
      if (o.dict.lookup(N('Type')) === N('Metadata')) continue;
      if (o.contents.length < 512) continue;
      const z = await deflate(o.contents);
      if (z.length < o.contents.length * 0.9) {
        o.dict.set(N('Filter'), N('FlateDecode'));
        ctx.assign(ref, PDFRawStream.of(o.dict, z));
      }
    }

    if (comp.strip.checked) {
      const infoRef = ctx.trailerInfo.Info;
      const info = infoRef && ctx.lookup(infoRef);
      if (info instanceof PDFDict) for (const k of info.keys()) info.delete(k);
      doc.catalog.delete(N('Metadata'));
    }

    dropUnreachable(ctx);
    const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
    return { orig: orig.length, bytes, shrunk, images: images.length, pages: doc.getPageCount() };
  }

  function renderCompress() {
    comp.list.textContent = '';
    for (const it of comp.files) {
      let metaText = 'Waiting…', cls = 'fr-meta', actions = [];
      if (it.state === 'working') metaText = it.msg || 'Working…';
      else if (it.state === 'error') { metaText = it.msg; cls += ' err'; }
      else if (it.state === 'done') {
        const r = it.result;
        const saved = 1 - r.bytes.length / r.orig;
        if (saved < 0.02) {
          metaText = `Already about as small as it gets (${lol.formatBytes(r.orig)}). Keep your original.`;
        } else {
          metaText = `${lol.formatBytes(r.orig)} → ${lol.formatBytes(r.bytes.length)} (${Math.round(saved * 100)}% smaller)`;
          cls += ' ok';
          const name = `${lol.baseName(it.file.name)}-smaller.pdf`;
          actions.push(lol.el('button', {
            class: 'mini-btn', type: 'button', text: 'Download', 'aria-label': `Download ${name}`,
            onclick: () => lol.download(new Blob([r.bytes], { type: 'application/pdf' }), name),
          }));
        }
      }
      comp.list.append(lol.el('li', { class: 'file-row' }, [
        lol.el('span', { class: 'fr-thumb', 'aria-hidden': 'true', style: 'display:grid;place-items:center;font-family:var(--font-mono);font-size:.7rem;color:var(--fg-muted)', text: 'PDF' }),
        lol.el('span', { class: 'fr-main' }, [
          lol.el('span', { class: 'fr-name', text: it.file.name }),
          lol.el('span', { class: cls, text: metaText }),
        ]),
        lol.el('span', { class: 'fr-actions' }, actions),
      ]));
    }
  }

  async function runCompress() {
    if (comp.running) { comp.rerun = true; return; }
    comp.running = true;
    do {
      comp.rerun = false;
      comp.files.forEach((f) => { f.state = 'waiting'; f.result = null; });
      renderCompress();
      lol.setStatus(comp.status, '');
      for (let i = 0; i < comp.files.length; i++) {
        if (comp.rerun) break;
        const it = comp.files[i];
        it.state = 'working';
        renderCompress();
        try {
          it.result = await compressOne(it.file, (msg, frac) => {
            it.msg = msg;
            lol.setProgress(comp.progress, (i + frac) / comp.files.length);
            const row = comp.list.children[i];
            if (row) row.querySelector('.fr-meta').textContent = msg;
          });
          it.state = 'done';
        } catch (e) {
          console.error(e);
          it.state = 'error';
          it.msg = friendlyError(e);
        }
        renderCompress();
      }
    } while (comp.rerun);
    lol.setProgress(comp.progress, null);
    const done = comp.files.filter((f) => f.state === 'done' && f.result.bytes.length < f.result.orig * 0.98);
    if (done.length) lol.setStatus(comp.status, `Done. Click Download to save${done.length > 1 ? ' each file' : ''}.`, 'ok');
    comp.running = false;
  }

  lol.dropzone(document.getElementById('compressDrop'), (files) => {
    const pdfs = files.filter(isPdf);
    if (!pdfs.length) { lol.setStatus(comp.status, 'That isn\'t a PDF. Drop a .pdf file.', 'err'); return; }
    comp.files = pdfs.map((file) => ({ file, state: 'waiting' }));
    runCompress();
  });

  renderMerge();
})();
