/*
  pdf.lol PDF-to-JPG tool. PDF.js draws each page on a canvas, the browser
  saves it as JPG or PNG, fflate builds the ZIP. Nothing is uploaded.
*/
(function () {
  'use strict';
  if (document.body.dataset.tool !== 'tojpg') return;
  const lol = window.lol;
  const T = window.pdfTools;
  const $ = (id) => document.getElementById(id);

  const statusEl = $('tojpgStatus');
  const list = $('tojpgList');
  const progress = $('tojpgProgress');
  const state = { file: null, bytes: null, items: [], running: false };
  const fmt = () => document.querySelector('input[name="tjfmt"]:checked').value;

  async function convert(file) {
    if (!T.isPdf(file)) { lol.setStatus(statusEl, 'That isn\'t a PDF. Drop a .pdf file.', 'err'); return; }
    state.file = file;
    state.bytes = new Uint8Array(await file.arrayBuffer());
    state.lastSig = null;
    await run();
  }

  async function run() {
    if (!state.bytes) return;
    // Only redraw when a setting really changed. (Leaving the page box fires
    // "change" even when nothing changed, and redrawing then would eat the click
    // on a Save button.)
    const sig = [state.file && state.file.name, state.file && state.file.size, $('tjDpi').value, fmt(), $('tjPages').value.replace(/\s+/g, '')].join('|');
    if (sig === state.lastSig && !state.rerun) return;
    // A settings change while a run is going restarts it once the current page finishes.
    if (state.running) { state.rerun = true; return; }
    state.lastSig = sig;
    state.running = true;
    state.rerun = false;
    state.items.forEach((it) => it.url && URL.revokeObjectURL(it.url));
    state.items = [];
    list.textContent = '';
    $('tojpgBulk').hidden = true;
    $('tojpgZip').disabled = true;
    lol.setStatus(statusEl, 'Opening…');
    let pdf;
    try {
      await T.loadLib(state.bytes); // clear message for locked files
      pdf = await T.openWithPdfjs(state.bytes);
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
      state.running = false;
      return;
    }
    let pages;
    try {
      pages = T.parseRanges($('tjPages').value, pdf.numPages);
      if (!pages.length) pages = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    } catch (e) {
      lol.setStatus(statusEl, e.message, 'err');
      state.running = false;
      return;
    }
    const dpi = parseInt($('tjDpi').value, 10);
    const type = fmt() === 'png' ? 'image/png' : 'image/jpeg';
    const ext = fmt() === 'png' ? 'png' : 'jpg';
    const base = lol.baseName(state.file.name);
    const pad = String(pdf.numPages).length;
    let capped = 0;
    $('tojpgBulk').hidden = false;
    try {
      for (let i = 0; i < pages.length; i++) {
        if (state.rerun) break;
        const n = pages[i];
        lol.setStatus(statusEl, `Drawing page ${i + 1} of ${pages.length}…`);
        lol.setProgress(progress, i / pages.length);
        const r = await T.renderPage(pdf, n, dpi / 72);
        if (r.capped) capped++;
        const blob = await new Promise((res) => r.canvas.toBlob(res, type, type === 'image/jpeg' ? 0.9 : undefined));
        r.canvas.width = r.canvas.height = 1;
        if (!blob) throw new Error('Your browser ran out of room for a page this large.');
        const name = `${base}-page-${String(n).padStart(pad, '0')}.${ext}`;
        const url = URL.createObjectURL(blob);
        const item = { name, blob, url };
        state.items.push(item);
        list.append(lol.el('li', { class: 'file-row' }, [
          lol.el('img', { class: 'fr-thumb', src: url, alt: '' }),
          lol.el('span', { class: 'fr-main' }, [
            lol.el('span', { class: 'fr-name', text: name }),
            lol.el('span', { class: 'fr-meta ok', text: `${Math.round(r.width)}×${Math.round(r.height)} · ${lol.formatBytes(blob.size)}${r.capped ? ' · scaled down to fit your browser' : ''}` }),
          ]),
          lol.el('span', { class: 'fr-actions' }, [
            lol.el('button', { class: 'mini-btn', type: 'button', text: 'Save', 'aria-label': `Save ${name}`, onclick: () => lol.download(blob, name) }),
          ]),
        ]));
        await T.yieldUI();
      }
      const total = state.items.reduce((s, x) => s + x.blob.size, 0);
      if (state.rerun) return; // a newer run takes over
      lol.setStatus(statusEl, `${state.items.length} image${state.items.length === 1 ? '' : 's'} ready (${lol.formatBytes(total)}).${capped ? ` ${capped} very large page${capped === 1 ? ' was' : 's were'} scaled down to fit what your browser can draw.` : ''}`, 'ok');
      $('tojpgZip').disabled = false;
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, T.friendlyError(e), 'err');
    } finally {
      lol.setProgress(progress, null);
      state.running = false;
      pdf && pdf.destroy && pdf.destroy();
      if (state.rerun) run();
    }
  }

  $('tojpgZip').addEventListener('click', async () => {
    if (!state.items.length) return;
    $('tojpgZip').disabled = true;
    lol.setStatus(statusEl, 'Building the ZIP…');
    try {
      const entries = {};
      for (const it of state.items) entries[it.name] = [new Uint8Array(await it.blob.arrayBuffer()), { level: 0 }];
      const zip = window.fflate.zipSync(entries);
      const name = `${lol.baseName(state.file.name)}-${state.items.length}-pages.zip`;
      lol.download(new Blob([zip], { type: 'application/zip' }), name);
      lol.setStatus(statusEl, `Saved ${name} (${lol.formatBytes(zip.length)}).`, 'ok');
    } catch (e) {
      console.error(e);
      lol.setStatus(statusEl, 'The ZIP was too big for your browser. Save the pages one at a time instead.', 'err');
    } finally {
      $('tojpgZip').disabled = false;
    }
  });

  $('tojpgClear').addEventListener('click', () => {
    state.items.forEach((it) => URL.revokeObjectURL(it.url));
    state.items = []; state.bytes = null; state.file = null; state.lastSig = null;
    list.textContent = '';
    $('tojpgBulk').hidden = true;
    lol.setStatus(statusEl, '');
  });

  // Changing a setting re-runs on the same file.
  ['tjDpi', 'tjPages'].forEach((id) => $(id).addEventListener('change', run));
  document.querySelectorAll('input[name="tjfmt"]').forEach((r) => r.addEventListener('change', run));

  lol.dropzone($('tojpgDrop'), (files) => convert(files[0]));
  window.__tojpgReady = true;
})();
