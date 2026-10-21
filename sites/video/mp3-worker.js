/*
  vid2gif.lol MP3 worker. Runs in a background thread in your browser.

  Two ways in:
    'mp4'  MP4/MOV with AAC (or MP3) sound: mp4box.js reads the file's index,
           we read just the sound bytes from your disk in small pieces, the
           browser's own AudioDecoder (WebCodecs) turns them into sound, and
           LAME turns that into MP3 as it goes. Memory use stays small even
           for hour-long videos.
    'pcm'  Anything else: the page decodes the sound with Web Audio and
           hands us the samples to encode.
  It never touches the network. The LAME WebAssembly is embedded in
  /vendor/lame-mp3-wasm.js, so it doesn't need to be fetched.
*/
import './vendor/WasmMediaEncoder.min.js';
import LAME_WASM_B64 from './vendor/lame-mp3-wasm.js';
import { createFile, Log } from './vendor/mp4box.min.js';

// mp4box logs harmless notes about QuickTime boxes it doesn't know. Keep the console clean.
Log.error = (mod, msg, iso) => { if (iso && iso.onError) iso.onError(mod, msg); };
Log.warn = Log.info = Log.debug = () => {};

const post = (m, t) => self.postMessage(m, t || []);

// ---------------------------------------------------------------------------
// MP3 encoder (LAME 3.100 in WebAssembly)
// ---------------------------------------------------------------------------
let wasmBytes = null;
function lameBytes() {
  if (!wasmBytes) {
    const bin = atob(LAME_WASM_B64);
    wasmBytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) wasmBytes[i] = bin.charCodeAt(i);
  }
  return wasmBytes;
}

class Mp3Out {
  static async create() {
    const o = new Mp3Out();
    o.enc = await self.WasmMediaEncoder.createEncoder('audio/mpeg', lameBytes());
    return o;
  }
  configure(sampleRate, channels, bitrate) {
    // MP3 at 192 or 320 kbps needs a 32, 44.1 or 48 kHz sample rate. LAME resamples anything else.
    const native = [32000, 44100, 48000].includes(sampleRate);
    const outRate = native ? undefined : sampleRate > 48000 && sampleRate % 44100 !== 0 ? 48000 : 44100;
    this.channels = Math.min(2, channels);
    this.enc.configure({ sampleRate, channels: this.channels, bitrate, ...(outRate ? { outputSampleRate: outRate } : {}) });
    this.chunks = [];
    this.bytes = 0;
    this.sampleRate = sampleRate;
    this.outRate = outRate || sampleRate;
  }
  push(planes) {
    const data = this.enc.encode(mix(planes, this.channels));
    if (data.length) { this.chunks.push(data.slice()); this.bytes += data.length; }
  }
  finish() {
    const data = this.enc.finalize();
    if (data.length) { this.chunks.push(data.slice()); this.bytes += data.length; }
    return new Blob(this.chunks, { type: 'audio/mpeg' });
  }
}

// Fold any channel layout down to what MP3 can hold (1 or 2 channels).
function mix(planes, want) {
  if (planes.length === want) return planes;
  const n = planes[0].length;
  if (want === 1) return [planes[0]];
  if (planes.length === 1) return [planes[0], planes[0]];
  const L = new Float32Array(n), R = new Float32Array(n);
  if (planes.length === 6) {
    // 5.1 in Web Audio order: L R C LFE SL SR
    const [l, r, c, , sl, sr] = planes;
    for (let i = 0; i < n; i++) {
      L[i] = 0.7 * (l[i] + 0.7071 * (c[i] + sl[i]));
      R[i] = 0.7 * (r[i] + 0.7071 * (c[i] + sr[i]));
    }
  } else {
    for (let c = 0; c < planes.length; c++) {
      const dst = c % 2 ? R : L, src = planes[c], g = 2 / planes.length;
      for (let i = 0; i < n; i++) dst[i] += src[i] * g;
    }
  }
  return [L, R];
}

// ---------------------------------------------------------------------------
// MP4 / MOV reading
// ---------------------------------------------------------------------------
async function readAt(file, pos, len) {
  return new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
}

