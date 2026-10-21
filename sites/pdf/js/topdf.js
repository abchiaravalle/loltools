/*
  pdf.lol JPG-to-PDF tool. Images become pages, in the order you set.
  JPEGs go in as-is (no quality loss) unless they need turning upright;
  other formats are drawn once and saved as PNG (lossless) or JPEG (photos).
  Nothing is uploaded.
*/
(function () {
  'use strict';
  if (document.body.dataset.tool !== 'topdf') return;
  const lol = window.lol;
  const T = window.pdfTools;
  const { PDFDocument } = window.PDFLib;
  const $ = (id) => document.getElementById(id);

  const statusEl = $('topdfStatus');
  const list = $('topdfList');
  let items = [];
  let seq = 0;

  const SIZES = { letter: [612, 792], a4: [595.28, 841.89] };

  function jpegOrientation(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return 1;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && off + 10 < v.byteLength && v.getUint32(off + 4) === 0x45786966) {
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

  const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);

  function add(files) {
    for (const file of files) {
      const it = { id: ++seq, file, error: null, url: null };
      if (isHeic(file)) it.error = 'HEIC photos need converting first. heic.lol does it in your browser.';
      else if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(file.name)) it.error = 'Not an image, so it\'s skipped.';
      else it.url = URL.createObjectURL(file);
      items.push(it);
    }
    render();
  }

  function move(id, d) {
    const i = items.findIndex((x) => x.id === id), j = i + d;
    if (i < 0 || j < 0 || j >= items.length) return;
    const [it] = items.splice(i, 1);
    items.splice(j, 0, it);
    render();
  }

  function render() {
    list.textContent = '';
    items.forEach((it, idx) => {
      list.append(lol.el('li', { class: 'file-row' }, [
        it.url ? lol.el('img', { class: 'fr-thumb', src: it.url, alt: '' }) : lol.el('span', { class: 'fr-thumb', 'aria-hidden': 'true' }),
        lol.el('span', { class: 'fr-main' }, [
          lol.el('span', { class: 'fr-name', text: `${idx + 1}. ${it.file.name}` }),
          lol.el('span', { class: 'fr-meta' + (it.error ? ' err' : ''), text: it.error || lol.formatBytes(it.file.size) }),
        ]),
        lol.el('span', { class: 'fr-actions' }, [
          lol.el('button', { class: 'mini-btn', type: 'button', title: 'Move up', 'aria-label': `Move ${it.file.name} up`, disabled: idx === 0, onclick: () => move(it.id, -1), text: '↑' }),
          lol.el('button', { class: 'mini-btn', type: 'button', title: 'Move down', 'aria-label': `Move ${it.file.name} down`, disabled: idx === items.length - 1, onclick: () => move(it.id, 1), text: '↓' }),
          lol.el('button', { class: 'mini-btn', type: 'button', title: 'Remove', 'aria-label': `Remove ${it.file.name}`, onclick: () => { it.url && URL.revokeObjectURL(it.url); items = items.filter((x) => x !== it); render(); }, text: '✕' }),
        ]),
      ]));
    });
    const good = items.filter((x) => !x.error);
    $('topdfBtn').disabled = !good.length;
    $('topdfClear').disabled = !items.length;
    $('topdfHint').hidden = items.length < 2;
    if (good.length) lol.setStatus(statusEl, `${good.length} image${good.length === 1 ? '' : 's'}, ${good.length} page${good.length === 1 ? '' : 's'}.`);
    else if (!items.length) lol.setStatus(statusEl, '');
  }

  // Decode an image with the browser and re-save it, upright.
  async function redraw(file, type) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, type, type === 'image/jpeg' ? 0.92 : undefined));
    c.width = c.height = 1;
    if (!blob) throw new Error('Your browser couldn\'t handle an image this large.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function embed(doc, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isJpg = bytes[0] === 0xFF && bytes[1] === 0xD8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (isJpg && jpegOrientation(bytes) === 1) {
      try { return await doc.embedJpg(bytes); } catch (_) { /* CMYK/progressive oddities fall through */ }
    }
    if (isPng) {
      try { return await doc.embedPng(bytes); } catch (_) { /* 16-bit / odd PNGs fall through */ }
    }
    // Photos stay JPEG; anything that might have transparency stays PNG.
    const asJpeg = isJpg || /webp|avif|bmp/i.test(file.type);
    return asJpeg ? doc.embedJpg(await redraw(file, 'image/jpeg')) : doc.embedPng(await redraw(file, 'image/png'));
  }

  $('topdfBtn').addEventListener('click', async () => {
    const good = items.filter((x) => !x.error);
    if (!good.length) return;
    $('topdfBtn').disabled = true;
    const sizeKey = $('tpSize').value;
    const margin = parseFloat($('tpMargin').value) || 0;
    lol.setProgress($('topdfProgress'), 0);
    try {
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.setProducer('pdf.lol');
      for (let i = 0; i < good.length; i++) {
        lol.setStatus(statusEl, `Adding image ${i + 1} of ${good.length}…`);
        let img;
        try {
          img = await embed(doc, good[i].file);
        } catch (e) {
          console.error(e);
          throw new Error(`"${good[i].file.name}" couldn't be read as an image.`);
        }
        let pw, ph;
        if (sizeKey === 'fit') {
          // Long side = 11 inches, shape kept, margin added around it.
          const s = 792 / Math.max(img.width, img.height);
          pw = img.width * s + margin * 2; ph = img.height * s + margin * 2;
        } else {
          [pw, ph] = SIZES[sizeKey];
          if (img.width > img.height) [pw, ph] = [ph, pw]; // landscape photo, landscape page
        }
        const page = doc.addPage([pw, ph]);
        const bw = pw - margin * 2, bh = ph - margin * 2;
        const s = Math.min(bw / img.width, bh / img.height);
        const w = img.width * s, h = img.height * s;
        page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
        lol.setProgress($('topdfProgress'), (i + 1) / good.length);
        await T.yieldUI();
      }
      const bytes = await doc.save({ useObjectStreams: true });
      const name = good.length === 1 ? `${lol.baseName(good[0].file.name)}.pdf` : `${lol.baseName(good[0].file.name)}-and-${good.length - 1}-more.pdf`;
      lol.download(new Blob([bytes], { type: 'application/pdf' }), name);
      lol.setStatus(statusEl, `Done: ${doc.getPageCount()} page${doc.getPageCount() === 1 ? '' : 's'}, ${lol.formatBytes(bytes.length)}. Saved as ${name}.`, 'ok');
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, e.message && /couldn't/.test(e.message) ? e.message : T.friendlyError(e), 'err');
    } finally {
      setTimeout(() => lol.setProgress($('topdfProgress'), null), 800);
      $('topdfBtn').disabled = false;
    }
  });

  $('topdfClear').addEventListener('click', () => {
    items.forEach((it) => it.url && URL.revokeObjectURL(it.url));
    items = [];
    render();
  });

  lol.dropzone($('topdfDrop'), add);
  window.__topdfReady = true;
})();
