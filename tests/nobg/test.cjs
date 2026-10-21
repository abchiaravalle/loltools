// Real-Chrome functional test for nobg.lol.
//   node tests/nobg/test.cjs http://127.0.0.1:18821/
// Needs: Playwright at /tmp/loltest/node_modules/playwright (or on NODE_PATH), Google Chrome,
// ImageMagick `magick`. Fixtures are generated into _work/nobg/fixtures/ by this script.
let playwright;
try { playwright = require('playwright'); } catch (_) { playwright = require('/tmp/loltest/node_modules/playwright'); }
const { chromium } = playwright;
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(ROOT, '_work/nobg');
const F = path.join(WORK, 'fixtures') + '/';
const OUT = path.join(WORK, 'out') + '/';
fs.mkdirSync(F, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:18821/';
const origin = new URL(base).origin;

const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  :: ' + detail : ''}`); };
const sh = (c) => execSync(c, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const fx = (file, expr) => parseFloat(sh(`magick "${file}" -format "%[fx:${expr}]" info:`));
// Mean of the alpha channel (0 = fully see-through, 1 = opaque) in a crop.
const alphaMean = (file, crop) => parseFloat(sh(`magick "${file}" -alpha extract ${crop ? `-crop ${crop} +repage` : ''} -format "%[fx:mean]" info:`));
const rgbAt = (file, x, y) => sh(`magick "${file}" -format "%[fx:int(255*p{${x},${y}}.r)],%[fx:int(255*p{${x},${y}}.g)],%[fx:int(255*p{${x},${y}}.b)]" info:`).split(',').map(Number);

// ---------------------------------------------------------------------------
// Fixtures (synthetic, made with ImageMagick; plus public stock images that ship with macOS)
// ---------------------------------------------------------------------------
function makeFixtures() {
  if (!fs.existsSync(F + 'synthetic-ball.jpg')) {
    sh(`magick -size 1200x900 -seed 7 plasma:fractal -blur 0x1 \\( -size 1200x900 pattern:checkerboard -scale 400% -negate -alpha set -channel A -evaluate set 35% +channel \\) -composite "${F}bg-busy.png"`);
    sh(`magick -size 600x600 radial-gradient:'#ffb066'-'#b3360b' "${F}ball.png"`);
    sh(`magick -size 600x600 xc:black -fill white -draw 'circle 300,300 300,0' "${F}ballmask.png"`);
    sh(`magick "${F}ball.png" "${F}ballmask.png" -alpha off -compose CopyOpacity -composite "${F}ballrgba.png"`);
    sh(`magick "${F}bg-busy.png" "${F}ballrgba.png" -geometry +300+150 -compose over -composite -quality 92 "${F}synthetic-ball.jpg"`);
  }
  if (!fs.existsSync(F + 'gt-ball.png')) sh(`magick -size 1200x900 xc:black -fill white -draw 'circle 600,450 600,150' -alpha off -type bilevel "${F}gt-ball.png"`);
  // A "head and shoulders" shape that runs off the bottom of the frame, on a cloudy background.
  if (!fs.existsSync(F + 'synthetic-bust.jpg')) {
    sh(`magick -size 1000x1000 -seed 11 plasma:'#3a6ea5'-'#9fc5e8' -blur 0x2 \\( -size 1000x1000 xc:none -fill '#f3efe6' -draw 'roundrectangle 180,520 820,1400 160,160' -fill '#e8b48a' -draw 'circle 500,330 500,150' \\) -compose over -composite "${F}synthetic-bust.jpg"`);
    sh(`magick -size 1000x1000 xc:black -fill white -draw 'roundrectangle 180,520 820,1400 160,160' -draw 'circle 500,330 500,150' -alpha off -type bilevel "${F}gt-bust.png"`);
  }
  if (!fs.existsSync(F + 'synthetic-figure.png')) {
    sh(`magick -size 900x1200 gradient:'#e8eef7'-'#bcc8dc' \\( -size 900x1200 xc:none -fill '#1f3b73' -draw 'circle 450,300 450,170' -draw 'roundrectangle 260,450 640,1050 60,60' -fill '#e0b13a' -draw 'rectangle 330,560 570,640' \\) -compose over -composite "${F}synthetic-figure.png"`);
    sh(`magick -size 900x1200 xc:black -fill white -draw 'circle 450,300 450,170' -draw 'roundrectangle 260,450 640,1050 60,60' -alpha off -type bilevel "${F}gt-figure.png"`);
  }
  // Real photos: macOS's built-in account pictures (stock images, no people).
  const pics = '/System/Library/Templates/Data/Library/User Pictures/';
  if (!fs.existsSync(F + 'real-penguin.jpg')) sh(`sips -s format jpeg "${pics}Animals/Penguin.heic" --out "${F}real-penguin.jpg"`);
  if (!fs.existsSync(F + 'real-parrot.jpg')) sh(`sips -s format jpeg "${pics}Animals/Parrot.heic" --out "${F}real-parrot.jpg"`);
  if (!fs.existsSync(F + 'real-basketball.webp')) {
    sh(`sips -s format jpeg "${pics}Sports/Basketball.heic" --out "${F}basketball.jpg"`);
    sh(`magick "${F}basketball.jpg" -quality 90 "${F}real-basketball.webp"`);
  }
  if (!fs.existsSync(F + 'real-owl.heic')) fs.copyFileSync(`${pics}Animals/Owl.heic`, F + 'real-owl.heic');
  if (!fs.existsSync(F + 'huge-ball.jpg')) sh(`magick "${F}synthetic-ball.jpg" -resize 6000x4500! -quality 85 "${F}huge-ball.jpg"`);
  // A PNG that is already partly see-through: its see-through corner must stay see-through.
  if (!fs.existsSync(F + 'has-alpha.png')) sh(`magick "${F}synthetic-ball.jpg" \\( -size 1200x900 xc:white -fill black -draw 'rectangle 0,0 300,200' \\) -alpha off -compose CopyOpacity -composite "${F}has-alpha.png"`);
  fs.writeFileSync(F + 'not-an-image.jpg', 'hello, this is not an image\n');
  fs.writeFileSync(F + 'empty.png', '');
  fs.writeFileSync(F + 'notes.pdf', '%PDF-1.4\n% fake\n');
}

(async () => {
  makeFixtures();
  // A real (but brand-new) Chrome profile, so the browser has a normal disk cache:
  // the first visit downloads the model, and the second visit below should reuse it.
  const profile = path.join(WORK, 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = ctx.pages()[0] || await ctx.newPage();
  const requests = [];
  const errors = [];
  const consoleBad = [];
  // Context-level listener: sees every request from every page and its workers, once.
  ctx.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || /Content Security Policy|Refused to/i.test(t)) consoleBad.push(`[${m.type()}] ${t}`);
  });
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') consoleBad.push(`[worker ${m.type()}] ${m.text()}`); }));

  const tLoad = Date.now();
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__nobgReady === true, null, { timeout: 30000 });
  const loadReqs = requests.slice();
  ok('page load fetches no model files (they wait until you add a photo)', !loadReqs.some((u) => /vendor\/imgly/.test(u)), `${loadReqs.length} requests at load`);

  const isolated = await page.evaluate(() => window.crossOriginIsolated);
  ok('page is cross-origin isolated (COOP/COEP), so the model can use threads', isolated === true, String(isolated));

  // CSP blocks other sites, from the page and from the worker.
  const ex = await page.evaluate(async () => { try { await fetch('https://example.com/', { mode: 'no-cors' }); return 'allowed'; } catch (e) { return 'blocked: ' + e.message; } });
  ok("fetch('https://example.com/') from the page is blocked", /^blocked/.test(ex), ex);
  const ex2 = await page.evaluate(async () => { try { await fetch('https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/resources.json'); return 'allowed'; } catch (e) { return 'blocked: ' + e.message; } });
  ok("fetch to IMG.LY's CDN from the page is blocked", /^blocked/.test(ex2), ex2);

  // ---- Wrong inputs ------------------------------------------------------------
  const tryBad = async (file, re, label) => {
    await page.setInputFiles('#fileInput', [file]);
    await page.waitForFunction(() => document.querySelector('#status').classList.contains('err'), null, { timeout: 20000 });
    const s = await page.textContent('#status');
    ok(`${label} gives a plain message`, re.test(s), s);
    ok(`${label}: no viewer or download button shown`, !(await page.isVisible('#viewer')));
  };
  await tryBad(F + 'not-an-image.jpg', /isn't a JPG, PNG or WebP photo/, 'text file named .jpg');
  await tryBad(F + 'empty.png', /empty/, 'empty file');
  await tryBad(F + 'notes.pdf', /PDF, not a photo/, 'PDF');
  await tryBad(F + 'real-owl.heic', /HEIC.*heic\.lol/, 'iPhone HEIC photo');
  ok('rejected files never loaded the model', !requests.some((u) => /vendor\/imgly/.test(u)));

  // ---- First photo: model download + cutout -------------------------------------------
  const progressSeen = [];
  const watch = setInterval(async () => {
    try {
      const s = await page.evaluate(() => [document.querySelector('#status').textContent, !document.querySelector('#progress').hidden]);
      if (s[0] && progressSeen[progressSeen.length - 1] !== s[0]) progressSeen.push(s[0]);
    } catch (_) { /* navigating */ }
  }, 60);
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', [F + 'synthetic-ball.jpg']);
  await page.waitForFunction(() => window.__nobg.runs.length >= 1 || document.querySelector('#status').classList.contains('err'), null, { timeout: 300000 });
  clearInterval(watch);
  const firstWall = Date.now() - t0;
  const tm = await page.evaluate(() => JSON.parse(JSON.stringify(window.__nobg)));
  const status1 = await page.textContent('#status');
  ok('first photo finishes', tm.runs.length === 1, status1);
  ok('shows model download progress the first time', progressSeen.some((s) => /Loading the AI model: [\d.]+ MB of 96 MB/.test(s)), progressSeen.slice(0, 4).join(' | '));
  ok('shows a "cutting out" step', progressSeen.some((s) => /Cutting out/.test(s)), '');
  console.log(`      model load ${tm.modelMs} ms (threads ${tm.threads}, isolated ${tm.isolated}); first cutout ${tm.runs[0] && tm.runs[0].cutMs} ms; wall ${firstWall} ms`);
  const modelReqs = requests.filter((u) => /vendor\/imgly\//.test(u));
  const distinct = new Set(modelReqs);
  const net1 = await page.evaluate(() => window.__nobgNet());
  const bytes1 = net1.reduce((s, e) => s + e.transferSize, 0);
  console.log(`      model + engine: ${modelReqs.length} requests, ${distinct.size} distinct files, ${(bytes1 / 1048576).toFixed(1)} MiB over the network`);
  ok('model and engine came from this site only', distinct.size > 20 && modelReqs.every((u) => u.startsWith(origin + '/vendor/imgly/')), `${distinct.size} files`);
  ok('each model piece is downloaded once', [...distinct].filter((u) => /\/[0-9a-f]{64}$/.test(u)).every((u) => modelReqs.filter((x) => x === u).length === 1), '');

  const viewerShown = await page.isVisible('#viewer');
  ok('before/after viewer appears', viewerShown);
  const checker = await page.evaluate(() => getComputedStyle(document.querySelector('#stage')).backgroundImage);
  ok('cutout preview sits on a checkerboard', /linear-gradient/.test(checker), checker.slice(0, 60));
  // Move the comparison slider and check the original's clip follows.
  await page.fill('#compare', '20');
  await page.dispatchEvent('#compare', 'input');
  const clip = await page.evaluate(() => getComputedStyle(document.querySelector('#beforeImg')).clipPath);
  ok('before/after slider moves the split', /80%/.test(clip), clip);
  await page.fill('#compare', '50');
  await page.dispatchEvent('#compare', 'input');

  await page.screenshot({ path: path.join(WORK, 'desktop-1440.png'), fullPage: true });

  // ---- Save transparent PNG, check it with ImageMagick ---------------------------------
  const saveAs = async (name) => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#saveBtn')]);
    const p = OUT + name;
    await d.saveAs(p);
    return { p, suggested: d.suggestedFilename() };
  };
  const t1 = await saveAs('ball-nobg.png');
  ok('filename is <name>-nobg.png', t1.suggested === 'synthetic-ball-nobg.png', t1.suggested);
  const id1 = sh(`magick identify -format "%m %wx%h %[channels]" "${t1.p}"`);
  ok('transparent PNG: real PNG, same size, has an alpha channel', /^PNG 1200x900 srgba/.test(id1), id1);
  const corners = ['200x150+0+0', '200x150+1000+0', '200x150+0+750', '200x150+1000+750'].map((c) => alphaMean(t1.p, c));
  ok('transparent PNG: busy background corners are see-through (alpha mean < 0.02)', corners.every((a) => a < 0.02), corners.map((a) => a.toFixed(4)).join(' '));
  const centre = alphaMean(t1.p, '300x300+450+300');
  ok('transparent PNG: ball centre is opaque (alpha mean > 0.98)', centre > 0.98, centre.toFixed(4));
  const centreMin = parseFloat(sh(`magick "${t1.p}" -alpha extract -crop 300x300+450+300 +repage -format "%[fx:minima]" info:`));
  ok('transparent PNG: ball centre is fully solid (every pixel alpha 255)', centreMin === 1, String(centreMin));
  const inter = parseFloat(sh(`magick "${t1.p}" -alpha extract -threshold 50% "${F}gt-ball.png" -compose multiply -composite -format "%[fx:mean]" info:`));
  const aM = parseFloat(sh(`magick "${t1.p}" -alpha extract -threshold 50% -format "%[fx:mean]" info:`));
  const gM = parseFloat(sh(`magick "${F}gt-ball.png" -format "%[fx:mean]" info:`));
  const iou = inter / (aM + gM - inter);
  ok('transparent PNG: cutout matches the true ball shape (IoU > 0.97)', iou > 0.97, iou.toFixed(4));
  const raw = execSync(`magick "${t1.p}" -depth 8 rgba:-`, { maxBuffer: 64 * 1024 * 1024 });
  let clear = 0, leaked = 0;
  for (let i = 0; i < raw.length; i += 4) if (raw[i + 3] === 0) { clear++; if (raw[i] || raw[i + 1] || raw[i + 2]) leaked++; }
  ok('transparent PNG: fully see-through pixels are blanked (old background not recoverable)', clear > 100000 && leaked === 0, `${clear} see-through pixels, ${leaked} still carry color`);
  const props = sh(`magick identify -verbose "${t1.p}" | grep -iE "exif|gps|tEXt|zTXt|iTXt" || true`);
  ok('transparent PNG: no metadata', props === '', props.slice(0, 120));

  // ---- Solid color, PNG and JPG -------------------------------------------------------------
  await page.click('label[for=bg-color]');
  ok('color picker appears for solid background', await page.isVisible('#bgColor'));
  await page.fill('#bgColor', '#3366cc');
  await page.dispatchEvent('#bgColor', 'input');
  const stageBg = await page.evaluate(() => getComputedStyle(document.querySelector('#stage')).backgroundColor);
  ok('preview shows the chosen color', stageBg === 'rgb(51, 102, 204)', stageBg);
  const t2 = await saveAs('ball-solid.png');
  const id2 = sh(`magick identify -format "%m %wx%h %[channels] %[opaque]" "${t2.p}"`);
  ok('solid PNG: name, real PNG, no alpha channel', t2.suggested === 'synthetic-ball-3366cc.png' && /^PNG 1200x900 srgb /.test(id2 + ' ') && !/srgba/.test(id2), `${t2.suggested} ${id2}`);
  const c2 = rgbAt(t2.p, 20, 20);
  ok('solid PNG: corner is exactly #3366cc', c2.join(',') === '51,102,204', c2.join(','));
  const ctr2 = rgbAt(t2.p, 600, 450);
  ok('solid PNG: ball centre keeps the ball color (orange, not blue)', ctr2[0] > 180 && ctr2[2] < 140, ctr2.join(','));

  await page.click('label[for=fmt-jpg]');
  ok('button says Download JPG', /JPG/.test(await page.textContent('#saveLabel')));
  const t3 = await saveAs('ball-solid.jpg');
  const id3 = sh(`magick identify -format "%m %wx%h %[channels]" "${t3.p}"`);
  ok('solid JPG: name, real JPEG, no alpha', t3.suggested === 'synthetic-ball-3366cc.jpg' && /^JPEG 1200x900 srgb\b/.test(id3) && !/srgba/.test(id3), `${t3.suggested} ${id3}`);
  const c3 = rgbAt(t3.p, 20, 20);
  ok('solid JPG: corner is #3366cc (within JPEG rounding, ±6)', Math.abs(c3[0] - 51) <= 6 && Math.abs(c3[1] - 102) <= 6 && Math.abs(c3[2] - 204) <= 6, c3.join(','));
  const exif3 = sh(`magick identify -format "%[EXIF:*]" "${t3.p}" 2>/dev/null || true`);
  ok('solid JPG: no EXIF metadata', exif3 === '', exif3.slice(0, 100));
  // White swatch
  await page.click('.nb-swatch[data-c="#ffffff"]');
  const t4 = await saveAs('ball-white.jpg');
  const c4 = rgbAt(t4.p, 1180, 880);
  ok('white swatch: corner is white', c4.every((v) => v >= 250), c4.join(','));
  // Back to see-through
  await page.click('label[for=bg-none]');
  ok('see-through forces PNG', /PNG/.test(await page.textContent('#saveLabel')));

  // ---- Synthetic figure on a gradient ----------------------------------------------------------
  await page.click('#clearBtn');
  ok('Clear empties the tool', !(await page.isVisible('#viewer')) && (await page.textContent('#status')) === '');
  await page.setInputFiles('#fileInput', [F + 'synthetic-figure.png']);
  await page.waitForFunction(() => window.__nobg.runs.length >= 2 || document.querySelector('#status').classList.contains('err'), null, { timeout: 120000 });
  const t5 = await saveAs('figure-nobg.png');
  const fIn = parseFloat(sh(`magick "${t5.p}" -alpha extract -threshold 50% "${F}gt-figure.png" -compose multiply -composite -format "%[fx:mean]" info:`));
  const fA = parseFloat(sh(`magick "${t5.p}" -alpha extract -threshold 50% -format "%[fx:mean]" info:`));
  const fG = parseFloat(sh(`magick "${F}gt-figure.png" -format "%[fx:mean]" info:`));
  const fIou = fIn / (fA + fG - fIn);
  ok('figure: cutout matches the true shape (IoU > 0.97)', fIou > 0.97, fIou.toFixed(4));
  ok('figure: background corner see-through, body opaque', alphaMean(t5.p, '150x150+0+0') < 0.02 && alphaMean(t5.p, '200x300+350+600') > 0.98, `${alphaMean(t5.p, '150x150+0+0').toFixed(4)} / ${alphaMean(t5.p, '200x300+350+600').toFixed(4)}`);

  // ---- Synthetic bust that runs off the bottom edge: second look must not hurt ------------------
  await page.click('#clearBtn');
  const seen2 = [];
  const watch2 = setInterval(async () => { try { const s = await page.textContent('#status'); if (seen2[seen2.length - 1] !== s) seen2.push(s); } catch (_) {} }, 40);
  await page.setInputFiles('#fileInput', [F + 'synthetic-bust.jpg']);
  await page.waitForFunction(() => window.__nobg.runs.length >= 3 || document.querySelector('#status').classList.contains('err'), null, { timeout: 120000 });
  clearInterval(watch2);
  ok('subject touching the edge: says it is taking a second look', seen2.some((s) => /taking a second look/.test(s)), seen2.find((s) => /taking a second look/.test(s)) || seen2.join(' | '));
  const tb = await saveAs('bust-nobg.png');
  const bIn = parseFloat(sh(`magick "${tb.p}" -alpha extract -threshold 50% "${F}gt-bust.png" -compose multiply -composite -format "%[fx:mean]" info:`));
  const bA = parseFloat(sh(`magick "${tb.p}" -alpha extract -threshold 50% -format "%[fx:mean]" info:`));
  const bG = parseFloat(sh(`magick "${F}gt-bust.png" -format "%[fx:mean]" info:`));
  const bIou = bIn / (bA + bG - bIn);
  ok('bust cut off by the frame: matches the true shape (IoU > 0.97), background clear', bIou > 0.97 && alphaMean(tb.p, '150x150+0+0') < 0.02, `IoU ${bIou.toFixed(4)}`);

  // ---- Real photos, as a batch (JPG + WebP), plus ZIP ---------------------------------------
  await page.click('#clearBtn');
  const before = (await page.evaluate(() => window.__nobg.runs.length));
  await page.setInputFiles('#fileInput', [F + 'real-penguin.jpg', F + 'real-basketball.webp', F + 'real-parrot.jpg', F + 'not-an-image.jpg']);
  await page.waitForFunction((n) => {
    const m = [...document.querySelectorAll('#list .fr-meta')];
    return m.length === 4 && m.every((x) => x.classList.contains('ok') || x.classList.contains('err'));
  }, before, { timeout: 300000 });
  const rows = await page.$$eval('#list .file-row', (r) => r.map((x) => [x.querySelector('.fr-name').textContent, x.querySelector('.fr-meta').textContent, x.querySelector('.fr-meta').className]));
  rows.forEach((r) => console.log('     ', r[0], '->', r[1]));
  ok('batch: 3 photos cut out, the bad file gets its own message', rows.filter((r) => /ok/.test(r[2])).length === 3 && /isn't a JPG/.test(rows[3][1]), '');
  ok('batch: summary line', /3 cut out, 1 couldn't be done/.test(await page.textContent('#status')), await page.textContent('#status'));
  ok('batch: ZIP button shows next to Download', await page.isVisible('#zipBtn') && !(await page.isDisabled('#zipBtn')));
  // Clicking a row previews it.
  await page.click('#list li:nth-child(3) .fr-main');
  ok('batch: clicking a row previews that photo', (await page.getAttribute('#list li:nth-child(3)', 'class')).includes('active'));
  await page.screenshot({ path: path.join(WORK, 'desktop-1440-batch.png'), fullPage: false });
  const saveRow = async (i, name) => {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(`#list li:nth-child(${i}) button:has-text("Save")`)]);
    const p = OUT + name; await d.saveAs(p); return p;
  };
  const peng = await saveRow(1, 'penguin-nobg.png');
  const pengCorner = alphaMean(peng, '80x80+0+0'), pengTR = alphaMean(peng, '80x80+432+0');
  const pengHead = alphaMean(peng, '40x30+240+165');
  const pengBelly = ['60x80+300+330', '40x40+250+300', '80x60+180+430'].map((c) => alphaMean(peng, c));
  ok('real penguin: plain sky corners see-through', pengCorner < 0.05 && pengTR < 0.05, `${pengCorner.toFixed(4)} ${pengTR.toFixed(4)}`);
  ok('real penguin: head opaque', pengHead > 0.95, pengHead.toFixed(4));
  // The penguin runs off the bottom of the photo. Without the second look its white belly came out about 70% see-through.
  ok('real penguin: white belly mostly solid (second look for subjects cut off by the frame)', pengBelly.every((a) => a > 0.6), pengBelly.map((a) => a.toFixed(3)).join(' '));
  const ballp = await saveRow(2, 'basketball-nobg.png');
  const bc = alphaMean(ballp, '40x40+0+0'), bm = alphaMean(ballp, '150x150+180+180');
  ok('real basketball (WebP input): corner see-through, ball opaque', bc < 0.05 && bm > 0.98, `${bc.toFixed(4)} / ${bm.toFixed(4)}`);
  const parrot = await saveRow(3, 'parrot-nobg.png');
  const pa = alphaMean(parrot, '200x200+150+150');
  ok('real parrot: face opaque', pa > 0.95, pa.toFixed(4));
  execSync(`magick -size 512x512 pattern:checkerboard \\( "${peng}" \\) -compose over -composite "${OUT}v-penguin.png" && magick -size 512x512 pattern:checkerboard \\( "${ballp}" \\) -compose over -composite "${OUT}v-ball.png" && magick -size 512x512 pattern:checkerboard \\( "${parrot}" \\) -compose over -composite "${OUT}v-parrot.png" && magick "${OUT}v-penguin.png" "${OUT}v-ball.png" "${OUT}v-parrot.png" +append "${WORK}/real-cutouts.png"`);

  const [dz] = await Promise.all([page.waitForEvent('download'), page.click('#zipBtn')]);
  const zf = OUT + dz.suggestedFilename();
  await dz.saveAs(zf);
  execSync(`rm -rf "${OUT}unz" && mkdir -p "${OUT}unz" && cd "${OUT}unz" && unzip -q "${zf}"`);
  const zfiles = fs.readdirSync(OUT + 'unz').sort();
  ok('ZIP holds the 3 cutouts as PNGs with alpha', zfiles.length === 3 && zfiles.every((f) => /-nobg\.png$/.test(f) && /srgba/.test(sh(`magick identify -format "%[channels]" "${OUT}unz/${f}"`))), zfiles.join(', '));

  // ---- A PNG that's already partly see-through ---------------------------------------------
  await page.click('#clearBtn');
  // Once the model has loaded, cutting out needs no network at all.
  await ctx.setOffline(true);
  const nOffline = requests.length;
  await page.setInputFiles('#fileInput', [F + 'has-alpha.png']);
  await page.waitForFunction((n) => window.__nobg.runs.length > n || document.querySelector('#status').classList.contains('err'), before + 3, { timeout: 120000 });
  const offlineStatus = await page.textContent('#status');
  await ctx.setOffline(false);
  ok('works offline once the model has loaded (network off for this photo)', /Done/.test(offlineStatus) && requests.slice(nOffline).every((u) => u.startsWith('blob:')), `${offlineStatus} · ${requests.length - nOffline} requests, all blob:`);
  const ha = await saveAs('has-alpha-nobg.png');
  const haCorner = alphaMean(ha.p, '250x150+20+20');
  ok('a see-through area in the original stays see-through', haCorner < 0.01, haCorner.toFixed(4));

  // ---- Huge photo (27 MP): scaled to fit, still works --------------------------------------
  await page.click('#clearBtn');
  const nRuns = await page.evaluate(() => window.__nobg.runs.length);
  await page.setInputFiles('#fileInput', [F + 'huge-ball.jpg']);
  await page.waitForFunction((n) => window.__nobg.runs.length > n || document.querySelector('#status').classList.contains('err'), nRuns, { timeout: 300000 });
  const cap = await page.textContent('#caption');
  const hb = await saveAs('huge-nobg.png');
  const hdim = sh(`magick identify -format "%wx%h" "${hb.p}"`);
  const [hw, hh] = hdim.split('x').map(Number);
  ok('27-megapixel photo: scaled under 16 MP and says so', hw * hh <= 16000000 && Math.abs(hw / hh - 4 / 3) < 0.01 && /scaled down from 6000×4500/.test(cap), `${hdim} · ${cap}`);
  ok('27-megapixel photo: still cut out (corner clear, centre opaque)', alphaMean(hb.p, `${Math.round(hw / 6)}x${Math.round(hh / 6)}+0+0`) < 0.02 && alphaMean(hb.p, `${Math.round(hw / 4)}x${Math.round(hh / 4)}+${Math.round(hw * 0.375)}+${Math.round(hh * 0.375)}`) > 0.98, '');

  // ---- Second run timing (model already loaded) ------------------------------------------
  const final = await page.evaluate(() => JSON.parse(JSON.stringify(window.__nobg)));
  const cuts = final.runs.map((r) => `${r.name} ${r.w}x${r.h} ${r.cutMs}ms`);
  console.log('      runs: ' + cuts.join(' | '));

  // ---- Worker can't reach other sites ---------------------------------------------------------
  const probe = await page.evaluate(() => window.__nobgProbe('https://example.com/'));
  ok("fetch('https://example.com/') from inside the AI worker is blocked", probe.blocked === true, probe.error || JSON.stringify(probe));

  // ---- Mobile 430px ----------------------------------------------------------------------------
  const m = await ctx.newPage();
  m.on('pageerror', (e) => errors.push('mobile: ' + String(e)));
  await m.setViewportSize({ width: 430, height: 932 });
  const nBefore2 = requests.length;
  await m.goto(base, { waitUntil: 'load' });
  await m.waitForFunction(() => window.__nobgReady === true);
  await m.setInputFiles('#fileInput', [F + 'real-penguin.jpg']);
  await m.waitForFunction(() => window.__nobg.runs.length >= 1 || document.querySelector('#status').classList.contains('err'), null, { timeout: 300000 });
  const tm2 = await m.evaluate(() => JSON.parse(JSON.stringify(window.__nobg)));
  const net2 = await m.evaluate(() => window.__nobgNet());
  const pieces2 = net2.filter((e) => /\/[0-9a-f]{64}$/.test(e.name));
  const bytes2 = net2.reduce((s, e) => s + e.transferSize, 0);
  ok('second visit: model pieces come from the browser cache (0 bytes downloaded)', pieces2.length >= 25 && pieces2.every((e) => e.transferSize === 0), `${pieces2.length} pieces, ${bytes2} bytes over the network in total, model ready in ${tm2.modelMs} ms`);
  console.log(`      second visit: model ready in ${tm2.modelMs} ms, cutout ${tm2.runs[0] && tm2.runs[0].cutMs} ms, ${requests.length - nBefore2} requests`);
  await m.click('label[for=bg-color]');
  await m.click('.nb-swatch[data-c="#9a8cff"]');
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('430px: no sideways scrolling', overflow <= 0, `overflow ${overflow}px`);
  await m.screenshot({ path: path.join(WORK, 'mobile-430.png'), fullPage: true });
  await m.emulateMedia({ colorScheme: 'dark' });
  await m.click('label[for=bg-none]');
  await m.waitForTimeout(400);
  await m.screenshot({ path: path.join(WORK, 'mobile-430-dark.png'), fullPage: false });
  await m.close();

  // ---- Privacy: every request was to this site --------------------------------------------
  const foreign = requests.filter((u) => !(u.startsWith(origin + '/') || u.startsWith('blob:') || u.startsWith('data:')));
  ok('every request (page, worker, model) was same-origin or blob:/data:', foreign.length === 0, foreign.length ? foreign.join(', ') : `${requests.length} requests, all ${origin}`);
  ok('no request to img.ly or staticimgly.com', !requests.some((u) => /img\.ly|staticimgly/.test(u)));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  // The only allowed console errors are the CSP blocks this test caused on purpose (example.com, IMG.LY's CDN).
  const probeNoise = (t) => /example\.com|staticimgly\.com/.test(t);
  const deliberate = consoleBad.filter(probeNoise);
  const other = consoleBad.filter((t) => !probeNoise(t));
  ok('no console errors or CSP violations (apart from the blocks this test triggers on purpose)', other.length === 0 && deliberate.length > 0, other.length ? other.slice(0, 5).join(' | ') : `${deliberate.length} deliberate blocks logged, nothing else`);

  await ctx.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\nmodel load ${tm.modelMs} ms; cutouts: ${final.runs.map((r) => r.cutMs + 'ms').join(', ')}`);
  console.log(`${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
