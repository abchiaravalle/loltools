/*
  pdf.lol Split tool. Pick pages, split into parts, or cut every N pages.
  pdf-lib copies the pages; PDF.js draws the thumbnails. Nothing is uploaded.
*/
(function () {
  'use strict';
  if (document.body.dataset.tool !== 'split') return;
  const lol = window.lol;
  const T = window.pdfTools;
  const { PDFDocument } = window.PDFLib;
  const $ = (id) => document.getElementById(id);

  const state = { file: null, doc: null, pdf: null, n: 0, picked: new Set(), thumbs: [] };
  const statusEl = $('splitStatus');
  const rangesEl = $('splitRanges');
  const mode = () => document.querySelector('input[name="splitmode"]:checked').value;

  const LABELS = {
    pick: { label: 'Pages to keep', hint: 'Click the pages below, or type page numbers and ranges. You get one PDF with just those pages.', ph: 'e.g. 1-3, 5, 8-10' },
    ranges: { label: 'Parts', hint: 'Each comma makes a new file. "1-3, 4-7, 8-" gives you three PDFs.', ph: 'e.g. 1-3, 4-7, 8-' },
  };

  function syncMode() {
    const m = mode();
    $('splitEveryField').hidden = m !== 'every';
    $('splitRangeField').hidden = m === 'every';
    if (LABELS[m]) {
      $('splitRangesLabel').textContent = LABELS[m].label;
      $('splitRangeHint').textContent = LABELS[m].hint;
      rangesEl.placeholder = LABELS[m].ph;
    }
    $('splitThumbs').classList.toggle('readonly', m !== 'pick');
    update();
  }
  document.querySelectorAll('input[name="splitmode"]').forEach((r) => r.addEventListener('change', syncMode));

  // Work out what we'd produce right now: an array of page-number arrays.
  function plan() {
    const m = mode();
    if (!state.n) return { groups: [] };
    try {
      if (m === 'pick') {
        const pages = T.parseRanges(rangesEl.value, state.n);
        return { groups: pages.length ? [pages] : [] };
      }
      if (m === 'ranges') return { groups: T.parseGroups(rangesEl.value, state.n) };
      const k = parseInt($('splitEvery').value, 10);
      if (!(k >= 1)) return { error: 'Enter how many pages go in each file (1 or more).' };
      const groups = [];
      for (let i = 1; i <= state.n; i += k) {
        const g = [];
        for (let j = i; j < i + k && j <= state.n; j++) g.push(j);
        groups.push(g);
      }
      return { groups };
    } catch (e) {
      return { error: e.message };
    }
  }

  function update() {
    const p = plan();
    // Thumbnail state
    const partOf = new Map();
    (p.groups || []).forEach((g, gi) => g.forEach((n) => partOf.set(n, gi + 1)));
    const multi = (p.groups || []).length > 1;
    state.thumbs.forEach((t, i) => {
      const n = i + 1;
      t.btn.setAttribute('aria-pressed', partOf.has(n) ? 'true' : 'false');
      t.part.hidden = !(multi && partOf.has(n));
      if (multi && partOf.has(n)) t.part.textContent = `#${partOf.get(n)}`;
    });
    const btn = $('splitBtn');
    if (p.error) {
      btn.disabled = true;
      lol.setStatus(statusEl, p.error, 'err');
      return;
    }
    const g = p.groups;
    btn.disabled = !g.length;
    if (!g.length) {
      $('splitBtnLabel').textContent = 'Download';
      lol.setStatus(statusEl, mode() === 'pick' ? 'Pick at least one page.' : 'Type the parts you want, like 1-3, 4-7.');
      return;
    }
    if (g.length === 1) {
      $('splitBtnLabel').textContent = `Download ${g[0].length}-page PDF`;
      lol.setStatus(statusEl, `You'll get 1 PDF with page${g[0].length === 1 ? '' : 's'} ${T.formatRanges(g[0])}.`);
    } else {
      $('splitBtnLabel').textContent = `Download ${g.length} PDFs as ZIP`;
      lol.setStatus(statusEl, `You'll get ${g.length} PDFs: ${g.slice(0, 6).map((x) => T.formatRanges(x)).join(' / ')}${g.length > 6 ? ' / …' : ''}.`);
    }
  }
  rangesEl.addEventListener('input', update);
  $('splitEvery').addEventListener('input', update);

  async function load(file) {
    if (!T.isPdf(file)) { lol.setStatus(statusEl, 'That isn\'t a PDF. Drop a .pdf file.', 'err'); return; }
    lol.setStatus(statusEl, 'Opening…');
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
      state.doc = await T.loadLib(bytes);
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
      return;
    }
    state.file = file;
    state.n = state.doc.getPageCount();
    state.thumbs = [];
    rangesEl.value = '';
    $('splitDrop').hidden = true;
    $('splitWork').hidden = false;
    const grid = $('splitThumbs');
    grid.textContent = '';
    for (let i = 1; i <= state.n; i++) {
      const btn = lol.el('button', { class: 'thumb', type: 'button', 'aria-pressed': 'false', 'aria-label': `Page ${i}` });
      const canvas = document.createElement('canvas');
      canvas.width = 90; canvas.height = 116;
      const part = lol.el('span', { class: 't-part', hidden: true });
      btn.append(canvas, lol.el('span', { class: 't-num', text: String(i) }), part);
      btn.addEventListener('click', () => {
        if (mode() !== 'pick') return;
        let pages = [];
        try { pages = T.parseRanges(rangesEl.value, state.n); } catch (_) { pages = []; }
        const set = new Set(pages);
        if (set.has(i)) set.delete(i); else set.add(i);
        rangesEl.value = T.formatRanges([...set].sort((a, b) => a - b));
        update();
      });
      grid.append(btn);
      state.thumbs.push({ btn, canvas, part });
    }
    update();
    // Thumbnails are a nicety: draw them after the grid is usable.
    try {
      state.pdf = await T.openWithPdfjs(bytes);
      const limit = Math.min(state.n, 300);
      for (let i = 1; i <= limit; i++) {
        if (state.file !== file) return;
        const pg = await state.pdf.getPage(i);
        const vp = pg.getViewport({ scale: 1 });
        await T.renderPage(state.pdf, i, 180 / Math.max(vp.width, vp.height), { canvas: state.thumbs[i - 1].canvas });
        if (i % 4 === 0) await T.yieldUI();
      }
    } catch (e) {
      console.warn('thumbnails skipped', e);
    }
  }

  $('splitBtn').addEventListener('click', async () => {
    const { groups } = plan();
    if (!groups || !groups.length) return;
    $('splitBtn').disabled = true;
    lol.setProgress($('splitProgress'), 0);
    try {
      const base = lol.baseName(state.file.name);
      const outs = [];
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const out = await PDFDocument.create({ updateMetadata: false });
        out.setProducer('pdf.lol');
        const pages = await out.copyPages(state.doc, g.map((n) => n - 1));
        pages.forEach((p) => out.addPage(p));
        const bytes = await out.save({ useObjectStreams: true });
        const label = g.length === 1 ? `page-${g[0]}` : `pages-${g[0]}-${g[g.length - 1]}`;
        outs.push({ name: `${base}-${label}.pdf`, bytes });
        lol.setProgress($('splitProgress'), (gi + 1) / groups.length);
        await T.yieldUI();
      }
      if (outs.length === 1) {
        lol.download(new Blob([outs[0].bytes], { type: 'application/pdf' }), outs[0].name);
        lol.setStatus(statusEl, `Saved ${outs[0].name} (${lol.formatBytes(outs[0].bytes.length)}).`, 'ok');
      } else {
        const entries = {};
        const used = new Set();
        outs.forEach((o, i) => {
          let n = o.name;
          if (used.has(n)) n = n.replace(/\.pdf$/, `-${i + 1}.pdf`);
          used.add(n);
          entries[n] = [o.bytes, { level: 0 }];
        });
        const zip = window.fflate.zipSync(entries);
        const zname = `${base}-split-${outs.length}-parts.zip`;
        lol.download(new Blob([zip], { type: 'application/zip' }), zname);
        lol.setStatus(statusEl, `Saved ${zname} with ${outs.length} PDFs (${lol.formatBytes(zip.length)}).`, 'ok');
      }
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
    } finally {
      setTimeout(() => lol.setProgress($('splitProgress'), null), 800);
      $('splitBtn').disabled = false;
    }
  });

  $('splitReset').addEventListener('click', () => {
    state.file = null; state.doc = null; state.pdf = null; state.n = 0; state.thumbs = [];
    $('splitThumbs').textContent = '';
    $('splitWork').hidden = true;
    $('splitDrop').hidden = false;
    lol.setStatus(statusEl, '');
  });

  lol.dropzone($('splitDrop'), (files) => load(files[0]));
  syncMode();
  window.__splitReady = true;
})();
