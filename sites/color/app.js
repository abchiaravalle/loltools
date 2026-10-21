/*
  colorpicker.lol app. Runs entirely in your browser. No libraries, no network.

  How picking from an image works:
  - The image is decoded by your browser and drawn 1:1 into a <canvas> (only
    scaled down if it's too big for the browser to hold).
  - The canvas is a normal 2D canvas in the sRGB color space. Browsers convert
    images with an embedded profile (for example Display P3 photos) to sRGB
    when they draw them, and treat untagged images as sRGB, so getImageData()
    returns sRGB values, the same ones CSS uses. Chrome, Edge, Firefox and
    Safari all do this for an sRGB canvas.
  - A click is mapped to a pixel with the canvas's on-screen box:
      x = floor((clientX - box.left) * canvas.width / box.width)
    The canvas has no border or padding, so its box is exactly the drawn
    image. The canvas holds the image's own pixels (not screen pixels), so
    devicePixelRatio doesn't change the mapping. Only the zoom loupe is sized
    by devicePixelRatio, so it stays sharp.
*/
(function () {
  'use strict';
  const lol = window.lol;
  const C = window.colormath;
  const $ = (id) => document.getElementById(id);

  const RECENT_KEY = 'colorpicker-recent-v1';
  const RECENT_MAX = 24;
  const touchFirst = matchMedia('(hover: none) and (pointer: coarse)').matches;
  // Phone browsers (iOS Safari especially) refuse canvases over ~16.7 MP.
  const MAX_PIXELS = touchFirst || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ? 16e6 : 50e6;
  const PALETTE_PIXELS = 250000;

  let current = C.parse('#336699');
  let other = C.parse('#ffffff');

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to the old way */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
  function announce(text) {
    const a = $('announce');
    a.textContent = '';
    setTimeout(() => { a.textContent = text; }, 30);
  }
  async function copyWithFeedback(btn, text, labelEl, doneText) {
    const ok = await copyText(text);
    const el = labelEl || btn;
    const before = el.dataset.label || el.textContent;
    el.dataset.label = before;
    el.textContent = ok ? (doneText || 'Copied') : 'Copy failed';
    btn.classList.add('copied');
    announce(ok ? `Copied ${text.split('\n').length > 1 ? 'the list' : text}` : 'Your browser blocked copying. Select the text and copy it yourself.');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { el.textContent = before; btn.classList.remove('copied'); }, 1400);
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Current color
  // ---------------------------------------------------------------------------
  const input = $('colorInput');
  const picker = $('nativePicker');
  const inputMsg = $('inputMsg');
  const css = (c) => (c.a < 255 ? `rgba(${c.r}, ${c.g}, ${c.b}, ${+(c.a / 255).toFixed(3)})` : `rgb(${c.r}, ${c.g}, ${c.b})`);
  const hex6 = (c) => C.toHex({ r: c.r, g: c.g, b: c.b, a: 255 });

  const NAME_LIST = Object.entries(C.NAMES).map(([n, h]) => [n, C.parse('#' + h)]);
  function nearestName(c) {
    let best = null, bd = Infinity;
    for (const [n, ref] of NAME_LIST) {
      const d = C.deltaOk(c, ref);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.classList.toggle('err', kind === 'err');
  }

  function render(opts) {
    opts = opts || {};
    const f = C.formats(current);
    $('swatch').style.background = css(current);
    for (const k of ['hex', 'rgb', 'hsl', 'hsv', 'cmyk', 'oklch']) $('v-' + k).textContent = f[k];
    if (!opts.fromInput) {
      input.value = f.hex;
      input.removeAttribute('aria-invalid');
      setMsg(inputMsg, current.clipped ? 'That color is outside what sRGB screens can show, so it was moved to the closest one.' : '');
    }
    if (!opts.fromPicker) picker.value = hex6(current);
    if (f.name) $('colorName').textContent = `CSS name: ${f.name}`;
    else if (current.a === 255) $('colorName').textContent = `Closest CSS name: ${nearestName(current)}`;
    else $('colorName').textContent = `${Math.round((current.a / 255) * 100)}% opaque`;
    renderContrast();
  }

  function setColor(c, opts) {
    if (!c) return;
    current = c;
    render(opts);
    if (opts && opts.remember) addRecent(c);
  }

  // Typed colors
  let typeTimer = 0;
  input.addEventListener('input', () => {
    const v = input.value.trim();
    clearTimeout(typeTimer);
    if (!v) { input.removeAttribute('aria-invalid'); setMsg(inputMsg, ''); return; }
    const c = C.parse(v);
    if (c) {
      input.removeAttribute('aria-invalid');
      setMsg(inputMsg, c.clipped ? 'That color is outside what sRGB screens can show, so it was moved to the closest one.' : '');
      setColor(c, { fromInput: true });
    } else {
      // Don't shout while someone is mid-word. Explain after a short pause.
      typeTimer = setTimeout(() => showBadInput(v), 900);
    }
  });
  function showBadInput(v) {
    input.setAttribute('aria-invalid', 'true');
    setMsg(inputMsg, `"${v.length > 40 ? v.slice(0, 40) + '...' : v}" isn't a color this page understands. Try #336699, rgb(51 102 153), hsl(210 50% 40%) or a name like teal.`, 'err');
  }
  input.addEventListener('change', () => {
    const v = input.value.trim();
    clearTimeout(typeTimer);
    if (!v) { render(); return; }
    const c = C.parse(v);
    if (c) addRecent(c); else showBadInput(v);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.dispatchEvent(new Event('change')); });

  // The browser's own picker (no alpha, so it always gives an opaque color).
  picker.addEventListener('input', () => setColor(C.parse(picker.value), { fromPicker: true }));
  picker.addEventListener('change', () => setColor(C.parse(picker.value), { fromPicker: true, remember: true }));

  // Copy a format
  document.querySelectorAll('.fmt-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = $('v-' + btn.dataset.fmt).textContent;
      copyWithFeedback(btn, text, btn.querySelector('.fmt-copy'));
    });
  });

  // ---------------------------------------------------------------------------
  // Pick from screen (EyeDropper API: Chrome, Edge and Opera on desktop)
  // ---------------------------------------------------------------------------
  const screenBtn = $('screenBtn');
  if (typeof window.EyeDropper === 'function') {
    screenBtn.hidden = false;
    screenBtn.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        const c = C.parse(res && res.sRGBHex);
        if (!c) throw new Error('unreadable');
        setColor(c, { remember: true });
        setMsg(inputMsg, '');
      } catch (err) {
        if (err && err.name === 'AbortError') return; // you pressed Esc
        setMsg(inputMsg, "Your browser didn't let the page pick from the screen. Take a screenshot and drop it in below instead.", 'err');
      }
    });
  } else {
    screenBtn.remove();
    $('screenNote').hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Recent picks (localStorage on this device only)
  // ---------------------------------------------------------------------------
  function loadRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v) ? v.filter((h) => typeof h === 'string' && C.parse(h)).slice(0, RECENT_MAX) : [];
    } catch (_) { return []; }
  }
  let recent = loadRecent();
  function saveRecent() {
    try {
      if (recent.length) localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      else localStorage.removeItem(RECENT_KEY);
    } catch (_) { /* private mode or storage full: keep it for this visit only */ }
  }
  function addRecent(c) {
    const h = C.toHex(c);
    recent = [h, ...recent.filter((x) => x !== h)].slice(0, RECENT_MAX);
    saveRecent();
    renderRecent();
  }
  function swatchButton(c, label, extra) {
    const hex = C.toHex(c);
    const btn = lol.el('button', { type: 'button', class: 'sw', title: `Use ${hex}`, 'aria-label': `Use ${hex}${extra ? ', ' + extra : ''}`, 'data-hex': hex }, [
      lol.el('span', { class: 'sw-fill' }),
      lol.el('span', { class: 'sw-hex', text: label || hex }),
    ]);
    btn.firstChild.style.background = css(c);
    return btn;
  }
  function renderRecent() {
    const ul = $('recent');
    ul.replaceChildren(...recent.map((h) => {
      const btn = swatchButton(C.parse(h), h);
      btn.addEventListener('click', () => setColor(C.parse(h)));
      return lol.el('li', null, [btn]);
    }));
    $('recentEmpty').hidden = recent.length > 0;
    $('copyRecent').disabled = !recent.length;
    $('clearRecent').disabled = !recent.length;
  }
  $('clearRecent').addEventListener('click', () => {
    recent = [];
    saveRecent();
    renderRecent();
    announce('Recent picks cleared');
  });
  $('copyRecent').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, recent.join('\n')));

  // ---------------------------------------------------------------------------
  // Contrast
  // ---------------------------------------------------------------------------
  const WHITE = { r: 255, g: 255, b: 255, a: 255 };
  const BLACK = { r: 0, g: 0, b: 0, a: 255 };
  const otherInput = $('otherInput');
  const otherPicker = $('otherPicker');
  const role = () => document.querySelector('input[name="role"]:checked').value;
  // A see-through background is shown (and measured) on top of white.
  const bgCss = (c) => (c.a < 255 ? `linear-gradient(${css(c)}, ${css(c)}), #ffffff` : css(c));
  function verdict(r) {
    if (r >= 7) return 'passes AAA';
    if (r >= 4.5) return 'passes AA';
    if (r >= 3) return 'large text only';
    return 'fails';
  }
  function cell(id, pass) {
    const td = $(id);
    td.textContent = pass ? '✓ Pass' : '✗ Fail';
    td.className = pass ? 'pass' : 'fail';
  }
  function renderContrast() {
    // Quick check: your color as a background behind white and black text.
    for (const [id, txt] of [['qcWhite', WHITE], ['qcBlack', BLACK]]) {
      const box = $(id);
      box.style.background = bgCss(current);
      const r = C.contrast(txt, current);
      box.querySelector('.qc-ratio').textContent = `${C.formatRatio(r)}:1, ${verdict(r)}`;
      box.dataset.ratio = C.formatRatio(r);
    }
    const fg = role() === 'text' ? current : other;
    const bg = role() === 'text' ? other : current;
    const sample = $('sample');
    sample.style.background = bgCss(bg);
    sample.style.color = css(fg);
    const w = C.wcag(C.contrast(fg, bg));
    $('ratio').textContent = w.text;
    $('ratioWord').textContent = w.aaaNormal ? 'Passes everything' : w.aaNormal ? 'Good for all text' : w.aaLarge ? 'Only for large text' : 'Too low for text';
    cell('aaNormal', w.aaNormal); cell('aaLarge', w.aaLarge); cell('aaaNormal', w.aaaNormal); cell('aaaLarge', w.aaaLarge);
    $('uiVerdict').textContent = w.ui ? 'this pair passes' : 'this pair fails';
    $('alphaNote').hidden = !(current.a < 255 || other.a < 255);
  }
  document.querySelectorAll('input[name="role"]').forEach((r) => r.addEventListener('change', () => {
    $('otherLabel').textContent = role() === 'text' ? 'Background color' : 'Text color';
    renderContrast();
  }));
  otherInput.addEventListener('input', () => {
    const c = C.parse(otherInput.value);
    if (c) {
      other = c;
      otherInput.removeAttribute('aria-invalid');
      setMsg($('otherMsg'), '');
      otherPicker.value = hex6(c);
      renderContrast();
    } else if (otherInput.value.trim()) {
      otherInput.setAttribute('aria-invalid', 'true');
      setMsg($('otherMsg'), "That isn't a color this page understands yet.", 'err');
    }
  });
  otherPicker.addEventListener('input', () => {
    other = C.parse(otherPicker.value);
    otherInput.value = otherPicker.value;
    otherInput.removeAttribute('aria-invalid');
    setMsg($('otherMsg'), '');
    renderContrast();
  });

  // ---------------------------------------------------------------------------
  // Pick from an image
  // ---------------------------------------------------------------------------
  const canvas = $('imgCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  const stage = $('stage');
  const loupe = $('loupe');
  const loupeCanvas = $('loupeCanvas');
  const lctx = loupeCanvas.getContext('2d');
  const marker = $('marker');
  const imgStatus = $('imgStatus');
  const LOUPE_CSS = 132, LOUPE_PX = 11; // 11 x 11 image pixels, 12x zoom
  let hasImage = false;
  let picked = null; // { x, y } in image pixels
  let kbPoint = null;

  if (touchFirst) {
    $('stageHint').textContent = 'Touch the image to zoom in, then drag to fine-tune. The point moves slower than your finger, so you can land on one pixel. Lift your finger to pick.';
    $('dzTitle').textContent = 'Tap to pick a photo or screenshot';
  }

  function readPixel(x, y) {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }
  // Client (CSS px) -> image pixel. Fractional result; floor() it to get the pixel.
  function toImage(clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    return { x: ((clientX - box.left) * canvas.width) / box.width, y: ((clientY - box.top) * canvas.height) / box.height };
  }
  const clampPx = (p) => ({ x: Math.min(canvas.width - 1, Math.max(0, Math.floor(p.x))), y: Math.min(canvas.height - 1, Math.max(0, Math.floor(p.y))) });
  // Image pixel center -> position inside .stage (CSS px).
  function toStage(px) {
    const box = canvas.getBoundingClientRect();
    const sbox = stage.getBoundingClientRect();
    return {
      x: box.left - sbox.left + ((px.x + 0.5) * box.width) / canvas.width,
      y: box.top - sbox.top + ((px.y + 0.5) * box.height) / canvas.height,
    };
  }

  function drawLoupe(px) {
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const W = Math.round(LOUPE_CSS * dpr);
    if (loupeCanvas.width !== W) { loupeCanvas.width = W; loupeCanvas.height = W; }
    const cell = W / LOUPE_PX;
    const half = (LOUPE_PX - 1) / 2;
    lctx.imageSmoothingEnabled = false;
    lctx.clearRect(0, 0, W, W);
    // Draw pixel by pixel from one small read, so edges of the image stay crisp
    // and out-of-image cells stay empty.
    const sx = px.x - half, sy = px.y - half;
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
    const x1 = Math.min(canvas.width, sx + LOUPE_PX), y1 = Math.min(canvas.height, sy + LOUPE_PX);
    if (x1 > x0 && y1 > y0) {
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let i = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++, i += 4) {
          lctx.fillStyle = `rgba(${d[i]}, ${d[i + 1]}, ${d[i + 2]}, ${d[i + 3] / 255})`;
          lctx.fillRect(Math.round((x - sx) * cell), Math.round((y - sy) * cell), Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
    // Center pixel outline, dark and light so it shows on any color.
    const c0 = Math.round(half * cell);
    const cs = Math.round(cell);
    lctx.lineWidth = Math.max(1, dpr);
    lctx.strokeStyle = '#000';
    lctx.strokeRect(c0 + 0.5, c0 + 0.5, cs - 1, cs - 1);
    lctx.strokeStyle = '#fff';
    lctx.strokeRect(c0 - lctx.lineWidth + 0.5, c0 - lctx.lineWidth + 0.5, cs - 1 + 2 * lctx.lineWidth, cs - 1 + 2 * lctx.lineWidth);
    const c = readPixel(px.x, px.y);
    $('loupeLabel').textContent = C.toHex(c);
  }

  function showLoupe(px, mode) {
    drawLoupe(px);
    loupe.hidden = false;
    const p = toStage(px);
    const sw = stage.clientWidth;
    const lw = LOUPE_CSS, lh = LOUPE_CSS + 26;
    let left, top;
    if (mode === 'touch') {
      // Above the finger, so your finger doesn't hide it.
      left = p.x - lw / 2;
      top = p.y - lh - 56;
      if (top < -40) top = p.y + 56;
    } else {
      left = p.x + 22;
      top = p.y - lh - 10;
      if (left + lw > sw) left = p.x - lw - 22;
      if (top < 0) top = p.y + 22;
    }
    left = Math.max(-8, Math.min(sw - lw + 8, left));
    loupe.style.left = left + 'px';
    loupe.style.top = top + 'px';
  }
  const hideLoupe = () => { loupe.hidden = true; };

  function placeMarker() {
    if (!picked || !hasImage) { marker.hidden = true; return; }
    const p = toStage(picked);
    marker.style.left = p.x + 'px';
    marker.style.top = p.y + 'px';
    marker.hidden = false;
  }

  function pickAt(px) {
    picked = px;
    const c = readPixel(px.x, px.y);
    setColor(c, { remember: true });
    placeMarker();
    $('picked').hidden = false;
    const ps = $('pickedSwatch');
    if (!ps.firstChild) ps.appendChild(document.createElement('span'));
    ps.firstChild.style.background = css(c);
    $('pickedHex').textContent = C.toHex(c);
    $('pickedAt').textContent = `pixel ${px.x}, ${px.y}`;
    canvas.dataset.pickX = px.x;
    canvas.dataset.pickY = px.y;
  }
  $('pickedCopy').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, $('pickedHex').textContent));

  // Mouse and pen: hover shows the loupe, press picks.
  // Touch: press shows the loupe above your finger, drag fine-tunes at a
  // third of your finger's speed, lift picks.
  const TOUCH_SPEED = 1 / 3;
  let touch = null;
  canvas.addEventListener('pointermove', (e) => {
    if (!hasImage) return;
    if (e.pointerType === 'touch') {
      if (!touch || touch.id !== e.pointerId) return;
      const box = canvas.getBoundingClientRect();
      const k = canvas.width / box.width;
      touch.point = {
        x: touch.anchor.x + (e.clientX - touch.cx) * k * TOUCH_SPEED,
        y: touch.anchor.y + (e.clientY - touch.cy) * k * TOUCH_SPEED,
      };
      const px = clampPx(touch.point);
      showLoupe(px, 'touch');
      picked = px; placeMarker();
      e.preventDefault();
      return;
    }
    showLoupe(clampPx(toImage(e.clientX, e.clientY)), 'mouse');
  });
  canvas.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hideLoupe(); });
  canvas.addEventListener('pointerdown', (e) => {
    if (!hasImage) return;
    if (e.pointerType === 'touch') {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
      const anchor = toImage(e.clientX, e.clientY);
      touch = { id: e.pointerId, anchor, point: anchor, cx: e.clientX, cy: e.clientY };
      const px = clampPx(anchor);
      showLoupe(px, 'touch');
      picked = px; placeMarker();
      return;
    }
    if (e.button !== 0) return;
    const px = clampPx(toImage(e.clientX, e.clientY));
    kbPoint = px;
    pickAt(px);
    showLoupe(px, 'mouse');
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!touch || touch.id !== e.pointerId) return;
    const px = clampPx(touch.point);
    touch = null;
    hideLoupe();
    kbPoint = px;
    pickAt(px);
  });
  canvas.addEventListener('pointercancel', () => { touch = null; hideLoupe(); placeMarker(); });
  canvas.addEventListener('contextmenu', (e) => { if (touch) e.preventDefault(); });

  // Keyboard: arrows move one pixel (Shift for 10), Enter or Space picks.
  canvas.addEventListener('keydown', (e) => {
    if (!hasImage) return;
    const step = e.shiftKey ? 10 : 1;
    const p = kbPoint || { x: Math.floor(canvas.width / 2), y: Math.floor(canvas.height / 2) };
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      kbPoint = clampPx({ x: p.x + moves[e.key][0], y: p.y + moves[e.key][1] });
      showLoupe(kbPoint, 'mouse');
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      kbPoint = p;
      pickAt(p);
      showLoupe(p, 'mouse');
    } else if (e.key === 'Escape') {
      hideLoupe();
    }
  });
  canvas.addEventListener('blur', hideLoupe);
  window.addEventListener('resize', () => { hideLoupe(); placeMarker(); });

  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name || '') || /heic|heif/i.test(file.type || '');
  }

  async function decode(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      // The image keeps its decoded pixels; the URL isn't needed after decode.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  let loadSeq = 0;
  async function loadImage(file) {
    const seq = ++loadSeq;
    if (!file) return;
    const looksImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|avif|svg|bmp|ico|heic|heif|tiff?|jxl)$/i.test(file.name || '');
    if (!looksImage) {
      lol.setStatus(imgStatus, `"${file.name}" isn't an image. Pick a PNG, JPG, WebP, GIF or similar.`, 'err');
      return;
    }
    if (!file.size) {
      lol.setStatus(imgStatus, `"${file.name}" is empty (0 bytes).`, 'err');
      return;
    }
    lol.setStatus(imgStatus, 'Opening your image...');
    let img;
    try {
      img = await decode(file);
    } catch (_) {
      if (seq !== loadSeq) return;
      lol.setStatus(imgStatus, isHeic(file)
        ? "This browser can't open HEIC photos (only Safari can). Turn it into a JPG first, then drop that in."
        : "Couldn't open that image. It may be damaged, or this browser can't read its format.", 'err');
      return;
    }
    if (seq !== loadSeq) return;
    let w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (!w || !h) { w = 1024; h = 1024; } // an SVG with no size of its own
    let note = '';
    if (w * h > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / (w * h));
      const nw = Math.max(1, Math.floor(w * s)), nh = Math.max(1, Math.floor(h * s));
      note = ` It's ${(w * h / 1e6).toFixed(0)} megapixels, so it's scaled down to ${nw} x ${nh} to keep this tab from running out of memory. Neighboring pixels are blended a little.`;
      w = nw; h = nh;
    }
    try {
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      ctx.getImageData(0, 0, 1, 1); // throws if the browser couldn't make the canvas
    } catch (_) {
      lol.setStatus(imgStatus, 'That image is too big for this browser to hold. Try a smaller copy or a screenshot.', 'err');
      return;
    }
    hasImage = true;
    picked = null;
    kbPoint = null;
    marker.hidden = true;
    $('picked').hidden = true;
    $('stageWrap').hidden = false;
    const dz = $('drop');
    dz.classList.add('compact');
    $('dzTitle').textContent = touchFirst ? 'Pick another image' : 'Drop, pick or paste another image';
    canvas.dataset.w = w;
    canvas.dataset.h = h;
    lol.setStatus(imgStatus, `${file.name || 'Pasted image'}, ${img.naturalWidth || w} x ${img.naturalHeight || h} px.${note}`, 'ok');
    runPalette();
  }

  lol.dropzone($('drop'), (files) => loadImage(files.find((f) => /^image\//.test(f.type)) || files[0]));
  lol.dropzone(stage, (files) => loadImage(files.find((f) => /^image\//.test(f.type)) || files[0]));

  // Paste a screenshot (or a color code) anywhere on the page.
  document.addEventListener('paste', (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    const file = Array.from(dt.files || []).find((f) => /^image\//.test(f.type))
      || Array.from(dt.items || []).filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).find(Boolean);
    if (file) {
      e.preventDefault();
      loadImage(file);
      return;
    }
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // normal paste into a box
    const c = C.parse(dt.getData('text/plain'));
    if (c) { e.preventDefault(); setColor(c, { remember: true }); }
  });

  // ---------------------------------------------------------------------------
  // Palette (k-means in a Web Worker, see colormath.js)
  // ---------------------------------------------------------------------------
  let worker = null;
  let palSeq = 0;
  let paletteColors = [];
  const kValue = () => +document.querySelector('input[name="k"]:checked').value;

  function paletteInWorker(buffer, k) {
    return new Promise((resolve, reject) => {
      if (!worker) {
        try { worker = new Worker('/palette-worker.js'); } catch (err) { reject(err); return; }
      }
      const id = ++palSeq;
      const onMsg = (e) => {
        if (e.data.id !== id) return;
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.colors);
      };
      const onErr = (e) => {
        worker.removeEventListener('message', onMsg);
        worker.removeEventListener('error', onErr);
        worker.terminate();
        worker = null;
        reject(e);
      };
      worker.addEventListener('message', onMsg);
      worker.addEventListener('error', onErr);
      worker.postMessage({ id, buffer, k }, [buffer]);
    });
  }

  let palRun = 0;
  async function runPalette() {
    if (!hasImage) return;
    const run = ++palRun;
    const k = kValue();
    // Shrink big images first, picking whole pixels (no blending) so every
    // color in the palette is one that's really in the image.
    let data;
    const area = canvas.width * canvas.height;
    if (area <= PALETTE_PIXELS) {
      data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    } else {
      const s = Math.sqrt(PALETTE_PIXELS / area);
      const tw = Math.max(1, Math.round(canvas.width * s)), th = Math.max(1, Math.round(canvas.height * s));
      const t = document.createElement('canvas');
      t.width = tw; t.height = th;
      const tctx = t.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(canvas, 0, 0, tw, th);
      data = tctx.getImageData(0, 0, tw, th).data;
    }
    $('paletteEmpty').textContent = 'Finding the main colors...';
    $('paletteEmpty').hidden = false;
    let colors;
    let engine = 'worker';
    try {
      colors = await paletteInWorker(data.buffer.slice(0), k);
    } catch (_) {
      engine = 'main';
      colors = C.palette(data, k); // no worker available: do it here
    }
    if (run !== palRun) return;
    $('palette').dataset.engine = engine;
    paletteColors = colors;
    renderPalette();
  }

  function renderPalette() {
    const ul = $('palette');
    ul.replaceChildren(...paletteColors.map((c) => {
      const pct = Math.round(c.share * 100);
      const btn = swatchButton(c, C.toHex(c), `about ${pct}% of the image`);
      btn.appendChild(lol.el('span', { class: 'sw-share', text: (pct < 1 ? '<1' : pct) + '%' }));
      btn.dataset.share = c.share.toFixed(4);
      btn.addEventListener('click', () => setColor({ r: c.r, g: c.g, b: c.b, a: 255 }, { remember: true }));
      return lol.el('li', null, [btn]);
    }));
    const empty = $('paletteEmpty');
    if (paletteColors.length) {
      empty.hidden = paletteColors.length >= kValue();
      empty.textContent = `This image only has ${paletteColors.length} clearly different color${paletteColors.length === 1 ? '' : 's'}.`;
    } else {
      empty.hidden = false;
      empty.textContent = hasImage ? 'This image is fully see-through, so there are no colors to list.' : 'Add an image above and its main colors show up here.';
    }
    $('copyCss').disabled = !paletteColors.length;
    $('copyHex').disabled = !paletteColors.length;
  }
  document.querySelectorAll('input[name="k"]').forEach((r) => r.addEventListener('change', runPalette));

  function paletteCss() {
    return ':root {\n' + paletteColors.map((c, i) => `  --color-${i + 1}: ${C.toHex(c)};`).join('\n') + '\n}';
  }
  $('copyCss').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, paletteCss()));
  $('copyHex').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, paletteColors.map((c) => C.toHex(c)).join('\n')));

  // ---------------------------------------------------------------------------
  // Start: a color in the address (#ff6600), else your last pick, else a blue.
  // ---------------------------------------------------------------------------
  const fromHash = C.parse(decodeURIComponent(location.hash.slice(1)));
  setColor(fromHash || (recent[0] && C.parse(recent[0])) || C.parse('#336699'));
  renderRecent();
  renderPalette();
  window.addEventListener('hashchange', () => {
    let c = null;
    try { c = C.parse(decodeURIComponent(location.hash.slice(1))); } catch (_) { c = null; }
    if (c) setColor(c);
  });
})();
