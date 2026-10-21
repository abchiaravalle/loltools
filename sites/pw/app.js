/*
  pwgen.lol app. Runs entirely in your browser.

  Randomness: every pick comes from crypto.getRandomValues, the browser's
  cryptographically secure generator. Nothing else is used as a random source.
  Picks use rejection sampling so every character and word is equally likely.

  Storage: passwords and passphrases are never written anywhere. No
  localStorage, no sessionStorage, no cookies, no URL. They live in this tab's
  memory and on screen until you make new ones or close the tab. Only your
  settings (length, which characters, word count, separator) are saved, in
  localStorage under "pwgen-settings".

  Network: none. The page's CSP sets connect-src 'none'.
*/
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const WORDS = window.EFF_LARGE_WORDLIST;
  const WORD_COUNT = 7776;

  // ---- Secure random integers -----------------------------------------------
  // A fresh source per generate action. It pulls 256 random 32-bit numbers at a
  // time from crypto.getRandomValues and hands them out one by one.
  function randomSource() {
    const buf = new Uint32Array(256);
    let i = buf.length;
    return function next32() {
      if (i >= buf.length) { window.crypto.getRandomValues(buf); i = 0; }
      return buf[i++];
    };
  }

  // Unbiased integer in [0, n). Plain "x % n" would favour the first
  // (2^32 mod n) results very slightly, because 2^32 isn't a multiple of n.
  // So we throw away any draw at or above the largest multiple of n that fits
  // in 32 bits and draw again (rejection sampling). The rest map evenly.
  const TWO32 = 4294967296;
  function randomBelow(n, next) {
    if (!(Number.isInteger(n) && n >= 1 && n <= TWO32)) throw new RangeError('bad range ' + n);
    const limit = TWO32 - (TWO32 % n);
    let x;
    do { x = next(); } while (x >= limit);
    return x % n;
  }

  // ---- Character sets ---------------------------------------------------------
  const SETS = {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digits: '0123456789',
    // All 32 printable ASCII symbols. With the three sets above that's 94.
    symbols: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  };
  const LOOKALIKES = '0O1lI';
  const CLASS_ORDER = ['lower', 'upper', 'digits', 'symbols'];

  function pickedClasses(o) {
    return CLASS_ORDER.filter((k) => o[k]).map((k) => {
      let chars = SETS[k];
      if (o.avoid) chars = chars.split('').filter((c) => !LOOKALIKES.includes(c)).join('');
      return { name: k, chars };
    });
  }

  // ---- Random password ----------------------------------------------------------
  // Each character is an independent uniform pick from the combined set.
  // "At least one of each kind": we make a whole password and, if it misses a
  // kind you picked, throw it away and make a fresh one. Throwing away whole
  // candidates keeps every valid password exactly equally likely, which a
  // "force one of each into fixed spots" trick wouldn't.
  function generatePassword(o, next) {
    const classes = pickedClasses(o);
    if (!classes.length) throw new Error('none');
    const all = classes.map((c) => c.chars).join('');
    for (let tries = 0; tries < 100000; tries++) {
      let s = '';
      for (let i = 0; i < o.length; i++) s += all[randomBelow(all.length, next)];
      if (!o.require || classes.every((c) => hasAny(s, c.chars))) return s;
    }
    throw new Error('rules'); // can't happen for length >= 8 with at most 4 kinds
  }
  function hasAny(s, chars) {
    for (let i = 0; i < s.length; i++) if (chars.includes(s[i])) return true;
    return false;
  }

  // log2 of a BigInt, accurate to double precision.
  function log2Big(x) {
    const s = x.toString(2);
    if (s.length <= 53) return Math.log2(Number(x));
    return Math.log2(Number(BigInt('0b' + s.slice(0, 53)))) + (s.length - 53);
  }

  // Strength in bits = log2(number of equally likely outputs). It's computed
  // from the settings, never from the password that came out.
  //  - Without "at least one of each": N^L outputs, so L * log2(N).
  //  - With it: output is uniform over the strings that contain every picked
  //    kind (see generatePassword). We count those exactly with
  //    inclusion-exclusion, sum over subsets T of the kinds of
  //    (-1)^|T| * (N - size of T's characters)^L, in BigInt, and take log2.
  //    No approximation. It's a little under L * log2(N), e.g. 130.9 vs 131.1
  //    bits for 20 characters from all 94.
  function passwordBits(o) {
    const sizes = pickedClasses(o).map((c) => c.chars.length);
    if (!sizes.length) return 0;
    const N = sizes.reduce((a, b) => a + b, 0);
    if (!o.require || sizes.length === 1) return o.length * Math.log2(N);
    let count = 0n;
    for (let mask = 0; mask < (1 << sizes.length); mask++) {
      let missing = 0, k = 0;
      for (let j = 0; j < sizes.length; j++) if (mask & (1 << j)) { missing += sizes[j]; k++; }
      const term = BigInt(N - missing) ** BigInt(o.length);
      count += k % 2 ? -term : term;
    }
    return log2Big(count);
  }

  // ---- Passphrase -----------------------------------------------------------------
  const SEPARATORS = { hyphen: '-', space: ' ', period: '.', underscore: '_', comma: ',' };

  function generatePassphrase(o, next) {
    let words = [];
    for (let i = 0; i < o.words; i++) words.push(WORDS[randomBelow(WORD_COUNT, next)]);
    if (o.cap) words = words.map((w) => w[0].toUpperCase() + w.slice(1));
    if (o.num) {
      const at = randomBelow(o.words, next);
      words[at] += String(randomBelow(10, next));
    }
    return words.join(SEPARATORS[o.sep] || '-');
  }

  // W words, each a uniform pick from 7,776: W * log2(7776), about 12.9 bits a word.
  // "Add a number" puts one uniform digit (10 choices) after one uniformly
  // chosen word (W choices): + log2(10 * W).
  // Separator and capitals are fixed choices, so they add nothing.
  // Every output string comes from exactly one set of picks: no word contains
  // a space, period, underscore, comma or digit, and the four hyphenated words
  // (drop-down, felt-tip, t-shirt, yo-yo) can't be split into two list words
  // ("drop", "felt", "t", "yo" aren't on the list). So these counts are exact.
  function passphraseBits(o) {
    return o.words * Math.log2(WORD_COUNT) + (o.num ? Math.log2(10 * o.words) : 0);
  }

  // ---- Strength in plain words ---------------------------------------------------------
  // Assumption, stated on the page: an offline attack (someone stole a database
  // of password hashes) trying 100 billion guesses a second. On average they
  // find it after trying half the possibilities, so time = 2^(bits-1) / rate.
  const RATE = 1e11;
  const YEAR = 365.25 * 86400;
  const UNIVERSE_YEARS = 13.8e9;
  function crackSeconds(bits) { return Math.pow(2, bits - 1) / RATE; }

  // A number in words, rounded to 2 significant figures: 4.5, 35 thousand,
  // 200 million. Past a quadrillion it returns "10^N" for setTimeText.
  function numberWords(n) {
    const r = Number(n.toPrecision(2));
    if (r >= 1e15) return '10^' + Math.floor(Math.log10(n));
    const scales = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
    for (const [v, w] of scales) if (r >= v) return `${Number((r / v).toPrecision(2))} ${w}`;
    return String(r);
  }
  function countOf(n, unit) {
    const w = numberWords(n);
    return `${w} ${unit}${w === '1' ? '' : 's'}`;
  }
  // Plain-words time. Huge values contain "10^N" for the caller to format.
  function plainTime(sec) {
    if (!isFinite(sec)) return 'longer than we can count';
    if (sec < 1) return 'less than a second';
    const units = [['month', YEAR / 12], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
    if (sec < YEAR) {
      for (const [u, len] of units) if (sec >= len) return 'about ' + countOf(sec / len, u);
    }
    const years = sec / YEAR;
    if (years < 1e10) return 'about ' + countOf(years, 'year');
    return `about ${numberWords(years / UNIVERSE_YEARS)} times the age of the universe`;
  }

  function strengthLevel(bits) {
    if (bits < 50) return ['weak', 'Weak'];
    if (bits < 70) return ['fair', 'Fair'];
    if (bits < 90) return ['strong', 'Strong'];
    return ['great', 'Very strong'];
  }

  // Writes "10^N" with a real superscript (and words for screen readers).
  function setTimeText(el, text) {
    el.textContent = '';
    el.removeAttribute('aria-label');
    const m = /^(.*)10\^(\d+)(.*)$/.exec(text);
    if (!m) { el.textContent = text; return; }
    const sup = document.createElement('sup');
    sup.textContent = m[2];
    el.append(m[1] + '10', sup, m[3]);
    el.setAttribute('aria-label', `${m[1]}10 to the power of ${m[2]}${m[3]}`);
  }

  // ---- Settings (never passwords) -------------------------------------------------------
  const SETTINGS_KEY = 'pwgen-settings';
  const DEFAULTS = {
    mode: 'password', length: 20, lower: true, upper: true, digits: true, symbols: true,
    avoid: false, require: true, words: 5, sep: 'hyphen', cap: false, num: false,
  };
  function loadSettings() {
    const s = { ...DEFAULTS };
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (raw.mode === 'password' || raw.mode === 'passphrase') s.mode = raw.mode;
      if (Number.isInteger(raw.length) && raw.length >= 8 && raw.length <= 128) s.length = raw.length;
      if (Number.isInteger(raw.words) && raw.words >= 3 && raw.words <= 15) s.words = raw.words;
      if (raw.sep in SEPARATORS) s.sep = raw.sep;
      for (const k of ['lower', 'upper', 'digits', 'symbols', 'avoid', 'require', 'cap', 'num']) {
        if (typeof raw[k] === 'boolean') s[k] = raw[k];
      }
    } catch (_) { /* private mode or bad JSON: use defaults */ }
    if (location.hash === '#passphrase') s.mode = 'passphrase';
    if (location.hash === '#password') s.mode = 'password';
    return s;
  }
  function saveSettings(s) {
    // Only these fields, by name, so a password can never sneak in.
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = s[k];
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (_) { /* ignore */ }
  }

  // ---- UI -------------------------------------------------------------------------------
  const out = $('pwOut');
  const msg = $('pwMsg');
  const btnCopy = $('copyBtn');
  const btnNew = $('newBtn');
  const btnTen = $('tenBtn');
  const list = $('pwList');
  const listWrap = $('listWrap');
  const s = loadSettings();
  let current = '';
  let batch = [];

  function readUi() {
    s.mode = document.querySelector('input[name="mode"]:checked').value;
    s.length = clampInt($('len').value, 8, 128, 20);
    for (const k of ['lower', 'upper', 'digits', 'symbols', 'avoid', 'require']) s[k] = $('o-' + k).checked;
    s.words = clampInt($('words').value, 3, 15, 5);
    s.sep = $('sep').value in SEPARATORS ? $('sep').value : 'hyphen';
    s.cap = $('o-cap').checked;
    s.num = $('o-num').checked;
  }
  function writeUi() {
    $('m-' + s.mode).checked = true;
    $('len').value = s.length; $('lenNum').value = s.length;
    for (const k of ['lower', 'upper', 'digits', 'symbols', 'avoid', 'require']) $('o-' + k).checked = s[k];
    $('words').value = s.words; $('wordsNum').value = s.words;
    $('sep').value = s.sep;
    $('o-cap').checked = s.cap;
    $('o-num').checked = s.num;
    $('pwOpts').hidden = s.mode !== 'password';
    $('ppOpts').hidden = s.mode !== 'passphrase';
    $('newLabel').textContent = s.mode === 'password' ? 'New password' : 'New passphrase';
  }
  function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
  }

  // Draw a password with digits and symbols tinted, so look-alikes are easier to tell apart.
  function paint(el, pw) {
    el.textContent = '';
    let run = '';
    let runKind = '';
    const flush = () => {
      if (!run) return;
      if (runKind) { const sp = document.createElement('span'); sp.className = runKind; sp.textContent = run; el.append(sp); }
      else el.append(run);
      run = '';
    };
    for (const ch of pw) {
      const kind = /[0-9]/.test(ch) ? 'c-dig' : /[A-Za-z]/.test(ch) ? '' : 'c-sym';
      if (kind !== runKind) { flush(); runKind = kind; }
      run += ch;
    }
    flush();
  }

  function makeOne(next) {
    return s.mode === 'password' ? generatePassword(s, next) : generatePassphrase(s, next);
  }
  function bitsNow() { return s.mode === 'password' ? passwordBits(s) : passphraseBits(s); }

  function showStrength(bits) {
    const sec = crackSeconds(bits);
    const [lvl, label] = strengthLevel(bits);
    const b = $('bits');
    b.textContent = bits.toFixed(1) + ' bits';
    b.dataset.bits = String(bits);
    $('strength').textContent = label;
    $('strength').className = 'st-label lvl-' + lvl;
    $('meter').className = 'meter lvl-' + lvl;
    $('meterFill').style.width = Math.min(100, Math.max(4, (bits / 128) * 100)) + '%';
    const crack = $('crack');
    crack.dataset.seconds = String(sec);
    setTimeText(crack, plainTime(sec));
  }

  function setEmpty(text) {
    current = '';
    out.textContent = '';
    out.classList.add('empty');
    out.dataset.empty = text;
    btnCopy.disabled = true;
    btnTen.disabled = true;
    $('bits').textContent = '0 bits';
    $('bits').dataset.bits = '0';
    $('strength').textContent = '';
    $('meterFill').style.width = '0%';
    $('crack').textContent = '';
    $('crack').dataset.seconds = '0';
    lol.setStatus(msg, text, 'err');
  }

  function generate() {
    readUi();
    writeUi();
    saveSettings(s);
    if (s.mode === 'password' && !pickedClasses(s).length) {
      setEmpty('Pick at least one kind of character.');
      hideList();
      return;
    }
    current = makeOne(randomSource());
    out.classList.remove('empty');
    paint(out, current);
    out.dataset.mode = s.mode;
    btnCopy.disabled = false;
    btnTen.disabled = false;
    showStrength(bitsNow());
    lol.setStatus(msg, '');
    // A batch made with old settings would no longer match the strength shown.
    if (!listWrap.hidden) makeTen();
  }

  function makeTen() {
    const next = randomSource();
    batch = [];
    for (let i = 0; i < 10; i++) batch.push(makeOne(next));
    list.textContent = '';
    batch.forEach((pw, i) => {
      const text = document.createElement('span');
      text.className = s.mode === 'passphrase' ? 'pw-text is-phrase' : 'pw-text';
      paint(text, pw);
      const b = lol.el('button', { type: 'button', class: 'mini-btn', 'data-i': String(i), 'aria-label': `Copy number ${i + 1}`, text: 'Copy' });
      list.append(lol.el('li', null, [text, b]));
    });
    listWrap.hidden = false;
    $('listNote').textContent = `Each one has the same strength as the one above: ${bitsNow().toFixed(1)} bits.`;
  }
  function hideList() { listWrap.hidden = true; list.textContent = ''; batch = []; }

  async function copyText(text, btn) {
    if (!text) return;
    let okCopy = false;
    try {
      await navigator.clipboard.writeText(text);
      okCopy = true;
    } catch (_) {
      // Older or locked-down browsers: copy through a hidden, temporary field.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.top = '0';
      document.body.append(ta);
      ta.select();
      try { okCopy = document.execCommand('copy'); } catch (_) { okCopy = false; }
      ta.value = '';
      ta.remove();
    }
    if (okCopy) {
      lol.setStatus(msg, 'Copied. Paste it where you need it.', 'ok');
      if (btn) {
        const label = btn.querySelector('.btn-label') || btn;
        const old = label.textContent;
        label.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => { label.textContent = old; btn.classList.remove('copied'); }, 1500);
      }
    } else {
      lol.setStatus(msg, "Your browser didn't allow copying. Select the text and copy it yourself.", 'err');
    }
  }

  // Wire up
  writeUi();
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { hideList(); generate(); }));
  const linkPair = (rangeId, numId) => {
    const r = $(rangeId), n = $(numId);
    r.addEventListener('input', () => { n.value = r.value; generate(); });
    n.addEventListener('input', () => {
      const v = parseInt(n.value, 10);
      if (Number.isFinite(v) && v >= +r.min && v <= +r.max) { r.value = v; generate(); }
    });
    n.addEventListener('change', () => { r.value = clampInt(n.value, +r.min, +r.max, +r.value); n.value = r.value; generate(); });
  };
  linkPair('len', 'lenNum');
  linkPair('words', 'wordsNum');
  for (const id of ['o-lower', 'o-upper', 'o-digits', 'o-symbols', 'o-avoid', 'o-require', 'o-cap', 'o-num', 'sep']) {
    $(id).addEventListener('change', generate);
  }
  btnNew.addEventListener('click', generate);
  btnTen.addEventListener('click', makeTen);
  btnCopy.addEventListener('click', () => copyText(current, btnCopy));
  $('hideList').addEventListener('click', hideList);
  list.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) copyText(batch[+b.dataset.i], b);
  });

  generate();

  // ---- Rough checker for a password you already have ------------------------------------
  // Plain heuristics, no library. It's a rough guess and the page says so.
  // Model: the cheapest way an attacker could describe the password, in bits.
  //  - A lone character costs log2(size of the character kinds the password uses).
  //  - A run of 3+ of the same character, or 3+ in a row on the alphabet or
  //    keyboard (abc, 321, qwer), costs one character plus a few bits.
  //  - A word on our short common-password list costs 10 bits (11 with
  //    l33t swaps), a word from the EFF list 12.9 (13.9 with swaps), a year
  //    1950 to 2039 about 6.5. Capitals in a word add 1 bit.
  //  - A word separator (space - _ . , /) costs 3 bits the first time and
  //    1 bit when it repeats, since attackers try word-sep-word patterns.
  // We take the cheapest split (dynamic programming), so "password1" scores
  // low and a random-looking string scores high. Real attackers do better.
  const COMMON = ('password passwd qwerty qwertyuiop asdfgh asdfghjkl zxcvbn letmein welcome admin administrator ' +
    'login iloveyou monkey dragon master sunshine princess football baseball soccer hockey shadow superman batman ' +
    'trustno1 abc123 123456 12345678 123456789 1234567890 111111 000000 654321 666666 121212 123123 112233 ' +
    'hello freedom whatever charlie michael jordan jennifer hunter buster killer pepper ginger cookie summer winter ' +
    'secret google apple computer internet starwars pokemon minecraft cheese chocolate flower lovely angel baby ' +
    'family money guest default changeme access passport mustang ferrari harley ranger thomas robert daniel andrew ' +
    'joshua matthew ashley jessica amanda nicole purple orange banana monday friday yankees lakers cowboys eagles ' +
    'tigers love test user pass qazwsx 1q2w3e4r zaq12wsx').split(' ');
  const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
  const deLeet = (str) => str.replace(/[0134579@$!]/g, (c) => LEET[c] || c);
  const commonSet = new Set(COMMON);
  const commonLeet = new Set(COMMON.filter((w) => /[a-z]/.test(w)).map(deLeet));
  const effSet = new Set(WORDS);
  const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', "asdfghjkl;'", 'zxcvbnm,./', 'abcdefghijklmnopqrstuvwxyz'];

  // +1 or -1 if b follows a on the alphabet, digits or a keyboard row, else 0.
  function stepDir(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    if (/[a-z0-9]/.test(a) && /[a-z0-9]/.test(b)) {
      const d = b.charCodeAt(0) - a.charCodeAt(0);
      if (d === 1 || d === -1) return d;
    }
    for (const r of ROWS) {
      const i = r.indexOf(a), j = r.indexOf(b);
      if (i >= 0 && j >= 0 && Math.abs(i - j) === 1) return j - i;
    }
    return 0;
  }

  function roughCheck(pw) {
    const chars = Array.from(pw);
    const n = chars.length;
    let pool = 0;
    const has = {
      lower: /[a-z]/.test(pw), upper: /[A-Z]/.test(pw), digit: /[0-9]/.test(pw),
      symbol: /[ !-\/:-@\[-`{-~]/.test(pw), other: /[^\x20-\x7e]/.test(pw),
    };
    if (has.lower) pool += 26;
    if (has.upper) pool += 26;
    if (has.digit) pool += 10;
    if (has.symbol) pool += 33;
    if (has.other) pool += 100;
    const per = Math.log2(Math.max(pool, 2));
    // Cost of each lone character. Separators are cheap: see the notes above.
    const lone = chars.map((c, i) => {
      if (!' -_.,/'.includes(c)) return per;
      return Math.min(per, chars.slice(0, i).includes(c) ? 1 : 3);
    });
    const lowerChars = chars.map((c) => c.toLowerCase());
    const best = new Array(n + 1).fill(Infinity);
    const step = new Array(n + 1).fill(null); // how we reached each position: { len, kind }
    const offer = (start, end, cost, kind) => {
      if (best[start] + cost < best[end]) { best[end] = best[start] + cost; step[end] = { len: end - start, kind }; }
    };
    best[0] = 0;
    for (let end = 1; end <= n; end++) {
      offer(end - 1, end, lone[end - 1], null);
      // Repeats (aaa) and runs (abc, 987, qwer) ending here.
      for (let start = end - 3; start >= 0; start--) {
        const seg = chars.slice(start, end);
        const same = seg.every((c) => c === seg[0]);
        const d = stepDir(seg[0], seg[1]);
        const run = d !== 0 && seg.every((c, i) => i === 0 || stepDir(seg[i - 1], c) === d);
        if (!same && !run) break;
        offer(start, end, lone[start] + (same ? 1 : 2) + Math.log2(end - start), same ? 'repeat' : 'run');
      }
      for (let len = 3; len <= Math.min(15, end); len++) {
        const start = end - len;
        const piece = lowerChars.slice(start, end).join('');
        const plain = deLeet(piece);
        const leet = plain !== piece ? 1 : 0;
        const caps = chars.slice(start, end).join('') !== piece ? 1 : 0;
        if (commonSet.has(piece)) offer(start, end, 10 + caps, 'common');
        else if (leet && /[a-z]/.test(plain) && commonLeet.has(plain)) offer(start, end, 10 + leet + caps, 'common');
        else if (effSet.has(piece) || (/[a-z]/.test(plain) && effSet.has(plain))) offer(start, end, Math.log2(WORD_COUNT) + leet + caps, 'word');
        else if (len === 4 && /^(19[5-9]\d|20[0-3]\d)$/.test(piece)) offer(start, end, Math.log2(90), 'year');
      }
    }
    // Walk back along the cheapest split to see which shortcuts it used.
    const notes = new Set();
    for (let e = n; e > 0; e -= step[e].len) if (step[e].kind) notes.add(step[e].kind);
    if (n < 12) notes.add('short');
    if (has.lower && !has.upper && !has.digit && !has.symbol && !has.other) notes.add('lowerOnly');
    return { bits: best[n], notes: Array.from(notes) };
  }

  const NOTE_TEXT = {
    common: 'It contains a very common password or word. Those get tried first.',
    word: 'It contains dictionary words. Attackers try word lists, so each word counts as one guess from a list, not as separate letters.',
    year: 'It contains a year. Years are among the first things attackers try.',
    run: 'It has a run like abc, 123 or qwerty, which is easy to guess.',
    repeat: 'It repeats the same character three or more times in a row.',
    short: 'It\'s under 12 characters. Longer is the easiest way to get stronger.',
    lowerOnly: 'It only uses lowercase letters.',
  };

  const chk = $('chkInput');
  function runCheck() {
    const pw = chk.value;
    const res = $('chkResult');
    if (!pw) { res.hidden = true; return; }
    const { bits, notes } = roughCheck(pw);
    const [lvl, label] = strengthLevel(bits);
    res.hidden = false;
    $('chkBits').textContent = `about ${Math.round(bits)} bits`;
    $('chkBits').dataset.bits = String(bits);
    $('chkLabel').textContent = label;
    $('chkLabel').className = 'st-label lvl-' + lvl;
    $('chkMeter').className = 'meter lvl-' + lvl;
    $('chkMeterFill').style.width = Math.min(100, Math.max(4, (bits / 128) * 100)) + '%';
    setTimeText($('chkCrack'), plainTime(crackSeconds(bits)));
    const ul = $('chkNotes');
    ul.textContent = '';
    for (const k of notes) ul.append(lol.el('li', { text: NOTE_TEXT[k] }));
  }
  chk.addEventListener('input', runCheck);
  $('chkShow').addEventListener('change', () => { chk.type = $('chkShow').checked ? 'text' : 'password'; });
})();
