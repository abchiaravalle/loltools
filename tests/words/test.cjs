// Real-Chrome test for wordcounter.lol.
//   node tests/words/test.cjs http://127.0.0.1:18823/
// Every count is read back from the page's own displayed numbers after typing or
// pasting the text into the real textarea. Plain-English word counts are
// cross-checked with `wc -w`, and X post lengths with the real twitter-text npm
// package (when installed in _work/words, see tests/words/gen-xcount.cjs).
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, '_work/words');
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:18823/';
const ORIGIN = new URL(base).origin;

let tt = null;
try { tt = require(path.join(ROOT, '_work/words/node_modules/twitter-text')); } catch (_) { /* optional */ }

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  :: ' + detail : ''}`);
};
const skipped = [];
const skip = (name, why) => { skipped.push({ name, why }); console.log(`SKIP  ${name}  :: ${why}`); };
const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));
const wcw = (text) => Number(execFileSync('wc', ['-w'], { input: text }).toString().trim());

// ---------------------------------------------------------------------------
// Known cases. w = words, c = characters (graphemes), ns = characters without
// spaces, s = sentences, p = paragraphs, l = lines. cu = UTF-16 length and
// cp = code points, listed where they differ from c, to show they're NOT what
// the page reports.
// ---------------------------------------------------------------------------
const CASES = [
  { n: 'empty input', t: '', w: 0, c: 0, ns: 0, s: 0, p: 0, l: 0 },
  { n: 'whitespace only', t: '   \n\n  \t ', w: 0, c: 9, ns: 0, s: 0, p: 0, l: 3 },
  { n: 'two words', t: 'Hello world', w: 2, c: 11, ns: 10, s: 1, p: 1, l: 1, type: true },
  { n: 'pangram', t: 'The quick brown fox jumps over the lazy dog.', w: 9, c: 44, ns: 36, s: 1, p: 1, type: true },
  { n: "contractions (straight ')", t: "Don't stop, it's fine. We'll see; they're here.", w: 8, c: 47, ns: 40, s: 2, p: 1, type: true },
  { n: 'contractions (curly ’)', t: 'I don’t know, you’re right.', w: 5, c: 27, ns: 23, s: 1, p: 1 },
  { n: 'hyphenated words', t: 'A well-known, state-of-the-art e-mail.', w: 4, c: 38, ns: 35, s: 1, p: 1 },
  { n: 'em dash and spaced en dash', t: 'yes—no and this – that', w: 5, c: 22, ns: 18, s: 1, p: 1 },
  { n: 'en dash range', t: 'pages 10–20', w: 3, c: 11, ns: 10, s: 1, p: 1 },
  { n: 'numbers, money, percent', t: 'It costs $1,299.99 or 3.5% less, about 2,000 units.', w: 9, c: 51, ns: 43, s: 1, p: 1 },
  { n: 'URL with path and query', t: 'Read https://example.com/a-b?x=1&y=2 now.', w: 3, c: 41, ns: 39, s: 1, p: 1 },
  { n: 'email address', t: 'Email me at hello@example.co.uk today.', w: 5, c: 38, ns: 34, s: 1, p: 1 },
  { n: 'www link', t: 'Go to www.example.org/page.', w: 3, c: 27, ns: 25, s: 1, p: 1 },
  { n: 'multiple spaces, tabs, newlines', t: 'one   two\n\n\nthree\t\tfour', w: 4, c: 23, ns: 15, s: 2, p: 2, l: 4, type: true },
  { n: 'paragraphs and blank lines', t: 'First paragraph here.\n\nSecond one. It has two sentences.\n\n\nThird.', w: 10, c: 65, ns: 53, s: 4, p: 3, l: 6 },
  { n: 'Windows line ending (CRLF)', t: 'Line one.\r\nLine two.', w: 4, c: 19, ns: 16, s: 2, p: 2, l: 2 },
  { n: 'family emoji (ZWJ sequence)', t: '👨‍👩‍👧‍👦', w: 0, c: 1, ns: 1, s: 0, p: 1, l: 1, cu: 11, cp: 7 },
  { n: 'three flags', t: '🇯🇵🇺🇸🇫🇷', w: 0, c: 3, ns: 3, s: 0, p: 1, cu: 12, cp: 6 },
  { n: 'skin-tone emoji between words', t: 'Nice 👍🏽 work', w: 2, c: 11, ns: 9, s: 1, p: 1, cu: 14 },
  { n: 'heart on fire (ZWJ + VS16)', t: '❤️‍🔥', w: 0, c: 1, ns: 1, s: 0, p: 1, cu: 5, cp: 4 },
  { n: 'emoji glued between words', t: 'hi😀there', w: 2, c: 8, ns: 8, s: 1, p: 1, cu: 9 },
  { n: 'combining accents (decomposed)', t: 'e\u0301te\u0301 cafe\u0301', w: 2, c: 8, ns: 7, s: 1, p: 1, cu: 11, cp: 11 },
  { n: 'Japanese', t: '私は猫が好きです。', w: 6, c: 9, ns: 9, s: 1, p: 1 },
  { n: 'Chinese', t: '我喜欢吃苹果。你呢？', w: 6, c: 10, ns: 10, s: 2, p: 1 },
  { n: 'Korean', t: '안녕하세요 세계', w: 2, c: 8, ns: 7, s: 1, p: 1 },
  { n: 'Thai (no spaces, vowel marks join)', t: 'สวัสดีครับ', w: 2, c: 7, ns: 7, s: 1, p: 1, cu: 10 },
  { n: 'titles, initials, a.m., time', t: 'Dr. Smith met Mr. Jones at 10:30 a.m. today. They talked.', w: 11, c: 57, ns: 47, s: 2, p: 1 },
  { n: 'repeated ?! ... punctuation', t: 'Really?! Yes!!! Wait... what?', w: 4, c: 29, ns: 26, s: 3, p: 1 },
  { n: 'Cyrillic', t: 'Привет, мир! Как дела?', w: 4, c: 22, ns: 19, s: 2, p: 1 },
  { n: 'Arabic', t: 'مرحبا بالعالم', w: 2, c: 13, ns: 12, s: 1, p: 1 },
  { n: 'date and time', t: 'Meet at 10:30 on 2024-01-15.', w: 5, c: 28, ns: 24, s: 1, p: 1 },
  { n: 'slashes split words', t: 'and/or 1/2', w: 4, c: 10, ns: 9, s: 1, p: 1 },
  { n: 'hashtag, mention, cashtag', t: '#love @user $AAPL', w: 3, c: 17, ns: 15, s: 1, p: 1 },
  { n: 'ampersand names', t: 'AT&T and Q&A', w: 3, c: 12, ns: 10, s: 1, p: 1 },
  { n: "rock 'n' roll", t: "rock 'n' roll", w: 3, c: 13, ns: 11, s: 1, p: 1 },
  { n: 'underscores', t: 'snake_case_name here', w: 2, c: 20, ns: 19, s: 1, p: 1 },
  { n: 'Spanish ¿? ¡!', t: '¿Dónde está? ¡Aquí!', w: 3, c: 19, ns: 17, s: 2, p: 1 },
  { n: 'number only', t: '42', w: 1, c: 2, ns: 2, s: 1, p: 1 },
  { n: 'punctuation only', t: '... !!! ---', w: 0, c: 11, ns: 9, s: 0, p: 1 },
  { n: 'non-breaking and ideographic spaces', t: 'a\u00A0b\u3000c', w: 3, c: 5, ns: 3, s: 1, p: 1 },
];

