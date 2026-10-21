/*
  vid2gif.lol app. Runs entirely in your browser.

  GIF: a hidden <video> element (your browser's own decoder) seeks to each
  frame time, a canvas grabs the pixels, and a Web Worker (gif-worker.js)
  picks the colors and writes the GIF.
  MP3: a Web Worker (mp3-worker.js) reads the sound out of the file, decodes
  it with your browser's own decoder, and encodes it with LAME (WebAssembly).
  Nothing here makes a network request. The file never leaves this tab.
*/
const lol = window.lol;
const $ = (id) => document.getElementById(id);

const GIF_WARN_SECONDS = 15;
const GIF_MAX_SECONDS = 60;
const BIG_PIXELS = 1280 * 720;

const state = {
  file: null, url: null, kind: null, dur: 0, vw: 0, vh: 0,
  audio: null, audioRate: 0, grab: null, busy: null, gifUrl: null, mp3Url: null, loadSeq: 0,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function fmtTime(s) {
  if (!isFinite(s)) return '';
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const h = Math.floor(m / 60);
  const ss = r.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(text) {
  const t = String(text || '').trim().replace(',', '.');
  if (!t) return NaN;
  if (!/^\d+(:\d+){0,2}(\.\d*)?$/.test(t) && !/^\d*\.\d+$/.test(t)) return NaN;
  return t.split(':').reduce((acc, p) => acc * 60 + parseFloat(p || '0'), 0);
}

function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 90) return `${Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function eta(elapsed, frac) {
  if (frac < 0.04 || elapsed < 600) return '';
  const left = (elapsed * (1 - frac)) / frac;
  if (left < 1500) return 'almost done';
  return `about ${fmtDur(left)} left`;
}

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }));

function seekTo(v, t) {
  // Already showing that frame: some browsers don't fire 'seeked' for a no-op seek.
  if (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) < 1e-6) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('seek-timeout')); }, 20000);
    const ok = () => { done(); resolve(); };
    const bad = () => { done(); reject(new Error('decode')); };
    function done() { clearTimeout(timer); v.removeEventListener('seeked', ok); v.removeEventListener('error', bad); }
    v.addEventListener('seeked', ok);
    v.addEventListener('error', bad);
    v.currentTime = t;
  });
}

// Load a video element and wait for its first frame (or an error).
function loadVideo(v, url) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish('timeout'), 30000);
    const ok = () => finish(null);
    const bad = () => finish('error');
    function finish(err) {
      clearTimeout(timer);
      v.removeEventListener('loadeddata', ok);
      v.removeEventListener('error', bad);
      resolve(err);
    }
    v.addEventListener('loadeddata', ok);
    v.addEventListener('error', bad);
    v.src = url;
    v.load();
  });
}

// Some WebM files (screen recorders, MediaRecorder) don't say how long they are.
async function fixDuration(v) {
  if (isFinite(v.duration) && v.duration > 0) return;
  v.currentTime = 1e101;
  await Promise.race([once(v, 'durationchange'), new Promise((r) => setTimeout(r, 4000))]);
  await seekTo(v, 0).catch(() => {});
}

// ---------------------------------------------------------------------------
// What kind of file is it?
// ---------------------------------------------------------------------------
async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const str = (a, n) => String.fromCharCode(...b.subarray(a, a + n));
  if (b.length >= 8 && /^(ftyp|moov|mdat|wide|free|skip|pnot)$/.test(str(4, 4))) return 'mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'AVI ') return 'avi';
  if (str(0, 4) === 'OggS') return 'ogg';
  if (b[0] === 0x47 && file.size > 188) return 'ts';
  if (b[0] === 0x89 && str(1, 3) === 'PNG') return 'image';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image';
  if (str(0, 3) === 'GIF' || (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP')) return 'image';
  if (str(0, 4) === '%PDF') return 'doc';
  if (str(0, 2) === 'PK') return 'doc';
  if (str(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio';
  if (str(0, 4) === 'fLaC' || (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE')) return 'audio';
  return 'other';
}

// Read just enough of a WebM/MKV file to see whether it has a sound track.
async function webmAudio(file) {
  const buf = new Uint8Array(await file.slice(0, Math.min(file.size, 8 << 20)).arrayBuffer());
  const dv = new DataView(buf.buffer);
  let p = 0;
  const vint = (keepMarker) => {
    const first = buf[p];
    if (first === undefined) throw new Error('eof');
    let len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
    if (len > 8) throw new Error('bad');
    let v = keepMarker ? first : first & (mask - 1);
    let ones = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + buf[p + i]; if (buf[p + i] !== 255) ones = false; }
    p += len;
    return { v, unknown: !keepMarker && ones };
  };
  const SEGMENT = 0x18538067, TRACKS = 0x1654ae6b, ENTRY = 0xae, AUDIO = 0xe1, CLUSTER = 0x1f43b675;
  const tracks = [];
  let sawTracks = false;
  const walk = (end, depth, track) => {
    while (p < end && p < buf.length) {
      const id = vint(true).v;
      const size = vint(false);
      const bodyEnd = size.unknown ? end : p + size.v;
      if (id === CLUSTER) return false;
      if (id === SEGMENT || id === TRACKS || id === ENTRY || id === AUDIO) {
        if (id === TRACKS) sawTracks = true;
        const t = id === ENTRY ? { type: 0, rate: 0 } : track;
        if (walk(Math.min(bodyEnd, buf.length), depth + 1, t) === false) return false;
        if (id === ENTRY) tracks.push(t);
        if (id === TRACKS) return false;
        p = bodyEnd;
      } else {
        if (size.unknown) return false;
        if (track && id === 0x83) track.type = buf[p];
        if (track && id === 0xb5) track.rate = size.v === 4 ? dv.getFloat32(p) : dv.getFloat64(p);
        p = bodyEnd;
      }
    }
    return true;
  };
  try { walk(buf.length, 0, null); } catch (_) { /* ran out of bytes */ }
  if (!sawTracks) return { audio: null };
  const a = tracks.find((t) => t.type === 2);
  return { audio: !!a, rate: a ? a.rate : 0 };
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------
function startWorker(url) {
  const w = new Worker(url, { type: 'module' });
  const waiting = [];
  let onProgress = null;
  let dead = null;
  const fail = (err) => { dead = err; while (waiting.length) waiting.shift().reject(err); };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { if (onProgress) onProgress(m); return; }
    if (m.type === 'error') { fail(new Error(m.message)); return; }
    const next = waiting.shift();
    if (next) next.resolve(m);
  };
  w.onerror = (e) => { e.preventDefault(); fail(new Error(e.message || 'worker failed')); };
  return {
    call(msg, transfer) {
      if (dead) return Promise.reject(dead);
      const p = new Promise((resolve, reject) => { waiting.push({ resolve, reject }); w.postMessage(msg, transfer || []); });
      p.catch(() => {}); // a call still in flight when the user presses Stop isn't an error
      return p;
    },
    set progress(fn) { onProgress = fn; },
    stop() { w.terminate(); fail(new Error('cancelled')); },
  };
}

// ---------------------------------------------------------------------------
// UI references
// ---------------------------------------------------------------------------
const drop = $('drop');
const loadStatus = $('loadStatus');
const editor = $('editor');
const preview = $('preview');
const startIn = $('start');
const endIn = $('end');
const clipNote = $('clipNote');
const gifBtn = $('gifBtn');
const mp3Btn = $('mp3Btn');
const cancelBtn = $('cancelBtn');
const progress = $('progress');
const statusEl = $('status');
const gifOut = $('gifOut');
const mp3Out = $('mp3Out');
const audioNote = $('audioNote');

const mode = () => document.querySelector('input[name="mode"]:checked').value;
const fps = () => parseInt(document.querySelector('input[name="fps"]:checked').value, 10);
const bitrate = () => parseInt(document.querySelector('input[name="kbps"]:checked').value, 10);

function outSize() {
  const sel = $('width').value;
  const w = sel === 'orig' ? state.vw : Math.min(parseInt(sel, 10), state.vw);
  const h = Math.max(1, Math.round((w * state.vh) / state.vw));
  return [w, h];
}

function trim() {
  let s = parseTime(startIn.value), e = parseTime(endIn.value);
  if (!isFinite(s)) s = NaN;
  if (!isFinite(e)) e = NaN;
  return [s, e];
}

function syncMode() {
  const m = mode();
  $('gifPanel').hidden = m !== 'gif';
  $('mp3Panel').hidden = m !== 'mp3';
  $('mp3TrimRow').hidden = m !== 'mp3';
  $('trimBox').hidden = m === 'mp3' && !$('mp3Trim').checked;
  refresh();
}

function setBusy(kind) {
  state.busy = kind;
  const busy = !!kind;
  for (const el of editor.querySelectorAll('input, select, button')) {
    if (el === cancelBtn) continue;
    el.disabled = busy;
  }
  drop.classList.toggle('is-busy', busy);
  drop.querySelector('input').disabled = busy;
  cancelBtn.hidden = !busy;
  if (!busy) refresh();
}

// Re-check the trim and settings, and update the note under them.
function refresh() {
  if (!state.file || state.busy) return;
  const [s, e] = trim();
  const m = mode();
  let note = '', kind = '';
  let gifOk = true;
  if (!isFinite(s) || !isFinite(e)) { note = 'Type times like 4, 4.5 or 1:04.5.'; kind = 'err'; gifOk = false; }
  else if (s < 0 || s >= state.dur) { note = `Start has to be before the end of the video (${fmtTime(state.dur)}).`; kind = 'err'; gifOk = false; }
  else if (e <= s) { note = 'End has to come after start.'; kind = 'err'; gifOk = false; }
  else {
    const end = Math.min(e, state.dur);
    const len = end - s;
    const n = Math.max(1, Math.round(len * fps()));
    const [w, h] = outSize();
    const bits = [`${len.toFixed(1)} s`, `${n} frames`, `${w} × ${h} px`];
    note = bits.join(' · ');
    if (len > GIF_MAX_SECONDS) {
      note = `That's ${len.toFixed(1)} s. GIFs here max out at ${GIF_MAX_SECONDS} s. For anything that long, share the video itself.`;
      kind = 'err'; gifOk = false;
    } else if (len > GIF_WARN_SECONDS) {
      note += `. Heads up: GIFs over ${GIF_WARN_SECONDS} s get huge (often tens of MB) and take a while. A shorter clip, smaller width or fewer frames per second helps.`;
      kind = 'warn';
    } else if (w * h > BIG_PIXELS) {
      note += '. Full size makes a big GIF and takes longer. 480 or 640 is plenty for most chats and posts.';
      kind = 'warn';
    }
  }
  clipNote.textContent = m === 'gif' ? note : '';
  clipNote.className = 'clip-note ' + (m === 'gif' ? kind : '');
  gifBtn.disabled = !gifOk || !state.vw;
  $('mode-gif').disabled = !state.vw;
  const trimOnly = $('mp3Trim').checked;
  const rangeOk = isFinite(s) && isFinite(e) && s >= 0 && s < state.dur && e > s;
  mp3Btn.disabled = state.audio === false || (trimOnly && !rangeOk);
  if (m === 'mp3' && trimOnly) {
    if (rangeOk) {
      clipNote.textContent = `Saves ${fmtTime(s)} to ${fmtTime(Math.min(e, state.dur))} (${(Math.min(e, state.dur) - s).toFixed(1)} s).`;
      clipNote.className = 'clip-note';
    } else {
      clipNote.textContent = note;
      clipNote.className = 'clip-note err';
    }
  }
}