async function topBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size && boxes.length < 5000) {
    const h = await readAt(file, pos, 16);
    const v = new DataView(h.buffer);
    let size = v.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let hdr = 8;
    if (size === 1) { size = Number(v.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - pos;
    if (size < hdr || !/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push({ type, pos, size });
    pos += size;
  }
  return boxes;
}

function findDsi(desc) {
  if (!desc) return null;
  if (desc.tag === 5 && desc.data) return desc.data;
  for (const d of desc.descs || []) { const r = findDsi(d); if (r) return r; }
  return null;
}

function parseAsc(b) {
  // AudioSpecificConfig: 5 bits object type, 4 bits rate index (15 = explicit 24 bits), 4 bits channels
  if (!b || b.length < 2) return {};
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let bits = 0, nb = 0, p = 0;
  const read = (n) => { while (nb < n) { bits = (bits << 8) | (b[p++] || 0); nb += 8; } nb -= n; return (bits >> nb) & ((1 << n) - 1); };
  let ot = read(5); if (ot === 31) ot = 32 + read(6);
  const ri = read(4);
  const rate = ri === 15 ? read(24) : rates[ri];
  const ch = read(4);
  return { rate, ch };
}

async function parseMp4(file) {
  const boxes = await topBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return { fallback: 'no-moov' };
  if (moov.size > 256 * 1024 * 1024) return { fallback: 'big-moov' };
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const parts = [];
  if (ftyp) parts.push(file.slice(ftyp.pos, ftyp.pos + ftyp.size));
  parts.push(file.slice(moov.pos, moov.pos + moov.size));
  const ab = await new Blob(parts).arrayBuffer();
  ab.fileStart = 0;
  const iso = createFile();
  let info = null, err = null;
  iso.onReady = (i) => { info = i; };
  iso.onError = (m, msg) => { err = msg; };
  iso.appendBuffer(ab);
  iso.flush();
  if (!info) return { fallback: 'parse: ' + (err || 'no info') };
  const fragmented = boxes.some((b) => b.type === 'moof') || info.isFragmented;
  const audios = info.tracks.filter((t) => t.type === 'audio' || (t.audio && t.audio.sample_rate));
  return { iso, info, audios, fragmented };
}

async function probeMp4(file) {
  const p = await parseMp4(file);
  if (p.fallback) return { hasAudio: null, note: p.fallback };
  const a = p.audios[0];
  return { hasAudio: p.audios.length > 0 || p.fragmented ? (p.audios.length > 0 ? true : null) : false, codec: a && a.codec, fragmented: p.fragmented };
}

async function mp4ToMp3(file, bitrate, range) {
  const p = await parseMp4(file);
  if (p.fallback) return { fallback: p.fallback };
  if (!p.audios.length) return p.fragmented ? { fallback: 'fragmented' } : { noaudio: true };
  if (p.fragmented) return { fallback: 'fragmented' };
  if (typeof AudioDecoder === 'undefined') return { fallback: 'no-webcodecs' };

  const { iso, info } = p;
  const t = p.audios.find((x) => /^mp4a/i.test(x.codec)) || p.audios[0];
  const trak = iso.getTrackById(t.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const esds = entry.esds || (entry.wave && (entry.wave.esds || (entry.wave.boxes || []).find((b) => b.type === 'esds')));
  const dcd = esds && esds.esd && (esds.esd.descs || []).find((d) => d.tag === 4);
  const oti = dcd && dcd.oti;
  let config;
  if (oti === 0x6b || oti === 0x69 || /^mp4a\.(6b|69)/i.test(t.codec)) {
    config = { codec: 'mp3', sampleRate: t.audio.sample_rate, numberOfChannels: t.audio.channel_count };
  } else if (/^mp4a/i.test(t.codec)) {
    const dsi = findDsi(esds && esds.esd);
    if (!dsi) return { fallback: 'no-asc' };
    const asc = parseAsc(dsi);
    const codec = /^mp4a\.40\.\d+$/.test(t.codec) ? t.codec : 'mp4a.40.2';
    config = {
      codec,
      sampleRate: t.audio.sample_rate > 0 && t.audio.sample_rate < 400000 ? t.audio.sample_rate : asc.rate,
      numberOfChannels: asc.ch || t.audio.channel_count || 2,
      description: new Uint8Array(dsi),
    };
  } else {
    return { fallback: 'codec ' + t.codec };
  }
  let supported = false;
  try { supported = (await AudioDecoder.isConfigSupported(config)).supported; } catch (_) { supported = false; }
  if (!supported) return { fallback: 'unsupported ' + config.codec };

  // Edit list: AAC starts with a little "priming" silence the file says to skip,
  // and the file says how long the sound really is.
  const mdTs = trak.mdia.mdhd.timescale;
  const samples = trak.samples;
  const mediaDur = samples.reduce((s, x) => s + x.duration, 0) / mdTs;
  let skipSec = 0, durSec = mediaDur;
  const edits = ((trak.edts && trak.edts.elst && trak.edts.elst.entries) || []).filter((e) => e.media_time >= 0);
  if (edits.length) {
    skipSec = edits[0].media_time / mdTs;
    durSec = Math.min(mediaDur - skipSec, edits.reduce((s, e) => s + e.segment_duration, 0) / info.timescale);
  }
  // Only part of the video? Decode from a little before the start (AAC needs
  // a frame or two to warm up) and cut to the exact sample.
  let first = 0, stop = samples.length;
  if (range) {
    const a = Math.max(0, range[0]), b = Math.min(durSec, range[1]);
    const want = skipSec + a - 0.25;
    while (first < samples.length - 1 && (samples[first + 1].cts / samples[first + 1].timescale) <= want) first++;
    const endT = skipSec + b + 0.25;
    stop = first + 1;
    while (stop < samples.length && samples[stop].cts / samples[stop].timescale < endT) stop++;
    skipSec = skipSec + a - samples[first].cts / samples[first].timescale;
    durSec = Math.max(0, b - a);
  }

  const out = await Mp3Out.create();
  let configured = false, skipLeft = 0, left = Infinity, failed = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      try {
        if (!configured) {
          out.configure(ad.sampleRate, ad.numberOfChannels, bitrate);
          skipLeft = Math.round(skipSec * ad.sampleRate);
          left = Math.round(durSec * ad.sampleRate);
          configured = true;
        }
        const n = ad.numberOfFrames;
        let planes = [];
        for (let c = 0; c < ad.numberOfChannels; c++) {
          const arr = new Float32Array(n);
          ad.copyTo(arr, { planeIndex: c, format: 'f32-planar' });
          planes.push(arr);
        }
        ad.close();
        let off = 0, len = n;
        if (skipLeft > 0) { const k = Math.min(skipLeft, len); off += k; len -= k; skipLeft -= k; }
        len = Math.min(len, left);
        if (len <= 0) return;
        left -= len;
        if (off || len < n) planes = planes.map((pl) => pl.subarray(off, off + len));
        out.push(planes);
      } catch (e) { failed = e; }
    },
    error: (e) => { failed = e; },
  });
  dec.configure(config);

  // Read the sound bytes in runs, so we touch as little of the video as we can.
  const WIN = 4 * 1024 * 1024, GAP = 64 * 1024;
  const t0 = performance.now();
  let lastPost = 0;
  for (let i = first; i < stop && left > 0;) {
    const start = samples[i].offset;
    let j = i + 1, end = samples[i].offset + samples[i].size;
    while (j < stop) {
      const s = samples[j];
      if (s.offset < end || s.offset - end > GAP || s.offset + s.size - start > WIN) break;
      end = s.offset + s.size; j++;
    }
    const buf = await readAt(file, start, end - start);
    for (let k = i; k < j; k++) {
      const s = samples[k];
      dec.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((s.cts * 1e6) / s.timescale),
        duration: Math.round((s.duration * 1e6) / s.timescale),
        data: buf.subarray(s.offset - start, s.offset - start + s.size),
      }));
    }
    i = j;
    while (dec.decodeQueueSize > 64 && !failed) await new Promise((r) => setTimeout(r, 0));
    if (failed) break;
    const now = performance.now();
    if (now - lastPost > 150) { lastPost = now; post({ type: 'progress', frac: (i - first) / (stop - first), bytes: out.bytes || 0, elapsed: now - t0 }); }
  }
  if (!failed) await dec.flush().catch((e) => { failed = e; });
  try { dec.close(); } catch (_) { /* already closed */ }
  if (failed) throw failed;
  if (!configured) return { fallback: 'no-output' };
  const blob = out.finish();
  return { blob, seconds: durSec, sampleRate: out.outRate, channels: out.channels, path: 'webcodecs' };
}

