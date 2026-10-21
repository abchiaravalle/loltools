// Real-Chrome functional test for pdf.lol. Usage: node test_pdf.cjs <baseUrl>
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
const F = process.env.FIXTURES || '/tmp/loltest/fixtures/';
const OUT = '/tmp/loltest/out/pdf/';
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2];
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`); };

function pdfPages(f) { return parseInt(execSync(`gs -q -dNODISPLAY -dNOSAFER -c "(${f}) (r) file runpdfbegin pdfpagecount = quit"`).toString().trim(), 10); }
function pdfText(f) { return execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=txtwrite -sOutputFile=- "${f}" 2>/dev/null`).toString(); }
function render(f, page, png) { execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r40 -dFirstPage=${page} -dLastPage=${page} -sOutputFile="${png}" "${f}"`); }
function gsClean(f) { try { execSync(`gs -q -dNOPAUSE -dBATCH -sDEVICE=nullpage "${f}" 2>&1`); return true; } catch (e) { return String(e.stdout || e.message).slice(0, 300); } }

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  const cspViolations = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('console', (m) => { if (/Content Security Policy|Refused/.test(m.text())) cspViolations.push(m.text()); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' });
  const loadReqs = requests.length;

  // ---- MERGE: a.pdf (2) + b.pdf (3) + orient8.jpg (1) + scan.pdf (3) = 9 pages
  await page.setInputFiles('#mergeInput', [F + 'a.pdf', F + 'b.pdf', F + 'orient8.jpg', F + 'scan.pdf']);
  await page.waitForFunction(() => !document.getElementById('mergeBtn').disabled, null, { timeout: 30000 });
  const st = await page.textContent('#mergeStatus');
  ok('merge: ready status counts pages', /9 pages/.test(st), st);
  // move b.pdf above a.pdf
  await page.click('#mergeList li:nth-child(2) button[title="Move up"]');
  const order = await page.$$eval('#mergeList .fr-name', (n) => n.map((x) => x.textContent));
  ok('merge: reorder works', /b\.pdf/.test(order[0]) && /a\.pdf/.test(order[1]), order.join(' | '));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#mergeBtn')]);
  const mf = OUT + dl.suggestedFilename();
  await dl.saveAs(mf);
  ok('merge: filename', dl.suggestedFilename() === 'b-merged.pdf', dl.suggestedFilename());
  ok('merge: page count = 9', pdfPages(mf) === 9, String(pdfPages(mf)));
  const txt = pdfText(mf);
  const iB = txt.indexOf('b.pdf page 1'), iA = txt.indexOf('a.pdf page 1');
  ok('merge: order b then a', iB >= 0 && iA > iB, `b@${iB} a@${iA}`);
  ok('merge: ghostscript opens it clean', gsClean(mf) === true);
  render(mf, 6, OUT + 'merge-p6-image.png');
  const dims = execSync(`magick identify -format "%w %h" ${OUT}merge-p6-image.png`).toString().split(' ').map(Number);
  ok('merge: EXIF-rotated photo page is landscape (upright)', dims[0] > dims[1], dims.join('x'));

  // ---- LOCKED PDF
  await page.click('#mergeClear');
  await page.setInputFiles('#mergeInput', [F + 'locked.pdf', F + 'a.pdf']);
  await page.waitForTimeout(1500);
  const lockedMsg = await page.textContent('#mergeList li:nth-child(1) .fr-meta');
  ok('merge: locked PDF gets a plain message', /password/i.test(lockedMsg), lockedMsg);

  // ---- COMPRESS
  await page.click('label[for=mode-compress]');
  const sizes = [];
  const comp = ['scan.pdf', 'real-2019-Bilsing-CF-brochure-web.pdf', 'real-COBOT-KIT-User-Manual-2021.pdf', 'real-BIL_FlyerA4_Toolingsystem_2017-05-23_v5_ENG.pdf', 'real-2020-Bilsing-CF-T-Beam-brochure-A4-SEP20_Spanish-1.pdf', 'real-marketmap.pdf', 'a.pdf'];
  await page.setInputFiles('#compressInput', comp.map((x) => F + x));
  await page.waitForFunction((n) => {
    const rows = [...document.querySelectorAll('#compressList .fr-meta')];
    return rows.length === n && rows.every((r) => /smaller|small as it gets|couldn|locked|wrong/i.test(r.textContent));
  }, comp.length, { timeout: 240000 });
  const metas = await page.$$eval('#compressList .file-row', (rows) => rows.map((r) => [r.querySelector('.fr-name').textContent, r.querySelector('.fr-meta').textContent, !!r.querySelector('button')]));
  for (let i = 0; i < metas.length; i++) {
    const [name, meta, hasBtn] = metas[i];
    console.log('   ', name, '->', meta);
    if (!hasBtn) { sizes.push([name, meta]); continue; }
    const [d2] = await Promise.all([page.waitForEvent('download'), page.click(`#compressList li:nth-child(${i + 1}) button`)]);
    const of = OUT + d2.suggestedFilename();
    await d2.saveAs(of);
    const src = F + name;
    const pin = pdfPages(src), pout = pdfPages(of);
    ok(`compress ${name}: same page count`, pin === pout, `${pin} -> ${pout}`);
    ok(`compress ${name}: smaller on disk`, fs.statSync(of).size < fs.statSync(src).size, `${fs.statSync(src).size} -> ${fs.statSync(of).size}`);
    ok(`compress ${name}: ghostscript opens it clean`, gsClean(of) === true);
    const tIn = pdfText(src).replace(/\s+/g, ' ').trim(), tOut = pdfText(of).replace(/\s+/g, ' ').trim();
    ok(`compress ${name}: text layer identical`, tIn === tOut, `${tIn.length} vs ${tOut.length} chars`);
    // visual: compare page 1 render
    let worst = 0, worstPage = 0;
    for (let pg = 1; pg <= Math.min(pin, 8); pg++) {
      render(src, pg, OUT + `v-in-${i}-${pg}.png`); render(of, pg, OUT + `v-out-${i}-${pg}.png`);
      const rmse = execSync(`magick compare -metric RMSE ${OUT}v-in-${i}-${pg}.png ${OUT}v-out-${i}-${pg}.png null: 2>&1 || true`).toString();
      const norm = parseFloat((/\(([\d.e-]+)\)/.exec(rmse) || [])[1]);
      if (!(norm <= worst)) { worst = norm; worstPage = pg; }
    }
    ok(`compress ${name}: every page looks the same (worst RMSE<0.06)`, worst < 0.06, `worst ${worst.toFixed(4)} on page ${worstPage}`);
    sizes.push([name, meta]);
  }
  const noBtn = metas.filter((m) => !m[2]);
  ok('compress: every file without a download says keep the original', noBtn.every((m) => /Keep your original/.test(m[1])), noBtn.map((m) => m[0] + ': ' + m[1]).join(' | ') || 'none');

  // ---- Network: after load, zero requests
  ok('no network requests after page load', requests.length === loadReqs, `${loadReqs} at load, ${requests.length} total`);
  ok('all load requests same-origin', requests.every((u) => u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')), requests.filter((u) => !u.startsWith(base)).join(', '));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  ok('no CSP violations', cspViolations.length === 0, cspViolations.join(' | '));

  // CSP actually blocks a fetch
  const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return false; } catch (_) { return true; } });
  ok('CSP blocks an outbound fetch', blocked);

  await b.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  fs.writeFileSync(OUT + 'results.json', JSON.stringify({ results, sizes }, null, 1));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
