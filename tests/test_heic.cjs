// Real-Chrome functional test for heic.lol.
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
const F = process.env.FIXTURES || '/tmp/loltest/fixtures/';
const OUT = '/tmp/loltest/out/heic/';
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2];
const realHeics = process.argv.slice(3);
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`); };
const exif = (f, k) => execSync(`magick identify -format "%[EXIF:${k}]" "${f}" 2>/dev/null || true`).toString().trim();
const allExif = (f) => execSync(`magick identify -format "%[EXIF:*]" "${f}" 2>/dev/null || true`).toString();

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__heicReady === true, null, { timeout: 30000 });
  const loadReqs = requests.length;

  const files = [F + 'test-gps.heic', F + 'withgps.jpg', ...realHeics];
  await page.setInputFiles('#fileInput', files);
  await page.waitForFunction((n) => {
    const m = [...document.querySelectorAll('#list .fr-meta')];
    return m.length === n && m.every((x) => x.classList.contains('ok') || x.classList.contains('err'));
  }, files.length, { timeout: 180000 });
  const rows = await page.$$eval('#list .file-row', (r) => r.map((x) => [x.querySelector('.fr-name').textContent, x.querySelector('.fr-meta').textContent, x.querySelector('.fr-meta').className]));
  rows.forEach((r) => console.log('   ', r[0], '->', r[1]));
  ok('non-HEIC JPG is rejected with a plain message', /isn't a HEIC/.test(rows[1][1]), rows[1][1]);
  ok('status line summarises', /converted/.test(await page.textContent('#status')), await page.textContent('#status'));

  // Save synthetic one, check pixels + metadata
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#list li:nth-child(1) button')]);
  const j1 = OUT + d1.suggestedFilename();
  await d1.saveAs(j1);
  ok('synthetic: filename', d1.suggestedFilename() === 'test-gps.jpg', d1.suggestedFilename());
  ok('synthetic: is a real JPEG 1600x1200', execSync(`magick identify -format "%m %wx%h" "${j1}"`).toString() === 'JPEG 1600x1200');
  ok('synthetic: GPS removed', exif(j1, 'GPSLatitude') === '' && !/GPS/i.test(allExif(j1)), allExif(j1).replace(/\n/g, ' ').slice(0, 200));
  ok('synthetic: camera model removed', exif(j1, 'Model') === '');
  ok('synthetic: date taken kept', exif(j1, 'DateTimeOriginal') === '2024:07:04 18:30:15', exif(j1, 'DateTimeOriginal'));
  ok('synthetic: time offset kept', exif(j1, 'OffsetTimeOriginal') === '-04:00', exif(j1, 'OffsetTimeOriginal'));
  const rm = execSync(`magick compare -metric RMSE "${F}base.jpg" "${j1}" null: 2>&1 || true`).toString();
  const norm = parseFloat((/\(([\d.e-]+)\)/.exec(rm) || [])[1]);
  ok('synthetic: pixels match the source (RMSE<0.03)', norm < 0.03, rm.trim());

  // Real iPhone photos: dims match HEIC, GPS gone, orientation upright
  for (let i = 0; i < realHeics.length; i++) {
    const src = realHeics[i];
    const idx = i + 3;
    const meta = rows[idx - 1];
    if (/err/.test(meta[2])) { ok(`real ${i + 1}: converted`, false, meta[1]); continue; }
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(`#list li:nth-child(${idx}) button`)]);
    const out = OUT + `real-${i + 1}.jpg`;
    await d.saveAs(out);
    // sips reports the HEIC's displayed (orientation-applied) size
    // Reference: macOS's own conversion, rotated upright the way Photos shows it.
    execSync(`sips -s format jpeg "${src}" --out "${OUT}ref-${i + 1}.jpg" >/dev/null && magick "${OUT}ref-${i + 1}.jpg" -auto-orient "${OUT}refo-${i + 1}.jpg"`);
    const ref = execSync(`magick identify -format "%wx%h" "${OUT}refo-${i + 1}.jpg"`).toString();
    const o = execSync(`magick identify -format "%wx%h" "${out}"`).toString();
    const srcGps = execSync(`magick identify -format "%[EXIF:GPSLatitude]" "${src}" 2>/dev/null || true`).toString().trim();
    ok(`real ${i + 1}: upright, same size as Photos shows it (${ref})`, o === ref, o);
    ok(`real ${i + 1}: no GPS in output`, !/GPS/i.test(allExif(out)), srcGps ? 'source HAD GPS ' + srcGps : 'source had no GPS');
    const r2 = execSync(`magick compare -metric RMSE "${OUT}refo-${i + 1}.jpg" "${out}" null: 2>&1 || true`).toString();
    const n2 = parseFloat((/\(([\d.e-]+)\)/.exec(r2) || [])[1]);
    ok(`real ${i + 1}: looks like macOS's own conversion (RMSE<0.05)`, n2 < 0.05, r2.trim());
  }

  // ZIP
  const [dz] = await Promise.all([page.waitForEvent('download'), page.click('#zipBtn')]);
  const zf = OUT + dz.suggestedFilename();
  await dz.saveAs(zf);
  const zlist = execSync(`unzip -l "${zf}"`).toString();
  const nOk = rows.filter((r) => /ok/.test(r[2])).length;
  const zcount = (zlist.match(/\.jpg/g) || []).length;
  ok('zip: contains every converted photo', zcount === nOk, `${zcount} in zip, ${nOk} converted`);
  execSync(`cd "${OUT}" && rm -rf unz && mkdir unz && cd unz && unzip -q "${zf}"`);
  ok('zip: files open as JPEGs', execSync(`magick identify -format "%m\\n" "${OUT}unz/test-gps.jpg"`).toString().trim() === 'JPEG');

  // PNG mode
  await page.click('#clearBtn');
  await page.click('label[for=fmt-png]');
  await page.setInputFiles('#fileInput', [F + 'test-gps.heic']);
  await page.waitForFunction(() => document.querySelector('#list .fr-meta.ok'), null, { timeout: 60000 });
  const [dp] = await Promise.all([page.waitForEvent('download'), page.click('#list li:nth-child(1) button')]);
  const pf = OUT + dp.suggestedFilename();
  await dp.saveAs(pf);
  ok('png mode: real PNG', execSync(`magick identify -format "%m %wx%h" "${pf}"`).toString() === 'PNG 1600x1200');
  ok('png mode: no GPS', !/GPS/i.test(allExif(pf)));

  // Resize option
  await page.click('#clearBtn');
  await page.click('label[for=fmt-jpg]');
  await page.selectOption('#maxSize', '1280');
  await page.setInputFiles('#fileInput', [F + 'test-gps.heic']);
  await page.waitForFunction(() => document.querySelector('#list .fr-meta.ok'), null, { timeout: 60000 });
  const [dr] = await Promise.all([page.waitForEvent('download'), page.click('#list li:nth-child(1) button')]);
  const rf = OUT + 'resized-' + dr.suggestedFilename();
  await dr.saveAs(rf);
  ok('resize: fits inside 1280', execSync(`magick identify -format "%wx%h" "${rf}"`).toString() === '1280x960');

  // Date off
  await page.click('#clearBtn');
  await page.selectOption('#maxSize', '0');
  await page.uncheck('#keepDate');
  await page.setInputFiles('#fileInput', [F + 'test-gps.heic']);
  await page.waitForFunction(() => document.querySelector('#list .fr-meta.ok'), null, { timeout: 60000 });
  const [dn] = await Promise.all([page.waitForEvent('download'), page.click('#list li:nth-child(1) button')]);
  const nf = OUT + 'nodate-' + dn.suggestedFilename();
  await dn.saveAs(nf);
  ok('date off: no EXIF at all', allExif(nf).trim() === '', allExif(nf).slice(0, 100));

  const net = requests.filter((u) => !u.startsWith('blob:'));
  ok('no network requests after page load (blob: thumbnails are local)', net.length === loadReqs, `${loadReqs} at load, ${requests.length} total: ${requests.slice(loadReqs).join(', ')}`);
  ok('all requests same-origin or blob', requests.every((u) => u.startsWith(base) || u.startsWith('blob:')), requests.filter((u) => !u.startsWith(base)).join(', '));
  ok('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
