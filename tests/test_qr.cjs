// Real-Chrome functional test for qr-code.lol. Every downloaded PNG is decoded
// by zbarimg (independent of the page's own jsQR self-check).
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = '/tmp/loltest/out/qr/';
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2];
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`); };
const zbar = (f) => { try { return execSync(`zbarimg --raw -q -Sbinary "${f}"`).toString().replace(/\n$/, ''); } catch (e) { return null; } };

(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: 'load' });
  const loadReqs = requests.length;

  const setType = (t) => page.click(`label[for=t-${t}]`);
  const waitCheck = async () => { await page.waitForTimeout(400); return (await page.textContent('#qrCheck')).trim(); };
  async function grab(tag, fmt = 'png') {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(fmt === 'png' ? '#dlPng' : '#dlSvg')]);
    const f = OUT + tag + '-' + d.suggestedFilename();
    await d.saveAs(f);
    return f;
  }

  const cases = [
    { t: 'url', tag: 'url', fill: { '#f-url': 'example.com/menu?table=4' }, expect: 'https://example.com/menu?table=4' },
    { t: 'url', tag: 'url-unicode', fill: { '#f-url': 'https://例え.jp/café?q=naïve 🎉' }, expect: 'https://例え.jp/café?q=naïve 🎉' },
    { t: 'text', tag: 'text', fill: { '#f-text': 'Line one\nLine two: ümlaut, emoji 🍕, quote "x"' }, expect: 'Line one\nLine two: ümlaut, emoji 🍕, quote "x"' },
    { t: 'wifi', tag: 'wifi', fill: { '#f-ssid': 'Chiara;Net:5G', '#f-pass': 'p@ss;word,"x"\\' }, expect: 'WIFI:T:WPA;S:Chiara\\;Net\\:5G;P:p@ss\\;word\\,\\"x\\"\\\\;;' },
    { t: 'vcard', tag: 'vcard', fill: { '#f-first': 'Ada', '#f-last': 'Lovelace', '#f-org': 'Analytical, Inc.', '#f-vphone': '+1 423 555 0100', '#f-vemail': 'ada@example.com' },
      expectFn: (s) => s.startsWith('BEGIN:VCARD') && s.includes('FN:Ada Lovelace') && s.includes('ORG:Analytical\\, Inc.') && s.includes('TEL;TYPE=CELL:+1 423 555 0100') && s.trim().endsWith('END:VCARD') },
    { t: 'email', tag: 'email', fill: { '#f-to': 'hi@example.com', '#f-subj': 'Hello there', '#f-body': 'A & B?' }, expect: 'mailto:hi@example.com?subject=Hello%20there&body=A%20%26%20B%3F' },
    { t: 'tel', tag: 'tel', fill: { '#f-tel': '+1 (423) 555-0100' }, expect: 'tel:+14235550100' },
  ];
  for (const c of cases) {
    await setType(c.t);
    for (const [sel, val] of Object.entries(c.fill)) await page.fill(sel, val);
    const chk = await waitCheck();
    ok(`${c.tag}: page self-check passes`, /Test scan passed/.test(chk), chk);
    const f = await grab(c.tag);
    const got = zbar(f);
    const pass = c.expectFn ? got && c.expectFn(got) : got === c.expect;
    ok(`${c.tag}: zbar decodes exactly`, pass, JSON.stringify(got).slice(0, 160));
    if (c.tag === 'url') ok('url: filename uses hostname', /qr-example\.com\.png$/.test(f), f.split('/').pop());
  }

  // SVG: rasterize and decode
  await setType('url');
  await page.fill('#f-url', 'https://qr-code.lol/svg-test');
  await waitCheck();
  const svg = await grab('svg', 'svg');
  execSync(`magick -density 300 "${svg}" -background white -flatten "${svg}.png"`);
  ok('svg: rasterized SVG decodes', zbar(svg + '.png') === 'https://qr-code.lol/svg-test', zbar(svg + '.png'));

  // Size option
  await page.click('.style-opts summary');
  await page.selectOption('#f-size', '2048');
  await page.waitForTimeout(300);
  const big = await grab('big');
  const dims = execSync(`magick identify -format "%w %h" "${big}"`).toString();
  const w = parseInt(dims, 10);
  ok('size: 2048 option gives ~2048 px PNG', w > 1900 && w <= 2048, dims);
  await page.selectOption('#f-size', '1024');

  // Color contrast warnings
  await page.evaluate(() => { const f = document.getElementById('f-fg'); f.value = '#bbbbbb'; f.dispatchEvent(new Event('input', { bubbles: true })); });
  let chk = await waitCheck();
  ok('low contrast warns or fails', /contrast is low|failed/.test(chk), chk);
  await page.evaluate(() => {
    const f = document.getElementById('f-fg'); f.value = '#ffffff'; f.dispatchEvent(new Event('input', { bubbles: true }));
    const g = document.getElementById('f-bg'); g.value = '#000000'; g.dispatchEvent(new Event('input', { bubbles: true }));
  });
  chk = await waitCheck();
  ok('inverted colors warn', /Light code on dark/.test(chk), chk);
  const inv = await grab('inverted');
  execSync(`magick "${inv}" -negate "${inv}.neg.png"`);
  ok('inverted PNG decodes after negate', zbar(inv + '.neg.png') === 'https://qr-code.lol/svg-test');
  await page.evaluate(() => {
    const f = document.getElementById('f-fg'); f.value = '#1d3557'; f.dispatchEvent(new Event('input', { bubbles: true }));
    const g = document.getElementById('f-bg'); g.value = '#ffffff'; g.dispatchEvent(new Event('input', { bubbles: true }));
  });
  chk = await waitCheck();
  ok('dark navy on white passes', /Test scan passed/.test(chk), chk);
  const navy = await grab('navy');
  ok('navy PNG decodes', zbar(navy) === 'https://qr-code.lol/svg-test');

  // Damage tolerance H decodes
  await page.selectOption('#f-ec', 'H');
  chk = await waitCheck();
  const h = await grab('ec-h');
  ok('EC level H decodes', zbar(h) === 'https://qr-code.lol/svg-test', chk);

  // Too long
  await setType('text');
  await page.fill('#f-text', 'x'.repeat(4000));
  chk = await waitCheck();
  ok('too much data shows a plain message', /too much to fit/.test(chk) && await page.isDisabled('#dlPng'), chk);

  // Empty state
  await page.fill('#f-text', '');
  await page.waitForTimeout(400);
  ok('empty input disables downloads', await page.isDisabled('#dlPng') && await page.isDisabled('#dlSvg'));

  // Deep link
  await page.goto(base + '#wifi', { waitUntil: 'load' });
  ok('deep link #wifi opens Wi-Fi form', await page.isVisible('#f-ssid'));

  ok('no network requests after page load', requests.filter((u) => !u.startsWith(base)).length === 0 && requests.length <= loadReqs * 2, `${loadReqs} at load, ${requests.length} total (incl. 1 reload)`);
  ok('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
