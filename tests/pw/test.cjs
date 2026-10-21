// Real-Chrome test for pwgen.lol.
//   node tests/pw/test.cjs http://127.0.0.1:18825/
// Serve first:  node scripts/build.mjs pw && node tests/serve.cjs dist/pw 18825
//
// What it proves, in the real page:
//  - randomness: chi-squared on 200k+ characters, on consecutive pairs, on
//    60k+ passphrase words, and on the "at least one of each kind" rule
//    (checked against the exact distribution, computed here in Node)
//  - Math.random is never called (it throws, set before any page script) and
//    never appears in the built JS
//  - every password follows its settings; passphrases only use EFF words and
//    the served list re-hashes to the EFF file's published SHA-256
//  - displayed bits equal the formula, and the crack time follows from them
//  - no generated password reaches localStorage, sessionStorage, cookies or the URL
//  - copy puts the password on the clipboard
//  - every request is same-origin, fetch to another site is blocked, no errors
// Screenshots: _work/pw/shot-1440.png, _work/pw/shot-430.png
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const base = process.argv[2] || 'http://127.0.0.1:18825/';
const ORIGIN = new URL(base).origin;
const ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(ROOT, 'dist/pw');
const SHOTS = path.join(ROOT, '_work/pw');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  :: ' + detail : ''}`);
};

// ---- Independent math (Node side) -------------------------------------------
const SETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
};
const LOOK = '0O1lI';
const ALL94 = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join('');
function classesFor(o) {
  return ['lower', 'upper', 'digits', 'symbols'].filter((k) => o[k])
    .map((k) => (o.avoid ? SETS[k].split('').filter((c) => !LOOK.includes(c)).join('') : SETS[k]));
}
function log2Big(x) {
  const s = x.toString(2);
  if (s.length <= 53) return Math.log2(Number(x));
  return Math.log2(Number(BigInt('0b' + s.slice(0, 53)))) + (s.length - 53);
}
// Number of length-L strings over the union that contain >= 1 of every class.
function countValid(sizes, L) {
  const N = sizes.reduce((a, b) => a + b, 0);
  let c = 0n;
  for (let m = 0; m < 1 << sizes.length; m++) {
    let miss = 0, k = 0;
    sizes.forEach((sz, j) => { if (m & (1 << j)) { miss += sz; k++; } });
    const t = BigInt(N - miss) ** BigInt(L);
    c += k % 2 ? -t : t;
  }
  return c;
}
function expectedPwBits(o) {
  const sizes = classesFor(o).map((c) => c.length);
  const N = sizes.reduce((a, b) => a + b, 0);
  if (!o.require || sizes.length === 1) return o.length * Math.log2(N);
  return log2Big(countValid(sizes, o.length));
}
const expectedPpBits = (o) => o.words * Math.log2(7776) + (o.num ? Math.log2(10 * o.words) : 0);

