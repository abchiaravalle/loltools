// Real-Chrome tests for pdf.lol's Sign, Split, PDF-to-JPG and JPG-to-PDF tools.
// Usage: node tests/pdf/test_more.cjs http://127.0.0.1:18811/
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const F = process.env.FIXTURES || '/tmp/loltest/fixtures/';
const OUT = '/tmp/loltest/out/pdf2/';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2].replace(/\/$/, '');
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`); };
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const pages = (f) => parseInt(sh(`gs -q -dNODISPLAY -dNOSAFER -c "(${f}) (r) file runpdfbegin pdfpagecount = quit"`).trim(), 10);
const text = (f, a, b) => sh(`gs -q -dNOPAUSE -dBATCH -sDEVICE=txtwrite ${a ? `-dFirstPage=${a} -dLastPage=${b}` : ''} -sOutputFile=- "${f}" 2>/dev/null`);
const gsClean = (f) => { try { sh(`gs -q -dNOPAUSE -dBATCH -sDEVICE=nullpage "${f}"`); return true; } catch (e) { return false; } };
const render = (f, pg, png, r = 50) => sh(`gs -q -dNOPAUSE -dBATCH -sDEVICE=png16m -dUseCropBox -r${r} -dFirstPage=${pg} -dLastPage=${pg} -sOutputFile="${png}" "${f}"`);
const rmse = (a, b) => parseFloat((/\(([\d.e-]+)\)/.exec(sh(`magick compare -metric RMSE "${a}" "${b}" null: 2>&1 || true`)) || [])[1]);

async function newPage(b, w = 1280, h = 1000) {
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page._reqs = []; page._errs = []; page._csp = [];
  page.on('request', (r) => page._reqs.push(r.url()));
  page.on('pageerror', (e) => page._errs.push(String(e)));
  page.on('console', (m) => { if (/Content Security Policy|Refused to/.test(m.text())) page._csp.push(m.text()); });
  return page;
}
async function grab(page, clickSel, tag) {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(clickSel)]);
  const f = OUT + (tag ? tag + '-' : '') + d.suggestedFilename();
  await d.saveAs(f);
  return { f, name: d.suggestedFilename() };
}
function netCheck(page, label) {
  const foreign = page._reqs.filter((u) => !(u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')));
  ok(`${label}: every request is same-origin`, foreign.length === 0, foreign.join(', ') || `${page._reqs.length} requests, all ${base}`);
  ok(`${label}: no page errors`, page._errs.length === 0, page._errs.join(' | '));
  ok(`${label}: no CSP violations`, page._csp.length === 0, page._csp.join(' | '));
}

(async () => {
  sh(`node "${path.join(__dirname, 'mkfixtures2.cjs')}" "${F}"`);
  const b = await chromium.launch({ channel: 'chrome', headless: true });

  // ===================== nav + pages =====================
  {
    const page = await newPage(b);
    for (const [p, tool, h1] of [['/', 'merge', 'Merge'], ['/compress/', 'compress', 'smaller'], ['/sign/', 'sign', 'Sign'], ['/split/', 'split', 'Split'], ['/pdf-to-jpg/', 'tojpg', 'JPG'], ['/jpg-to-pdf/', 'topdf', 'images']]) {
      await page.goto(base + p, { waitUntil: 'load' });
      const vis = await page.evaluate((t) => {
        const panels = [...document.querySelectorAll('.tool-panel')].filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.id);
        const active = getComputedStyle(document.querySelector(`.tool-nav a[data-tool="${t}"]`)).backgroundColor;
        return { panels, active, h1: document.querySelector('h1').textContent, canon: document.querySelector('link[rel=canonical]').href };
      }, tool);
      ok(`page ${p}: only its own panel shows, nav highlights it, canonical matches`, vis.panels.length === 1 && vis.panels[0] === 'panel-' + tool && new RegExp(h1, 'i').test(vis.h1) && vis.canon.endsWith(p), JSON.stringify(vis));
    }
    await page.goto(base + '/#compress', { waitUntil: 'load' });
    await page.waitForURL(/\/compress\/$/, { timeout: 5000 }).catch(() => {});
    ok('old /#compress link redirects to /compress/', /\/compress\/$/.test(page.url()), page.url());
    await page.context().close();
  }

  // ===================== SPLIT =====================
  {
    const page = await newPage(b);
    await page.goto(base + '/split/', { waitUntil: 'load' });
    const loadReqs = page._reqs.length;
    await page.setInputFiles('#splitInput', F + 'six.pdf');
    await page.waitForSelector('#splitWork:not([hidden])');
    await page.waitForFunction(() => document.querySelectorAll('#splitThumbs .thumb').length === 6);
    ok('split: dropzone hides and "pages per file" stays hidden in pick mode', !(await page.isVisible('#splitDrop')) && !(await page.isVisible('#splitEveryField')) && await page.isVisible('#splitRangeField'));
    // click pages 2, 4, 5 by thumbnail
    for (const n of [2, 4, 5]) await page.click(`#splitThumbs .thumb:nth-child(${n})`);
    const rv = await page.inputValue('#splitRanges');
    ok('split pick: clicking thumbnails fills the range box', rv === '2, 4-5', rv);
    const s1 = await grab(page, '#splitBtn', 'pick');
    ok('split pick: 1 PDF with 3 pages', pages(s1.f) === 3, `${s1.name} pages=${pages(s1.f)}`);
    const t1 = text(s1.f).replace(/\s+/g, ' ');
    ok('split pick: pages are 2, 4, 5 in order', /PAGE 2.*PAGE 4.*PAGE 5/.test(t1) && !/PAGE [136]/.test(t1), t1.trim().slice(0, 80));
    ok('split pick: gs opens it clean', gsClean(s1.f));
    // ranges -> zip
    await page.click('label[for=sm-ranges]');
    await page.fill('#splitRanges', '1-2, 3-4, 5-');
    await page.waitForTimeout(150);
    const s2 = await grab(page, '#splitBtn', 'ranges');
    ok('split parts: ZIP download', /\.zip$/.test(s2.name), s2.name);
    sh(`rm -rf "${OUT}unz" && mkdir "${OUT}unz" && cd "${OUT}unz" && unzip -q "${s2.f}"`);
    const zf = fs.readdirSync(OUT + 'unz').sort();
    ok('split parts: 3 PDFs in the ZIP', zf.length === 3, zf.join(', '));
    const expect = { 'six-pages-1-2.pdf': [2, 'PAGE 1.*PAGE 2'], 'six-pages-3-4.pdf': [2, 'PAGE 3.*PAGE 4'], 'six-pages-5-6.pdf': [2, 'PAGE 5.*PAGE 6'] };
    for (const [n, [pc, re]] of Object.entries(expect)) {
      const fp = OUT + 'unz/' + n;
      const exists = fs.existsSync(fp);
      ok(`split parts: ${n} has the right pages`, exists && pages(fp) === pc && new RegExp(re).test(text(fp).replace(/\s+/g, ' ')), exists ? `pages=${pages(fp)}` : 'missing');
    }
    // every N
    await page.click('label[for=sm-every]');
    await page.fill('#splitEvery', '4');
    await page.waitForTimeout(150);
    const lbl = (await page.textContent('#splitBtnLabel')).trim();
    ok('split every 4: button says 2 PDFs', /2 PDFs/.test(lbl), lbl);
    // bad input
    await page.click('label[for=sm-pick]');
    await page.fill('#splitRanges', '2-9');
    await page.waitForTimeout(150);
    const err = await page.textContent('#splitStatus');
    ok('split: out-of-range page gives a plain message and disables the button', /only has 6 pages/.test(err) && await page.isDisabled('#splitBtn'), err);
    await page.fill('#splitRanges', 'abc');
    await page.waitForTimeout(150);
    ok('split: junk input gives a plain message', /isn't a page number/.test(await page.textContent('#splitStatus')));
    // locked
    await page.click('#splitReset');
    await page.setInputFiles('#splitInput', F + 'locked.pdf');
    await page.waitForTimeout(1200);
    ok('split: locked PDF message', /password/i.test(await page.textContent('#splitStatus')));
    netCheck(page, 'split');
    const blocked = await page.evaluate(async () => { try { await fetch('https://example.com/'); return false; } catch (_) { return true; } });
    ok('split: CSP blocks fetch to another site', blocked);
    await page.context().close();
  }

  // ===================== PDF TO JPG =====================
  {
    const page = await newPage(b);
    await page.goto(base + '/pdf-to-jpg/', { waitUntil: 'load' });
    await page.setInputFiles('#tojpgInput', F + 'six.pdf');
    await page.waitForFunction(() => /ready/.test(document.getElementById('tojpgStatus').textContent), null, { timeout: 60000 });
    const rows = await page.$$eval('#tojpgList .fr-name', (n) => n.map((x) => x.textContent));
    ok('pdf→jpg: 6 images listed', rows.length === 6 && rows[0] === 'six-page-1.jpg', rows.join(', '));
    const one = await grab(page, '#tojpgList li:nth-child(3) button', 'p3');
    const id = sh(`magick identify -format "%m %wx%h" "${one.f}"`);
    ok('pdf→jpg: page 3 is a 150 DPI JPEG (1275x1650)', id === 'JPEG 1275x1650', id);
    render(F + 'six.pdf', 3, OUT + 'ref3.png', 150);
    const e3 = rmse(OUT + 'ref3.png', one.f);
    ok('pdf→jpg: page 3 looks like ghostscript\'s render (RMSE<0.05)', e3 < 0.05, String(e3));
    const z = await grab(page, '#tojpgZip', 'zip');
    const zl = sh(`unzip -l "${z.f}"`);
    ok('pdf→jpg: ZIP has 6 JPGs', (zl.match(/\.jpg/g) || []).length === 6);
    // PNG + 300 dpi + subset
    await page.click('label[for=tj-png]');
    await page.waitForFunction(() => document.querySelector('#tojpgList .fr-name') && /\.png$/.test(document.querySelector('#tojpgList .fr-name').textContent) && /ready/.test(document.getElementById('tojpgStatus').textContent), null, { timeout: 60000 });
    await page.selectOption('#tjDpi', '300');
    await page.fill('#tjPages', '2, 5');
    await page.dispatchEvent('#tjPages', 'change');
    await page.waitForFunction(() => {
      const n = [...document.querySelectorAll('#tojpgList .fr-name')].map((x) => x.textContent).join(',');
      return n === 'six-page-2.png,six-page-5.png' && /ready/.test(document.getElementById('tojpgStatus').textContent)
        && /2550/.test(document.querySelector('#tojpgList li:nth-child(2) .fr-meta').textContent);
    }, null, { timeout: 60000 });
    const two = await grab(page, '#tojpgList li:nth-child(2) button', 'p5');
    ok('pdf→jpg: page subset + PNG at 300 DPI', two.name === 'six-page-5.png' && sh(`magick identify -format "%m %wx%h" "${two.f}"`) === 'PNG 2550x3300', two.name + ' ' + sh(`magick identify -format "%m %wx%h" "${two.f}"`));
    // rotated pages come out rotated
    await page.fill('#tjPages', '');
    await page.selectOption('#tjDpi', '72');
    await page.click('#tojpgClear');
    await page.setInputFiles('#tojpgInput', F + 'rot.pdf');
    await page.waitForFunction(() => document.querySelectorAll('#tojpgList li').length === 4 && /ready/.test(document.getElementById('tojpgStatus').textContent), null, { timeout: 60000 });
    const metas = await page.$$eval('#tojpgList .fr-meta', (n) => n.map((x) => x.textContent.split(' ')[0]));
    ok('pdf→jpg: rotated pages come out sideways, cropbox respected', metas[0] === '612×792' && metas[1] === '792×612' && metas[2] === '792×612' && metas[3] === '612×792', metas.join(' | '));
    netCheck(page, 'pdf→jpg');
    await page.context().close();
  }

  // ===================== JPG TO PDF =====================
  {
    const page = await newPage(b);
    await page.goto(base + '/jpg-to-pdf/', { waitUntil: 'load' });
    sh(`magick "${F}base.jpg" "${OUT}base.webp"`);
    sh(`magick -size 400x300 xc:none -fill "#9a8cff" -draw "circle 200,150 200,40" "${OUT}alpha.png"`);
    await page.setInputFiles('#topdfInput', [F + 'base.jpg', F + 'orient8.jpg', OUT + 'base.webp', OUT + 'alpha.png', F + 'test-gps.heic', F + 'a.pdf']);
    await page.waitForTimeout(400);
    const metas = await page.$$eval('#topdfList .fr-meta', (n) => n.map((x) => x.textContent));
    ok('jpg→pdf: HEIC points to heic.lol, PDF is skipped', /heic\.lol/.test(metas[4]) && /Not an image/.test(metas[5]), metas.slice(4).join(' | '));
    await page.click('#topdfList li:nth-child(2) button[title="Move up"]');
    const order = await page.$$eval('#topdfList .fr-name', (n) => n.map((x) => x.textContent));
    ok('jpg→pdf: reorder works', /orient8/.test(order[0]) && /base\.jpg/.test(order[1]), order.slice(0, 2).join(' | '));
    const out = await grab(page, '#topdfBtn', 'fit');
    ok('jpg→pdf: 4 pages (bad files left out)', pages(out.f) === 4, String(pages(out.f)));
    ok('jpg→pdf: gs opens it clean', gsClean(out.f));
    render(out.f, 1, OUT + 'tp1.png', 40);
    const d1 = sh(`magick identify -format "%w %h" "${OUT}tp1.png"`).split(' ').map(Number);
    ok('jpg→pdf: EXIF-sideways photo became an upright landscape page', d1[0] > d1[1], d1.join('x'));
    // page 2 = base.jpg embedded as-is: compare to source
    render(out.f, 2, OUT + 'tp2.png', 72);
    sh(`magick "${F}base.jpg" -resize ${sh(`magick identify -format "%wx%h!" "${OUT}tp2.png"`)} "${OUT}base-r.png"`);
    const e2 = rmse(OUT + 'base-r.png', OUT + 'tp2.png');
    ok('jpg→pdf: photo page matches the source image (RMSE<0.05)', e2 < 0.05, String(e2));
    // Letter size with margins
    await page.selectOption('#tpSize', 'letter');
    await page.selectOption('#tpMargin', '36');
    const out2 = await grab(page, '#topdfBtn', 'letter');
    const box = sh(`gs -q -dNODISPLAY -dNOSAFER -c "(${out2.f}) (r) file runpdfbegin 2 pdfgetpage /MediaBox pget pop == quit"`).trim();
    ok('jpg→pdf: Letter pages (landscape photo → landscape Letter)', /\[0 0 792(\.0)? 612(\.0)?\]/.test(box), box);
    netCheck(page, 'jpg→pdf');
    await page.context().close();
  }

  // ===================== SIGN =====================
  {
    const page = await newPage(b, 1280, 1100);
    await page.goto(base + '/sign/', { waitUntil: 'load' });
    await page.setInputFiles('#signInput', F + 'rot.pdf');
    await page.waitForFunction(() => document.querySelectorAll('#signPages .sign-page').length === 4, null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const fitD = await page.evaluate(() => {
      const card = document.querySelector('#panel-sign').closest('.card').getBoundingClientRect();
      return [...document.querySelectorAll('.sign-page')].map((p) => p.getBoundingClientRect()).every((r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5);
    });
    ok('sign desktop: every page fits inside the card', fitD);
    ok('sign: save disabled before anything is placed', await page.isDisabled('#signSave'));
    // draw a signature
    await page.click('#sigCreate');
    const padBox = await page.locator('#sigPad').boundingBox();
    const pts = [];
    for (let t = 0; t <= 1; t += 0.02) pts.push([padBox.x + padBox.width * (0.1 + 0.8 * t), padBox.y + padBox.height * (0.5 + 0.25 * Math.sin(t * 12))]);
    await page.mouse.move(...pts[0]); await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...p, { steps: 2 });
    await page.mouse.up();
    await page.click('#sigUse');
    // No wait here on purpose: the very next tap must place the signature.
    ok('sign: dialog closes, place button armed immediately', !(await page.evaluate(() => document.getElementById('sigDialog').open)) && await page.evaluate(() => document.getElementById('addSig').classList.contains('armed')));
    // Place on each page at a known spot: 25% across, 70% down (as shown on screen)
    const targets = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) await page.click('#addSig');
      const pg = page.locator('#signPages .sign-page').nth(i);
      await pg.scrollIntoViewIfNeeded();
      const bb = await pg.boundingBox();
      const tx = bb.x + bb.width * 0.25, ty = bb.y + bb.height * 0.70;
      await page.mouse.click(tx, ty);
      targets.push({ fx: 0.25, fy: 0.70 });
      await page.waitForTimeout(150);
    }
    // add a date on page 1, top right area
    await page.locator('#signPages .sign-page').nth(0).scrollIntoViewIfNeeded();
    await page.click('#addDate');
    const bb0 = await page.locator('#signPages .sign-page').nth(0).boundingBox();
    await page.mouse.click(bb0.x + bb0.width * 0.7, bb0.y + bb0.height * 0.15);
    await page.waitForTimeout(200);
    const dateVal = await page.locator('.overlay.text-ov input').first().inputValue();
    // drag test: move the page-1 signature by +60px right
    const sig0 = page.locator('#signPages .sign-page').nth(0).locator('.overlay:not(.text-ov)');
    await sig0.scrollIntoViewIfNeeded();
    const sb = await sig0.boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 60, sb.y + sb.height / 2, { steps: 5 });
    await page.mouse.up();
    const sb2 = await sig0.boundingBox();
    ok('sign: dragging moves the signature', Math.abs(sb2.x - sb.x - 60) < 3, `${sb.x.toFixed(1)} -> ${sb2.x.toFixed(1)}`);
    // record each overlay's on-screen box as a fraction of its page
    const fracs = await page.evaluate(() => [...document.querySelectorAll('#signPages .sign-page')].map((pg) => {
      const pr = pg.getBoundingClientRect();
      const o = pg.querySelector('.overlay:not(.text-ov)').getBoundingClientRect();
      return { cx: (o.left + o.width / 2 - pr.left) / pr.width, cy: (o.top + o.height / 2 - pr.top) / pr.height };
    }));
    const out = await grab(page, '#signSave', 'signed');
    ok('sign: filename', out.name === 'rot-signed.pdf', out.name);
    ok('sign: same page count, opens clean', pages(out.f) === 4 && gsClean(out.f));
    ok('sign: original text still there', /normal page/.test(text(out.f)) && /cropbox offset/.test(text(out.f)));
    ok('sign: date text stamped', text(out.f, 1, 1).includes(dateVal), dateVal);
    // For each page: diff signed vs original render; the ink's centroid must sit where we placed it.
    for (let i = 0; i < 4; i++) {
      render(F + 'rot.pdf', i + 1, OUT + `o${i}.png`, 60);
      render(out.f, i + 1, OUT + `s${i}.png`, 60);
      sh(`magick "${OUT}o${i}.png" "${OUT}s${i}.png" -compose difference -composite -colorspace gray -threshold 15% "${OUT}d${i}.png"`);
      const info = sh(`magick "${OUT}d${i}.png" -format "%w %h %[fx:mean]" info:`).split(' ').map(Number);
      // centroid of white (changed) pixels
      const cent = sh(`magick "${OUT}d${i}.png" -define connected-components:verbose=true -define connected-components:area-threshold=30 -connected-components 8 null: 2>&1 | awk 'NR>1 && $NF ~ /gray\\(255\\)|#FFFFFF|srgb\\(255,255,255\\)/ {split($3,c,","); n++; sx+=c[1]; sy+=c[2]} END {if(n) printf "%f %f %d", sx/n, sy/n, n; else print "0 0 0"}'`).trim().split(' ').map(Number);
      // For page 1 only the signature (date is elsewhere) - restrict to the lower half for page 1
      let cx = cent[0] / info[0], cy = cent[1] / info[1];
      if (i === 0) {
        const lower = sh(`magick "${OUT}d${i}.png" -crop 100%x50%+0+${Math.floor(info[1] / 2)} +repage -define connected-components:verbose=true -define connected-components:area-threshold=30 -connected-components 8 null: 2>&1 | awk 'NR>1 && $NF ~ /gray\\(255\\)|#FFFFFF|srgb\\(255,255,255\\)/ {split($3,c,","); n++; sx+=c[1]; sy+=c[2]} END {if(n) printf "%f %f", sx/n, sy/n; else print "0 0"}'`).trim().split(' ').map(Number);
        cx = lower[0] / info[0]; cy = (lower[1] + Math.floor(info[1] / 2)) / info[1];
      }
      const want = fracs[i];
      const err = Math.hypot(cx - want.cx, cy - want.cy);
      ok(`sign page ${i + 1} (${['normal', 'rot 90', 'rot 270', 'cropbox'][i]}): ink lands where it was placed (err<0.05)`, info[2] > 0 && err < 0.05, `want ${want.cx.toFixed(3)},${want.cy.toFixed(3)} got ${cx.toFixed(3)},${cy.toFixed(3)} changed=${(info[2] * 100).toFixed(2)}%`);
      // upright check: the signed area's bounding box should be wider than tall (signature is a horizontal scribble)
      const crop = sh(`magick "${OUT}d${i}.png" ${i === 0 ? `-crop 100%x50%+0+${Math.floor(info[1] / 2)} +repage` : ''} -trim -format "%w %h" info:`).split(' ').map(Number);
      ok(`sign page ${i + 1}: signature reads upright (wider than tall)`, crop[0] > crop[1] * 1.5, crop.join('x'));
    }
    // typed signature mode
    await page.click('#sigCreate');
    await page.click('label[for=sig-type]');
    await page.fill('#sigName', 'Ada Lovelace');
    await page.click('label[for=ink-blue]');
    await page.click('#sigUse');
    await page.waitForTimeout(300);
    ok('sign: typed signature accepted (status: ' + (await page.textContent('#signStatus')) + ')', /Change signature/.test(await page.textContent('#sigCreateLabel')) && await page.evaluate(() => document.getElementById('addSig').classList.contains('armed')));
    // nothing stored
    const stored = await page.evaluate(() => JSON.stringify({ ls: Object.keys(localStorage), ss: Object.keys(sessionStorage) }));
    ok('sign: signature not stored anywhere (only the theme key may exist)', !/sig|sign/i.test(stored), stored);
    netCheck(page, 'sign');
    await page.screenshot({ path: OUT + 'sign-desk.png' });
    await page.context().close();
  }

  // mobile screenshots of sign + split
  {
    const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(base + '/sign/', { waitUntil: 'load' });
    await page.setInputFiles('#signInput', F + 'six.pdf');
    await page.waitForFunction(() => document.querySelectorAll('#signPages .sign-page').length === 6, null, { timeout: 60000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT + 'sign-m430.png' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    ok('sign @430px: no sideways scroll', !overflow);
    const fit = await page.evaluate(() => {
      const card = document.querySelector('#panel-sign').closest('.card').getBoundingClientRect();
      return [...document.querySelectorAll('.sign-page')].map((p) => p.getBoundingClientRect()).every((r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5);
    });
    ok('sign @430px: every page fits inside the card', fit);
    ok('sign @430px: dropzone hides once a PDF is open', !(await page.isVisible('#signDrop')));
    await page.goto(base + '/split/', { waitUntil: 'load' });
    await page.setInputFiles('#splitInput', F + 'six.pdf');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: OUT + 'split-m430.png', fullPage: true });
    ok('split @430px: no sideways scroll', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await ctx.close();
  }

  await b.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