// ---------------------------------------------------------------------------
// Loading a video
// ---------------------------------------------------------------------------
function resetOutputs() {
  if (state.gifUrl) URL.revokeObjectURL(state.gifUrl);
  if (state.mp3Url) URL.revokeObjectURL(state.mp3Url);
  state.gifUrl = state.mp3Url = null;
  gifOut.hidden = true; gifOut.querySelector('img').removeAttribute('src');
  mp3Out.hidden = true; mp3Out.querySelector('audio').removeAttribute('src');
  lol.setStatus(statusEl, '');
  lol.setProgress(progress, null);
}

function reject(msg) {
  lol.setStatus(loadStatus, msg, 'err');
}

async function openFile(files) {
  if (state.busy) return;
  const file = files[0];
  const seq = ++state.loadSeq;
  lol.setStatus(loadStatus, '');
  if (!file) return;
  if (files.length > 1) lol.setStatus(loadStatus, 'One video at a time. Using the first one you picked.');
  if (file.size === 0) return reject('That file is empty (0 bytes). Pick a video file.');
  const kind = await sniff(file);
  if (seq !== state.loadSeq) return;
  if (kind === 'image') return reject(`${file.name} is a picture, not a video. Pick an MP4, MOV or WebM video.`);
  if (kind === 'doc') return reject(`${file.name} isn't a video. Pick an MP4, MOV or WebM video.`);
  if (kind === 'audio' || /^audio\//.test(file.type)) return reject(`${file.name} is a sound file, not a video. vid2gif.lol needs a video.`);
  if (kind === 'other' && !/^video\//.test(file.type) && !/\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp|mpe?g|ts)$/i.test(file.name)) {
    return reject(`${file.name} doesn't look like a video. Pick an MP4, MOV or WebM video.`);
  }

  lol.setStatus(loadStatus, 'Opening the video…');
  const url = URL.createObjectURL(file);
  const err = await loadVideo(preview, url);
  if (seq !== state.loadSeq) { URL.revokeObjectURL(url); return; }
  if (err) {
    URL.revokeObjectURL(url);
    preview.removeAttribute('src'); preview.load();
    return reject(kind === 'avi' || kind === 'ts'
      ? `Your browser can't play ${file.name}, so vid2gif.lol can't read it. MP4, MOV and WebM work best.`
      : `Your browser can't play ${file.name}, so vid2gif.lol can't read it. It may be damaged, or use a format (like some iPhone HEVC videos) this browser doesn't support. Try Safari, or a different browser.`);
  }
  await fixDuration(preview);
  if (seq !== state.loadSeq) return;

  if (state.url) URL.revokeObjectURL(state.url);
  resetOutputs();
  Object.assign(state, {
    file, url, kind, dur: preview.duration, vw: preview.videoWidth, vh: preview.videoHeight,
    audio: null, audioRate: 0,
  });
  if (state.grab) { state.grab.removeAttribute('src'); state.grab.load(); state.grab.remove(); state.grab = null; }

  $('fileName').textContent = file.name;
  $('fileMeta').textContent = [state.vw ? `${state.vw} × ${state.vh}` : 'no picture', fmtTime(state.dur), lol.formatBytes(file.size)].join(' · ');
  startIn.value = fmtTime(0);
  endIn.value = fmtTime(Math.min(state.dur, 5));
  editor.hidden = false;
  drop.classList.add('compact');
  $('dzTitle').textContent = 'Pick a different video';
  lol.setStatus(loadStatus, '');

  const gifRadio = $('mode-gif');
  gifRadio.disabled = !state.vw;
  if (!state.vw) { $('mode-mp3').checked = true; lol.setStatus(loadStatus, 'This file has sound but no picture, so only the MP3 option works.'); }
  syncMode();
  checkAudio(seq);
}

async function checkAudio(seq) {
  audioNote.textContent = '';
  audioNote.className = 'hint';
  let has = null, rate = 0;
  try {
    if (state.kind === 'mp4') {
      const w = startWorker('/mp3-worker.js');
      const r = await w.call({ type: 'probe', file: state.file });
      w.stop();
      has = r.hasAudio;
    } else if (state.kind === 'webm') {
      const r = await webmAudio(state.file);
      has = r.audio; rate = r.rate;
    }
  } catch (_) { has = null; }
  if (seq !== state.loadSeq) return;
  state.audio = has;
  state.audioRate = rate;
  if (has === false) {
    audioNote.textContent = "This video has no audio track, so there's no sound to save as an MP3.";
    audioNote.className = 'hint err';
  }
  refresh();
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------
async function getGrabber() {
  if (state.grab) return state.grab;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.className = 'grabber';
  v.setAttribute('aria-hidden', 'true');
  document.body.append(v);
  const err = await loadVideo(v, state.url);
  if (err) { v.remove(); throw new Error('decode'); }
  // iOS Safari only paints seeked frames after the video has played once.
  try { await v.play(); v.pause(); } catch (_) { /* autoplay blocked, fine on desktop */ }
  state.grab = v;
  return v;
}

let cancel = null;

async function makeGif() {
  const [s0, e0] = trim();
  const start = Math.max(0, s0);
  const end = Math.min(e0, state.dur);
  const rate = fps();
  const n = Math.max(1, Math.round((end - start) * rate));
  const [W, H] = outSize();
  const dither = $('style').value;
  const file = state.file;

  resetOutputs();
  setBusy('gif');
  const t0 = performance.now();
  let stopped = false;
  const worker = startWorker('/gif-worker.js');
  cancel = () => { stopped = true; worker.stop(); };
  lol.setProgress(progress, 0);
  lol.setStatus(statusEl, 'Getting ready…');
  try {
    const v = await getGrabber();
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const last = Math.max(0, state.dur - 0.001);
    const grab = async (t) => {
      await seekTo(v, Math.min(last, t + 0.0005));
      if (stopped) throw new Error('cancelled');
      ctx.drawImage(v, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H).data.buffer;
    };

    // Pass 1: look at frames spread across the clip to choose the colors.
    const samples = Math.min(n, 16);
    const total = samples + n;
    let doneUnits = 0;
    const tick = (label) => {
      doneUnits++;
      const frac = doneUnits / total;
      lol.setProgress(progress, frac);
      const left = eta(performance.now() - t0, frac);
      lol.setStatus(statusEl, label + (left ? `, ${left}` : ''));
    };
    for (let k = 0; k < samples; k++) {
      const i = samples === 1 ? 0 : Math.round((k * (n - 1)) / (samples - 1));
      const buf = await grab(start + i / rate);
      await worker.call({ type: 'sample', data: buf }, [buf]);
      tick('Choosing colors');
    }
    const { colors } = await worker.call({ type: 'start', w: W, h: H, dither });

    // Pass 2: every frame. Seek to the next one while the worker encodes this one.
    let pending = null;
    let size = 0;
    for (let i = 0; i < n; i++) {
      const buf = await grab(start + i / rate);
      const delay = Math.round(((i + 1) * 100) / rate) - Math.round((i * 100) / rate);
      if (pending) size = (await pending).size;
      pending = worker.call({ type: 'frame', data: buf, delay }, [buf]);
      tick(`Frame ${i + 1} of ${n}${size ? ` · ${lol.formatBytes(size)} so far` : ''}`);
    }
    if (pending) await pending;
    lol.setStatus(statusEl, 'Finishing the GIF…');
    const { bytes } = await worker.call({ type: 'finish' });
    worker.stop();
    const ms = performance.now() - t0;
    const blob = new Blob([bytes], { type: 'image/gif' });
    state.gifUrl = URL.createObjectURL(blob);
    const name = `${lol.baseName(file.name)}.gif`;
    const img = gifOut.querySelector('img');
    img.src = state.gifUrl;
    img.width = W; img.height = H;
    $('gifMeta').textContent = `${W} × ${H} px · ${n} frames · ${(n / rate).toFixed(1)} s · ${lol.formatBytes(blob.size)}`;
    $('gifSave').onclick = () => lol.download(blob, name);
    $('gifSave').setAttribute('aria-label', `Save ${name}`);
    gifOut.hidden = false;
    gifOut.dataset.ms = Math.round(ms);
    gifOut.dataset.colors = colors;
    lol.setProgress(progress, null);
    const big = blob.size > 15 * 1024 * 1024 ? ' It\'s big: some sites and chat apps won\'t take a GIF this size.' : '';
    lol.setStatus(statusEl, `GIF ready: ${lol.formatBytes(blob.size)}, made in ${fmtDur(ms)}.${big}`, 'ok');
  } catch (e) {
    worker.stop();
    lol.setProgress(progress, null);
    if (stopped) lol.setStatus(statusEl, 'Stopped. Nothing was saved.');
    else {
      console.error(e);
      const msg = String((e && e.message) || e);
      lol.setStatus(statusEl, /decode|seek-timeout/.test(msg)
        ? "Your browser couldn't read the frames of this video. It may be damaged, or too big for this device."
        : /memory|allocation|Array buffer/i.test(msg)
          ? 'This device ran out of memory. Try a shorter clip, a smaller width or fewer frames per second.'
          : "Something went wrong making the GIF. Try a shorter clip or a smaller width.", 'err');
    }
  } finally {
    cancel = null;
    setBusy(null);
  }
}

// ---------------------------------------------------------------------------
// MP3
// ---------------------------------------------------------------------------
async function decodeWithWebAudio(file, range) {
  // Web Audio decodes the whole sound track into memory at once (about 1.3 GB an hour in stereo).
  if (file.size > 1.5 * 1024 * 1024 * 1024 || state.dur > 3600) throw new Error('too-big');
  const buf = await file.arrayBuffer();
  const rate = state.audioRate >= 32000 && state.audioRate <= 48000 ? state.audioRate : 44100;
  const ctx = new OfflineAudioContext(1, 1, rate);
  let audio;
  try { audio = await ctx.decodeAudioData(buf); } catch (_) { throw new Error('no-decode'); }
  let a = 0, b = audio.length;
  if (range) { a = Math.max(0, Math.round(range[0] * audio.sampleRate)); b = Math.min(audio.length, Math.round(range[1] * audio.sampleRate)); }
  const planes = [];
  for (let c = 0; c < Math.min(audio.numberOfChannels, 6); c++) planes.push(audio.getChannelData(c).slice(a, b));
  if (audio.numberOfChannels > 2 && audio.numberOfChannels !== 6) planes.length = 2;
  return { planes, sampleRate: audio.sampleRate };
}

async function makeMp3() {
  const file = state.file;
  const kbps = bitrate();
  let range = null;
  if ($('mp3Trim').checked) {
    const [s, e] = trim();
    range = [Math.max(0, s), Math.min(e, state.dur)];
  }
  resetOutputs();
  setBusy('mp3');
  const t0 = performance.now();
  let stopped = false;
  const worker = startWorker('/mp3-worker.js');
  cancel = () => { stopped = true; worker.stop(); };
  worker.progress = (m) => {
    lol.setProgress(progress, m.frac);
    const left = eta(performance.now() - t0, m.frac);
    lol.setStatus(statusEl, `Making the MP3 · ${lol.formatBytes(m.bytes)} so far${left ? `, ${left}` : ''}`);
  };
  lol.setProgress(progress, 0);
  lol.setStatus(statusEl, 'Reading the sound…');
  try {
    let res = null;
    if (state.kind === 'mp4') {
      res = await worker.call({ type: 'mp4', file, bitrate: kbps, range });
      if (res.noaudio) throw new Error('no-audio');
      if (res.fallback) res = null;
    }
    if (!res) {
      if (state.audio === false) throw new Error('no-audio');
      lol.setStatus(statusEl, 'Reading the sound (this part has no progress bar)…');
      const { planes, sampleRate } = await decodeWithWebAudio(file, range);
      if (stopped) throw new Error('cancelled');
      if (!planes.length || !planes[0].length) throw new Error('no-decode');
      res = await worker.call({ type: 'pcm', planes, sampleRate, bitrate: kbps }, planes.map((p) => p.buffer));
    }
    worker.stop();
    const ms = performance.now() - t0;
    const blob = res.blob;
    state.mp3Url = URL.createObjectURL(blob);
    const name = `${lol.baseName(file.name)}.mp3`;
    const audio = mp3Out.querySelector('audio');
    audio.src = state.mp3Url;
    $('mp3Meta').textContent = `${fmtTime(res.seconds)} · ${kbps} kbps · ${res.channels === 1 ? 'mono' : 'stereo'} · ${lol.formatBytes(blob.size)}`;
    $('mp3Save').onclick = () => lol.download(blob, name);
    $('mp3Save').setAttribute('aria-label', `Save ${name}`);
    mp3Out.hidden = false;
    mp3Out.dataset.ms = Math.round(ms);
    mp3Out.dataset.path = res.path;
    lol.setProgress(progress, null);
    lol.setStatus(statusEl, `MP3 ready: ${lol.formatBytes(blob.size)}, made in ${fmtDur(ms)}.`, 'ok');
  } catch (e) {
    worker.stop();
    lol.setProgress(progress, null);
    const msg = String((e && e.message) || e);
    if (stopped) lol.setStatus(statusEl, 'Stopped. Nothing was saved.');
    else if (msg === 'no-audio') {
      state.audio = false;
      audioNote.textContent = "This video has no audio track, so there's no sound to save as an MP3.";
      audioNote.className = 'hint err';
      lol.setStatus(statusEl, "This video has no audio track, so there's no sound to save as an MP3.", 'err');
    } else if (msg === 'too-big') {
      lol.setStatus(statusEl, "This video is too long or too big for your browser to pull the sound out of in one go. That limit is for WebM and other non-MP4 files. MP4 and MOV files are read in small pieces and don't have it.", 'err');
    } else if (msg === 'no-decode') {
      lol.setStatus(statusEl, "Your browser couldn't read any sound in this video. It may have no audio track, or use a sound format this browser can't decode.", 'err');
    } else {
      console.error(e);
      lol.setStatus(statusEl, /memory|allocation|Array buffer/i.test(msg)
        ? 'This device ran out of memory pulling the sound out. Try a computer, or tick "Only the part between start and end".'
        : 'Something went wrong making the MP3. The sound in this video may be in a format your browser can\'t decode.', 'err');
    }
  } finally {
    cancel = null;
    setBusy(null);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', syncMode));
document.querySelectorAll('input[name="fps"]').forEach((r) => r.addEventListener('change', refresh));
for (const el of [startIn, endIn]) {
  el.addEventListener('input', refresh);
  el.addEventListener('blur', () => { const t = parseTime(el.value); if (isFinite(t)) el.value = fmtTime(t); refresh(); });
}
$('width').addEventListener('change', refresh);
$('mp3Trim').addEventListener('change', syncMode);
$('setStart').addEventListener('click', () => { startIn.value = fmtTime(preview.currentTime); refresh(); });
$('setEnd').addEventListener('click', () => { endIn.value = fmtTime(preview.currentTime); refresh(); });
gifBtn.addEventListener('click', () => { if (!state.busy) makeGif(); });
mp3Btn.addEventListener('click', () => { if (!state.busy) makeMp3(); });
cancelBtn.addEventListener('click', () => { if (cancel) cancel(); });

lol.dropzone(drop, openFile);
window.__videoReady = true;