// ---------------------------------------------------------------------------
// Samples handed over by the page (Web Audio decode)
// ---------------------------------------------------------------------------
async function pcmToMp3(planes, sampleRate, bitrate) {
  const out = await Mp3Out.create();
  out.configure(sampleRate, planes.length, bitrate);
  const n = planes[0].length;
  const STEP = 1152 * 32;
  const t0 = performance.now();
  let lastPost = 0;
  for (let i = 0; i < n; i += STEP) {
    out.push(planes.map((p) => p.subarray(i, Math.min(n, i + STEP))));
    const now = performance.now();
    if (now - lastPost > 150) {
      lastPost = now;
      post({ type: 'progress', frac: i / n, bytes: out.bytes, elapsed: now - t0 });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return { blob: out.finish(), seconds: n / sampleRate, sampleRate: out.outRate, channels: out.channels, path: 'webaudio' };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'probe') post({ type: 'result', ...(await probeMp4(m.file)) });
    else if (m.type === 'mp4') post({ type: 'result', ...(await mp4ToMp3(m.file, m.bitrate, m.range)) });
    else if (m.type === 'pcm') post({ type: 'result', ...(await pcmToMp3(m.planes, m.sampleRate, m.bitrate)) });
  } catch (err) {
    post({ type: 'error', message: String((err && (err.message || err.name)) || err) });
  }
};