// Upper tail of chi-squared: Q(df/2, x/2), regularized incomplete gamma.
function lnGamma(z) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z, y = z, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function gammaQ(a, x) {
  if (x < a + 1) { // series for P, then 1-P
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 100000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d; // continued fraction for Q
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}
const chi2p = (stat, df) => gammaQ(df / 2, stat / 2);
function chi2(counts, expected) {
  let s = 0;
  for (let i = 0; i < counts.length; i++) s += (counts[i] - expected[i]) ** 2 / expected[i];
  return s;
}

// Can `tokens` (split on the separator) be read as exactly n EFF words?
// Needed for "-" because four EFF words contain a hyphen.
function segmentable(tokens, n, wordSet) {
  const memo = new Map();
  const go = (i, left) => {
    if (i === tokens.length) return left === 0;
    if (left === 0) return false;
    const key = i + ',' + left;
    if (memo.has(key)) return memo.get(key);
    let r = false;
    for (let j = i + 1; j <= Math.min(tokens.length, i + 2) && !r; j++) {
      if (wordSet.has(tokens.slice(i, j).join('-'))) r = go(j, left - 1);
    }
    memo.set(key, r);
    return r;
  };
  return go(0, n);
}

(async () => {
  // Self-check of the chi-squared helper against textbook values.
  const selfP = [chi2p(18.307, 10), chi2p(93, 93), chi2p(3.841, 1)];
  ok('chi-squared helper matches tables (0.05, ~0.48, 0.05)',
    Math.abs(selfP[0] - 0.05) < 1e-3 && Math.abs(selfP[1] - 0.4807) < 0.01 && Math.abs(selfP[2] - 0.05) < 1e-3, selfP.map((p) => p.toFixed(4)).join(', '));

  // ---- Static check of the built files -------------------------------------------
  const builtJs = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) builtJs.push(p);
  });
  walk(DIST);
  const MR = /Math\s*(\.\s*random|\[\s*['"`]random)/;
  const htmlScripts = [...fs.readFileSync(path.join(DIST, 'index.html'), 'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const mrHits = builtJs.filter((f) => MR.test(fs.readFileSync(f, 'utf8'))).concat(MR.test(htmlScripts) ? ['index.html inline script'] : []);
  ok('grep: no Math.random in any built JS file or inline script', builtJs.length >= 3 && mrHits.length === 0,
    `${builtJs.length} JS files scanned: ${builtJs.map((f) => path.relative(DIST, f)).join(', ')}${mrHits.length ? ' | HITS: ' + mrHits.join(', ') : ''}`);
  const appSrc = fs.readFileSync(path.join(DIST, 'app.js'), 'utf8');
  ok('grep: app.js uses crypto.getRandomValues', /crypto\.getRandomValues\(/.test(appSrc));
  ok('grep: no storage writes in app.js other than the settings key',
    (appSrc.match(/\b(localStorage|sessionStorage)\.setItem\(/g) || []).length === 1 && /localStorage\.setItem\(SETTINGS_KEY, JSON\.stringify\(out\)\)/.test(appSrc) && !/document\.cookie|history\.(push|replace)State|location\.(hash|search|href)\s*=(?!=)/.test(appSrc));

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });

  // Before ANY page script: Math.random throws and counts, storage writes are logged.
  await ctx.addInitScript(() => {
    window.__mathRandomCalls = 0;
    Object.defineProperty(Math, 'random', {
      configurable: false, writable: false,
      value: function () { window.__mathRandomCalls++; throw new Error('Math.random was called'); },
    });
    window.__storageWrites = [];
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      window.__storageWrites.push([this === window.sessionStorage ? 'session' : 'local', String(k), String(v)]);
      return orig.call(this, k, v);
    };
  });

  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(m.text()); });
  const notFound = [];
  page.on('response', (r) => { if (r.status() >= 400) notFound.push(r.status() + ' ' + r.url()); });

  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  const seen = new Set(); // every password/passphrase the page showed us
  const remember = (arr) => arr.forEach((p) => seen.add(p));

  // ---- On load ------------------------------------------------------------------------------
  const first = await page.textContent('#pwOut');
  remember([first]);
  ok('generates a password on load (20 chars by default)', first.length === 20, JSON.stringify(first));
  ok('Math.random override is in place and was never called',
    await page.evaluate(() => { try { Math.random(); return false; } catch (e) { return window.__mathRandomCalls === 1; } }));
  await page.evaluate(() => { window.__mathRandomCalls = 0; });

  // ---- UI helpers ---------------------------------------------------------------------------
  const setMode = (m) => page.click(`label[for=m-${m}]`);
  async function setPw(o) {
    await setMode('password');
    await page.evaluate((o) => {
      const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));
      const r = document.getElementById('len'); r.value = o.length; fire(r, 'input');
      for (const k of ['lower', 'upper', 'digits', 'symbols', 'avoid', 'require']) {
        const c = document.getElementById('o-' + k);
        if (c.checked !== !!o[k]) { c.checked = !!o[k]; fire(c, 'change'); }
      }
    }, o);
  }
  async function setPp(o) {
    await setMode('passphrase');
    await page.evaluate((o) => {
      const fire = (el, t) => el.dispatchEvent(new Event(t, { bubbles: true }));
      const r = document.getElementById('words'); r.value = o.words; fire(r, 'input');
      const s = document.getElementById('sep'); s.value = o.sep; fire(s, 'change');
      for (const k of ['cap', 'num']) {
        const c = document.getElementById('o-' + k);
        if (c.checked !== !!o[k]) { c.checked = !!o[k]; fire(c, 'change'); }
      }
    }, o);
  }
  // Click "New" and "Make 10" `rounds` times in the page; return every output shown.
  const harvest = (rounds) => page.evaluate((rounds) => {
    const out = [];
    for (let i = 0; i < rounds; i++) {
      document.getElementById('newBtn').click();
      out.push(document.getElementById('pwOut').textContent);
      document.getElementById('tenBtn').click();
      document.querySelectorAll('#pwList .pw-text').forEach((e) => out.push(e.textContent));
    }
    return out;
  }, rounds);
  const shown = () => page.evaluate(() => ({
    bits: +document.getElementById('bits').dataset.bits,
    bitsText: document.getElementById('bits').textContent,
    sec: +document.getElementById('crack').dataset.seconds,
    crack: document.getElementById('crack').textContent,
  }));

  // ---- Chi-squared on characters: 94-char set ------------------------------------------------------
  await setPw({ length: 128, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 0 });
  let t0 = Date.now();
  const big = await harvest(160); // 160 * 11 * 128 = 225,280 chars
  const genMs = Date.now() - t0;
  remember(big);
  const text = big.join('');
  const counts = new Array(94).fill(0);
  let outside = 0;
  for (const ch of text) { const i = ch.charCodeAt(0) - 33; if (i >= 0 && i < 94) counts[i]++; else outside++; }
  const exp94 = new Array(94).fill(text.length / 94);
  const x94 = chi2(counts, exp94);
  const p94 = chi2p(x94, 93);
  ok(`chi-squared, single characters over all 94 (n=${text.length})`, text.length >= 20000 && outside === 0 && p94 > 0.001,
    `chi2=${x94.toFixed(1)} df=93 p=${p94.toFixed(4)}, min/max count ${Math.min(...counts)}/${Math.max(...counts)}, made in ${genMs} ms`);
  ok('every one of the 94 characters appears', counts.every((c) => c > 0));
  // Consecutive pairs inside each password (catches correlation between picks).
  const pairs = new Array(94 * 94).fill(0);
  let nPairs = 0;
  for (const pw of big) for (let i = 1; i < pw.length; i++) { pairs[(pw.charCodeAt(i - 1) - 33) * 94 + pw.charCodeAt(i) - 33]++; nPairs++; }
  const xPairs = chi2(pairs, new Array(94 * 94).fill(nPairs / (94 * 94)));
  const pPairs = chi2p(xPairs, 94 * 94 - 1);
  ok(`chi-squared, consecutive pairs (n=${nPairs}, 8,836 cells)`, pPairs > 0.001, `chi2=${xPairs.toFixed(0)} df=8835 p=${pPairs.toFixed(4)}`);
  // Position check: first character of each password alone.
  const firsts = new Array(94).fill(0);
  big.forEach((pw) => firsts[pw.charCodeAt(0) - 33]++);
  const pFirst = chi2p(chi2(firsts, new Array(94).fill(big.length / 94)), 93);
  ok(`chi-squared, first character only (n=${big.length})`, pFirst > 0.001, `p=${pFirst.toFixed(4)}`);

  // ---- Chi-squared with look-alikes removed (89 chars) ------------------------------------------
  await setPw({ length: 128, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 1, require: 0 });
  const big2 = await harvest(40); // 56,320 chars
  remember(big2);
  const set89 = classesFor({ lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 1 }).join('');
  const c89 = new Array(89).fill(0);
  let bad89 = 0;
  for (const ch of big2.join('')) { const i = set89.indexOf(ch); if (i < 0) bad89++; else c89[i]++; }
  const n89 = c89.reduce((a, b) => a + b, 0);
  const p89 = chi2p(chi2(c89, new Array(89).fill(n89 / 89)), 88);
  ok(`chi-squared, 89 chars with look-alikes off (n=${n89})`, set89.length === 89 && bad89 === 0 && p89 > 0.001, `p=${p89.toFixed(4)}, look-alikes seen: ${bad89}`);

  // ---- "At least one of each" is unbiased: exact distribution of digit counts --------------
  // L=8 from a-z + 0-9 with the rule on. If the page is uniform over valid
  // strings, the number of digits k (1..7) follows C(8,k) 10^k 26^(8-k) / valid.
  await setPw({ length: 8, lower: 1, upper: 0, digits: 1, symbols: 0, avoid: 0, require: 1 });
  const small = await harvest(600); // 6,600 passwords
  remember(small);
  const valid = countValid([26, 10], 8);
  const binom = (n, k) => { let r = 1n; for (let i = 0n; i < BigInt(k); i++) r = r * (BigInt(n) - i) / (i + 1n); return r; };
  const probs = [];
  for (let k = 1; k <= 7; k++) probs.push(Number(binom(8, k) * 10n ** BigInt(k) * 26n ** BigInt(8 - k) * 1000000000n / valid) / 1e9);
  const kc = new Array(7).fill(0);
  let badSmall = 0;
  for (const pw of small) {
    const k = (pw.match(/[0-9]/g) || []).length;
    if (pw.length !== 8 || !/^[a-z0-9]+$/.test(pw) || k < 1 || k > 7) badSmall++; else kc[k - 1]++;
  }
  // Merge k=6,7 (small expected counts).
  const obs = [...kc.slice(0, 5), kc[5] + kc[6]];
  const expK = [...probs.slice(0, 5), probs[5] + probs[6]].map((p) => p * small.length);
  const pK = chi2p(chi2(obs, expK), obs.length - 1);
  ok(`"at least one of each" matches the exact unbiased distribution (n=${small.length})`, badSmall === 0 && pK > 0.001,
    `digits-per-password observed ${obs.join('/')} vs expected ${expK.map((e) => e.toFixed(0)).join('/')}, p=${pK.toFixed(4)}`);

  // ---- Every password follows its settings ----------------------------------------------------
  const configs = [
    { length: 8, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 1 },
    { length: 8, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 1, require: 1 },
    { length: 12, lower: 0, upper: 0, digits: 1, symbols: 0, avoid: 0, require: 1 },
    { length: 9, lower: 0, upper: 1, digits: 0, symbols: 1, avoid: 1, require: 1 },
    { length: 20, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 1 },
    { length: 33, lower: 1, upper: 0, digits: 0, symbols: 0, avoid: 1, require: 0 },
    { length: 128, lower: 1, upper: 1, digits: 1, symbols: 0, avoid: 1, require: 1 },
  ];
  for (const o of configs) {
    await setPw(o);
    const got = await harvest(50); // 550 each
    remember(got);
    const classes = classesFor(o);
    const allowed = new Set(classes.join(''));
    const fails = got.filter((pw) =>
      pw.length !== o.length ||
      [...pw].some((c) => !allowed.has(c)) ||
      (o.avoid && [...pw].some((c) => LOOK.includes(c))) ||
      (o.require && !classes.every((cl) => [...pw].some((c) => cl.includes(c)))));
    const label = `len ${o.length}, ${['lower', 'upper', 'digits', 'symbols'].filter((k) => o[k]).join('+')}${o.avoid ? ', no look-alikes' : ''}${o.require ? ', one of each' : ''}`;
    ok(`settings respected: ${label} (${got.length} passwords)`, fails.length === 0, fails.length ? 'bad: ' + fails.slice(0, 3).join(' | ') : undefined);
  }
  // With the rule ON and length 8 over 4 kinds, a naive generator misses a kind
  // about 1 time in 3. So "all present" above is a real test of the rule.

  // ---- Bits shown = formula ---------------------------------------------------------------
  const bitCases = [
    [{ length: 20, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 0 }, 131.1],
    [{ length: 20, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 1 }, 130.9],
    [{ length: 16, lower: 1, upper: 1, digits: 1, symbols: 0, avoid: 1, require: 0 }, null],
    [{ length: 8, lower: 0, upper: 0, digits: 1, symbols: 0, avoid: 0, require: 1 }, 26.6],
    [{ length: 128, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 1, require: 1 }, null],
    [{ length: 12, lower: 1, upper: 0, digits: 1, symbols: 0, avoid: 0, require: 1 }, null],
  ];
  for (const [o, approx] of bitCases) {
    await setPw(o);
    const s = await shown();
    const want = expectedPwBits(o);
    const secWant = Math.pow(2, want - 1) / 1e11;
    const pass = Math.abs(s.bits - want) < 1e-9 && s.bitsText === want.toFixed(1) + ' bits' &&
      (approx == null || want.toFixed(1) === approx.toFixed(1)) && Math.abs(s.sec / secWant - 1) < 1e-9;
    ok(`bits: password len ${o.length}, ${classesFor(o).join('').length} chars${o.require ? ', one of each' : ''}`, pass,
      `shown "${s.bitsText}" (${s.bits}), formula ${want.toFixed(4)}; crack "${s.crack}"`);
  }
  const ppCases = [
    [{ words: 5, sep: 'hyphen', cap: 0, num: 0 }, 64.6],
    [{ words: 6, sep: 'space', cap: 1, num: 0 }, 77.5],
    [{ words: 6, sep: 'period', cap: 0, num: 1 }, null],
    [{ words: 3, sep: 'underscore', cap: 1, num: 1 }, null],
    [{ words: 15, sep: 'comma', cap: 0, num: 0 }, null],
  ];
  for (const [o, approx] of ppCases) {
    await setPp(o);
    const s = await shown();
    const want = expectedPpBits(o);
    const pass = Math.abs(s.bits - want) < 1e-9 && s.bitsText === want.toFixed(1) + ' bits' &&
      (approx == null || want.toFixed(1) === approx.toFixed(1)) && Math.abs(s.sec / (Math.pow(2, want - 1) / 1e11) - 1) < 1e-9;
    ok(`bits: passphrase ${o.words} words${o.num ? ' + number' : ''}${o.cap ? ', capitals' : ''}`, pass,
      `shown "${s.bitsText}", formula ${want.toFixed(4)}; crack "${s.crack}"`);
  }
  const assume = await page.textContent('.st-assume');
  ok('page states the guess rate assumption', /100 billion guesses a second/.test(assume) && /offline/.test(assume), assume.trim());
  await setPw({ length: 20, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 0 });
  const c20 = await page.textContent('#crack');
  await setPw({ length: 8, lower: 0, upper: 0, digits: 1, symbols: 0, avoid: 0, require: 0 });
  const c8 = await page.textContent('#crack');
  ok('plain-language crack time reads sensibly', /age of the universe/.test(c20) && c8 === 'less than a second', `20 of 94: "${c20}"; 8 digits: "${c8}"`);

  // ---- Wordlist: 7,776 unique, identical to the EFF file ---------------------------------
  const wl = await page.evaluate(() => Array.from(window.EFF_LARGE_WORDLIST));
  const wlSet = new Set(wl);
  const dice = (i) => { let s = ''; for (let k = 0; k < 5; k++) { s = String((i % 6) + 1) + s; i = Math.floor(i / 6); } return s; };
  const rebuilt = wl.map((w, i) => `${dice(i)}\t${w}\n`).join('');
  const sha = crypto.createHash('sha256').update(rebuilt).digest('hex');
  ok('wordlist has exactly 7,776 unique words', wl.length === 7776 && wlSet.size === 7776, `${wl.length} words, ${wlSet.size} unique`);
  ok('wordlist rebuilt with dice numbers matches the EFF file SHA-256',
    sha === 'addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e', sha);

  // ---- Passphrases: only EFF words, settings respected, words uniform -------------------------
  const SEP = { hyphen: '-', space: ' ', period: '.', underscore: '_', comma: ',' };
  const ppConfigs = [
    { words: 5, sep: 'hyphen', cap: 0, num: 0 },
    { words: 7, sep: 'space', cap: 1, num: 1 },
    { words: 4, sep: 'period', cap: 0, num: 1 },
    { words: 6, sep: 'underscore', cap: 1, num: 0 },
    { words: 3, sep: 'comma', cap: 0, num: 0 },
  ];
  for (const o of ppConfigs) {
    await setPp(o);
    const got = await harvest(40);
    remember(got);
    const bad = got.filter((pp) => {
      let digits = 0;
      let parts = pp.split(SEP[o.sep]);
      if (o.num) {
        const withNum = parts.filter((w) => /[0-9]$/.test(w));
        digits = (pp.match(/[0-9]/g) || []).length;
        if (withNum.length !== 1 || digits !== 1) return true;
        parts = parts.map((w) => w.replace(/[0-9]$/, ''));
      } else if (/[0-9]/.test(pp)) return true;
      if (o.cap) {
        // "T-shirt" style: only the first letter of each whole word is a capital.
        if (o.sep !== 'hyphen' && parts.some((w) => w[0] !== w[0].toUpperCase())) return true;
        parts = parts.map((w) => w[0].toLowerCase() + w.slice(1));
      }
      if (/[A-Z]/.test(parts.join(''))) return true;
      if (o.sep === 'hyphen') return !segmentable(parts, o.words, wlSet);
      return parts.length !== o.words || parts.some((w) => !wlSet.has(w));
    });
    ok(`passphrase: ${o.words} words, "${SEP[o.sep]}"${o.cap ? ', capitals' : ''}${o.num ? ', number' : ''} (${got.length} made)`, bad.length === 0,
      bad.length ? 'bad: ' + bad.slice(0, 3).join(' | ') : got[0]);
  }
  // Word frequencies: 15 words, space separated, no extras.
  await setPp({ words: 15, sep: 'space', cap: 0, num: 0 });
  const many = await harvest(400); // 4,400 phrases x 15 = 66,000 words
  remember(many);
  const idx = new Map(wl.map((w, i) => [w, i]));
  const wc = new Array(7776).fill(0);
  let nWords = 0, unknown = 0;
  for (const pp of many) for (const w of pp.split(' ')) { const i = idx.get(w); if (i === undefined) unknown++; else { wc[i]++; nWords++; } }
  const xW = chi2(wc, new Array(7776).fill(nWords / 7776));
  const pW = chi2p(xW, 7775);
  ok(`chi-squared, passphrase words over 7,776 (n=${nWords})`, unknown === 0 && pW > 0.001, `chi2=${xW.toFixed(0)} df=7775 p=${pW.toFixed(4)}, unknown words: ${unknown}`);
  // Where the number lands, and which digit.
  await setPp({ words: 5, sep: 'space', cap: 0, num: 1 });
  const nums = await harvest(300);
  remember(nums);
  const pos = new Array(5).fill(0), dig = new Array(10).fill(0);
  for (const pp of nums) { const ws = pp.split(' '); const j = ws.findIndex((w) => /[0-9]$/.test(w)); pos[j]++; dig[+ws[j].slice(-1)]++; }
  const pPos = chi2p(chi2(pos, new Array(5).fill(nums.length / 5)), 4);
  const pDig = chi2p(chi2(dig, new Array(10).fill(nums.length / 10)), 9);
  ok(`"add a number": position and digit both uniform (n=${nums.length})`, pPos > 0.001 && pDig > 0.001, `position p=${pPos.toFixed(4)}, digit p=${pDig.toFixed(4)}`);

  // ---- Empty charset: plain message --------------------------------------------------------
  await setPw({ length: 20, lower: 0, upper: 0, digits: 0, symbols: 0, avoid: 0, require: 1 });
  const emptyMsg = (await page.textContent('#pwMsg')).trim();
  ok('no character kinds picked: plain message, copy disabled', /Pick at least one kind of character/.test(emptyMsg) && await page.isDisabled('#copyBtn') && (await page.textContent('#pwOut')) === '', emptyMsg);

  // ---- Length box clamps -------------------------------------------------------------------------
  await setPw({ length: 20, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 1 });
  await page.fill('#lenNum', '500'); await page.press('#lenNum', 'Tab');
  const l500 = (await page.textContent('#pwOut')).length;
  await page.fill('#lenNum', '3'); await page.press('#lenNum', 'Tab');
  const l3 = (await page.textContent('#pwOut')).length;
  ok('length box clamps to 8..128', l500 === 128 && l3 === 8, `typed 500 -> ${l500}, typed 3 -> ${l3}`);
  remember([await page.textContent('#pwOut')]);

  // ---- Copy -------------------------------------------------------------------------------------
  await setPw({ length: 24, lower: 1, upper: 1, digits: 1, symbols: 1, avoid: 0, require: 1 });
  await page.click('#newBtn');
  const shownPw = await page.textContent('#pwOut');
  remember([shownPw]);
  await page.click('#copyBtn');
  await page.waitForTimeout(150);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok('copy button puts the shown password on the clipboard', clip === shownPw && clip.length === 24, JSON.stringify(clip));
  ok('copy shows a confirmation', /Copied/.test(await page.textContent('#pwMsg')) && /Copied/.test(await page.textContent('#copyBtn')));
  await page.click('#tenBtn');
  const third = await page.textContent('#pwList li:nth-child(3) .pw-text');
  remember(await page.$$eval('#pwList .pw-text', (els) => els.map((e) => e.textContent)));
  await page.click('#pwList li:nth-child(3) button');
  await page.waitForTimeout(150);
  ok('copy button in the list of 10 copies that entry', (await page.evaluate(() => navigator.clipboard.readText())) === third, JSON.stringify(third));
  ok('list of 10 has 10 entries', (await page.$$('#pwList li')).length === 10);
  await setPp({ words: 5, sep: 'hyphen', cap: 0, num: 0 });
  const ppShown = await page.textContent('#pwOut');
  remember([ppShown]);
  await page.click('#copyBtn');
  await page.waitForTimeout(150);
  ok('copy works for a passphrase', (await page.evaluate(() => navigator.clipboard.readText())) === ppShown, ppShown);

  // ---- Rough checker ---------------------------------------------------------------------------
  const checkOne = async (pw) => { await page.fill('#chkInput', pw); return page.evaluate(() => ({ bits: +document.getElementById('chkBits').dataset.bits, label: document.getElementById('chkLabel').textContent, crack: document.getElementById('chkCrack').textContent, notes: document.getElementById('chkNotes').textContent })); };
  const weak = await checkOne('Password1');
  const weak2 = await checkOne('qwerty12345');
  const strong = await checkOne(shownPw);
  const phrase = await checkOne('correct-battery-staple-trouble');
  ok('checker: common password rates Weak', weak.label === 'Weak' && weak.bits < 30 && /common/.test(weak.notes), `${weak.bits.toFixed(1)} bits, ${weak.crack}`);
  ok('checker: keyboard run rates Weak', weak2.label === 'Weak', `${weak2.bits.toFixed(1)} bits`);
  ok('checker: 24 random chars rate Very strong', strong.label === 'Very strong' && strong.bits > 100, `${strong.bits.toFixed(1)} bits`);
  ok('checker: 4 EFF words scored as words (~52 bits), not as 30 letters', phrase.bits > 45 && phrase.bits < 60, `${phrase.bits.toFixed(1)} bits, ${phrase.label}`);
  const intro = await page.textContent('.chk-intro');
  ok('checker copy says it is rough and never sent', /rough/i.test(intro) && /never sent anywhere/.test(intro), intro.trim());
  ok('checker input is a password field with autocomplete off', await page.evaluate(() => { const i = document.getElementById('chkInput'); return i.type === 'password' && i.autocomplete === 'off'; }));

  // ---- Settings persist; passwords don't -----------------------------------------------------------
  await setPw({ length: 37, lower: 1, upper: 0, digits: 1, symbols: 0, avoid: 1, require: 1 });
  remember([await page.textContent('#pwOut')]);
  const before = await page.evaluate(() => ({
    writes: window.__storageWrites, local: Object.entries(localStorage), session: Object.entries(sessionStorage),
    cookie: document.cookie, href: location.href, mr: window.__mathRandomCalls,
  }));
  const settingsRaw = before.local.find(([k]) => k === 'pwgen-settings');
  const settingsKeys = settingsRaw ? Object.keys(JSON.parse(settingsRaw[1])).sort().join(',') : '';
  ok('settings saved under one key with only setting fields', settingsKeys === 'avoid,cap,digits,length,lower,mode,num,require,sep,symbols,upper,words', settingsKeys);
  ok('only pwgen-settings / theme keys ever written; nothing to sessionStorage',
    before.writes.every(([where, k]) => where === 'local' && (k === 'pwgen-settings' || k === 'loltools-theme')) && before.session.length === 0,
    `${before.writes.length} writes`);
  // No generated password (or checker input) inside any stored value, cookie or URL.
  const blobs = [...before.writes.map((w) => w[2]), ...before.local.map((e) => e.join('=')), ...before.session.map((e) => e.join('=')), before.cookie, before.href];
  const extra = [shownPw, 'Password1', 'correct-battery-staple-trouble'];
  const leaked = [...seen, ...extra].filter((pw) => pw && pw.length >= 8 && blobs.some((b) => b.includes(pw)));
  ok(`no generated password in localStorage, sessionStorage, cookies or URL (${seen.size} checked)`, leaked.length === 0 && before.cookie === '' && seen.size > 10000,
    leaked.length ? 'LEAKED: ' + leaked.slice(0, 3).join(' | ') : `cookie="${before.cookie}", url=${before.href}`);
  await page.reload({ waitUntil: 'load' });
  const after = await page.evaluate(() => ({ len: document.getElementById('len').value, mode: document.querySelector('input[name=mode]:checked').value, avoid: document.getElementById('o-avoid').checked, pw: document.getElementById('pwOut').textContent }));
  ok('settings come back after reload, with a fresh password', after.len === '37' && after.mode === 'password' && after.avoid && after.pw.length === 37 && !seen.has(after.pw), JSON.stringify({ ...after, pw: after.pw.length + ' chars' }));
  ok('Math.random never called during the whole run', before.mr === 0 && (await page.evaluate(() => window.__mathRandomCalls)) === 0, `calls: ${before.mr}`);

  // ---- Network ----------------------------------------------------------------------------------
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://example.com/'); return 'NOT BLOCKED'; } catch (e) { return 'blocked: ' + e.name; }
  });
  ok("fetch('https://example.com/') is blocked by the page", blocked.startsWith('blocked'), blocked);
  const foreign = requests.filter((u) => !(u.startsWith(ORIGIN + '/') || u.startsWith('blob:') || u.startsWith('data:')));
  // example.com never even reaches the network; Chrome blocks it before the request.
  ok('every request is same-origin', foreign.length === 0, `${requests.length} requests${foreign.length ? ' | FOREIGN: ' + foreign.join(', ') : ''}`);
  // Snapshot console/HTTP errors from the tool page before visiting the credits pages
  // (Chrome asks for /favicon.ico on pages without an icon; that's not the tool's doing).
  const toolConsole = consoleErrors.slice();
  const toolHttpErrors = notFound.slice();
  const licRes = await page.goto(new URL('/licenses/', base).href);
  const licHtml = await licRes.text();
  ok('/licenses/ credits the EFF wordlist under CC BY 3.0 with licence text',
    /EFF large wordlist/.test(licHtml) && /CC BY 3\.0/.test(licHtml) && /eff-large-wordlist\.LICENSE\.txt/.test(licHtml));
  const licTxt = await (await page.goto(new URL('/vendor/licenses/eff-large-wordlist.LICENSE.txt', base).href)).text();
  ok('licence file has attribution and the CC BY 3.0 US legal code', /Electronic Frontier Foundation/.test(licTxt) && /Attribution 3\.0 United States/.test(licTxt) && /4\. Restrictions/.test(licTxt), `${licTxt.length} chars`);

  // ---- Screenshots ------------------------------------------------------------------------------
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.click('#tenBtn');
  await page.screenshot({ path: path.join(SHOTS, 'shot-1440.png'), fullPage: true });
  const mob = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await mob.newPage();
  const mErrors = [];
  mp.on('pageerror', (e) => mErrors.push(String(e)));
  mp.on('console', (m) => { if (m.type() === 'error') mErrors.push(m.text()); });
  await mp.goto(base, { waitUntil: 'load' });
  const overflow1 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await mp.click('#tenBtn');
  await mp.screenshot({ path: path.join(SHOTS, 'shot-430.png'), fullPage: true });
  await mp.click('label[for=m-passphrase]');
  await mp.evaluate(() => { const r = document.getElementById('words'); r.value = 15; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await mp.fill('#chkInput', 'Summer2024!');
  const overflow2 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await mp.screenshot({ path: path.join(SHOTS, 'shot-430-passphrase.png'), fullPage: true });
  ok('430px: no sideways scrolling (password, 10 list, 15-word passphrase)', overflow1 <= 0 && overflow2 <= 0, `overflow ${overflow1}px / ${overflow2}px`);
  ok('430px: no errors', mErrors.length === 0, mErrors.join(' | '));
  await mob.close();

  // ---- Errors ----------------------------------------------------------------------------------
  // The only console error allowed is the CSP block from our own example.com fetch.
  const otherConsole = toolConsole.filter((t) => !(/example\.com/.test(t) && /Content Security Policy|connect-src/.test(t)));
  ok('no page errors', errors.length === 0, errors.join(' | '));
  ok('tool page: no console errors or CSP violations (besides the deliberate example.com block)', otherConsole.length === 0, otherConsole.join(' | '));
  ok('tool page: no failed (4xx/5xx) requests', toolHttpErrors.length === 0, toolHttpErrors.join(' | '));
  const credit404 = notFound.filter((u) => !toolHttpErrors.includes(u) && !/\/favicon\.ico$/.test(u));
  ok('credits pages: nothing missing (favicon.ico aside)', credit404.length === 0, notFound.slice(toolHttpErrors.length).join(' | ') || 'none');

  await browser.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  console.log(`screenshots: ${path.join(SHOTS, 'shot-1440.png')}, ${path.join(SHOTS, 'shot-430.png')}, ${path.join(SHOTS, 'shot-430-passphrase.png')}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
