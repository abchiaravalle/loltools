/*
  pdf.lol shared helpers for the Sign, Split, PDF-to-JPG and JPG-to-PDF tools.
  PDF.js loads on demand from /vendor/pdfjs/ (same origin). Nothing is uploaded.
*/
(function () {
  'use strict';
  const P = {};
  let pdfjsPromise = null;

  // Load PDF.js once, from this site only.
  P.pdfjs = function () {
    if (!pdfjsPromise) {
      pdfjsPromise = import('/vendor/pdfjs/build/pdf.min.mjs').then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
        return lib;
      });
    }
    return pdfjsPromise;
  };

  P.openWithPdfjs = async function (bytes) {
    const lib = await P.pdfjs();
    const task = lib.getDocument({
      data: bytes.slice(0), // PDF.js takes ownership of the buffer
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
      isEvalSupported: false,
      enableXfa: false,
    });
    return task.promise;
  };

  // Largest canvas most browsers will draw (Safari caps near 16.7 megapixels).
  P.MAX_PIXELS = 16777216;

  // Render one page into a canvas at `scale` (1 = 72 DPI). Returns { canvas, scale, capped }.
  P.renderPage = async function (pdf, pageNum, scale, opts) {
    const page = await pdf.getPage(pageNum);
    let vp = page.getViewport({ scale });
    let capped = false;
    if (vp.width * vp.height > P.MAX_PIXELS) {
      const s = Math.sqrt(P.MAX_PIXELS / (vp.width * vp.height)) * 0.98;
      vp = page.getViewport({ scale: scale * s });
      capped = true;
    }
    const canvas = (opts && opts.canvas) || document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
    page.cleanup();
    return { canvas, scale: vp.scale, capped, width: vp.width, height: vp.height };
  };

  // "1-3, 5, 8-" -> sorted unique page numbers within 1..max. Throws a plain-language Error.
  P.parseRanges = function (text, max) {
    const out = new Set();
    const s = String(text || '').trim();
    if (!s) return [];
    for (const raw of s.split(/[,;\s]+/)) {
      if (!raw) continue;
      const m = /^(\d*)\s*[-–]\s*(\d*)$/.exec(raw);
      let a, b;
      if (m) {
        a = m[1] ? parseInt(m[1], 10) : 1;
        b = m[2] ? parseInt(m[2], 10) : max;
      } else if (/^\d+$/.test(raw)) {
        a = b = parseInt(raw, 10);
      } else {
        throw new Error(`"${raw}" isn't a page number or range. Try something like 1-3, 5.`);
      }
      if (a < 1 || b < 1) throw new Error('Page numbers start at 1.');
      if (a > max || b > max) throw new Error(`This PDF only has ${max} page${max === 1 ? '' : 's'}.`);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) out.add(i);
    }
    return [...out].sort((x, y) => x - y);
  };

  // Ranges as groups: "1-3, 4-6" -> [[1,2,3],[4,5,6]] (order kept, for "split into parts").
  P.parseGroups = function (text, max) {
    const groups = [];
    for (const raw of String(text || '').split(/[,;]+/)) {
      const t = raw.trim();
      if (!t) continue;
      const pages = P.parseRanges(t, max);
      if (pages.length) groups.push(pages);
    }
    return groups;
  };

  // Compact text for a page list: [1,2,3,5] -> "1-3, 5"
  P.formatRanges = function (pages) {
    const out = [];
    let i = 0;
    while (i < pages.length) {
      let j = i;
      while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
      out.push(i === j ? String(pages[i]) : `${pages[i]}-${pages[j]}`);
      i = j + 1;
    }
    return out.join(', ');
  };

  P.friendlyError = function (e) {
    const msg = String((e && (e.message || e)) || '');
    if (/encrypt|password/i.test(msg)) return 'This PDF is locked with a password. pdf.lol can\'t open locked PDFs yet.';
    if (/No PDF header|Failed to parse|Invalid PDF|invalid|expected/i.test(msg)) return 'pdf.lol couldn\'t read this file. It may be damaged or not a real PDF.';
    return 'Something went wrong (' + msg.slice(0, 140) + ').';
  };

  P.isPdf = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

  P.loadLib = async function (bytes) {
    return window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false, throwOnInvalidObject: false });
  };

  P.yieldUI = () => new Promise((r) => setTimeout(r, 0));

  window.pdfTools = P;
})();