// Independent grapheme counter: Swift's String.count is Unicode extended grapheme
// clusters, from Apple's own ICU-free implementation.
function swiftGraphemes(strings) {
  const src = path.join(OUT, 'graphemes.swift');
  fs.writeFileSync(src, 'import Foundation\nlet d = FileHandle.standardInput.readDataToEndOfFile()\nlet arr = try! JSONSerialization.jsonObject(with: d) as! [String]\nprint(arr.map { String($0.count) }.joined(separator: ","))\n');
  try {
    const out = execFileSync('swift', [src], { input: JSON.stringify(strings), timeout: 120000 }).toString().trim();
    return out.split(',').map(Number);
  } catch (e) { return null; }
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  console.log('Chrome', browser.version());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Headless Chrome keeps its own in-memory clipboard, so real Cmd/Ctrl+V pastes
  // don't touch this computer's clipboard.
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const page = await ctx.newPage();
  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  // Chrome's own network log (DevTools protocol), independent of Playwright's request events.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const cdpSent = [];
  const cdpBlocked = [];
  const cdpIds = {};
  cdp.on('Network.requestWillBeSent', (e) => { cdpSent.push(e.request.url); cdpIds[e.requestId] = e.request.url; });
  cdp.on('Network.loadingFailed', (e) => { if (e.blockedReason) cdpBlocked.push({ url: cdpIds[e.requestId], reason: e.blockedReason }); });
  await page.goto(base, { waitUntil: 'load' });

  const ta = '#text';
  const read = () => page.evaluate(() => {
    const t = (id) => document.getElementById(id).textContent;
    return {
      w: t('s-words'), c: t('s-chars'), ns: t('s-nospace'), s: t('s-sentences'), p: t('s-paragraphs'), l: t('s-lines'),
      read: t('s-read'), speak: t('s-speak'), avg: t('s-avg'), longest: t('s-longest'),
      ms: document.querySelector('.wc-stats').dataset.ms, done: document.querySelector('.wc-stats').dataset.done,
    };
  });
  // Wait until the page has recounted AND its numbers are for the text that's in the box now.
  const waitUpdate = async (prevDone) => {
    await page.waitForFunction((p) => {
      const d = document.querySelector('.wc-stats').dataset;
      return d.done !== p && d.len === String(document.getElementById('text').value.length);
    }, prevDone, { timeout: 15000 });
  };
  const clearBox = async () => {
    await page.click('#clearBtn');
    await page.waitForFunction(() => document.getElementById('text').value === '');
  };
  // "Paste": put the text on the clipboard, then a real Cmd/Ctrl+V keypress into the
  // textarea (one trusted insertFromPaste input event, like a person pasting).
  // "Type": real key presses, one input event per character.
  async function paste(text) {
    const okw = await page.evaluate(async (s) => { try { await navigator.clipboard.writeText(s); return true; } catch (e) { return String(e); } }, text);
    if (okw !== true) throw new Error('clipboard write failed: ' + okw);
    await page.focus(ta);
    await page.keyboard.press('ControlOrMeta+V');
  }
  async function enter(text, how) {
    await clearBox();
    await page.focus(ta);
    if (!text) return;
    const before = (await read()).done;
    if (how === 'type') await page.keyboard.type(text, { delay: 0 });
    else await paste(text);
    await waitUpdate(before).catch(() => {});
    await page.waitForTimeout(20);
  }

  // ---- 1. Known cases -----------------------------------------------------
  const table = [];
  const sw = swiftGraphemes(CASES.map((c) => c.t));
  ok('independent grapheme counter (swift) available', !!sw, sw ? 'Swift String.count' : 'swift not found');
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    await enter(c.t, c.type ? 'type' : 'paste');
    const v = await page.inputValue(ta);
    const r = await read();
    const got = { w: num(r.w), c: num(r.c), ns: num(r.ns), s: num(r.s), p: num(r.p), l: num(r.l) };
    const fields = ['w', 'c', 'ns', 's', 'p'].concat(c.l !== undefined ? ['l'] : []);
    const bad = fields.filter((f) => got[f] !== c[f]);
    // CRLF: a textarea normalizes \r\n to \n, which is what a real paste gives you.
    const valueOk = v === c.t.replace(/\r\n/g, '\n');
    let extra = '';
    if (c.cu !== undefined) extra += ` utf16=${c.t.length}${c.t.length === c.cu ? '' : '(table says ' + c.cu + ')'}`;
    if (c.cp !== undefined) extra += ` codepoints=${[...c.t].length}`;
    const swiftOk = !sw || sw[i] === c.c || c.t.includes('\r\n');
    ok(`case ${String(i + 1).padStart(2)}: ${c.n}`, bad.length === 0 && valueOk && swiftOk,
      `${c.type ? 'typed' : 'pasted'}; page w=${got.w} c=${got.c} ns=${got.ns} s=${got.s} p=${got.p} l=${got.l}` +
      (bad.length ? ` | EXPECTED ${bad.map((f) => f + '=' + c[f]).join(' ')}` : '') + (sw ? ` | swift graphemes=${sw[i]}` : '') + extra + (valueOk ? '' : ' | textarea value differs'));
    table.push({ case: c.n, text: c.t, expected: { w: c.w, c: c.c, ns: c.ns, s: c.s, p: c.p, l: c.l }, page: got, swiftGraphemes: sw && sw[i] });
  }
  fs.writeFileSync(path.join(OUT, 'cases.json'), JSON.stringify(table, null, 2));
  ok('case table has at least 25 cases', CASES.length >= 25, CASES.length + ' cases');

  // ---- 2. Derived stats -----------------------------------------------------
  await enter('The quick brown fox jumps over the lazy dog. The fox is quick and the dog is lazy.');
  let r = await read();
  ok('average word length (letters/words)', r.avg === '3.5', `page ${r.avg}; 63 letters / 18 words = 3.50`);
  ok('longest word', r.longest === 'quick' || r.longest === 'brown' || r.longest === 'jumps', r.longest);
  const top = await page.$$eval('#topWords li', (lis) => lis.map((l) => l.textContent));
  ok('top words skip common words by default', JSON.stringify(top) === JSON.stringify(['dog×2', 'fox×2', 'lazy×2', 'quick×2']), JSON.stringify(top));
  await page.check('#includeCommon');
  await page.waitForTimeout(50);
  const top2 = await page.$$eval('#topWords li', (lis) => lis.map((l) => l.textContent));
  ok('"include common words" toggle adds them', top2[0] === 'the×4' && top2.includes('is×2'), JSON.stringify(top2));
  await page.uncheck('#includeCommon');

  // Reading/speaking time with a known word count.
  await enter(Array.from({ length: 476 }, (_, i) => 'word' + (i % 50)).join(' '));
  r = await read();
  ok('reading time = words / 238 wpm', r.w === '476' && r.read === '2 min', `${r.w} words -> "${r.read}" (476/238 = 2.0 min)`);
  ok('speaking time = words / 130 wpm', r.speak === '3 min 40 sec', `"${r.speak}" (476/130 = 3.66 min = 3:40)`);
  const faqTxt = await page.textContent('.faq');
  ok('reading/speaking speeds are stated on the page', /238 words a minute/.test(await page.textContent('.wc-stats')) && /130 words a minute/.test(faqTxt) && /238 words a minute/.test(faqTxt));
  ok('FAQ explains how characters are counted', /How do you count characters\?/.test(faqTxt) && /1 character/.test(faqTxt));

  // ---- 3. wc -w cross-check on plain English ---------------------------------
  const PARAS = [
    { n: 'plain prose', t: 'Four score and seven years ago our fathers brought forth on this continent, a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.' },
    { n: 'contractions, hyphens, numbers', t: "It's a well-known fact that the 3 o'clock train doesn't stop at 4th Street. We'll take the 5:15 express, which costs $12.50, and we're home by 6." },
    { n: 'multi-paragraph with blank lines', t: 'Now we are engaged in a great civil war, testing whether that nation, or any nation so conceived and so dedicated, can long endure.\n\nWe are met on a great battle-field of that war.\n\n\nWe have come to dedicate a portion of that field.' },
    { n: 'spaced double hyphen (wc counts "--" as a word)', t: 'It is for us the living, rather, to be dedicated here to the unfinished work -- which they who fought here have thus far so nobly advanced -- and that government shall not perish.' },
    { n: 'unspaced em dashes (wc sees one word)', t: 'The plan was simple—too simple, maybe—but it worked. Nobody expected that—least of all me.' },
    { n: 'spaced em dashes (wc counts the dash)', t: 'We waited — and waited — until the rain stopped.' },
  ];
  for (const P of PARAS) {
    await enter(P.t);
    r = await read();
    const ours = num(r.w);
    const wc = wcw(P.t);
    // Expected difference, worked out from the text itself:
    //  - a whitespace-separated token with no letters or digits ("--", "—") is a word to wc, not to us
    //  - a dash glued between two words ("simple—too") is one word to wc, two to us
    const lone = P.t.split(/\s+/).filter((x) => x && !/[\p{L}\p{N}]/u.test(x)).length;
    const glued = (P.t.match(/[\p{L}\p{N}][\u2014\u2013][\p{L}\p{N}]/gu) || []).length;
    const expect = wc - lone + glued;
    ok(`wc -w cross-check: ${P.n}`, ours === expect, `page ${ours}, wc -w ${wc}` + (lone || glued ? ` (differs by design: ${lone} dash-only token(s) wc counts, ${glued} glued dash(es) wc doesn't split)` : ' (same)'));
  }

  // ---- 4. Selection counts ---------------------------------------------------
  await enter('Alpha beta gamma. Delta epsilon.\nSecond line here.');
  ok('selection box hidden with no selection', await page.isHidden('#selInfo'));
  await page.evaluate(() => { const t = document.getElementById('text'); t.focus(); t.setSelectionRange(0, 17); });
  await page.waitForTimeout(50);
  let sel = await page.evaluate(() => ['sel-words', 'sel-chars', 'sel-nospace', 'sel-sentences'].map((id) => document.getElementById(id).textContent));
  ok('selection counts (setSelectionRange "Alpha beta gamma.")', (await page.isVisible('#selInfo')) && sel.join(',') === '3,17,15,1', sel.join(','));
  // Real double-click on the first word.
  const box = await page.locator(ta).boundingBox();
  await page.mouse.dblclick(box.x + 30, box.y + 26);
  await page.waitForTimeout(80);
  const selTxt = await page.evaluate(() => { const t = document.getElementById('text'); return t.value.slice(t.selectionStart, t.selectionEnd); });
  sel = await page.evaluate(() => ['sel-words', 'sel-chars'].map((id) => document.getElementById(id).textContent));
  ok('selection counts after real double-click', selTxt.trim() === 'Alpha' && sel[0] === '1' && Number(sel[1]) === selTxt.length, `selected "${selTxt}" -> ${sel.join(',')}`);
  // Keyboard selection: End, then Shift+Left x5.
  await page.keyboard.press('ControlOrMeta+End');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(60);
  sel = await page.evaluate(() => ['sel-words', 'sel-chars'].map((id) => document.getElementById(id).textContent));
  ok('selection counts after Shift+Arrow keys ("here.")', sel.join(',') === '1,5', sel.join(','));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(60);
  ok('selection box hides when the selection collapses', await page.isHidden('#selInfo'));
  // Emoji selection counts graphemes too.
  await enter('ab 👨‍👩‍👧‍👦 cd');
  await page.evaluate(() => { const t = document.getElementById('text'); t.focus(); t.setSelectionRange(3, 14); });
  await page.waitForTimeout(50);
  sel = await page.evaluate(() => ['sel-words', 'sel-chars'].map((id) => document.getElementById(id).textContent));
  ok('selection of a family emoji counts 1 character', sel.join(',') === '0,1', sel.join(','));
  await page.keyboard.press('ArrowRight');

  // ---- 5. Limit presets --------------------------------------------------------
  const lim = (key) => page.evaluate((k) => {
    const li = document.getElementById('lim-' + k);
    return { n: document.getElementById(k + '-n').textContent, st: document.getElementById(k + '-st').textContent, state: li.dataset.state,
      width: li.querySelector('.meter > span').style.width, now: li.querySelector('.meter').getAttribute('aria-valuenow') };
  }, key);
  await enter('a'.repeat(279));
  let L = await lim('x');
  ok('X: 279 of 280 is near the limit', L.n === '279' && L.st === '1 left' && L.state === 'warn', JSON.stringify(L));
  await enter('a'.repeat(280));
  L = await lim('x');
  ok('X: 280 is exactly at the limit (not over)', L.n === '280' && L.st === '0 left' && L.state === 'warn' && L.width === '100%', JSON.stringify(L));
  await enter('a'.repeat(281));
  L = await lim('x');
  ok('X: 281 is over', L.st === '1 over' && L.state === 'over', JSON.stringify(L));

  const xCases = [
    'Hello world',
    'Read this: https://example.com/a/very/long/path/that/keeps/going/and/going?with=query&more=1 ok',
    'Short link example.com and t.co/abc123',
    '日本語のテキストです。',
    '한국어 텍스트',
    '👨‍👩‍👧‍👦 🇺🇸 👍🏽 ❤️',
    'naïve café — “quotes” …',
    'Mixed: 你好 https://例え.jp/path 😀 done.',
    'email me@example.com is not a link to X? It is.',
    'Version 1.2.3 and file.txt and node.js',
  ];
  for (const t of xCases) {
    await enter(t);
    L = await lim('x');
    const name = `X weighting matches twitter-text: ${JSON.stringify(t).slice(0, 48)}`;
    if (!tt) { skip(name, `page ${L.n}; twitter-text not installed (cd _work/words && npm install twitter-text@3.1.0)`); continue; }
    const ref = tt.parseTweet(t).weightedLength;
    ok(name, num(L.n) === ref, `page ${L.n}, twitter-text ${ref}`);
  }
  // Fuzz: long mixed texts against the real library.
  if (tt) {
    const toks = ['the', 'quick', 'fox', 'example.com', 'https://a.co/x?y=1', 'www.test.org/p', '日本', '한국', '😀', '👨‍👩‍👧', '🇯🇵', "don't", 'e.g.', '3.14', 'U.S.A.', '—', 'naïve', 'a@b.com', 'x.y.z', '#tag', '@user', '\n'];
    let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let mism = 0;
    for (let k = 0; k < 8; k++) {
      let s = '';
      const n = 30 + Math.floor(rnd() * 120);
      for (let i = 0; i < n; i++) s += toks[Math.floor(rnd() * toks.length)] + (rnd() < 0.85 ? ' ' : '');
      await enter(s);
      L = await lim('x');
      if (num(L.n) !== tt.parseTweet(s).weightedLength) mism++;
    }
    ok('X weighting fuzz (8 random mixed posts) matches twitter-text', mism === 0, `${mism} mismatches`);
  } else skip('X weighting fuzz', 'twitter-text not installed');
  // Hand-checked X values that don't need the library: a 90-char link is 23, an emoji 2, CJK 2 each.
  for (const [t, want] of [['https://example.com/' + 'a'.repeat(70), 23], ['ok 😀', 5], ['日本', 4], ['a…', 3]]) {
    await enter(t);
    L = await lim('x');
    ok(`X weighting by hand: ${JSON.stringify(t).slice(0, 30)} = ${want}`, num(L.n) === want, `page ${L.n}`);
  }

  await enter('x'.repeat(2200));
  L = await lim('ig');
  ok('Instagram: 2,200 at the limit', L.n === '2,200' && L.st === '0 left' && L.state === 'warn', JSON.stringify(L));
  await enter('x'.repeat(2201));
  L = await lim('ig');
  ok('Instagram: 2,201 over', L.st === '1 over' && L.state === 'over', JSON.stringify(L));
  await enter('x'.repeat(3001));
  L = await lim('li');
  ok('LinkedIn: 3,001 over', L.n === '3,001' && L.st === '1 over' && L.state === 'over', JSON.stringify(L));
  await enter('x'.repeat(2500));
  L = await lim('li');
  ok('LinkedIn: 2,500 fine', L.st === '500 left' && L.state === 'ok', JSON.stringify(L));

  for (const [n, st, state] of [[150, '10 left', 'ok'], [154, '6 left', 'ok'], [155, 'May get cut off', 'warn'], [160, 'May get cut off', 'warn'], [161, '1 over', 'over']]) {
    await enter('m'.repeat(n));
    L = await lim('meta');
    ok(`Meta description: ${n} chars -> ${state}`, L.st === st && L.state === state, JSON.stringify(L));
  }
  // Meta counts graphemes: 158 letters + 1 family emoji = 159.
  await enter('m'.repeat(158) + '👨‍👩‍👧‍👦');
  L = await lim('meta');
  ok('Meta description counts an emoji as 1', L.n === '159', JSON.stringify(L));

  const smsInfo = () => page.evaluate(() => ({ max: document.getElementById('sms-max').textContent, gsm: document.getElementById('lim-sms').dataset.gsm, parts: document.getElementById('lim-sms').dataset.parts, note: document.getElementById('sms-note').textContent }));
  await enter('s'.repeat(160));
  L = await lim('sms'); let S = await smsInfo();
  ok('SMS: 160 plain characters = 1 text', S.max === '160' && S.parts === '1' && L.st === '0 left' && L.state !== 'over', JSON.stringify({ ...L, ...S }));
  await enter('s'.repeat(161));
  L = await lim('sms'); S = await smsInfo();
  ok('SMS: 161 plain characters = 2 texts', S.parts === '2' && L.st === 'Sends as 2 texts' && L.state === 'over', JSON.stringify({ ...L, ...S }));
  await enter('s'.repeat(306));
  S = await smsInfo();
  ok('SMS: 306 plain = 2 texts (153 each)', S.parts === '2', S.parts);
  await enter('s'.repeat(307));
  S = await smsInfo();
  ok('SMS: 307 plain = 3 texts', S.parts === '3', S.parts);
  await enter('Hi 😀');
  L = await lim('sms'); S = await smsInfo();
  ok('SMS: one emoji switches the limit to 70', S.max === '70' && S.gsm === '0' && L.n === '5' && /70 per message/.test(S.note), JSON.stringify({ ...L, ...S }));
  await enter('u'.repeat(69) + '😀');
  S = await smsInfo(); L = await lim('sms');
  ok('SMS: 69 letters + 1 emoji = 71 units = 2 texts (emoji takes 2)', L.n === '71' && S.parts === '2', JSON.stringify({ ...L, ...S }));
  await enter('u'.repeat(69) + 'é'.repeat(0) + 'ü');
  S = await smsInfo();
  ok('SMS: ü is in the plain set (stays 160)', S.max === '160' && S.parts === '1', JSON.stringify(S));
  await enter('Price: 80€ and {braces}');
  L = await lim('sms'); S = await smsInfo();
  ok('SMS: € and { } count 2 each but stay in the 160 set', S.max === '160' && L.n === String('Price: 80€ and {braces}'.length + 3), JSON.stringify({ ...L, ...S }));
  await enter('Curly ’quote’');
  S = await smsInfo();
  ok('SMS: curly quotes switch to 70', S.max === '70', JSON.stringify(S));

  // Custom limit.
  await page.fill('#customMax', '10');
  await enter('Hello');
  L = await lim('custom');
  ok('Custom 10 chars, "Hello" is under', L.st === '5 left' && L.state === 'ok', JSON.stringify(L));
  await enter('Hello world!');
  L = await lim('custom');
  ok('Custom 10 chars, 12 chars is over', L.st === '2 characters over' && L.state === 'over', JSON.stringify(L));
  await page.selectOption('#customUnit', 'words');
  await page.fill('#customMax', '3');
  await enter('one two three');
  L = await lim('custom');
  ok('Custom 3 words, 3 words is at the limit', L.n === '3' && L.st === '0 left' && L.state === 'warn', JSON.stringify(L));
  await enter('one two three four');
  L = await lim('custom');
  ok('Custom 3 words, 4 words is over', L.st === '1 word over' && L.state === 'over', JSON.stringify(L));
  await page.fill('#customMax', '1000');
  await page.waitForTimeout(30);
  L = await lim('custom');
  ok('Custom limit updates live when you change the number', L.st === '996 left' && L.state === 'ok', JSON.stringify(L));
  await page.fill('#customMax', '0');
  await page.waitForTimeout(30);
  L = await lim('custom');
  ok('Custom limit 0 asks for a real number', /1 or more/.test(L.st), JSON.stringify(L));
  await page.fill('#customMax', '500');
  await page.selectOption('#customUnit', 'chars');

  // ---- 6. Performance ------------------------------------------------------------
  const vocab = 'time person year way day thing man world life hand part child eye woman place work week case point government company number group problem fact be have do say get make go know take see come think look want give use find tell ask seem feel try leave call good new first last long great little own other old right big high different small large next early young important few public bad same able'.split(' ');
  let seed2 = 7; const rnd2 = () => (seed2 = (seed2 * 16807) % 2147483647) / 2147483647;
  const words10k = [];
  for (let i = 0; i < 10000; i++) words10k.push(vocab[Math.floor(rnd2() * vocab.length)]);
  let big = '';
  for (let i = 0; i < words10k.length; i++) {
    big += words10k[i];
    big += i === words10k.length - 1 ? '.' : (i % 120 === 119 ? '.\n\n' : (i % 15 === 14 ? '. ' : ' '));
  }
  await clearBox();
  await page.evaluate(async (s) => navigator.clipboard.writeText(s), big);
  await page.focus(ta);
  let before = (await read()).done;
  const t0 = Date.now();
  await page.keyboard.press('ControlOrMeta+V');
  await waitUpdate(before);
  const wall = Date.now() - t0;
  r = await read();
  ok('10,000-word paste: count is exact and matches wc -w', num(r.w) === 10000 && wcw(big) === 10000, `page ${r.w}, wc -w ${wcw(big)}, ${big.length} chars`);
  ok('10,000-word paste: update under 50 ms', Number(r.ms) < 50, `count+render ${r.ms} ms; Cmd+V to numbers on screen ${wall} ms (includes test-driver round trips)`);
  // Some input paths (Chrome's insertText, dictation) fire one input event per line.
  // The page must collapse that burst into one recount, not 250.
  await clearBox();
  await page.focus(ta);
  await page.evaluate(() => { window.__updates = 0; new MutationObserver(() => window.__updates++).observe(document.querySelector('.wc-stats'), { attributes: true, attributeFilter: ['data-done'] }); });
  before = (await read()).done;
  const t1 = Date.now();
  await page.keyboard.insertText(big);
  await waitUpdate(before);
  const burstWall = Date.now() - t1;
  await page.waitForTimeout(100);
  const burst = await page.evaluate(() => ({ updates: window.__updates, events: document.getElementById('text').value.split('\n').length }));
  ok('burst of input events collapses into at most 2 recounts', burst.updates <= 2 && num((await read()).w) === 10000, `${burst.updates} recount(s) for ~${burst.events} input events, wall ${burstWall} ms`);
  // Typing at the end of the 10k-word text: real key presses, each one a full recount.
  const typedMs = [];
  for (const ch of ' and more') {
    before = (await read()).done;
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await waitUpdate(before);
    typedMs.push(Number((await read()).ms));
  }
  typedMs.sort((a, b) => a - b);
  r = await read();
  ok('10,000 words: every keystroke update under 50 ms', typedMs[typedMs.length - 1] < 50 && num(r.w) === 10002, `${typedMs.length} keys, median ${typedMs[Math.floor(typedMs.length / 2)].toFixed(1)} ms, max ${typedMs[typedMs.length - 1].toFixed(1)} ms, words now ${r.w}`);
  // In-page timing loop, independent of the app's own timer: insert text through
  // the browser's editing path (the same one a keystroke uses), then time until the
  // new numbers are in the page and laid out.
  const loop = await page.evaluate(async () => {
    const t = document.getElementById('text');
    const stats = document.querySelector('.wc-stats');
    const times = [], ours = [];
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
    for (let i = 0; i < 20; i++) {
      const a = performance.now();
      document.execCommand('insertText', false, ' x');
      void document.getElementById('s-words').offsetHeight;
      times.push(performance.now() - a);
      ours.push(Number(stats.dataset.ms));
      await new Promise((r) => setTimeout(r, 30)); // a fast typist's gap between keys
    }
    times.sort((x, y) => x - y); ours.sort((x, y) => x - y);
    return { median: times[10], max: times[19], oursMax: ours[19], words: document.getElementById('s-words').textContent };
  });
  ok('10,000 words: 20 back-to-back edits, each under 50 ms', loop.max < 50 && loop.words === '10,022', `median ${loop.median.toFixed(1)} ms, max ${loop.max.toFixed(1)} ms (edit to numbers laid out; our counting+render max ${loop.oursMax.toFixed(1)} ms), words ${loop.words}`);
  // A whole book: 200,000 words still counts exactly (updates after a short pause).
  const book = (big + '\n\n').repeat(20);
  await clearBox();
  await page.evaluate((b) => { const t = document.getElementById('text'); t.value = b; t.dispatchEvent(new Event('input', { bubbles: true })); }, book);
  await page.waitForFunction(() => document.getElementById('s-words').textContent === '200,000', null, { timeout: 20000 }).catch(() => {});
  r = await read();
  ok('200,000-word text (1.2M chars) counts exactly', r.w === '200,000', `page ${r.w}, ${book.length} chars, update ${r.ms} ms`);

  // ---- 7. Files ---------------------------------------------------------------------
  await clearBox();
  await page.setInputFiles('#fileInput', { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFHello from a file.\nSecond line, still here.', 'utf8') });
  await page.waitForFunction(() => document.getElementById('s-words').textContent === '8', null, { timeout: 5000 }).catch(() => {});
  r = await read();
  const st1 = await page.textContent('#status');
  ok('open .txt (UTF-8 with BOM): text loads, BOM not counted', r.w === '8' && r.c === '43' && /Opened “note.txt”/.test(st1), `w=${r.w} c=${r.c} :: ${st1}`);
  await page.setInputFiles('#fileInput', { name: 'readme.md', mimeType: '', buffer: Buffer.from('# Title\n\nSome *markdown* text.', 'utf8') });
  await page.waitForFunction(() => document.getElementById('s-words').textContent === '4', null, { timeout: 5000 }).catch(() => {});
  r = await read();
  const undoVisible = await page.isVisible('#undoBtn');
  ok('open .md (no MIME type): loads and offers Undo', r.w === '4' && undoVisible, `w=${r.w}, undo ${undoVisible}`);
  await page.click('#undoBtn');
  r = await read();
  ok('Undo brings back the replaced text', r.w === '8', `w=${r.w}`);
  await page.setInputFiles('#fileInput', { name: 'report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') });
  await page.waitForTimeout(100);
  let st = await page.textContent('#status');
  ok('wrong file type is refused in plain words', /isn’t a \.txt or \.md file/.test(st) && (await read()).w === '8', st);
  await page.setInputFiles('#fileInput', { name: 'huge.txt', mimeType: 'text/plain', buffer: Buffer.alloc(6 * 1024 * 1024, 0x61) });
  await page.waitForTimeout(150);
  st = await page.textContent('#status');
  ok('file over 5 MB is refused in plain words', /limit is 5 MB/.test(st), st);
  await page.setInputFiles('#fileInput', { name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x02]) });
  await page.waitForTimeout(150);
  st = await page.textContent('#status');
  ok('binary file named .txt is refused', /doesn’t look like plain text/.test(st) && (await read()).w === '8', st);
  // Drag and drop a file onto the box.
  const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['Dropped words count too.'], 'drop.txt', { type: 'text/plain' })); return d; });
  await page.dispatchEvent('#dropArea', 'dragover', { dataTransfer: dt });
  await page.dispatchEvent('#dropArea', 'drop', { dataTransfer: dt });
  await page.waitForFunction(() => document.getElementById('s-words').textContent === '4', null, { timeout: 5000 }).catch(() => {});
  ok('drag and drop a .txt onto the box', (await read()).w === '4', (await read()).w);

  // ---- 8. Local save toggle --------------------------------------------------------
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  const req2 = [];
  p2.on('request', (q) => req2.push(q.url()));
  p2.on('pageerror', (e) => pageErrors.push('ctx2: ' + e));
  await p2.goto(base);
  const ls = () => p2.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  ok('save toggle is OFF by default', !(await p2.isChecked('#saveToggle')));
  await p2.focus('#text');
  await p2.keyboard.type('Secret draft one');
  await p2.waitForTimeout(600);
  let store = await ls();
  ok('with saving off, nothing is written to localStorage', !JSON.stringify(store).includes('Secret'), JSON.stringify(store));
  await p2.reload();
  ok('with saving off, reload starts empty', (await p2.inputValue('#text')) === '', JSON.stringify(await p2.inputValue('#text')));
  await p2.check('#saveToggle');
  await p2.focus('#text');
  await p2.keyboard.type('Secret draft two');
  await p2.waitForTimeout(600);
  store = await ls();
  ok('with saving on, the draft is in localStorage', store['wordcounter-draft'] === 'Secret draft two' && store['wordcounter-save'] === '1', JSON.stringify(store));
  await p2.reload();
  const restored = await p2.inputValue('#text');
  const st2 = await p2.textContent('#status');
  ok('with saving on, reload restores the text and the toggle', restored === 'Secret draft two' && (await p2.isChecked('#saveToggle')) && /saved draft is back/.test(st2), `${JSON.stringify(restored)} :: ${st2}`);
  ok('restored draft is counted', (await p2.textContent('#s-words')) === '3');
  // Type and reload straight away: the pagehide save catches it.
  await p2.focus('#text');
  await p2.keyboard.press('End');
  await p2.keyboard.type(' plus');
  await p2.reload();
  ok('edits right before closing are kept (pagehide save)', (await p2.inputValue('#text')) === 'Secret draft two plus', JSON.stringify(await p2.inputValue('#text')));
  await p2.click('#clearBtn');
  store = await ls();
  ok('Clear wipes the saved copy from localStorage', !('wordcounter-draft' in store) && (await p2.inputValue('#text')) === '', JSON.stringify(store));
  ok('Clear says the saved copy was deleted', /saved copy in this browser is deleted/.test(await p2.textContent('#status')), await p2.textContent('#status'));
  await p2.reload();
  ok('after Clear, reload stays empty', (await p2.inputValue('#text')) === '');
  await p2.focus('#text');
  await p2.keyboard.type('Another draft');
  await p2.waitForTimeout(600);
  await p2.uncheck('#saveToggle');
  store = await ls();
  ok('turning saving off deletes the saved copy', !('wordcounter-draft' in store) && !('wordcounter-save' in store), JSON.stringify(store));
  await p2.reload();
  ok('after turning it off, reload starts empty', (await p2.inputValue('#text')) === '' && !(await p2.isChecked('#saveToggle')));
  // Too big for localStorage: plain message, and no stale older draft left behind.
  await p2.check('#saveToggle');
  await p2.fill('#text', 'Small draft first');
  await p2.waitForTimeout(700);
  const hadSmall = (await ls())['wordcounter-draft'] === 'Small draft first';
  await p2.evaluate(() => { const t = document.getElementById('text'); t.value = 'word '.repeat(1300000); t.dispatchEvent(new Event('input', { bubbles: true })); });
  await p2.waitForFunction(() => /too long to save/.test(document.getElementById('status').textContent), null, { timeout: 15000 }).catch(() => {});
  const qst = await p2.textContent('#status');
  store = await ls();
  ok('draft too big for browser storage: plain message, no stale copy left', hadSmall && /too long to save/.test(qst) && !('wordcounter-draft' in store) && (await p2.textContent('#s-words')) === '1,300,000',
    `${qst} | stored keys: ${Object.keys(store).join(',')} | words ${await p2.textContent('#s-words')}`);
  await p2.click('#clearBtn');
  await p2.uncheck('#saveToggle');
  const privacy = await p2.textContent('.privacy-card');
  ok('privacy copy says the draft is saved only in this browser on this device', /saved only in this browser on this device/.test(privacy) && /saved only in this browser on this device/.test(await p2.textContent('.wc-save')));
  ok('save-toggle context: all requests same-origin', req2.every((u) => u.startsWith(ORIGIN + '/')), req2.filter((u) => !u.startsWith(ORIGIN + '/')).join(', '));
  await ctx2.close();

  // ---- 9. Fallback without Intl.Segmenter --------------------------------------------
  const ctx3 = await browser.newContext();
  await ctx3.addInitScript(() => { try { delete Intl.Segmenter; } catch (_) {} });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => pageErrors.push('fallback: ' + e));
  await p3.goto(base);
  ok('fallback: browser without Intl.Segmenter shows a plain note', await p3.isVisible('#fallbackNote'));
  const fb = [
    ["Don't stop—it's well-known. Note:This at 10:30!", 8, 47, 2],
    ['Dr. Smith went home. He slept.', 6, 30, 2],
    ['👨‍👩‍👧‍👦 🇯🇵🇺🇸 e\u0301', 1, 6, 1],
    ['Visit https://example.com/x?y=1. Ok', 3, 35, 2],
  ];
  for (const [t, w, c, s] of fb) {
    await p3.fill('#text', t);
    await p3.waitForTimeout(30);
    const got = await p3.evaluate(() => ['s-words', 's-chars', 's-sentences'].map((id) => document.getElementById(id).textContent));
    ok(`fallback counts: ${JSON.stringify(t).slice(0, 40)}`, got.join(',') === [w, c, s].join(','), `${got.join(',')} (expected ${w},${c},${s})`);
  }
  await ctx3.close();

  // ---- 10. Privacy: network and CSP ---------------------------------------------------
  const fetchRes = await page.evaluate(async () => {
    let violation = null;
    document.addEventListener('securitypolicyviolation', (e) => { violation = e.violatedDirective + ' ' + e.blockedURI; }, { once: true });
    try { await fetch('https://example.com/'); return 'NOT BLOCKED'; } catch (e) { await new Promise((r) => setTimeout(r, 50)); return 'blocked: ' + e.name + (violation ? ' / CSP ' + violation : ''); }
  });
  ok("fetch('https://example.com/') is blocked by CSP", /^blocked/.test(fetchRes) && /connect-src/.test(fetchRes), fetchRes);
  // sendBeacon returns true when it QUEUES a request, so check that CSP actually blocked it.
  const beacon = await page.evaluate(async () => {
    const seen = [];
    const h = (e) => seen.push(e.violatedDirective + ' ' + e.blockedURI);
    document.addEventListener('securitypolicyviolation', h);
    let ret;
    try { ret = navigator.sendBeacon('https://example.com/beacon', 'x'); } catch (e) { ret = 'threw ' + e.name; }
    await new Promise((r) => setTimeout(r, 300));
    document.removeEventListener('securitypolicyviolation', h);
    return { ret: String(ret), seen };
  });
  ok('sendBeacon to another site is blocked by CSP', beacon.seen.some((s) => /connect-src/.test(s) && /example\.com\/beacon/.test(s)), JSON.stringify(beacon));
  await page.waitForTimeout(300);
  const leaked = cdpSent.filter((u) => !u.startsWith(ORIGIN + '/') && !u.startsWith('data:') && !u.startsWith('blob:'));
  const leakedNotBlocked = leaked.filter((u) => !cdpBlocked.some((b) => b.url === u && b.reason === 'csp'));
  ok("Chrome's network log: every off-site attempt was blocked by CSP before sending", leakedNotBlocked.length === 0,
    `${cdpSent.length} requests seen by Chrome; off-site attempts ${leaked.length} (${[...new Set(leaked)].join(', ')}), blocked: ${JSON.stringify(cdpBlocked)}`);
  const foreign = requests.filter((u) => !u.startsWith(ORIGIN + '/') && !u.startsWith('data:') && !u.startsWith('blob:'));
  ok('every request is same-origin', foreign.length === 0, `${requests.length} requests: ${[...new Set(requests.map((u) => new URL(u).pathname))].join(' ')}` + (foreign.length ? ' | FOREIGN: ' + foreign.join(', ') : ''));
  const unexpected = consoleErrors.filter((m) => !/example\.com/.test(m));
  ok('no console errors except the deliberate blocked fetch', unexpected.length === 0, unexpected.join(' | ') || `${consoleErrors.length} expected CSP message(s)`);
  ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // View-source comment and copy rules.
  const html = await (await page.request.get(base)).text();
  const head = html.slice(0, html.indexOf('-->'));
  const loaded = [...new Set(requests.filter((u) => u.startsWith(ORIGIN)).map((u) => new URL(u).pathname.replace(/^\//, '') || 'index.html'))];
  const missing = loaded.filter((f) => !head.includes(f));
  ok('view-source comment lists every file the page loads', missing.length === 0, 'loaded: ' + loaded.join(', ') + (missing.length ? ' | not listed: ' + missing.join(', ') : ''));
  const bodyText = await page.evaluate(() => document.body.innerText);
  // innerText doesn't include what's typed in the textarea, only the page's own copy.
  ok('no em dashes in visible copy', !/\u2014/.test(bodyText), (bodyText.match(/.{0,30}\u2014.{0,30}/g) || []).join(' | '));
  ok('no banned hype words', !/seamless|effortless|powerful|unleash/i.test(bodyText));
  const cspMeta = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  ok("CSP keeps connect-src 'none'", /connect-src 'none'/.test(cspMeta), cspMeta);

  // ---- 11. Screenshots -------------------------------------------------------------------
  const SAMPLE = "Paste your draft here and watch the numbers move. Don't worry, it never leaves this tab.\n\nLinks like https://wordcounter.lol count as 23 on X, and 👨‍👩‍👧‍👦 counts as one character. 日本語も数えます。";
  for (const [w, name] of [[1440, 'desktop-1440'], [430, 'mobile-430']]) {
    const c = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: w < 500 ? 2 : 1 });
    const p = await c.newPage();
    await p.goto(base);
    await p.fill('#text', SAMPLE);
    await p.evaluate(() => { const t = document.getElementById('text'); t.focus(); t.setSelectionRange(0, 50); });
    await p.waitForTimeout(150);
    const f = path.join(OUT, `screenshot-${name}.png`);
    await p.screenshot({ path: f, fullPage: true });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(`screenshot ${name} saved, no sideways scroll`, fs.existsSync(f) && overflow <= 0, `${f} (overflow ${overflow}px)`);
    await c.close();
  }

  await browser.close();
  const passed = results.filter((x) => x.pass).length;
  console.log(`\n${passed}/${results.length} passed` + (skipped.length ? `, ${skipped.length} skipped (not counted)` : ''));
  fs.writeFileSync(path.join(OUT, 'test-results.json'), JSON.stringify(results, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
