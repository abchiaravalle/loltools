// Real-Chrome functional test for colorpicker.lol.
//   node tests/color/test.cjs http://127.0.0.1:18824/
// Independent references:
//   - ImageMagick builds the test images and reads back the true pixel at each
//     point we click, converts a Display P3 image to sRGB, and does OKLCH/CMYK.
//   - tests/color/refs.py (Python colorsys + WCAG formula) gives HSL, HSV, CMYK,
//     luminance and contrast ratios.
//   - Chrome's own CSS engine (canvas fillStyle) checks the color-text parser.
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const WORK = path.join(ROOT, '_work/color');
fs.mkdirSync(WORK, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:18824/';
const ORIGIN = new URL(base).origin;

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  :: ' + detail : ''}`);
};
const magick = (...args) => execFileSync('magick', args, { maxBuffer: 1 << 26 }).toString().trim();
const W = (f) => path.join(WORK, f);

// ---------------------------------------------------------------------------
// Test images (ImageMagick)
// ---------------------------------------------------------------------------
const BLOCK = 160;
const BLOCKS = [
  ['#ff0000', '#00ff00', '#0000ff', '#336699'],
  ['#f5c26b', '#000000', '#ffffff', '#7f7f7f'],
];
const STRIP_Y0 = 2 * BLOCK, STRIP_H = 40, IMG_W = 4 * BLOCK, IMG_H = STRIP_Y0 + STRIP_H;
function makeImages() {
  for (let r = 0; r < 2; r++) {
    magick('-size', `${BLOCK}x${BLOCK}`, ...BLOCKS[r].map((c) => 'xc:' + c), '+append', W(`row${r}.png`));
  }
  // A strip where every column has its own color: R = x mod 256, G = 255 - R, B = 100 * floor(x / 256).
  magick('-size', `${IMG_W}x${STRIP_H}`, 'xc:black',
    '-channel', 'R', '-fx', '(i%256)/255', '-channel', 'G', '-fx', '(255-(i%256))/255', '-channel', 'B', '-fx', 'floor(i/256)*100/255', '+channel',
    W('strip.png'));
  magick(W('row0.png'), W('row1.png'), W('strip.png'), '-append', '-strip', '-depth', '8', '-type', 'TrueColor', 'PNG24:' + W('blocks.png'));
  // Display P3 tagged image of rgb(200,100,50) in P3 numbers.
  magick('-size', '64x64', 'xc:rgb(200,100,50)', '-profile', '/System/Library/ColorSync/Profiles/Display P3.icc', W('p3.png'));
  magick('-size', '120x80', 'xc:#c0ffee', '-depth', '8', 'PNG24:' + W('paste.png'));
  magick('-size', '64x64', 'xc:#8b4513', '-depth', '8', 'PNG24:' + W('drop.png'));
  magick('-size', '50x50', 'xc:none', 'PNG32:' + W('clear.png'));
  magick('-size', '5000x4000', 'xc:#336699', '-depth', '8', 'PNG24:' + W('big.png'));
  if (!fs.existsSync(W('photo.jpg'))) magick('-seed', '7', '-size', '2400x1600', 'plasma:fractal', '-blur', '0x2', '-quality', '90', W('photo.jpg'));
  fs.writeFileSync(W('notes.txt'), 'not an image\n');
  fs.writeFileSync(W('empty.png'), Buffer.alloc(0));
  fs.writeFileSync(W('broken.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]));
}
// True pixel values, read by ImageMagick.
function pixels(file, pts) {
  const fmt = pts.map(([x, y]) => `%[hex:p{${x},${y}}]`).join(' ');
  return magick(file, '-format', fmt, 'info:').split(/\s+/).map((h) => '#' + h.toLowerCase().slice(0, 6));
}

// ---------------------------------------------------------------------------
// Reference conversions (Python colorsys + WCAG, ImageMagick OKLCH)
// ---------------------------------------------------------------------------
const TABLE = ['#ff0000', '#00ff00', '#0000ff', '#336699', '#f5c26b', '#000000', '#ffffff', '#777777', '#808080',
  '#663399', '#6495ed', '#b8860b', '#123456', '#abcdef', '#fedcba', '#00ffff', '#ff00ff', '#ffff00', '#010203',
  '#c0ffee', '#7f7f7f', '#e6e6fa', '#8b4513', '#ff0080', '#2e8b57'];
const PAIRS = [
  ['#000000', '#ffffff'], ['#777777', '#ffffff'], ['#767676', '#ffffff'], ['#336699', '#ffffff'], ['#f5c26b', '#000000'],
  ['#ff0000', '#ffffff'], ['#0000ff', '#ffffff'], ['#00ff00', '#000000'], ['#949494', '#ffffff'], ['#595959', '#ffffff'],
  ['#ffffff', '#ffffff'], ['#123456', '#abcdef'],
];
function references() {
  const args = [path.join(__dirname, 'refs.py'), ...TABLE, ...PAIRS.map((p) => 'pair:' + p.join(','))];
  return JSON.parse(execFileSync('python3', args).toString());
}
const hueDiff = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
const nums = (s) => (s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

(async () => {
  makeImages();
  const REF = references();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const allRequests = [];
  const errors = [];
  const cspViolations = [];
  let workers = 0;
  function watch(ctx, label) {
    ctx.on('request', (r) => allRequests.push({ label, url: r.url() }));
    ctx.on('page', (p) => attachPage(p, label));
  }
  function attachPage(p, label) {
    p.on('pageerror', (e) => errors.push(`${label}: ${e}`));
    p.on('console', (m) => {
      const t = m.text();
      if (/Content Security Policy|Refused to/i.test(t)) cspViolations.push(`${label}: ${t}`);
      else if (m.type() === 'error') errors.push(`${label} console: ${t}`);
    });
    p.on('worker', () => { workers++; });
  }

  // =========================================================================
  // Desktop, 1440 wide, Retina-style devicePixelRatio 2
  // =========================================================================
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  watch(ctx, 'desktop');
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  ok('page title from tools.json', /colorpicker\.lol/.test(await page.title()), await page.title());
  const hasED = await page.evaluate(() => typeof window.EyeDropper === 'function');
  const btnVisible = await page.isVisible('#screenBtn');
  ok('Pick-from-screen button matches EyeDropper support', hasED === btnVisible, `EyeDropper in this Chrome: ${hasED}, button visible: ${btnVisible}`);
  ok('starts on #336699', (await page.textContent('#v-hex')) === '#336699');

  // ---- Conversion table ----------------------------------------------------
  const readFormats = () => page.evaluate(() => Object.fromEntries(['hex', 'rgb', 'hsl', 'hsv', 'cmyk', 'oklch'].map((k) => [k, document.getElementById('v-' + k).textContent])));
  let convFails = [];
  let maxErr = { hsl: 0, hsv: 0, cmyk: 0, L: 0, Cc: 0, h: 0 };
  for (const hex of TABLE) {
    await page.fill('#colorInput', hex);
    const f = await readFormats();
    const r = REF.colors[hex];
    const bad = [];
    if (f.hex !== r.hex) bad.push('hex ' + f.hex);
    if (f.rgb !== `rgb(${r.rgb.join(', ')})`) bad.push('rgb ' + f.rgb);
    const hsl = nums(f.hsl), hsv = nums(f.hsv), cmyk = nums(f.cmyk), lch = nums(f.oklch);
    // HSL and HSV are shown with 1 decimal, so they must be within 0.05 of the reference.
    const eHsl = Math.max(hueDiff(hsl[0], r.hsl[0]), Math.abs(hsl[1] - r.hsl[1]), Math.abs(hsl[2] - r.hsl[2]));
    const eHsv = Math.max(hueDiff(hsv[0], r.hsv[0]), Math.abs(hsv[1] - r.hsv[1]), Math.abs(hsv[2] - r.hsv[2]));
    // CMYK is shown as whole percents: within 0.5 of both Python and ImageMagick.
    const eCmyk = Math.max(...cmyk.map((v, i) => Math.abs(v - r.cmyk[i])), ...cmyk.map((v, i) => Math.abs(v - r.cmyk_im[i])));
    const eL = Math.abs(lch[0] - r.oklch.l), eC = Math.abs(lch[1] - r.oklch.c), eH = r.oklch.c < 2e-4 ? 0 : hueDiff(lch[2], r.oklch.h);
    maxErr = { hsl: Math.max(maxErr.hsl, eHsl), hsv: Math.max(maxErr.hsv, eHsv), cmyk: Math.max(maxErr.cmyk, eCmyk), L: Math.max(maxErr.L, eL), Cc: Math.max(maxErr.Cc, eC), h: Math.max(maxErr.h, eH) };
    if (eHsl > 0.0501) bad.push('hsl ' + f.hsl + ' ref ' + r.hsl.map((v) => v.toFixed(3)));
    if (eHsv > 0.0501) bad.push('hsv ' + f.hsv + ' ref ' + r.hsv.map((v) => v.toFixed(3)));
    if (eCmyk > 0.5001) bad.push('cmyk ' + f.cmyk + ' ref ' + r.cmyk.map((v) => v.toFixed(2)));
    if (eL > 0.0051 || eC > 0.00006 || eH > 0.0151) bad.push(`oklch ${f.oklch} ref ${r.oklch.l.toFixed(4)}% ${r.oklch.c.toFixed(5)} ${r.oklch.h.toFixed(3)}`);
    if (!/^rgb\(/.test(f.rgb) || !/^hsl\(/.test(f.hsl) || !/^hsv\(/.test(f.hsv) || !/^cmyk\(/.test(f.cmyk) || !/^oklch\(/.test(f.oklch)) bad.push('format shape');
    if (bad.length) convFails.push(hex + ': ' + bad.join('; '));
  }
  ok(`conversions match references for ${TABLE.length} colors (HEX, RGB, HSL, HSV, CMYK, OKLCH)`, convFails.length === 0,
    convFails.length ? convFails.join(' | ') : `max error: HSL ${maxErr.hsl.toFixed(3)}, HSV ${maxErr.hsv.toFixed(3)}, CMYK ${maxErr.cmyk.toFixed(3)}, OKLCH L ${maxErr.L.toFixed(4)} C ${maxErr.Cc.toFixed(5)} h ${maxErr.h.toFixed(3)}`);
  await page.fill('#colorInput', '#336699');
  const f369 = await readFormats();
  ok('#336699 shows exact strings', f369.hex === '#336699' && f369.rgb === 'rgb(51, 102, 153)' && f369.hsl === 'hsl(210, 50%, 40%)' && f369.hsv === 'hsv(210, 66.7%, 60%)' && f369.cmyk === 'cmyk(67%, 33%, 0%, 40%)' && f369.oklch === 'oklch(49.93% 0.0987 250.43)', JSON.stringify(f369));

  // ---- Typed input formats, checked against Chrome's own CSS color parser ----
  const INPUTS = ['#369', '#336699', '#33669980', '#3698', 'rgb(51, 102, 153)', 'rgb(51 102 153)', 'rgba(51,102,153,0.5)', 'rgb(51 102 153 / 50%)',
    'rgb(20%, 40%, 60%)', 'hsl(210, 50%, 40%)', 'hsl(210deg 50% 40%)', 'hsla(210, 50%, 40%, .25)', 'hsl(0.5turn 100% 25%)', 'hsl(17, 83%, 61%)',
    'hsl(300 76% 72%)', 'rebeccapurple', 'Teal', 'CornflowerBlue', 'transparent', 'oklch(49.93% 0.0987 250.43)', 'oklch(0.7 0.1 150)',
    '  #ABCDEF  ', 'hsl(-30, 100%, 50%)', 'rgb(255 128 0 / 0.75)'];
  const parseCheck = await page.evaluate(async (inputs) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    // Opaque colors: let Chrome paint it and read the pixel. See-through colors:
    // Chrome's computed style (canvas readback is premultiplied, so it rounds).
    const probe = document.createElement('span'); document.body.appendChild(probe);
    const browserColor = (s) => {
      probe.style.color = ''; probe.style.color = s.trim();
      const m = /^rgba?\(([^)]+)\)$/.exec(getComputedStyle(probe).color);
      if (m) { const v = m[1].split(',').map(Number); if (v.length === 4) return [v[0], v[1], v[2], Math.round(v[3] * 255)]; }
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#010203'; cx.fillStyle = s.trim(); cx.globalCompositeOperation = 'copy'; cx.fillRect(0, 0, 1, 1); return Array.from(cx.getImageData(0, 0, 1, 1).data);
    };
    const input = document.getElementById('colorInput');
    const out = [];
    for (const s of inputs) {
      input.value = s; input.dispatchEvent(new Event('input', { bubbles: true }));
      const hex = document.getElementById('v-hex').textContent;
      const p = window.colormath.parse(hex);
      out.push({ s, hex, page: [p.r, p.g, p.b, p.a], chrome: browserColor(s) });
    }
    // All 148 CSS color names.
    let nameMismatch = [];
    for (const n of Object.keys(window.colormath.NAMES)) {
      const p = window.colormath.parse(n);
      const b = browserColor(n);
      if (p.r !== b[0] || p.g !== b[1] || p.b !== b[2] || b[3] !== 255) nameMismatch.push(n);
    }
    return { out, nameMismatch, nameCount: Object.keys(window.colormath.NAMES).length };
  }, INPUTS);
  // Chrome writes alpha with 2 or 3 decimals, so alpha may differ by one step.
  const parseBad = parseCheck.out.filter((o) => {
    const tol = 0;
    if (o.page[3] < 255 && Math.abs(o.page[3] - o.chrome[3]) <= 1) return o.page.slice(0, 3).some((v, i) => v !== o.chrome[i]);
    if (o.page[3] === 0 && o.chrome[3] === 0) return false;
    return o.page.some((v, i) => Math.abs(v - o.chrome[i]) > tol);
  });
  ok(`${INPUTS.length} typed formats parse like Chrome's own CSS engine`, parseBad.length === 0,
    parseBad.length ? parseBad.map((o) => `${o.s} -> page ${o.page} chrome ${o.chrome}`).join(' | ') : parseCheck.out.map((o) => `${o.s.trim()}=${o.hex}`).slice(0, 8).join(', ') + ', ...');
  ok(`all ${parseCheck.nameCount} CSS color names match Chrome`, parseCheck.nameCount >= 148 && parseCheck.nameMismatch.length === 0, parseCheck.nameMismatch.join(', '));

  await page.fill('#colorInput', 'rgb(51 102 153 / 50%)');
  ok('alpha input keeps #rrggbbaa', (await page.textContent('#v-hex')) === '#33669980' && (await page.textContent('#v-rgb')) === 'rgba(51, 102, 153, 0.502)');
  await page.fill('#colorInput', 'oklch(70% 0.4 30)');
  ok('out-of-sRGB color is clipped with a plain note', /outside what sRGB/.test(await page.textContent('#inputMsg')), await page.textContent('#inputMsg'));
  await page.fill('#colorInput', 'blurple');
  await page.waitForTimeout(1100);
  const badMsg = await page.textContent('#inputMsg');
  ok('nonsense input gets a plain message, keeps last color', /isn't a color/.test(badMsg) && (await page.getAttribute('#colorInput', 'aria-invalid')) === 'true' && (await page.textContent('#v-hex')) === '#ff0000', badMsg);
  await page.fill('#colorInput', '');
  await page.waitForTimeout(100);
  ok('empty input is calm (no error)', (await page.textContent('#inputMsg')) === '');

  // ---- Copy buttons -> clipboard --------------------------------------------
  await page.fill('#colorInput', '#f5c26b');
  const clipFails = [];
  for (const k of ['hex', 'rgb', 'hsl', 'hsv', 'cmyk', 'oklch']) {
    const shown = await page.textContent('#v-' + k);
    await page.click(`.fmt-row[data-fmt="${k}"]`);
    await page.waitForTimeout(80);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip !== shown) clipFails.push(`${k}: shown ${shown} clip ${clip}`);
  }
  const clipHex = await page.evaluate(() => navigator.clipboard.readText());
  await page.click('.fmt-row[data-fmt="hex"]');
  ok('each copy button puts its exact string on the clipboard', clipFails.length === 0 && (await page.evaluate(() => navigator.clipboard.readText())) === '#f5c26b', clipFails.join(' | ') || 'last: ' + clipHex);
  ok('copy shows "Copied" feedback', (await page.textContent('.fmt-row[data-fmt="hex"] .fmt-copy')) === 'Copied');

  // ---- Contrast --------------------------------------------------------------
  const contrastFails = [];
  const contrastShow = [];
  for (const [fg, bg] of PAIRS) {
    await page.click('label[for=role-text]');
    await page.fill('#colorInput', fg);
    await page.fill('#otherInput', bg);
    const shown = await page.textContent('#ratio');
    const ref = REF.pairs[`${fg},${bg}`];
    const cells = await page.evaluate(() => ['aaNormal', 'aaLarge', 'aaaNormal', 'aaaLarge'].map((id) => document.getElementById(id).className === 'pass'));
    const want = [ref >= 4.5, ref >= 3, ref >= 7, ref >= 4.5];
    const refShown = Math.round(ref * 100) / 100;
    // Shown value is the reference rounded to 2 decimals (rounded down only if rounding would fake a pass).
    const shownOk = Math.abs(parseFloat(shown) - refShown) < 0.0001 || (Math.floor(ref * 100) / 100).toFixed(2) === shown;
    if (!shownOk || cells.some((c, i) => c !== want[i])) contrastFails.push(`${fg} on ${bg}: shown ${shown}, ref ${ref.toFixed(4)}, cells ${cells} want ${want}`);
    contrastShow.push(`${fg}/${bg}=${shown}`);
    // Swap roles: same ratio.
    await page.click('label[for=role-bg]');
    if ((await page.textContent('#ratio')) !== shown) contrastFails.push(`${fg}/${bg} changes when roles swap`);
  }
  ok(`contrast ratio + AA/AAA cells for ${PAIRS.length} pairs match the WCAG reference`, contrastFails.length === 0, contrastFails.join(' | ') || contrastShow.join(', '));
  await page.click('label[for=role-text]');
  await page.fill('#colorInput', '#000000'); await page.fill('#otherInput', '#ffffff');
  ok('black on white = 21.00', (await page.textContent('#ratio')) === '21.00');
  await page.fill('#colorInput', '#777777');
  ok('#777777 on white = 4.48 and fails AA normal, passes AA large',
    (await page.textContent('#ratio')) === '4.48' && (await page.getAttribute('#aaNormal', 'class')) === 'fail' && (await page.getAttribute('#aaLarge', 'class')) === 'pass');
  await page.fill('#colorInput', '#767676');
  ok('#767676 on white = 4.54 passes AA normal', (await page.textContent('#ratio')) === '4.54' && (await page.getAttribute('#aaNormal', 'class')) === 'pass');
  const sampleStyle = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('sample')); return [s.color, s.backgroundColor]; });
  ok('live text sample uses the two colors', sampleStyle[0] === 'rgb(118, 118, 118)' && sampleStyle[1] === 'rgb(255, 255, 255)', sampleStyle.join(' on '));
  await page.fill('#colorInput', '#336699');
  const quick = await page.evaluate(() => [document.getElementById('qcWhite').dataset.ratio, document.getElementById('qcBlack').dataset.ratio]);
  ok('default white and black text checks shown', quick[0] === REF.colors['#336699'].vs_white.toFixed(2) && quick[1] === REF.colors['#336699'].vs_black.toFixed(2), `white ${quick[0]}, black ${quick[1]}`);

  // ---- Pick from an image: exact pixel at the click point --------------------
  let t0 = Date.now();
  await page.setInputFiles('#fileInput', W('blocks.png'));
  await page.waitForSelector('#palette li', { timeout: 15000 });
  const loadMs = Date.now() - t0;
  const dims = await page.evaluate(() => { const c = document.getElementById('imgCanvas'); const b = c.getBoundingClientRect(); return { w: c.width, h: c.height, bw: b.width, bh: b.height }; });
  ok('image drawn at its own size', dims.w === IMG_W && dims.h === IMG_H, JSON.stringify(dims));

  async function clickPixel(pg, x, y) {
    const box = await pg.evaluate(() => { const c = document.getElementById('imgCanvas'); c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height, w: c.width, h: c.height }; });
    const cx = box.left + ((x + 0.5) * box.width) / box.w;
    const cy = box.top + ((y + 0.5) * box.height) / box.h;
    await pg.mouse.click(cx, cy);
    await pg.waitForTimeout(30);
    return pg.evaluate(() => ({ hex: document.getElementById('v-hex').textContent, picked: document.getElementById('pickedHex').textContent, x: +document.getElementById('imgCanvas').dataset.pickX, y: +document.getElementById('imgCanvas').dataset.pickY }));
  }
  async function blockChecks(pg, label) {
    const fails = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 4; c++) {
        const x = c * BLOCK + BLOCK / 2, y = r * BLOCK + BLOCK / 2;
        const got = await clickPixel(pg, x, y);
        const want = BLOCKS[r][c];
        const truth = pixels(W('blocks.png'), [[x, y]])[0];
        if (got.hex !== want || got.picked !== want || truth !== want) fails.push(`${want}: page ${got.hex} magick ${truth}`);
      }
    }
    ok(`${label}: clicking the center of each of the 8 blocks reports the exact HEX`, fails.length === 0, fails.join(' | ') || BLOCKS.flat().join(' '));
  }
  await blockChecks(page, 'desktop dpr2');

  // Single-pixel accuracy on the strip, where every column is a different color.
  const stripPts = [[0, STRIP_Y0 + 5], [1, STRIP_Y0 + 5], [37, STRIP_Y0 + 20], [255, STRIP_Y0 + 1], [256, STRIP_Y0 + 39], [300, STRIP_Y0 + 10], [511, STRIP_Y0 + 20], [512, STRIP_Y0 + 20], [639, STRIP_Y0 + 39]];
  const truthStrip = pixels(W('blocks.png'), stripPts);
  const stripFails = [];
  for (let i = 0; i < stripPts.length; i++) {
    const got = await clickPixel(page, ...stripPts[i]);
    if (got.x !== stripPts[i][0] || got.y !== stripPts[i][1] || got.hex !== truthStrip[i]) stripFails.push(`(${stripPts[i]}) page (${got.x},${got.y}) ${got.hex} magick ${truthStrip[i]}`);
  }
  ok('desktop dpr2: single-pixel picks land on the exact pixel and color (9 points incl. edges)', stripFails.length === 0, stripFails.join(' | ') || truthStrip.join(' '));

  // Loupe on hover shows the hovered pixel.
  {
    const box = await page.evaluate(() => { const b = document.getElementById('imgCanvas').getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width }; });
    const k = box.width / IMG_W;
    await page.mouse.move(box.left + (100.5) * k, box.top + (STRIP_Y0 + 15.5) * k);
    await page.waitForTimeout(50);
    const loupe = await page.evaluate(() => {
      const l = document.getElementById('loupe'); const lc = document.getElementById('loupeCanvas');
      const d = lc.getContext('2d').getImageData(Math.floor(lc.width / 2), Math.floor(lc.height / 2), 1, 1).data;
      return { hidden: l.hidden, label: document.getElementById('loupeLabel').textContent, center: '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''), w: lc.width };
    });
    const truth = pixels(W('blocks.png'), [[100, STRIP_Y0 + 15]])[0];
    ok('hover loupe appears and its center pixel is the hovered pixel', !loupe.hidden && loupe.label === truth && loupe.center === truth, `${JSON.stringify(loupe)} magick ${truth}`);
    ok('loupe canvas is sized for devicePixelRatio 2', loupe.w === 264, 'width ' + loupe.w);
  }
  // Keyboard: start at a known pixel, arrows move one pixel, Enter picks.
  await clickPixel(page, 300, STRIP_Y0 + 10);
  await page.focus('#imgCanvas');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  {
    const got = await page.evaluate(() => ({ hex: document.getElementById('v-hex').textContent, x: +document.getElementById('imgCanvas').dataset.pickX, y: +document.getElementById('imgCanvas').dataset.pickY }));
    const truth = pixels(W('blocks.png'), [[303, STRIP_Y0 + 11]])[0];
    ok('keyboard: arrows move one pixel, Enter picks', got.x === 303 && got.y === STRIP_Y0 + 11 && got.hex === truth, JSON.stringify(got) + ' magick ' + truth);
  }

  // ---- Palette ---------------------------------------------------------------
  const engine = await page.getAttribute('#palette', 'data-engine');
  ok('palette ran in a Web Worker (off the main thread)', workers >= 1 && engine === 'worker', `${workers} worker(s), engine=${engine}, first palette in ${loadMs} ms incl. decode`);
  async function readPalette(pg) {
    return pg.evaluate(() => Array.from(document.querySelectorAll('#palette .sw')).map((b) => ({ hex: b.dataset.hex, share: +b.dataset.share })));
  }
  async function setK(pg, k) {
    const before = JSON.stringify(await readPalette(pg));
    await pg.click(`label[for=k${k}]`);
    await pg.waitForFunction((n) => document.querySelectorAll('#palette .sw').length > 0 && (document.querySelectorAll('#palette .sw').length === n || document.querySelectorAll('#palette .sw').length < n), k);
    await pg.waitForTimeout(200);
    return readPalette(pg);
  }
  const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const dist = (a, b) => Math.hypot(...rgbOf(a).map((v, i) => v - rgbOf(b)[i]));
  const pal8 = await setK(page, 8);
  const blockList = BLOCKS.flat();
  const palMatch = blockList.map((b) => Math.min(...pal8.map((p) => dist(p.hex, b))));
  ok('palette (8) finds all 8 blocks within RGB distance 8', pal8.length === 8 && palMatch.every((d) => d <= 8), pal8.map((p) => `${p.hex} ${(p.share * 100).toFixed(1)}%`).join(', ') + ' | max dist ' + Math.max(...palMatch).toFixed(2));
  const blockShare = BLOCK * BLOCK / (IMG_W * IMG_H);
  ok('palette shares are close to the real block areas', pal8.every((p) => Math.abs(p.share - blockShare) < 0.05), `each block is ${(blockShare * 100).toFixed(1)}% of the image`);
  const pal5 = await setK(page, 5);
  ok('palette (5) gives 5 colors, each a real block color', pal5.length === 5 && pal5.every((p) => blockList.some((b) => dist(p.hex, b) <= 8)), pal5.map((p) => p.hex).join(' '));
  const pal6 = await setK(page, 6);
  ok('palette (6) gives 6 colors', pal6.length === 6, pal6.map((p) => p.hex).join(' '));
  await setK(page, 8);
  await page.click('#copyCss');
  await page.waitForTimeout(80);
  const cssClip = await page.evaluate(() => navigator.clipboard.readText());
  const cssVars = [...cssClip.matchAll(/--color-(\d+): (#[0-9a-f]{6});/g)].map((m) => m[2]);
  ok('Copy as CSS variables gives a :root block with every swatch', /^:root \{\n/.test(cssClip) && /\n\}$/.test(cssClip) && JSON.stringify(cssVars) === JSON.stringify(pal8.map((p) => p.hex)), cssClip.split('\n').slice(0, 3).join(' '));
  await page.click('#copyHex');
  await page.waitForTimeout(80);
  const hexClip = await page.evaluate(() => navigator.clipboard.readText());
  ok('Copy HEX list gives one HEX per line', hexClip === pal8.map((p) => p.hex).join('\n'), hexClip.replace(/\n/g, ' '));
  await page.click('#palette li:nth-child(2) .sw');
  ok('clicking a palette swatch makes it the current color', (await page.textContent('#v-hex')) === pal8[1].hex);

  // Bigger photo: timing, and every palette color is a color really in the image.
  t0 = Date.now();
  await page.setInputFiles('#fileInput', W('photo.jpg'));
  await page.waitForFunction(() => /photo\.jpg/.test(document.getElementById('imgStatus').textContent));
  await page.waitForFunction(() => document.querySelectorAll('#palette .sw').length >= 5 && !document.getElementById('paletteEmpty').textContent.includes('Finding'));
  const photoMs = Date.now() - t0;
  const photoPal = await readPalette(page);
  const photoOk = await page.evaluate((hexes) => {
    const c = document.getElementById('imgCanvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    // Each swatch is the average of a 8x8x8 box, so allow a few levels.
    return hexes.map((h) => { const v = parseInt(h.slice(1), 16); const r = v >> 16, g = (v >> 8) & 255, b = v & 255; let best = 1e9; for (const s of set) { const dd = Math.abs((s >> 16) - r) + Math.abs(((s >> 8) & 255) - g) + Math.abs((s & 255) - b); if (dd < best) best = dd; if (!best) break; } return best; });
  }, photoPal.map((p) => p.hex));
  ok('2400x1600 photo: palette in reasonable time, colors close to real pixels', photoPal.length === 8 && photoMs < 8000 && photoOk.every((d) => d <= 12), `${photoMs} ms (decode + palette), ${photoPal.map((p) => p.hex).join(' ')}, nearest real pixel L1 ${Math.max(...photoOk)}`);

  // ---- Color management: Display P3 image is read as sRGB ---------------------
  await page.setInputFiles('#fileInput', W('p3.png'));
  await page.waitForFunction(() => /p3\.png/.test(document.getElementById('imgStatus').textContent));
  {
    const got = await clickPixel(page, 32, 32);
    const want = magick(W('p3.png'), '-profile', '/System/Library/ColorSync/Profiles/sRGB Profile.icc', '-format', '%[hex:p{32,32}]', 'info:').toLowerCase();
    const raw = magick(W('p3.png'), '-format', '%[hex:p{32,32}]', 'info:').toLowerCase();
    const d = Math.max(...rgbOf(got.hex).map((v, i) => Math.abs(v - rgbOf('#' + want)[i])));
    ok('Display P3 image is converted to sRGB before reading (matches ImageMagick+ICC within 2)', d <= 2 && got.hex !== '#' + raw.slice(0, 6), `page ${got.hex}, ImageMagick sRGB #${want}, raw P3 numbers #${raw}`);
  }

  // ---- Paste and drop ---------------------------------------------------------
  const b64 = (f) => fs.readFileSync(W(f)).toString('base64');
  await page.evaluate((data) => {
    const u8 = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'paste.png', { type: 'image/png' }));
    document.body.focus();
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64('paste.png'));
  await page.waitForFunction(() => /paste\.png/.test(document.getElementById('imgStatus').textContent));
  ok('pasting a screenshot loads it', (await clickPixel(page, 60, 40)).hex === '#c0ffee');
  await page.evaluate((data) => {
    const u8 = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([u8], 'drop.png', { type: 'image/png' }));
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64('drop.png'));
  await page.waitForFunction(() => /drop\.png/.test(document.getElementById('imgStatus').textContent));
  ok('dropping an image loads it', (await clickPixel(page, 10, 10)).hex === '#8b4513');
  await page.evaluate(() => {
    document.activeElement && document.activeElement.blur();
    const dt = new DataTransfer(); dt.setData('text/plain', 'rebeccapurple');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  ok('pasting a color code onto the page sets it', (await page.textContent('#v-hex')) === '#663399');

  // ---- Failure paths ------------------------------------------------------------
  const fail = async (file, re, label) => {
    await page.setInputFiles('#fileInput', file);
    await page.waitForFunction((r) => new RegExp(r).test(document.getElementById('imgStatus').textContent) && document.getElementById('imgStatus').classList.contains('err'), re.source, { timeout: 8000 }).catch(() => {});
    const s = await page.textContent('#imgStatus');
    ok(label, re.test(s) && await page.evaluate(() => document.getElementById('imgStatus').classList.contains('err')), s);
  };
  await fail(W('notes.txt'), /isn't an image/, 'text file: plain "isn\'t an image" message');
  await fail(W('empty.png'), /is empty/, 'empty file: plain "is empty" message');
  await fail(W('broken.png'), /Couldn't open that image/, 'damaged PNG: plain "couldn\'t open" message');
  await fail(path.join(ROOT, 'tests/fixtures/test-gps.heic'), /HEIC/, 'HEIC in Chrome: explains only Safari opens HEIC');
  await page.setInputFiles('#fileInput', W('clear.png'));
  await page.waitForFunction(() => /clear\.png/.test(document.getElementById('imgStatus').textContent));
  await page.waitForTimeout(400);
  ok('fully see-through image: palette explains there are no colors', /see-through/.test(await page.textContent('#paletteEmpty')) && (await page.$$('#palette li')).length === 0, await page.textContent('#paletteEmpty'));
  ok('see-through pixel reads as #00000000', (await clickPixel(page, 25, 25)).hex === '#00000000');

  // ---- Recent picks (localStorage only), persist + Clear --------------------------
  const recentBefore = await page.evaluate(() => Array.from(document.querySelectorAll('#recent .sw')).map((b) => b.dataset.hex));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('colorpicker-recent-v1') || '[]'));
  ok('recent picks are listed and stored in localStorage', recentBefore.length >= 5 && JSON.stringify(stored) === JSON.stringify(recentBefore) && recentBefore[0] === '#00000000', `${recentBefore.length} saved, newest ${recentBefore.slice(0, 4).join(' ')}`);
  ok('recent list is capped at 24 and has no repeats', recentBefore.length <= 24 && new Set(recentBefore).size === recentBefore.length);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  ok('nothing else is stored', keys.every((k) => k === 'colorpicker-recent-v1' || k === 'loltools-theme') && await page.evaluate(() => document.cookie === ''), keys.join(', '));
  await page.reload({ waitUntil: 'load' });
  const recentAfter = await page.evaluate(() => Array.from(document.querySelectorAll('#recent .sw')).map((b) => b.dataset.hex));
  ok('recent picks survive a reload', JSON.stringify(recentAfter) === JSON.stringify(recentBefore), `${recentAfter.length} after reload`);
  ok('after reload the last pick is the current color', (await page.textContent('#v-hex')) === recentBefore[0]);
  await page.click('#recent li:nth-child(3) .sw');
  ok('clicking a recent swatch reuses it', (await page.textContent('#v-hex')) === recentBefore[2]);
  await page.click('#clearRecent');
  ok('Clear empties the list and localStorage', (await page.$$('#recent li')).length === 0 && (await page.evaluate(() => localStorage.getItem('colorpicker-recent-v1'))) === null && await page.isDisabled('#clearRecent'));
  await page.reload({ waitUntil: 'load' });
  ok('still empty after reload', (await page.$$('#recent li')).length === 0 && await page.isVisible('#recentEmpty'));

  // Deep link: a color in the address.
  await page.goto(base + '#ff6600', { waitUntil: 'load' });
  ok('a color in the address (#ff6600) opens with it', (await page.textContent('#v-hex')) === '#ff6600');

  // ---- Desktop screenshot -----------------------------------------------------
  await page.goto(base, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', W('blocks.png'));
  await page.waitForSelector('#palette li');
  await clickPixel(page, 400, 80);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: W('desktop-1440.png'), fullPage: true, scale: 'css' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: W('desktop-1440-dark.png'), fullPage: false, scale: 'css' });
  await page.emulateMedia({ colorScheme: 'light' });

  // ---- Network: everything same-origin, fetch blocked ---------------------------
  const cspBefore = cspViolations.length;
  const fetchResult = await page.evaluate(async () => {
    try { await fetch('https://example.com/'); return 'ALLOWED'; } catch (e) { return 'blocked: ' + e.name; }
  });
  ok("fetch('https://example.com/') is blocked by the page's CSP", /^blocked/.test(fetchResult), fetchResult);
  // Remove the one violation we caused on purpose.
  cspViolations.splice(cspBefore);
  await ctx.close();

  // =========================================================================
  // Phone, 430 wide, touch, devicePixelRatio 3
  // =========================================================================
  const mctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
  watch(mctx, 'mobile');
  const m = await mctx.newPage();
  await m.goto(base, { waitUntil: 'load' });
  ok('phone: no sideways scrolling at 430px', await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await m.evaluate(() => `${document.documentElement.scrollWidth} <= ${window.innerWidth}`));
  ok('phone: touch hint shown', /drag to fine-tune/.test(await m.textContent('#stageHint')));
  await m.setInputFiles('#fileInput', W('blocks.png'));
  await m.waitForSelector('#palette li');
  const mdims = await m.evaluate(() => { const b = document.getElementById('imgCanvas').getBoundingClientRect(); return `${b.width.toFixed(1)}x${b.height.toFixed(1)} CSS px for 640x360`; });
  await blockChecks(m, `phone dpr3 (canvas scaled to ${mdims})`);
  // Scaled-down canvas: clicked point maps to the right pixel (within the half-pixel a CSS point covers).
  const mFails = [];
  for (const [x, y] of [[37, STRIP_Y0 + 20], [300, STRIP_Y0 + 10], [600, STRIP_Y0 + 30]]) {
    const got = await clickPixel(m, x, y);
    const truth = pixels(W('blocks.png'), [[got.x, got.y]])[0];
    if (Math.abs(got.x - x) > 1 || Math.abs(got.y - y) > 1 || got.hex !== truth) mFails.push(`(${x},${y}) got (${got.x},${got.y}) ${got.hex} magick ${truth}`);
  }
  ok('phone: scaled canvas maps the tap to the right pixel and reads that pixel', mFails.length === 0, mFails.join(' | ') || 'ok');

  // Touch: press, drag (moves at 1/3 speed), lift picks.
  {
    const cdp = await mctx.newCDPSession(m);
    const box = await m.evaluate(() => { const c = document.getElementById('imgCanvas'); c.scrollIntoView({ block: 'center' }); const b = c.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; });
    const k = IMG_W / box.width;
    const sx = box.left + 120.5 / k, sy = box.top + (STRIP_Y0 + 20.5) / k;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] });
    await m.waitForTimeout(40);
    const loupeShown = await m.evaluate(() => !document.getElementById('loupe').hidden);
    const DX = 30; // CSS px of finger movement
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx + (DX * i) / 6, y: sy }] });
      await m.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await m.waitForTimeout(60);
    const got = await m.evaluate(() => ({ hex: document.getElementById('v-hex').textContent, x: +document.getElementById('imgCanvas').dataset.pickX, y: +document.getElementById('imgCanvas').dataset.pickY, loupeHidden: document.getElementById('loupe').hidden }));
    const expectX = Math.floor(120.5 + DX * k / 3);
    const truth = pixels(W('blocks.png'), [[got.x, got.y]])[0];
    ok('touch: loupe shows on press, drag fine-tunes at 1/3 speed, lift picks that pixel',
      loupeShown && got.loupeHidden && Math.abs(got.x - expectX) <= 1 && got.y === STRIP_Y0 + 20 && got.hex === truth,
      `finger moved ${DX} CSS px = ${(DX * k).toFixed(1)} image px, point moved to x=${got.x} (expected ~${expectX}), ${got.hex} magick ${truth}`);
  }
  // Big photo gets scaled to the phone limit with a plain note.
  await m.setInputFiles('#fileInput', W('big.png'));
  await m.waitForFunction(() => /big\.png/.test(document.getElementById('imgStatus').textContent), null, { timeout: 30000 });
  const bigMsg = await m.textContent('#imgStatus');
  const bigDims = await m.evaluate(() => { const c = document.getElementById('imgCanvas'); return [c.width, c.height]; });
  ok('phone: 20 MP image is scaled under 16 MP with a plain note', /scaled down/.test(bigMsg) && bigDims[0] * bigDims[1] <= 16e6 && (await clickPixel(m, 100, 100)).hex === '#336699', `${bigDims.join('x')} :: ${bigMsg}`);
  await m.setInputFiles('#fileInput', W('blocks.png'));
  await m.waitForFunction(() => /blocks\.png/.test(document.getElementById('imgStatus').textContent));
  await m.waitForSelector('#palette li');
  await clickPixel(m, 560, 80);
  ok('phone: picked row and marker visible after a tap', await m.isVisible('#picked') && await m.isVisible('#marker') && (await m.textContent('#pickedHex')) === '#336699');
  await m.evaluate(() => window.scrollTo(0, 0));
  await m.screenshot({ path: W('mobile-430.png'), fullPage: true, scale: 'css' });
  await mctx.close();

  // =========================================================================
  // EyeDropper missing (Safari, Firefox, phones) and present (mocked)
  // =========================================================================
  const nctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  watch(nctx, 'no-eyedropper');
  await nctx.addInitScript(() => { delete window.EyeDropper; });
  const n = await nctx.newPage();
  await n.goto(base, { waitUntil: 'load' });
  ok('no EyeDropper: button is gone (not a broken button) and a plain note shows',
    (await n.$('#screenBtn')) === null && await n.isVisible('#screenNote') && /only works in Chrome, Edge and Opera/.test(await n.textContent('#screenNote')),
    await n.textContent('#screenNote'));
  await nctx.close();

  const ectx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  watch(ectx, 'mock-eyedropper');
  await ectx.addInitScript(() => {
    window.__edMode = 'ok';
    window.EyeDropper = class { open() {
      if (window.__edMode === 'abort') return Promise.reject(new DOMException('cancelled', 'AbortError'));
      if (window.__edMode === 'error') return Promise.reject(new DOMException('nope', 'NotAllowedError'));
      return Promise.resolve({ sRGBHex: '#abcdef' });
    } };
  });
  const e = await ectx.newPage();
  await e.goto(base, { waitUntil: 'load' });
  ok('EyeDropper present: button shows, note hidden', await e.isVisible('#screenBtn') && !(await e.isVisible('#screenNote')));
  await e.click('#screenBtn');
  await e.waitForTimeout(80);
  ok('EyeDropper result becomes the current color and a recent pick', (await e.textContent('#v-hex')) === '#abcdef' && (await e.evaluate(() => JSON.parse(localStorage.getItem('colorpicker-recent-v1'))[0])) === '#abcdef');
  await e.evaluate(() => { window.__edMode = 'abort'; });
  await e.click('#screenBtn'); await e.waitForTimeout(80);
  ok('Esc (AbortError) is silent', (await e.textContent('#inputMsg')) === '' && (await e.textContent('#v-hex')) === '#abcdef');
  await e.evaluate(() => { window.__edMode = 'error'; });
  await e.click('#screenBtn'); await e.waitForTimeout(80);
  ok('other EyeDropper errors get a plain message', /didn't let the page pick/.test(await e.textContent('#inputMsg')), await e.textContent('#inputMsg'));
  await ectx.close();

  // =========================================================================
  // Network + errors, across every context
  // =========================================================================
  const foreign = allRequests.filter((r) => !(r.url.startsWith(ORIGIN + '/') || r.url.startsWith('blob:') || r.url.startsWith('data:')) && r.url !== 'https://example.com/');
  const exampleReqs = allRequests.filter((r) => r.url === 'https://example.com/');
  ok('every request is same-origin (or blob:/data:)', foreign.length === 0, `${allRequests.length} requests total; foreign: ${foreign.map((r) => r.url).join(', ') || 'none'}`);
  ok('the example.com fetch never left the browser as an allowed request', exampleReqs.length <= 1, `${exampleReqs.length} attempt(s) seen (blocked by CSP)`);
  const uniq = [...new Set(allRequests.map((r) => r.url.replace(ORIGIN, '').replace(/\?.*$/, '')))].filter((u) => !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('http'));
  ok('page loads only its own files', uniq.every((u) => ['/', '/lol.css', '/lol.js', '/color.css', '/colormath.js', '/app.js', '/palette-worker.js'].includes(u)), uniq.join(' '));
  ok('no CSP violations (besides the deliberate fetch)', cspViolations.length === 0, cspViolations.join(' | '));
  ok('no page errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  console.log(`screenshots: ${W('desktop-1440.png')}  ${W('mobile-430.png')}`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => { console.error('HARNESS ERROR', err); process.exit(2); });
