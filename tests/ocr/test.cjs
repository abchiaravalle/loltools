// Real-Chrome functional test for imgtotext.lol (KEY=ocr).
//   node tests/ocr/test.cjs http://127.0.0.1:18822/
// Serve dist/ocr first:  node tests/serve.cjs dist/ocr 18822
//
// Makes test images with ImageMagick (known text), reads them in the page,
// scores the result with a Levenshtein character error rate (CER), and
// cross-checks against the native `tesseract` CLI on the same images.
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { make } = require('./mkimages.cjs');

const base = (process.argv[2] || 'http://127.0.0.1:18822/').replace(/\/?$/, '/');
const ORIGIN = new URL(base).origin;
const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(ROOT, '_work/ocr');
const IMG = path.join(WORK, 'img');
const OUT = path.join(WORK, 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  :: ' + detail : ''}`);
};
const info = (msg) => console.log(`      ${msg}`);

// ---- scoring ---------------------------------------------------------------
function lev(a, b) {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// Compare text, not layout: collapse all whitespace runs to one space.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const cer = (got, want) => lev(norm(got), norm(want)) / norm(want).length;
const pct = (x) => (x * 100).toFixed(1) + '%';

function nativeTesseract(file, args = []) {
  try {
    return execFileSync('/opt/homebrew/bin/tesseract', [file, 'stdout', ...args], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) {
    return '';
  }
}

(async () => {
  // ---- fixtures ------------------------------------------------------------
  const { texts: T } = make(IMG);
  const huge = path.join(IMG, 'huge.png');
  if (!fs.existsSync(huge)) {
    // 6400x4000 = 25.6 MP, over the page's 16 MP cap, with big text so it's
    // still readable after the page scales it down.
    execFileSync('magick', ['-size', '6400x4000', 'xc:white', '-fill', 'black', '-font', '/System/Library/Fonts/Supplemental/Arial.ttf',
      '-pointsize', '150', '-annotate', '+300+800', 'Huge photos get scaled down first.', huge]);
  }
  const P = (n) => path.join(IMG, n);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await ctx.newPage();

  const requests = [];
  const errors = [];
  const consoleErrors = [];
  ctx.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[worker] ' + m.text()); }));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });

  const resp = await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ocrReady === true, null, { timeout: 30000 });
  const loadReqs = requests.slice();
  info(`page load requests: ${loadReqs.map((u) => u.replace(ORIGIN, '')).join(', ')}`);

  // ---- headers / CSP -------------------------------------------------------
  const csp = resp.headers()['content-security-policy'] || '';
  ok('CSP header: connect-src \'self\' only', /connect-src 'self'(;|$)/.test(csp), csp.match(/connect-src[^;]*/)?.[0]);
  ok('CSP header: script-src \'self\' \'wasm-unsafe-eval\', no unsafe-eval', /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp) && !/'unsafe-eval'/.test(csp), csp.match(/script-src[^;]*/)?.[0]);
  ok('CSP header: worker-src \'self\' (no blob:)', /worker-src 'self'(;|$)/.test(csp), csp.match(/worker-src[^;]*/)?.[0]);
  ok('no engine files fetched before an image is given', !loadReqs.some((u) => /worker\.min|tesseract-core|traineddata/.test(u)));

  const until = (fn, arg, timeout = 120000) => page.waitForFunction(fn, arg, { timeout });
  const waitDone = (timeout) => until(() => {
    const s = document.getElementById('tool').dataset.state;
    return s === 'done' || (s !== 'working' && document.getElementById('status').classList.contains('err'));
  }, null, timeout);
  const runFile = async (file) => {
    await page.evaluate(() => { window.__ocrLast = null; });
    const t0 = Date.now();
    await page.setInputFiles('#fileInput', file);
    await until(() => document.getElementById('tool').dataset.state === 'working' || document.getElementById('status').classList.contains('err'), null, 10000);
    await waitDone();
    const ms = Date.now() - t0;
    const last = await page.evaluate(() => window.__ocrLast);
    const text = await page.inputValue('#out');
    const status = await page.textContent('#status');
    const note = await page.evaluate(() => (document.getElementById('confNote').hidden ? '' : document.getElementById('confText').textContent));
    return { ms, last, text, status, note };
  };

  // ---- progress messages during the cold run ------------------------------
  await page.evaluate(() => {
    window.__statusLog = [];
    const s = document.getElementById('status');
    new MutationObserver(() => window.__statusLog.push(s.textContent)).observe(s, { childList: true, characterData: true, subtree: true });
  });

  // ---- 1. clean screenshot (cold: engine + English download) --------------
  const r1 = await runFile(P('clean.png'));
  const statusLog = await page.evaluate(() => window.__statusLog);
  const c1 = cer(r1.text, T.clean);
  const n1 = nativeTesseract(P('clean.png'));
  ok(`clean screenshot: CER < 3% (cold run ${r1.ms} ms incl. engine + English download)`, c1 < 0.03, `browser CER ${pct(c1)}, conf ${r1.last && r1.last.confidence}; native tesseract CLI CER ${pct(cer(n1, T.clean))}`);
  ok('progress: showed engine loading', statusLog.some((s) => /Loading the text reader/.test(s)), [...new Set(statusLog)].slice(0, 6).join(' | '));
  ok('progress: showed language loading', statusLog.some((s) => /English language file/.test(s)));
  ok('progress: showed recognizing %', statusLog.some((s) => /Reading text… \d+%/.test(s)));
  ok('clean screenshot: no low-confidence warning', r1.note === '', r1.note);
  ok('result textarea is editable', await page.evaluate(() => { const t = document.getElementById('out'); return !t.readOnly && !t.disabled; }));
  const coreReqs = requests.filter((u) => /\/core\//.test(u)).map((u) => u.replace(ORIGIN, ''));
  ok('exactly one engine build was downloaded', coreReqs.length === 1, coreReqs.join(', '));
  info(`real Chrome picked: ${coreReqs[0]}`);
  ok('worker loaded from this site, not a blob: wrapper', requests.some((u) => u === ORIGIN + '/vendor/tesseract/worker.min.js'));

  // ---- warm run: same image again -----------------------------------------
  const r1b = await runFile(P('clean.png'));
  ok(`warm run is faster than the cold run (${r1b.ms} ms vs ${r1.ms} ms)`, r1b.ms < r1.ms && cer(r1b.text, T.clean) < 0.03, `engine-reported ${r1b.last && r1b.last.ms} ms`);
  ok('warm run downloaded nothing new', requests.filter((u) => /\/core\/|traineddata/.test(u)).length === 2);

  // ---- 2. rotated, noisy photo of a document ------------------------------
  const r2 = await runFile(P('photo.jpg'));
  const c2 = cer(r2.text, T.photo);
  const n2 = nativeTesseract(P('photo.jpg'));
  const n2b = nativeTesseract(P('photo.jpg'), ['--psm', '6']);
  ok(`tilted noisy photo: CER < 10% (${r2.ms} ms)`, c2 < 0.10, `browser CER ${pct(c2)}, conf ${r2.last && r2.last.confidence}, straightened ${((r2.last && r2.last.rotateRadians) * 180 / Math.PI).toFixed(1)}°; native CLI CER ${pct(cer(n2, T.photo))} (default psm 3), ${pct(cer(n2b, T.photo))} (psm 6)`);

  // ---- 3. small-text receipt ----------------------------------------------
  const r3 = await runFile(P('receipt.png'));
  const c3 = cer(r3.text, T.receipt);
  const n3 = nativeTesseract(P('receipt.png'));
  const n3b = nativeTesseract(P('receipt.png'), ['--psm', '6']);
  ok(`small-text receipt: CER < 10% (${r3.ms} ms)`, c3 < 0.10, `browser CER ${pct(c3)}, conf ${r3.last && r3.last.confidence}; native CLI CER ${pct(cer(n3, T.receipt))} (psm 3), ${pct(cer(n3b, T.receipt))} (psm 6)`);
  ok('receipt: the total line is read correctly', /TOTAL\s+29\.86/.test(r3.text), (r3.text.match(/.*TOTAL.*/g) || []).join(' / '));
  fs.writeFileSync(path.join(OUT, 'receipt.browser.txt'), r3.text);

  // ---- 4. dark-mode WebP screenshot ---------------------------------------
  const r4 = await runFile(P('dark.webp'));
  const c4 = cer(r4.text, T.dark);
  ok(`dark-mode WebP screenshot: CER < 3% (${r4.ms} ms)`, c4 < 0.03, `browser CER ${pct(c4)}; native CLI CER ${pct(cer(nativeTesseract(P('dark.webp')), T.dark))}`);

  // ---- 5. low-confidence warning ------------------------------------------
  const r5 = await runFile(P('blurry.jpg'));
  ok('blurry photo: plain-words low-confidence warning shown', /may be wrong|probably wrong|couldn't find any text/.test(r5.note), `conf ${r5.last && r5.last.confidence}: "${r5.note}"`);
  const lowBoxes = await page.$$eval('.ocr-box.low', (b) => b.length);
  info(`blurry photo read as: ${JSON.stringify(r5.text.slice(0, 80))} (${lowBoxes} low-confidence line boxes)`);

  // ---- 6. other languages: only on demand ---------------------------------
  const otherLang = (u) => /\/(spa|fra|deu|por)\.traineddata/.test(u);
  ok('no other language files downloaded before picking one', !requests.some(otherLang));
  await page.setInputFiles('#fileInput', P('spanish.png'));
  await waitDone();
  const engOnSpanish = await page.inputValue('#out');
  await page.evaluate(() => { window.__ocrLast = null; });
  await page.selectOption('#lang', 'spa');
  await until(() => window.__ocrLast && window.__ocrLast.lang === 'spa', null, 60000);
  const spaText = await page.inputValue('#out');
  const cSpa = cer(spaText, T.spanish);
  ok('Spanish: picking it downloads spa.traineddata.gz from this site, and nothing else', requests.filter(otherLang).map((u) => u.replace(ORIGIN, '')).join(',') === '/vendor/tesseract/lang/spa.traineddata.gz', requests.filter(otherLang).join(', '));
  ok('Spanish: accents read correctly (CER < 3%)', cSpa < 0.03 && /niño/.test(spaText) && /Mañana/.test(spaText), `CER ${pct(cSpa)} (English model on the same image: ${pct(cer(engOnSpanish, T.spanish))})`);
  await page.selectOption('#lang', 'eng');
  await until(() => window.__ocrLast && window.__ocrLast.lang === 'eng', null, 60000);

  // A language file that fails to download gives a plain message, not a hang.
  await ctx.route('**/lang/fra.traineddata.gz', (route) => route.abort('internetdisconnected'));
  await page.evaluate(() => { window.__ocrLast = null; });
  await page.selectOption('#lang', 'fra');
  let failMsg = '';
  try {
    await until(() => document.getElementById('status').classList.contains('err'), null, 30000);
    failMsg = await page.textContent('#status');
  } catch (_) { failMsg = '(timed out)'; }
  ok('failed language download: plain message, no hang', /language file didn't download/.test(failMsg), failMsg);
  await ctx.unroute('**/lang/fra.traineddata.gz');
  await page.selectOption('#lang', 'eng');
  await until(() => window.__ocrLast && window.__ocrLast.lang === 'eng', null, 60000);
  ok('recovers after the failed download (English works again)', cer(await page.inputValue('#out'), T.spanish) < 0.25, (await page.textContent('#status')));

  // ---- 7. paste from clipboard --------------------------------------------
  // (a) synthetic paste event carrying a File, exactly what the browser hands
  //     the page when you press Ctrl/Cmd+V with an image on the clipboard.
  const cleanB64 = fs.readFileSync(P('clean.png')).toString('base64');
  await page.evaluate(() => { window.__ocrLast = null; });
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, cleanB64);
  await until(() => window.__ocrLast);
  const pasted = await page.inputValue('#out');
  ok('paste (ClipboardEvent with an image File) reads the image', cer(pasted, T.clean) < 0.03, `CER ${pct(cer(pasted, T.clean))}`);

  // (b) the real thing: put a PNG on Chrome's clipboard, press Ctrl/Cmd+V.
  const photoPng = path.join(OUT, 'photo-for-paste.png');
  execFileSync('magick', [P('photo.jpg'), photoPng]);
  const photoB64 = fs.readFileSync(photoPng).toString('base64');
  await page.evaluate(() => { window.__ocrLast = null; });
  const wrote = await page.evaluate(async (b64) => {
    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
      return 'ok';
    } catch (e) { return String(e); }
  }, photoB64);
  let realPaste = 'clipboard write failed: ' + wrote;
  if (wrote === 'ok') {
    await page.click('h1');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    try {
      await until(() => window.__ocrLast, null, 30000);
      realPaste = await page.inputValue('#out');
    } catch (_) { realPaste = '(nothing happened after the key press)'; }
  }
  const realOk = cer(realPaste, T.photo) < 0.10;
  ok('paste (real clipboard image + Cmd/Ctrl+V keypress)', realOk, realOk ? `CER ${pct(cer(realPaste, T.photo))}` : realPaste.slice(0, 120));

  // (c) Paste button (navigator.clipboard.read), same clipboard content
  const pasteBtnShown = await page.isVisible('#pasteBtn');
  if (pasteBtnShown) {
    await page.evaluate(() => { window.__ocrLast = null; });
    await page.click('#pasteBtn');
    await until(() => window.__ocrLast || document.getElementById('status').classList.contains('err'), null, 30000);
    const viaBtn = await page.inputValue('#out');
    ok('Paste image button reads the clipboard image', cer(viaBtn, T.photo) < 0.10, `CER ${pct(cer(viaBtn, T.photo))}`);
  } else ok('Paste image button is shown in Chrome', false);

  // (d) pasting plain text outside the textarea says it's not an image
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  ok('paste of plain text: plain-language message', /text, not an image/.test(await page.textContent('#status')), await page.textContent('#status'));

  // ---- 8. offline after load (FAQ claims this) ----------------------------
  await ctx.setOffline(true);
  const before = requests.length;
  const rOff = await runFile(P('dark.webp'));
  await ctx.setOffline(false);
  ok('works offline once loaded (same tab, language already used)', cer(rOff.text, T.dark) < 0.03 && requests.slice(before).every((u) => u.startsWith('blob:')), `CER ${pct(cer(rOff.text, T.dark))}, ${requests.length - before} new requests`);

  // ---- 9. Copy + Download .txt --------------------------------------------
  await runFile(P('clean.png'));
  const shown = await page.inputValue('#out');
  await page.evaluate(() => navigator.clipboard.writeText('stale'));
  await page.click('#copyBtn');
  await until(() => /Copied/.test(document.querySelector('#copyBtn span').textContent), null, 5000);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok('Copy button puts the exact text on the clipboard', clip === shown, `${clip.length} chars`);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlBtn')]);
  const dlPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(dlPath);
  const dlText = fs.readFileSync(dlPath, 'utf8');
  const fileType = execFileSync('file', ['-b', dlPath]).toString().trim();
  ok('Download .txt: named after the image', dl.suggestedFilename() === 'clean.txt', dl.suggestedFilename());
  ok('Download .txt: file content = textarea text + newline', dlText === shown + '\n', `${dlText.length} bytes, file(1): ${fileType}`);
  ok('Download .txt: content matches the known text (CER < 3%)', cer(dlText, T.clean) < 0.03, pct(cer(dlText, T.clean)));

  // edits are what gets copied/saved
  await page.fill('#out', shown + '\nEdited by hand ✓');
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#dlBtn')]);
  const dl2Path = path.join(OUT, 'edited.txt');
  await dl2.saveAs(dl2Path);
  ok('Download .txt keeps your edits (UTF-8)', fs.readFileSync(dl2Path, 'utf8').endsWith('Edited by hand ✓\n'));

  // join lines
  await runFile(P('clean.png'));
  await page.check('#joinLines');
  const joined = await page.inputValue('#out');
  ok('Join lines: one paragraph, no line breaks', !/\n/.test(joined) && cer(joined, T.clean) < 0.03, JSON.stringify(joined.slice(0, 60)) + '…');
  await page.uncheck('#joinLines');
  ok('Join lines off: line breaks come back', /\n/.test(await page.inputValue('#out')));

  // preview boxes
  const boxes = await page.$$eval('.ocr-box', (b) => b.length);
  ok('preview shows one box per text line', boxes === 3, `${boxes} boxes for a 3-line image`);

  // ---- 9. failure paths ---------------------------------------------------
  const bad = async (file) => {
    await page.setInputFiles('#fileInput', file);
    await until(() => document.getElementById('status').classList.contains('err'), null, 15000).catch(() => {});
    return page.textContent('#status');
  };
  const mTxt = await bad(P('notes.txt'));
  ok('text file: "isn\'t an image" message', /isn't an image/.test(mTxt), mTxt);
  const mPdf = await bad(P('fake.pdf'));
  ok('PDF: says take a screenshot instead', /PDF/.test(mPdf) && /screenshot/.test(mPdf), mPdf);
  const mBroken = await bad(P('broken.png'));
  ok('damaged PNG: "couldn\'t open this image" message', /couldn't open this image/.test(mBroken), mBroken);
  await page.setInputFiles('#fileInput', { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) });
  ok('empty file: plain message', /empty/.test(await page.textContent('#status')), await page.textContent('#status'));
  ok('previous result is kept after a bad file', (await page.inputValue('#out')).length > 50);

  // multiple files dropped at once: reads the first image, says so
  await page.evaluate(() => { window.__ocrLast = null; });
  const dropFiles = [['notes.txt', 'text/plain'], ['dark.webp', 'image/webp'], ['clean.png', 'image/png']]
    .map(([n, type]) => ({ n, type, b64: fs.readFileSync(P(n)).toString('base64') }));
  await page.evaluate((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.n, { type: f.type }));
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dropFiles);
  await until(() => window.__ocrLast);
  await page.waitForTimeout(100);
  const multiStatus = await page.textContent('#status');
  ok('drop of several files: reads the first image and says so', cer(await page.inputValue('#out'), T.dark) < 0.03 && /3 files/.test(multiStatus), multiStatus);

  // huge image gets scaled down
  const rH = await runFile(huge);
  ok(`huge 25.6 MP image: scaled down, still read (${rH.ms} ms)`, /scaled down/.test(rH.status) && cer(rH.text, 'Huge photos get scaled down first.') < 0.05, rH.status + ' :: ' + JSON.stringify(rH.text));

  // ---- 10. non-SIMD fallback builds actually work under this CSP ----------
  for (const core of ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']) {
    const fb = await page.evaluate(async ({ core, b64 }) => {
      try {
        const { default: Tesseract } = await import('/vendor/tesseract/tesseract.esm.min.js');
        const w = await Tesseract.createWorker('eng', 1, {
          workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract/core/' + core,
          langPath: '/vendor/tesseract/lang', workerBlobURL: false, cacheMethod: 'none',
        });
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const { data } = await w.recognize(new Blob([bytes], { type: 'image/png' }), { debug_file: '/dev/null' });
        await w.terminate();
        return data.text;
      } catch (e) { return 'ERROR ' + e; }
    }, { core, b64: cleanB64 });
    ok(`fallback build ${core} loads and reads under the CSP`, cer(fb, T.clean) < 0.03, `CER ${pct(cer(fb, T.clean))}`);
  }

  // ---- 11. privacy -------------------------------------------------------
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://example.com/'); return 'NOT BLOCKED'; } catch (e) { return 'blocked: ' + e.message; }
  });
  ok('fetch(\'https://example.com/\') is blocked by CSP', /^blocked/.test(blocked), blocked);
  const workerBlocked = await page.evaluate(() => {
    try { new Worker('https://example.com/x.js'); return 'NOT BLOCKED'; } catch (e) { return 'blocked: ' + e.name; }
  });
  ok('cross-origin Worker script is refused', /^blocked/.test(workerBlocked), workerBlocked);
  const idb = await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ['(unknown)']));
  ok('nothing stored in IndexedDB (language files not cached on disk)', idb.length === 0, JSON.stringify(idb));
  const ls = await page.evaluate(() => Object.keys(localStorage));
  ok('localStorage holds at most the theme', ls.every((k) => k === 'loltools-theme'), JSON.stringify(ls));

  const offOrigin = requests.filter((u) => !(u.startsWith(ORIGIN + '/') || u.startsWith('blob:') || u.startsWith('data:')));
  ok('every request is same-origin (or blob:/data:)', offOrigin.length === 0, offOrigin.join(', ') || `${requests.length} requests, all ${ORIGIN}`);
  ok('no CDN requests (jsdelivr/unpkg)', !requests.some((u) => /jsdelivr|unpkg|cdn/i.test(u)));
  const files = [...new Set(requests.filter((u) => u.startsWith(ORIGIN)).map((u) => u.replace(ORIGIN, '').split('?')[0]))];
  info(`distinct files requested: ${files.join(', ')}`);

  // ---- 12. layout + screenshots -------------------------------------------
  await runFile(P('photo.jpg'));
  await page.evaluate(() => { document.getElementById('previewBox').open = true; });
  await page.waitForTimeout(300);
  const shotD = path.join(WORK, 'ocr-desktop-1440.png');
  await page.screenshot({ path: shotD, fullPage: true });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
  ok('430px wide: no horizontal scrolling', overflow <= 430, `scrollWidth ${overflow}`);
  const shotM = path.join(WORK, 'ocr-mobile-430.png');
  await page.screenshot({ path: shotM, fullPage: true });
  // also the empty state on mobile
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push('[p2] ' + String(e)));
  await p2.setViewportSize({ width: 430, height: 932 });
  await p2.goto(base);
  await p2.waitForFunction(() => window.__ocrReady);
  const shotM0 = path.join(WORK, 'ocr-mobile-430-empty.png');
  await p2.screenshot({ path: shotM0, fullPage: false });
  await p2.close();
  info(`screenshots: ${shotD}, ${shotM}, ${shotM0}`);

  // ---- 13. errors ---------------------------------------------------------
  const cspViolations = await page.evaluate(() => window.__csp);
  const unexpectedCsp = cspViolations.filter((v) => !/example\.com/.test(v));
  ok('no CSP violations except the deliberate example.com probes', unexpectedCsp.length === 0, cspViolations.join(' | '));
  // Expected console errors: the deliberate example.com fetch/Worker and the aborted fra download.
  const unexpectedConsole = consoleErrors.filter((t) => !/example\.com|fra\.traineddata|ERR_INTERNET_DISCONNECTED|Failed to fetch/.test(t));
  ok('no unexpected console errors', unexpectedConsole.length === 0, unexpectedConsole.join(' | ').slice(0, 400));
  ok('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();

  // ---- summary ------------------------------------------------------------
  console.log('\nAccuracy (CER, lower is better)         browser   native CLI (psm 3 / psm 6)');
  const row = (name, b, f) => console.log(`  ${name.padEnd(38)} ${pct(b).padStart(6)}    ${pct(cer(nativeTesseract(P(f)), T[f.split('.')[0]])).padStart(6)} / ${pct(cer(nativeTesseract(P(f), ['--psm', '6']), T[f.split('.')[0]])).padStart(6)}`);
  row('clean screenshot', c1, 'clean.png');
  row('tilted noisy photo', c2, 'photo.jpg');
  row('small-text receipt', c3, 'receipt.png');
  row('dark-mode WebP', c4, 'dark.webp');
  console.log(`Timing: cold first run ${r1.ms} ms, warm run ${r1b.ms} ms (same image)`);
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
