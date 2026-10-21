/*
  qr-code.lol app. Runs entirely in your browser.
  qrcode-generator draws the pattern; jsQR reads it back as a self-check.
  Nothing here makes a network request.
*/
(function () {
  'use strict';
  const lol = window.lol;
  const $ = (id) => document.getElementById(id);

  // Use real UTF-8 so accented letters and emoji survive the round trip.
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  const canvas = $('qrCanvas');
  const frame = $('qrFrame');
  const check = $('qrCheck');
  const payloadEl = $('qrPayload');
  const btnPng = $('dlPng');
  const btnSvg = $('dlSvg');

  const type = () => document.querySelector('input[name="type"]:checked').value;
  const v = (id) => $(id).value.trim();

  // ---- Payload builders ----------------------------------------------------
  // Wi-Fi and vCard need certain characters escaped or phones misread them.
  const wifiEsc = (s) => s.replace(/([\\;,:"])/g, '\\$1');
  const vEsc = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

  function normalizeUrl(s) {
    if (!s) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
    return 'https://' + s;
  }

  const builders = {
    url: () => normalizeUrl(v('f-url')),
    text: () => $('f-text').value,
    wifi: () => {
      const ssid = $('f-ssid').value;
      if (!ssid) return '';
      const sec = $('f-sec').value;
      const pass = $('f-pass').value;
      let s = `WIFI:T:${pass ? sec : 'nopass'};S:${wifiEsc(ssid)};`;
      if (pass && sec !== 'nopass') s += `P:${wifiEsc(pass)};`;
      if ($('f-hidden').checked) s += 'H:true;';
      return s + ';';
    },
    vcard: () => {
      const first = v('f-first'), last = v('f-last'), org = v('f-org'), title = v('f-title');
      const phone = v('f-vphone'), email = v('f-vemail'), url = v('f-vurl');
      if (!(first || last || org || phone || email)) return '';
      const fn = [first, last].filter(Boolean).join(' ') || org;
      const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${vEsc(last)};${vEsc(first)};;;`, `FN:${vEsc(fn)}`];
      if (org) lines.push(`ORG:${vEsc(org)}`);
      if (title) lines.push(`TITLE:${vEsc(title)}`);
      if (phone) lines.push(`TEL;TYPE=CELL:${phone}`);
      if (email) lines.push(`EMAIL:${email}`);
      if (url) lines.push(`URL:${normalizeUrl(url)}`);
      lines.push('END:VCARD');
      return lines.join('\r\n');
    },
    email: () => {
      const to = v('f-to');
      if (!to) return '';
      const q = [];
      if (v('f-subj')) q.push('subject=' + encodeURIComponent(v('f-subj')));
      if ($('f-body').value.trim()) q.push('body=' + encodeURIComponent($('f-body').value));
      return `mailto:${to}${q.length ? '?' + q.join('&') : ''}`;
    },
    tel: () => {
      const t = v('f-tel').replace(/[^\d+]/g, '');
      return t ? `tel:${t}` : '';
    },
  };

  // ---- QR model ------------------------------------------------------------
  let current = null; // { qr, n, payload }

  function makeQr(payload) {
    const qr = qrcode(0, $('f-ec').value);
    qr.addData(payload, 'Byte');
    qr.make();
    return qr;
  }

  function quiet() { return $('f-margin').checked ? 4 : 0; }

  function drawTo(cnv, qr, px, fg, bg) {
    const n = qr.getModuleCount();
    const q = quiet();
    const cells = n + q * 2;
    const cell = Math.floor(px / cells) || 1;
    const size = cell * cells;
    cnv.width = size; cnv.height = size;
    const ctx = cnv.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = fg;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + q) * cell, (r + q) * cell, cell, cell);
      }
    }
    return size;
  }

  function svgFor(qr, fg, bg) {
    const n = qr.getModuleCount();
    const q = quiet();
    const s = n + q * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!qr.isDark(r, c)) { c++; continue; }
        let run = 1;
        while (c + run < n && qr.isDark(r, c + run)) run++;
        d += `M${c + q} ${r + q}h${run}v1h-${run}z`;
        c += run;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" width="1024" height="1024" shape-rendering="crispEdges">` +
      `<rect width="${s}" height="${s}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>\n`;
  }

  // ---- Contrast check (WCAG relative luminance) ----------------------------
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function contrast(a, b) {
    const la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function setCheck(text, kind) {
    check.textContent = text;
    check.className = 'qr-check' + (kind ? ' ' + kind : '');
  }

  // Read the code back off a fresh render with jsQR, the same way a phone would.
  function selfTest(qr, payload, fg, bg) {
    const c = document.createElement('canvas');
    drawTo(c, qr, 600, fg, bg);
    // jsQR needs some margin to find the corners, even if the user turned it off.
    const pad = document.createElement('canvas');
    pad.width = c.width + 80; pad.height = c.height + 80;
    const px = pad.getContext('2d');
    px.fillStyle = bg; px.fillRect(0, 0, pad.width, pad.height);
    px.drawImage(c, 40, 40);
    const data = px.getImageData(0, 0, pad.width, pad.height);
    const res = jsQR(data.data, pad.width, pad.height, { inversionAttempts: 'attemptBoth' });
    return !!res && res.data === payload;
  }

  // ---- Render loop ---------------------------------------------------------
  let timer = 0;
  function schedule() { clearTimeout(timer); timer = setTimeout(render, 120); }

  function render() {
    const payload = builders[type()]();
    const fg = $('f-fg').value, bg = $('f-bg').value;
    if (!payload) {
      current = null;
      frame.classList.add('empty');
      btnPng.disabled = btnSvg.disabled = true;
      payloadEl.textContent = '';
      setCheck('');
      return;
    }
    let qr;
    try {
      qr = makeQr(payload);
    } catch (e) {
      current = null;
      frame.classList.add('empty');
      btnPng.disabled = btnSvg.disabled = true;
      setCheck('That\'s too much to fit in one QR code. Shorten it, or lower the damage tolerance.', 'err');
      return;
    }
    current = { qr, payload };
    frame.classList.remove('empty');
    drawTo(canvas, qr, 528, fg, bg);
    btnPng.disabled = btnSvg.disabled = false;
    payloadEl.textContent = payload.length > 220 ? payload.slice(0, 220) + '…' : payload;

    const ratio = contrast(fg, bg);
    const inverted = lum(fg) > lum(bg);
    const ok = selfTest(qr, payload, fg, bg);
    if (!ok) setCheck('✗ Our test scan failed. Try darker code and lighter background colors.', 'err');
    else if (ratio < 4) setCheck(`! Scans here, but the contrast is low (${ratio.toFixed(1)}:1). Some phones may struggle.`, 'warn');
    else if (inverted) setCheck('! Light code on dark scans on newer phones. Older ones may not read it.', 'warn');
    else if (!$('f-margin').checked) setCheck('! Scans here. Leave space around it wherever you place it.', 'warn');
    else setCheck('✓ Test scan passed. The code reads back exactly what you entered.', 'ok');
  }

  function fileBase() {
    const p = current ? current.payload : 'qr';
    const t = type();
    if (t === 'url') {
      try { return 'qr-' + new URL(p).hostname.replace(/^www\./, ''); } catch (_) { /* fall through */ }
    }
    if (t === 'wifi') return 'qr-wifi-' + ($('f-ssid').value || 'network');
    if (t === 'vcard') return 'qr-contact-' + ([v('f-first'), v('f-last')].filter(Boolean).join('-') || 'card');
    return 'qr-' + t;
  }
  const safe = (s) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'qr';

  btnPng.addEventListener('click', () => {
    if (!current) return;
    const c = document.createElement('canvas');
    drawTo(c, current.qr, parseInt($('f-size').value, 10), $('f-fg').value, $('f-bg').value);
    c.toBlob((b) => lol.download(b, safe(fileBase()) + '.png'), 'image/png');
  });
  btnSvg.addEventListener('click', () => {
    if (!current) return;
    const svg = svgFor(current.qr, $('f-fg').value, $('f-bg').value);
    lol.download(new Blob([svg], { type: 'image/svg+xml' }), safe(fileBase()) + '.svg');
  });

  // ---- Wire up ---------------------------------------------------------------
  function showType() {
    const t = type();
    document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.getAttribute('data-for') !== t; });
    render();
  }
  document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', showType));
  $('qrForm').addEventListener('input', schedule);
  $('qrForm').addEventListener('change', schedule);
  $('qrForm').addEventListener('submit', (e) => e.preventDefault());

  // Deep links: /#wifi, /#vcard, etc.
  function fromHash() {
    const h = location.hash.slice(1);
    if (builders[h]) { $('t-' + h).checked = true; showType(); }
  }
  window.addEventListener('hashchange', fromHash);
  fromHash();
  showType();
})();
