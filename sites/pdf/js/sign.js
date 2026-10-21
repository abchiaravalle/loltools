/*
  pdf.lol Sign tool. Draw or type a signature, place it (plus a date or text)
  on the pages, then pdf-lib stamps it into the PDF. The signature only lives
  in this tab's memory. Nothing is stored or uploaded.
*/
(function () {
  'use strict';
  if (document.body.dataset.tool !== 'sign') return;
  const lol = window.lol;
  const T = window.pdfTools;
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const $ = (id) => document.getElementById(id);

  const state = {
    file: null, bytes: null, pdf: null, pages: [], // pages: [{ num, el, wPt, hPt }]
    sigPng: null, sigAspect: 3, overlays: [], placing: null,
  };
  const statusEl = $('signStatus');

  // ---------------------------------------------------------------------------
  // Signature pad
  // ---------------------------------------------------------------------------
  const dialog = $('sigDialog');
  const pad = $('sigPad');
  const typed = $('sigTyped');
  const pctx = pad.getContext('2d');
  let strokes = [];
  let drawing = null;
  const ink = () => document.querySelector('input[name="ink"]:checked').value;
  const sigMode = () => document.querySelector('input[name="sigmode"]:checked').value;

  function padPoint(e) {
    const r = pad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (pad.width / r.width), y: (e.clientY - r.top) * (pad.height / r.height), p: e.pressure || 0.5 };
  }
  function redrawPad() {
    pctx.clearRect(0, 0, pad.width, pad.height);
    pctx.strokeStyle = ink();
    pctx.lineCap = 'round'; pctx.lineJoin = 'round';
    for (const s of strokes) {
      if (s.length === 1) {
        pctx.beginPath(); pctx.fillStyle = ink(); pctx.arc(s[0].x, s[0].y, 2.2, 0, Math.PI * 2); pctx.fill();
        continue;
      }
      pctx.beginPath();
      pctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length - 1; i++) {
        const mx = (s[i].x + s[i + 1].x) / 2, my = (s[i].y + s[i + 1].y) / 2;
        pctx.lineWidth = 3.2;
        pctx.quadraticCurveTo(s[i].x, s[i].y, mx, my);
      }
      const last = s[s.length - 1];
      pctx.lineTo(last.x, last.y);
      pctx.stroke();
    }
  }
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    drawing = [padPoint(e)];
    strokes.push(drawing);
    redrawPad();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs) drawing.push(padPoint(ev));
    redrawPad();
  });
  const endStroke = () => { drawing = null; };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  function renderTyped() {
    const c = typed.getContext('2d');
    c.clearRect(0, 0, typed.width, typed.height);
    const name = $('sigName').value.trim();
    if (!name) return;
    let size = 96;
    const font = (s) => `italic ${s}px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive`;
    c.font = font(size);
    while (c.measureText(name).width > typed.width * 0.9 && size > 24) { size -= 4; c.font = font(size); }
    c.fillStyle = ink();
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    c.fillText(name, typed.width / 2, typed.height / 2);
  }
  $('sigName').addEventListener('input', renderTyped);
  document.querySelectorAll('input[name="ink"]').forEach((r) => r.addEventListener('change', () => { redrawPad(); renderTyped(); }));
  document.querySelectorAll('input[name="sigmode"]').forEach((r) => r.addEventListener('change', () => {
    const t = sigMode() === 'type';
    $('sigDrawWrap').hidden = t;
    $('sigTypeWrap').hidden = !t;
    if (t) { $('sigName').focus(); renderTyped(); }
  }));
  $('sigClear').addEventListener('click', () => { strokes = []; redrawPad(); $('sigName').value = ''; renderTyped(); });
  $('sigCancel').addEventListener('click', () => dialog.close());

  // Crop a canvas to its inked pixels, with a little padding.
  function trimCanvas(src) {
    const ctx = src.getContext('2d');
    const { width: w, height: h } = src;
    const d = ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  $('sigUse').addEventListener('click', async () => {
    // Re-render at 2x for a crisp stamp.
    const src = sigMode() === 'type' ? typed : pad;
    const big = document.createElement('canvas');
    big.width = src.width * 2; big.height = src.height * 2;
    const bctx = big.getContext('2d');
    if (src === pad) {
      bctx.scale(2, 2);
      bctx.strokeStyle = ink(); bctx.fillStyle = ink(); bctx.lineCap = 'round'; bctx.lineJoin = 'round'; bctx.lineWidth = 3.2;
      for (const s of strokes) {
        if (s.length === 1) { bctx.beginPath(); bctx.arc(s[0].x, s[0].y, 2.2, 0, Math.PI * 2); bctx.fill(); continue; }
        bctx.beginPath(); bctx.moveTo(s[0].x, s[0].y);
        for (let i = 1; i < s.length - 1; i++) bctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
        bctx.lineTo(s[s.length - 1].x, s[s.length - 1].y); bctx.stroke();
      }
    } else {
      bctx.drawImage(src, 0, 0, big.width, big.height);
    }
    const trimmed = trimCanvas(big);
    if (!trimmed) { lol.setStatus(statusEl, sigMode() === 'type' ? 'Type your name first.' : 'Draw your signature in the box first.', 'err'); return; }
    const blob = await new Promise((r) => trimmed.toBlob(r, 'image/png'));
    state.sigPng = new Uint8Array(await blob.arrayBuffer());
    state.sigUrl && URL.revokeObjectURL(state.sigUrl);
    state.sigUrl = URL.createObjectURL(blob);
    state.sigAspect = trimmed.width / trimmed.height;
    dialog.close();
    $('sigCreateLabel').textContent = 'Change signature';
    $('addSig').disabled = false;
    armPlacing('sig');
    lol.setStatus(statusEl, 'Now tap the page where your signature goes.');
  });

  $('sigCreate').addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    redrawPad();
  });

  // ---------------------------------------------------------------------------
  // Placing overlays
  // ---------------------------------------------------------------------------
  function armPlacing(kind) {
    state.placing = kind;
    ['addSig', 'addDate', 'addText'].forEach((id) => $(id).classList.remove('armed'));
    const btn = { sig: 'addSig', date: 'addDate', text: 'addText' }[kind];
    if (btn) $(btn).classList.add('armed');
    state.pages.forEach((p) => p.el.classList.toggle('placing', !!kind));
  }
  $('addSig').addEventListener('click', () => armPlacing(state.placing === 'sig' ? null : 'sig'));
  $('addDate').addEventListener('click', () => armPlacing(state.placing === 'date' ? null : 'date'));
  $('addText').addEventListener('click', () => armPlacing(state.placing === 'text' ? null : 'text'));

  const today = () => new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  // Overlay geometry is stored in PDF points relative to the page's top-left,
  // so it stays right at any on-screen size.
  function addOverlay(page, kind, xPt, yPt) {
    const ov = { page, kind, x: xPt, y: yPt, w: 0, h: 0, text: '' };
    if (kind === 'sig') {
      ov.w = Math.min(page.wPt * 0.32, 180); ov.h = ov.w / state.sigAspect;
    } else {
      ov.text = kind === 'date' ? today() : 'Your text';
      ov.size = 12;
      ov.w = Math.max(60, ov.text.length * ov.size * 0.55); ov.h = ov.size * 1.3;
    }
    ov.x = Math.max(0, Math.min(page.wPt - ov.w, ov.x - ov.w / 2));
    ov.y = Math.max(0, Math.min(page.hPt - ov.h, ov.y - ov.h / 2));
    const el = document.createElement('div');
    el.className = 'overlay' + (kind === 'sig' ? '' : ' text-ov');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', kind === 'sig' ? 'Signature' : 'Text box');
    if (kind === 'sig') {
      const img = document.createElement('img'); img.src = state.sigUrl; img.alt = '';
      el.append(img);
    } else {
      const ta = document.createElement('input');
      ta.type = 'text'; ta.className = 'ov-text'; ta.value = ov.text; ta.setAttribute('aria-label', 'Text');
      ta.addEventListener('input', () => { ov.text = ta.value; ov.w = Math.max(40, ta.value.length * ov.size * 0.55 + 6); layout(ov); });
      el.append(ta);
      ov.input = ta;
    }
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ov-del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Remove');
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', () => { el.remove(); state.overlays = state.overlays.filter((o) => o !== ov); refresh(); });
    const size = document.createElement('span');
    size.className = 'ov-size'; size.textContent = '⤡'; size.setAttribute('aria-hidden', 'true');
    el.append(del, size);
    page.el.append(el);
    ov.el = el;
    state.overlays.push(ov);
    layout(ov);
    dragify(ov, el, size);
    refresh();
    if (ov.input) setTimeout(() => { ov.input.focus(); ov.input.select(); }, 0);
    return ov;
  }

  function pxPerPt(page) { return page.el.getBoundingClientRect().width / page.wPt; }
  function layout(ov) {
    const k = pxPerPt(ov.page);
    ov.el.style.left = ov.x * k + 'px';
    ov.el.style.top = ov.y * k + 'px';
    ov.el.style.width = ov.w * k + 'px';
    ov.el.style.height = ov.h * k + 'px';
    if (ov.input) ov.input.style.fontSize = ov.size * k + 'px';
  }
  window.addEventListener('resize', () => state.overlays.forEach(layout));

  function dragify(ov, el, handle) {
    let start = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target === handle) return;
      // A text box that's being edited keeps normal text selection.
      if (ov.input && document.activeElement === ov.input && e.target === ov.input) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      start = { mx: e.clientX, my: e.clientY, x: ov.x, y: ov.y, mode: 'move', moved: 0 };
    });
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      start = { mx: e.clientX, my: e.clientY, w: ov.w, h: ov.h, size: ov.size, mode: 'size' };
    });
    const move = (e) => {
      if (!start) return;
      const k = pxPerPt(ov.page);
      const dx = (e.clientX - start.mx) / k, dy = (e.clientY - start.my) / k;
      if (start.mode === 'move') {
        start.moved = Math.max(start.moved, Math.abs(e.clientX - start.mx) + Math.abs(e.clientY - start.my));
        ov.x = Math.max(0, Math.min(ov.page.wPt - ov.w, start.x + dx));
        ov.y = Math.max(0, Math.min(ov.page.hPt - ov.h, start.y + dy));
      } else if (ov.kind === 'sig') {
        const w = Math.max(30, Math.min(ov.page.wPt - ov.x, start.w + dx));
        ov.w = w; ov.h = w / state.sigAspect;
      } else {
        const f = Math.max(0.4, (start.h + dy) / start.h);
        ov.size = Math.max(6, Math.min(72, start.size * f));
        ov.h = ov.size * 1.3;
        ov.w = Math.max(40, ov.text.length * ov.size * 0.55 + 6);
      }
      layout(ov);
    };
    const end = () => {
      // A tap (no real drag) on a text box puts the cursor in it.
      if (start && start.mode === 'move' && start.moved < 4 && ov.input) ov.input.focus();
      start = null;
    };
    el.addEventListener('pointermove', move);
    handle.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end); handle.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end); handle.addEventListener('pointercancel', end);
  }

  function refresh() {
    $('signSave').disabled = !state.overlays.length;
  }

  // ---------------------------------------------------------------------------
  // Load a PDF and show its pages
  // ---------------------------------------------------------------------------
  async function load(file) {
    if (!T.isPdf(file)) { lol.setStatus(statusEl, 'That isn\'t a PDF. Drop a .pdf file.', 'err'); return; }
    lol.setStatus(statusEl, 'Opening…');
    try {
      state.bytes = new Uint8Array(await file.arrayBuffer());
      await T.loadLib(state.bytes); // fails early on locked or broken files
      state.pdf = await T.openWithPdfjs(state.bytes);
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
      return;
    }
    state.file = file;
    state.overlays = [];
    state.pages = [];
    const host = $('signPages');
    host.textContent = '';
    $('signDrop').hidden = true;
    $('signWork').hidden = false;
    const n = state.pdf.numPages;
    const shown = Math.min(n, 60);
    for (let i = 1; i <= shown; i++) {
      const pg = await state.pdf.getPage(i);
      const vp1 = pg.getViewport({ scale: 1 });
      const el = document.createElement('div');
      el.className = 'sign-page';
      el.style.width = Math.min(760, vp1.width * 1.3) + 'px';
      el.dataset.page = i;
      const label = document.createElement('span'); label.className = 'pg-num'; label.textContent = `Page ${i}`;
      const canvas = document.createElement('canvas');
      el.append(canvas, label);
      host.append(el);
      const page = { num: i, el, wPt: vp1.width, hPt: vp1.height, vp: vp1 };
      state.pages.push(page);
      const cssW = Math.min(760, vp1.width * 1.3);
      await T.renderPage(state.pdf, i, (cssW / vp1.width) * Math.min(2, window.devicePixelRatio || 1), { canvas });
      el.addEventListener('pointerdown', (e) => {
        if (!state.placing || e.target.closest('.overlay')) return;
        const r = el.getBoundingClientRect();
        const k = r.width / page.wPt;
        addOverlay(page, state.placing, (e.clientX - r.left) / k, (e.clientY - r.top) / k);
        armPlacing(null);
        lol.setStatus(statusEl, 'Drag to move it, use the corner to resize. Add more, or download.');
      });
      await T.yieldUI();
    }
    lol.setStatus(statusEl, n > shown
      ? `Showing the first ${shown} of ${n} pages. You can sign any of these.`
      : `${n} page${n === 1 ? '' : 's'}. ${state.sigPng ? 'Click "Place signature", then tap the page.' : 'Create your signature to start.'}`);
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------
  $('signSave').addEventListener('click', async () => {
    $('signSave').disabled = true;
    lol.setStatus(statusEl, 'Saving…');
    try {
      const doc = await PDFDocument.load(state.bytes, { updateMetadata: false });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const img = state.sigPng ? await doc.embedPng(state.sigPng) : null;
      const pages = doc.getPages();
      const { degrees } = window.PDFLib;
      for (const ov of state.overlays) {
        const p = pages[ov.page.num - 1];
        // PDF.js knows exactly how the page is shown (crop box offset + rotation).
        // Map the box's on-screen bottom-left corner back to PDF space, and turn
        // the stamp by the page's rotation so it reads upright on screen.
        const vp = ov.page.vp;
        const rot = ((vp.rotation % 360) + 360) % 360;
        if (ov.kind === 'sig') {
          const [x, y] = vp.convertToPdfPoint(ov.x, ov.y + ov.h);
          p.drawImage(img, { x, y, width: ov.w, height: ov.h, rotate: degrees(rot) });
        } else {
          const text = ov.text.trim();
          if (!text) continue;
          // Baseline sits a little above the bottom of the box.
          const [x, y] = vp.convertToPdfPoint(ov.x + 2, ov.y + ov.h - ov.size * 0.27);
          p.drawText(text, { x, y, size: ov.size, font, color: rgb(0.067, 0.067, 0.067), rotate: degrees(rot) });
        }
      }
      const out = await doc.save({ useObjectStreams: true });
      const name = `${lol.baseName(state.file.name)}-signed.pdf`;
      lol.download(new Blob([out], { type: 'application/pdf' }), name);
      lol.setStatus(statusEl, `Saved as ${name}. Your signature wasn't stored anywhere.`, 'ok');
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
    } finally {
      $('signSave').disabled = !state.overlays.length;
    }
  });

  $('signReset').addEventListener('click', () => {
    state.overlays = []; state.pages = []; state.pdf = null; state.bytes = null; state.file = null;
    $('signPages').textContent = '';
    $('signWork').hidden = true;
    $('signDrop').hidden = false;
    armPlacing(null);
    refresh();
    lol.setStatus(statusEl, '');
  });

  lol.dropzone($('signDrop'), (files) => load(files[0]));
  window.__signReady = true;
})();
