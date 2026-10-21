// Real-Chrome functional test for vid2gif.lol (KEY=video).
// Usage: node tests/video/test.cjs http://127.0.0.1:18826/
// Needs: ffmpeg + ffprobe + magick on PATH, uv (for numpy FFT), Playwright at /tmp/loltest.
const { chromium } = require('/tmp/loltest/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const makeFixtures = require('./fixtures.cjs');

const ROOT = path.resolve(__dirname, '../..');
const FX = path.join(ROOT, '_work/video/fixtures');
const OUT = path.join(ROOT, '_work/video/out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const base = process.argv[2] || 'http://127.0.0.1:18826/';
const origin = new URL(base).origin;

const results = [];
const timings = {};
const ok = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== '' ? '  :: ' + detail : ''}`);
};
const sh = (cmd) => execSync(cmd, { maxBuffer: 1 << 28 }).toString().trim();
const shq = (cmd) => { try { return sh(cmd + ' 2>&1'); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } };
const probe = (f) => JSON.parse(sh(`ffprobe -v error -count_frames -show_entries stream=codec_name,width,height,nb_read_frames,sample_rate,channels,bit_rate:format=duration,format_name,bit_rate -of json "${f}"`));
const rmse = (a, b) => parseFloat((/\(([\d.e-]+)\)/.exec(shq(`magick compare -metric RMSE "${a}" "${b}" null:`)) || [])[1]);
const means = (f) => sh(`magick "${f}" -format "%[fx:mean.r*255] %[fx:mean.g*255] %[fx:mean.b*255]" info:`).split(' ').map(Number);

// Peak frequency of an audio file: ffmpeg decodes to raw float, numpy does the FFT.
function peakHz(file) {
  const raw = path.join(OUT, path.basename(file) + '.f32');
  sh(`ffmpeg -v error -y -i "${file}" -ac 1 -ar 44100 -f f32le "${raw}"`);
  const py = path.join(OUT, 'peak.py');
  fs.writeFileSync(py, [
    'import sys, numpy as np',
    'x = np.fromfile(sys.argv[1], dtype=np.float32)',
    'x = x[int(0.25*44100):]  # skip the start',
    'n = min(len(x), 44100*2)',
    'x = x[:n] * np.hanning(n)',
    's = np.abs(np.fft.rfft(x)); f = np.fft.rfftfreq(n, 1/44100)',
    'k = int(np.argmax(s)); top = s[k]; rest = np.sort(s)[-40] if len(s) > 40 else 0',
    'rms = float(np.sqrt(np.mean(np.fromfile(sys.argv[1], dtype=np.float32)**2)))',
    'print(f"{f[k]:.2f} {rms:.4f} {top/ max(np.median(s),1e-9):.1f}")',
  ].join('\n'));
  const [hz, rms, snr] = sh(`uv run -q --with numpy python "${py}" "${raw}"`).split(/\s+/).map(Number);
  return { hz, rms, snr };
}

(async () => {
  const F = makeFixtures(FX);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const requests = [];
  const pageErrors = [];
  const consoleErrors = [];
  page.on('request', (r) => requests.push(r.url()));
  ctx.on('request', (r) => { if (!requests.includes(r.url())) requests.push(r.url()); }); // includes workers
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('worker', (w) => w.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[worker] ' + m.text()); }));

  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__videoReady === true, null, { timeout: 30000 });

  // ---- The privacy promise ----------------------------------------------------
  const exampleBlocked = await page.evaluate(async () => {
    try { await fetch('https://example.com/', { mode: 'no-cors' }); return false; } catch (_) { return true; }
  });
  ok('fetch("https://example.com/") from the page is blocked', exampleBlocked);
  const cspMeta = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  ok('CSP: connect-src none, no unsafe-eval', /connect-src 'none'/.test(cspMeta) && !/'unsafe-eval'/.test(cspMeta), cspMeta.match(/script-src[^;]*/)[0]);
  const rawHtml = await new Promise((res, rej) => require(base.startsWith('https') ? 'https' : 'http').get(base, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36' } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res(d)); }).on('error', rej));
  const top = rawHtml.slice(0, rawHtml.indexOf('<html'));
  ok('view-source comment lists what loads and says nothing is uploaded', /never uploaded/.test(top) && /lame-mp3-wasm\.js/.test(top) && /connect-src 'none'/.test(top));

  const status = () => page.textContent('#status');
  const loadMsg = () => page.textContent('#loadStatus');
  const waitResult = (sel) => page.waitForSelector(`${sel}:not([hidden]), #status.err`, { timeout: 180000 });
  async function open(file) {
    await page.setInputFiles('#fileInput', file);
    // Done when this file's name is showing (or an error is).
    await page.waitForFunction((name) => {
      const s = document.getElementById('loadStatus');
      return s.classList.contains('err') || (!document.getElementById('editor').hidden && document.getElementById('fileName').textContent === name);
    }, path.basename(file), { timeout: 60000 });
  }
  async function setTrim(a, b) {
    await page.fill('#start', String(a));
    await page.fill('#end', String(b));
    await page.dispatchEvent('#end', 'input');
  }
  async function save(btn, name) {
    const [d] = await Promise.all([page.waitForEvent('download'), page.click(btn)]);
    const f = path.join(OUT, name || d.suggestedFilename());
    await d.saveAs(f);
    return { f, suggested: d.suggestedFilename() };
  }
  async function makeGif() {
    const t = Date.now();
    await page.click('#gifBtn');
    await waitResult('#gifOut');
    return { wall: Date.now() - t, ms: +(await page.getAttribute('#gifOut', 'data-ms')), err: await page.$('#status.err') ? await status() : null };
  }
  async function makeMp3() {
    const t = Date.now();
    await page.click('#mp3Btn');
    await waitResult('#mp3Out');
    return { wall: Date.now() - t, ms: +(await page.getAttribute('#mp3Out', 'data-ms')), path: await page.getAttribute('#mp3Out', 'data-path'), err: await page.$('#status.err') ? await status() : null };
  }
  const mode = (m) => page.click(`label[for=mode-${m}]`);

  // ---- Wrong inputs -----------------------------------------------------------
  await page.setInputFiles('#fileInput', F.png);
  await page.waitForSelector('#loadStatus.err');
  ok('picture file: plain message', /is a picture, not a video/.test(await loadMsg()), await loadMsg());
  await page.setInputFiles('#fileInput', F.txt);
  await page.waitForFunction(() => /doesn't look like a video/.test(document.getElementById('loadStatus').textContent));
  ok('text file: plain message', true, await loadMsg());
  await page.setInputFiles('#fileInput', F.empty);
  await page.waitForFunction(() => /empty/.test(document.getElementById('loadStatus').textContent));
  ok('empty file: plain message', true, await loadMsg());
  await page.setInputFiles('#fileInput', F.fakeMp4);
  await page.waitForFunction(() => /can't play/.test(document.getElementById('loadStatus').textContent), null, { timeout: 40000 });
  ok('damaged MP4: plain message', true, await loadMsg());
  ok('editor stays hidden after bad files', await page.$eval('#editor', (e) => e.hidden));

  // ---- Main clip: GIF 1-4 s, 480 px, 15 fps ----------------------------------
  await open(F.sine);
  ok('sine.mp4 opens', !(await page.$('#loadStatus.err')), await page.textContent('#fileMeta'));
  await mode('gif');
  await setTrim(1, 4);
  await page.selectOption('#width', '480');
  await page.click('label[for=fps-15]');
  ok('clip note shows length/frames/size', /3\.0 s · 45 frames · 480 × 270 px/.test(await page.textContent('#clipNote')), await page.textContent('#clipNote'));
  const g1 = await makeGif();
  timings.gif_720p_3s_480w_15fps_ms = g1.ms;
  ok('GIF made', !g1.err, g1.err || (await status()));
  const shownSize = await page.textContent('#gifMeta');
  const gif1 = await save('#gifSave');
  ok('GIF filename', gif1.suggested === 'sine.gif', gif1.suggested);
  const p1 = probe(gif1.f);
  const s1 = p1.streams[0];
  ok('ffprobe: it is a GIF', s1.codec_name === 'gif' && /gif/.test(p1.format.format_name), `${s1.codec_name} / ${p1.format.format_name}`);
  ok('ffprobe: 480 × 270', s1.width === 480 && s1.height === 270, `${s1.width}x${s1.height}`);
  ok('ffprobe: ~45 frames (15 fps × 3 s)', Math.abs(+s1.nb_read_frames - 45) <= 1, s1.nb_read_frames);
  ok('ffprobe: ~3 s long', Math.abs(+p1.format.duration - 3) <= 0.1, p1.format.duration);
  const magickFrames = +sh(`magick identify -format "%n\\n" "${gif1.f}" | head -1`);
  ok('magick agrees on frame count', magickFrames === +s1.nb_read_frames, magickFrames);
  ok('page shows the real file size', shownSize.includes(await page.evaluate((n) => window.lol.formatBytes(n), fs.statSync(gif1.f).size)), `${shownSize} vs ${fs.statSync(gif1.f).size} B`);

  // Frame 22 of the GIF is t = 1 + 22/15 = 2.4667 s, which is source frame 74 at 30 fps.
  sh(`magick "${gif1.f}" -coalesce "${OUT}/g1-%d.png"`);
  const grab = (n, out) => sh(`ffmpeg -v error -y -i "${F.sine}" -vf "select=eq(n\\,${n}),scale=480:270:flags=bicubic" -fps_mode passthrough -frames:v 1 "${out}"`);
  grab(74, `${OUT}/src-74.png`); grab(73, `${OUT}/src-73.png`); grab(75, `${OUT}/src-75.png`);
  const r74 = rmse(`${OUT}/src-74.png`, `${OUT}/g1-22.png`);
  const r73 = rmse(`${OUT}/src-73.png`, `${OUT}/g1-22.png`);
  const r75 = rmse(`${OUT}/src-75.png`, `${OUT}/g1-22.png`);
  ok('middle frame matches the ffmpeg source frame (RMSE < 0.05)', r74 < 0.05, `RMSE ${r74.toFixed(4)}`);
  ok('...and it is the right moment (closer than the frames either side)', r74 < r73 * 0.6 && r74 < r75 * 0.6, `prev ${r73.toFixed(4)}, this ${r74.toFixed(4)}, next ${r75.toFixed(4)}`);
  const mA = means(`${OUT}/src-74.png`), mB = means(`${OUT}/g1-22.png`);
  const shift = Math.max(...mA.map((v, i) => Math.abs(v - mB[i])));
  ok('no color shift (mean R/G/B within 4 of 255)', shift < 4, `src ${mA.map((v) => v.toFixed(1))} gif ${mB.map((v) => v.toFixed(1))}`);
  // First and last frames line up with the trim points too.
  grab(30, `${OUT}/src-30.png`); grab(118, `${OUT}/src-118.png`);
  const rFirst = rmse(`${OUT}/src-30.png`, `${OUT}/g1-0.png`), rLast = rmse(`${OUT}/src-118.png`, `${OUT}/g1-44.png`);
  ok('first frame is t = 1.0 s and last is t = 3.933 s', rFirst < 0.05 && rLast < 0.05, `first ${rFirst.toFixed(4)}, last ${rLast.toFixed(4)}`);
  sh(`magick "${OUT}/src-74.png" "${OUT}/g1-22.png" -append "${OUT}/compare-frame22.png"`);

  // ---- MP3 at 192 kbps --------------------------------------------------------
  await mode('mp3');
  ok('trim boxes hide for a whole-track MP3', await page.$eval('#trimBox', (e) => e.hidden));
  await page.click('label[for=kbps-192]');
  const m1 = await makeMp3();
  timings.mp3_6s_192k_ms = m1.ms;
  ok('MP3 made (MP4: read in pieces with WebCodecs)', !m1.err && m1.path === 'webcodecs', m1.err || m1.path);
  const mp31 = await save('#mp3Save');
  const pm = probe(mp31.f);
  const srcDur = +sh(`ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${F.sine}"`);
  ok('ffprobe: codec mp3', pm.streams[0].codec_name === 'mp3', pm.streams[0].codec_name);
  ok('ffprobe: 192 kbps', +pm.streams[0].bit_rate === 192000, pm.streams[0].bit_rate);
  ok('duration within 0.2 s of the source', Math.abs(+pm.format.duration - srcDur) <= 0.2, `${pm.format.duration} vs ${srcDur}`);
  const pk1 = peakHz(mp31.f);
  ok('1 kHz tone is there (numpy FFT peak)', Math.abs(pk1.hz - 1000) <= 3 && pk1.rms > 0.05, `peak ${pk1.hz} Hz, rms ${pk1.rms}, peak/median ${pk1.snr}`);
  // Trimmed MP3
  await page.check('#mp3Trim');
  await setTrim(1, 4);
  const m2 = await makeMp3();
  const mp32 = await save('#mp3Save', 'sine-1to4.mp3');
  const pm2 = probe(mp32.f);
  ok('trimmed MP3 (1 to 4 s) is 3 s long', !m2.err && Math.abs(+pm2.format.duration - 3) <= 0.1, pm2.format.duration);
  await page.uncheck('#mp3Trim');
  await page.click('label[for=kbps-320]');
  await makeMp3();
  const mp33 = await save('#mp3Save', 'sine-320.mp3');
  ok('320 kbps option works', +probe(mp33.f).streams[0].bit_rate === 320000, probe(mp33.f).streams[0].bit_rate);
  await page.click('label[for=kbps-192]');

  // ---- No audio track ---------------------------------------------------------
  await open(F.noaudio);
  await mode('mp3');
  await page.waitForFunction(() => /no audio track/.test(document.getElementById('audioNote').textContent), null, { timeout: 20000 });
  ok('MP4 with no sound: plain "no audio track" message', true, await page.textContent('#audioNote'));
  ok('...and the MP3 button is off', await page.$eval('#mp3Btn', (b) => b.disabled));
  await open(F.webmSilent);
  await mode('mp3');
  await page.waitForFunction(() => /no audio track/.test(document.getElementById('audioNote').textContent), null, { timeout: 20000 });
  ok('WebM with no sound: same message', true, await page.textContent('#audioNote'));

  // ---- WebM (VP9 + Opus) -------------------------------------------------------
  await open(F.webm);
  await mode('gif');
  await setTrim(0, 3);
  await page.selectOption('#width', '320');
  await page.click('label[for=fps-10]');
  const g2 = await makeGif();
  timings.gif_webm_3s_320w_10fps_ms = g2.ms;
  const gif2 = await save('#gifSave');
  const p2 = probe(gif2.f).streams[0];
  ok('WebM to GIF: 320 px wide, 30 frames', !g2.err && p2.width === 320 && p2.height === 180 && Math.abs(+p2.nb_read_frames - 30) <= 1, `${p2.width}x${p2.height}, ${p2.nb_read_frames} frames`);
  await mode('mp3');
  const m3 = await makeMp3();
  timings.mp3_webm_4s_ms = m3.ms;
  const mp34 = await save('#mp3Save');
  const pw = probe(mp34.f);
  const pkw = peakHz(mp34.f);
  ok('WebM to MP3 (Web Audio path): mp3, ~4 s, 1 kHz', !m3.err && m3.path === 'webaudio' && pw.streams[0].codec_name === 'mp3' && Math.abs(+pw.format.duration - 4) <= 0.2 && Math.abs(pkw.hz - 1000) <= 3,
    `${m3.path}, ${pw.format.duration} s, ${pkw.hz} Hz`);

  // ---- iPhone-style portrait HEVC MOV -----------------------------------------
  await open(F.iphone);
  const iphoneErr = await page.$('#loadStatus.err');
  ok('portrait HEVC MOV opens in Chrome', !iphoneErr, iphoneErr ? await loadMsg() : await page.textContent('#fileMeta'));
  if (!iphoneErr) {
    await mode('gif');
    await setTrim(1, 3);
    await page.selectOption('#width', '480');
    await page.click('label[for=fps-15]');
    const g3 = await makeGif();
    timings.gif_hevc_portrait_2s_480w_ms = g3.ms;
    const gif3 = await save('#gifSave');
    const p3 = probe(gif3.f).streams[0];
    ok('portrait GIF comes out upright (480 × 853)', !g3.err && p3.width === 480 && p3.height === 853, `${p3.width}x${p3.height}`);
    sh(`magick "${gif3.f}" -coalesce "${OUT}/g3-%d.png"`);
    // GIF frame 15 = t 2.0 s = source frame 60; ffmpeg applies the rotation flag itself.
    sh(`ffmpeg -v error -y -i "${F.iphone}" -vf "select=eq(n\\,60),scale=480:853:flags=bicubic" -fps_mode passthrough -frames:v 1 "${OUT}/srcp-60.png"`);
    const rp = rmse(`${OUT}/srcp-60.png`, `${OUT}/g3-15.png`);
    ok('portrait frame matches the rotated source (RMSE < 0.05)', rp < 0.05, rp.toFixed(4));
    await mode('mp3');
    const m4 = await makeMp3();
    const mp35 = await save('#mp3Save');
    const pi = probe(mp35.f);
    const pki = peakHz(mp35.f);
    ok('MOV to MP3: stereo 44.1 kHz, 5 s, 1 kHz', !m4.err && pi.streams[0].channels === 2 && +pi.streams[0].sample_rate === 44100 && Math.abs(+pi.format.duration - 5) <= 0.2 && Math.abs(pki.hz - 1000) <= 3,
      `${m4.path}, ${pi.streams[0].channels} ch, ${pi.streams[0].sample_rate} Hz, ${pi.format.duration} s, ${pki.hz} Hz`);
  }

  // ---- Long clip: warnings, cap, progress + estimate, Stop, long MP3 ---------
  await open(F.long);
  await mode('gif');
  await page.selectOption('#width', 'orig');
  await setTrim(0, 20);
  ok('over 15 s: plain size warning', /GIFs over 15 s get huge/.test(await page.textContent('#clipNote')) && !(await page.$eval('#gifBtn', (b) => b.disabled)), await page.textContent('#clipNote'));
  await setTrim(0, 65);
  ok('over 60 s: refused with a reason', /max out at 60 s/.test(await page.textContent('#clipNote')) && (await page.$eval('#gifBtn', (b) => b.disabled)), await page.textContent('#clipNote'));
  await setTrim(5, 2);
  ok('end before start: plain message', /End has to come after start/.test(await page.textContent('#clipNote')));
  await setTrim(0, 50);
  await page.click('label[for=fps-20]');
  await page.click('#gifBtn');
  const seen = [];
  let widthSeen = 0;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const s = await status();
    if (!seen.includes(s)) seen.push(s);
    widthSeen = Math.max(widthSeen, await page.$eval('#progress > span', (e) => parseFloat(e.style.width) || 0));
    if (/left|almost done/.test(s) && widthSeen > 5) break;
  }
  const withEta = seen.find((s) => /left|almost done/.test(s));
  ok('progress bar moves and shows a time estimate', widthSeen > 0 && !!withEta, `${widthSeen.toFixed(1)}% · "${withEta || seen.slice(-1)[0]}"`);
  await page.click('#cancelBtn');
  await page.waitForFunction(() => /Stopped/.test(document.getElementById('status').textContent), null, { timeout: 10000 });
  ok('Stop works', true, await status());
  ok('controls come back after Stop', !(await page.$eval('#gifBtn', (b) => b.disabled)));
  await mode('mp3');
  await page.click('label[for=kbps-128]');
  const m5 = await makeMp3();
  timings.mp3_70s_stereo_128k_ms = m5.ms;
  const mp36 = await save('#mp3Save');
  const pl = probe(mp36.f);
  ok('70 s stereo MP3 at 128 kbps: right length and channels', !m5.err && Math.abs(+pl.format.duration - 70) <= 0.2 && pl.streams[0].channels === 2 && +pl.streams[0].bit_rate === 128000,
    `${pl.format.duration} s, ${pl.streams[0].channels} ch, ${pl.streams[0].bit_rate} bps`);
  // A bigger GIF for the timing record: 10 s, 640 px wide source of 320 (stays 320), 15 fps
  await mode('gif');
  await page.selectOption('#width', '480');
  await setTrim(10, 20);
  await page.click('label[for=fps-15]');
  const g4 = await makeGif();
  timings.gif_10s_320w_15fps_ms = g4.ms;
  const gif4 = await save('#gifSave', 'long-10s.gif');
  const p4 = probe(gif4.f);
  ok('10 s GIF: 150 frames, ~10 s', Math.abs(+p4.streams[0].nb_read_frames - 150) <= 1 && Math.abs(+p4.format.duration - 10) <= 0.1, `${p4.streams[0].nb_read_frames} frames, ${p4.format.duration} s, ${fs.statSync(gif4.f).size} B`);

  // ---- Screenshots ------------------------------------------------------------
  await open(F.sine);
  await mode('gif');
  await setTrim(1, 4);
  await page.selectOption('#width', '480');
  await page.click('label[for=fps-15]');
  await makeGif();
  await page.screenshot({ path: path.join(OUT, 'desktop-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 430, height: 932 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no sideways scrolling at 430 px', overflow <= 0, `${overflow}px extra`);
  await page.screenshot({ path: path.join(OUT, 'mobile-430.png'), fullPage: true });
  await page.goto(base);
  await page.waitForFunction(() => window.__videoReady === true);
  await page.screenshot({ path: path.join(OUT, 'mobile-430-empty.png'), fullPage: false });

  // ---- Network + errors -------------------------------------------------------
  const bad = requests.filter((u) => !(u.startsWith(origin + '/') || u.startsWith('blob:') || u.startsWith('data:')));
  ok('every request is same-origin, blob: or data:', bad.length === 0, bad.length ? bad.join(', ') : `${requests.length} requests, e.g. ${[...new Set(requests.map((u) => u.replace(/\?.*$/, '').replace(/blob:.*/, 'blob:…')))].slice(0, 14).join(' ')}`);
  const csp = await page.evaluate(() => window.__csp);
  const unexpectedErrors = consoleErrors.filter((t) => !/example\.com/.test(t) && !/Failed to load resource/.test(t));
  ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  ok('no console errors or CSP violations (other than the example.com probe)', unexpectedErrors.length === 0 && csp.every((v) => /example\.com/.test(v)), [...unexpectedErrors, ...csp].join(' | '));
  const r404 = requests.filter((u) => /\/vendor\/|\.js/.test(u));
  ok('workers and vendor files loaded from this origin', r404.some((u) => /mp3-worker\.js/.test(u)) && r404.some((u) => /gif-worker\.js/.test(u)) && r404.some((u) => /lame-mp3-wasm\.js/.test(u)));

  await browser.close();

  // ---- Credits: every vendored file is credited and its licence text is served ----
  const get = (u) => new Promise((res, rej) => require(base.startsWith('https') ? 'https' : 'http').get(new URL(u, base), { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36' } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => res({ status: r.statusCode, body: d })); }).on('error', rej));
  const lic = await get('/licenses/');
  const vendored = fs.readdirSync(path.join(ROOT, 'sites/video/vendor')).filter((f) => /\.js$/.test(f));
  const missing = vendored.filter((f) => !lic.body.includes(`/vendor/${f}`));
  const licFiles = [...lic.body.matchAll(/href="(\/vendor\/licenses\/[^"]+)"/g)].map((m) => m[1]);
  const licStatus = await Promise.all(licFiles.map(async (f) => [f, (await get(f)).status]));
  ok('licenses page credits every vendored file, licence texts are served', missing.length === 0 && licFiles.length >= 4 && licStatus.every((x) => x[1] === 200),
    missing.length ? 'missing: ' + missing.join(', ') : licStatus.map((x) => `${x[0].split('/').pop()} ${x[1]}`).join(', '));
  fs.writeFileSync(path.join(OUT, 'timings.json'), JSON.stringify(timings, null, 2));
  console.log('\nexport times (ms, measured in the page):', JSON.stringify(timings));
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
