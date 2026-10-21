/*
  nobg.lol worker. Runs the background-removal model off the main thread so the
  page stays responsive while it works.

  Everything it loads comes from this site:
    /vendor/imgly/background-removal.mjs  IMG.LY's library (AGPL-3.0), lightly patched
    /vendor/imgly/ort.wasm.min.mjs        onnxruntime-web, which runs the model
    /vendor/imgly/ort-wasm-simd-threaded.mjs + .wasm pieces
    /vendor/imgly/resources.json          list of the model and wasm pieces (4 MiB each)
    /png.js                               our PNG writer
  The page hands this worker a File from your disk. It sends back a PNG.
  Nothing is uploaded: the Content-Security-Policy on this file only allows
  requests to this site, and this site has no server code to receive anything.
*/
import { preload, removeBackground } from '/vendor/imgly/background-removal.mjs';
import { encodePNG } from '/png.js';

const PUBLIC = new URL('/vendor/imgly/', self.location.origin).href;
// Phone browsers cap a canvas near 16.7 megapixels; stay under that.
const MAX_PIXELS = 16000000;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const threads = () => (self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4)) : 1);

let config = null;
let ready = null;
const loaded = {};

function cfg(model) {
  if (!config) {
    config = {
      publicPath: PUBLIC,
      model,
      device: 'cpu',
      output: { format: 'image/x-rgba8' },
      // The model and wasm pieces are named by their SHA-256, so a copy in the
      // browser's cache can never be out of date. Use it without asking the server.
      fetchArgs: { cache: 'force-cache' },
      progress: (key, cur, total) => {
        if (!key.startsWith('fetch:')) return;
        loaded[key] = cur;
        post({ type: 'fetch', key: key.slice(6), cur, total, sum: Object.values(loaded).reduce((a, b) => a + b, 0) });
      },
    };
  }
  return config;
}

function ensureReady(model) {
  if (!ready) {
    ready = (async () => {
      const t0 = performance.now();
      let total = 0;
      try {
        const res = await (await fetch(PUBLIC + 'resources.json')).json();
        for (const k in res) if (k === '/models/' + model || k.endsWith('.wasm')) total += res[k].size;
      } catch (e) {
        throw coded('model', e);
      }
      post({ type: 'model-start', total });
      try {
        await preload(cfg(model));
      } catch (e) {
        throw coded(/memory|allocation|RangeError/i.test(String(e)) ? 'memory' : 'model', e);
      }
      const info = { ms: Math.round(performance.now() - t0), threads: threads(), isolated: !!self.crossOriginIsolated, total };
      post({ type: 'model-ready', ...info });
      return info;
    })();
    ready.catch(() => { ready = null; }); // if loading failed, the next photo tries again
  }
  return ready;
}

function coded(code, e) {
  const err = new Error(String((e && e.message) || e || code));
  err.code = code;
  return err;
}

async function decode(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw coded('decode', e);
  }
  const ow = bmp.width, oh = bmp.height;
  let w = ow, h = oh, scaled = false;
  if (w * h > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
    scaled = true;
  }
  try {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return { w, h, ow, oh, scaled, data, bmp };
  } catch (e) {
    bmp.close();
    throw coded('memory', e);
  }
}

// ---------------------------------------------------------------------------
// Second look for subjects cut off by the edge of the photo.
// The model tends to fade out the part of a subject that runs off the frame
// (a penguin's white belly, the shoulders in a close-up). If the first pass
// says the subject touches an edge, we run the model again on a copy with that
// edge mirrored outwards, so the subject no longer stops at the border, and
// keep whichever answer is more solid. Only pixels the first pass already
// counted as part of the subject can get more solid, so the background
// can't creep back in.
// ---------------------------------------------------------------------------
const EDGE_SHARE = 0.1;   // the subject covers more than 10% of an edge
const PAD = 0.25;         // mirror a quarter of the photo's size outwards
const LOOK_MAX = 1536;    // the model sees 1024 px anyway; keep this pass light

function touchingEdges(px, w, h) {
  const on = (x, y) => px[(y * w + x) * 4 + 3] >= 32;
  let t = 0, b = 0, l = 0, r = 0;
  for (let x = 0; x < w; x++) { if (on(x, 0)) t++; if (on(x, h - 1)) b++; }
  for (let y = 0; y < h; y++) { if (on(0, y)) l++; if (on(w - 1, y)) r++; }
  const e = { top: t / w > EDGE_SHARE, bottom: b / w > EDGE_SHARE, left: l / h > EDGE_SHARE, right: r / h > EDGE_SHARE };
  return e.top || e.bottom || e.left || e.right ? e : null;
}

async function secondLook(bmp, w, h, edges, model, px) {
  const fw = 1 + PAD * ((edges.left ? 1 : 0) + (edges.right ? 1 : 0));
  const fh = 1 + PAD * ((edges.top ? 1 : 0) + (edges.bottom ? 1 : 0));
  const s = Math.min(1, LOOK_MAX / Math.max(w * fw, h * fh));
  const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
  const c = new OffscreenCanvas(sw, sh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, sw, sh);
  const src = ctx.getImageData(0, 0, sw, sh).data;
  const pl = edges.left ? Math.round(sw * PAD) : 0, pr = edges.right ? Math.round(sw * PAD) : 0;
  const pt = edges.top ? Math.round(sh * PAD) : 0, pb = edges.bottom ? Math.round(sh * PAD) : 0;
  const W = sw + pl + pr, H = sh + pt + pb;
  const big = new Uint8Array(W * H * 4);
  const refl = (i, n) => { if (i < 0) i = -i - 1; if (i >= n) i = 2 * n - i - 1; return i < 0 ? 0 : i >= n ? n - 1 : i; };
  for (let Y = 0; Y < H; Y++) {
    const sy = refl(Y - pt, sh);
    for (let X = 0; X < W; X++) {
      const si = (sy * sw + refl(X - pl, sw)) * 4, di = (Y * W + X) * 4;
      big[di] = src[si]; big[di + 1] = src[si + 1]; big[di + 2] = src[si + 2]; big[di + 3] = 255;
    }
  }
  const res = await removeBackground(new Blob([big], { type: `image/x-rgba8;width=${W};height=${H}` }), cfg(model));
  const m = new Uint8Array(await res.arrayBuffer());
  // Merge: sample the second mask (bilinear) over the original frame.
  const kx = sw / w, ky = sh / h;
  let changed = 0;
  for (let y = 0; y < h; y++) {
    let my = (y + 0.5) * ky - 0.5; if (my < 0) my = 0; if (my > sh - 1) my = sh - 1;
    const y0 = Math.floor(my), y1 = Math.min(sh - 1, y0 + 1), fy = my - y0;
    const r0 = (y0 + pt) * W, r1 = (y1 + pt) * W;
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4 + 3;
      const a1 = px[j];
      if (a1 < 8) continue;
      let mx = (x + 0.5) * kx - 0.5; if (mx < 0) mx = 0; if (mx > sw - 1) mx = sw - 1;
      const x0 = Math.floor(mx), x1 = Math.min(sw - 1, x0 + 1), fx = mx - x0;
      const a = m[(r0 + x0 + pl) * 4 + 3] * (1 - fx) + m[(r0 + x1 + pl) * 4 + 3] * fx;
      const b = m[(r1 + x0 + pl) * 4 + 3] * (1 - fx) + m[(r1 + x1 + pl) * 4 + 3] * fx;
      const a2 = Math.round(a * (1 - fy) + b * fy);
      if (a2 > a1) { px[j] = a2; changed++; }
    }
  }
  return changed;
}

async function run(msg) {
  await ensureReady(msg.model);
  const t0 = performance.now();
  const img = await decode(msg.file);
  const bmp = img.bmp;
  try {
    return await cutAndSend(msg, img, bmp, t0);
  } finally {
    bmp.close();
  }
}

async function cutAndSend(msg, img, bmp, t0) {
  // If the picture already has see-through parts, keep them see-through.
  let srcAlpha = null;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] !== 255) { srcAlpha = true; break; }
  }
  if (srcAlpha) {
    srcAlpha = new Uint8Array(img.w * img.h);
    for (let i = 0, j = 3; i < srcAlpha.length; i++, j += 4) srcAlpha[i] = img.data[j];
  }
  const t1 = performance.now();
  post({ type: 'stage', id: msg.id, stage: 'cut' });
  let buf;
  try {
    const input = new Blob([img.data], { type: `image/x-rgba8;width=${img.w};height=${img.h}` });
    img.data = null;
    const out = await removeBackground(input, cfg(msg.model));
    buf = await out.arrayBuffer();
  } catch (e) {
    throw coded(/memory|allocation|RangeError|Aborted/i.test(String(e)) ? 'memory' : 'run', e);
  }
  const px = new Uint8Array(buf);
  let edges = null, looked = 0;
  if (msg.secondLook !== false) {
    edges = touchingEdges(px, img.w, img.h);
    if (edges) {
      post({ type: 'stage', id: msg.id, stage: 'edges' });
      try {
        looked = await secondLook(bmp, img.w, img.h, edges, msg.model, px);
      } catch (e) {
        // Not worth failing over: the first pass is still a usable cutout.
        console.warn('second look skipped', e);
      }
    }
  }
  if (srcAlpha) {
    for (let i = 0, j = 3; i < srcAlpha.length; i++, j += 4) if (srcAlpha[i] < px[j]) px[j] = srcAlpha[i];
  }
  // The model's mask never quite reaches 0 or 255 (it tops out around 254), so
  // snap the last couple of percent: the subject becomes fully solid and the
  // background fully clear. Soft edges in between are kept as they are.
  // Then blank the color of fully see-through pixels, so the old background
  // can't be recovered from the file by an app that ignores transparency.
  let subject = 0;
  for (let j = 3; j < px.length; j += 4) {
    let a = px[j];
    if (a >= 250) a = px[j] = 255;
    else if (a <= 5) a = px[j] = 0;
    if (a === 0) { px[j - 3] = 0; px[j - 2] = 0; px[j - 1] = 0; }
    else if (a >= 128) subject++;
  }
  const t2 = performance.now();
  post({ type: 'stage', id: msg.id, stage: 'png' });
  const png = await encodePNG(px, img.w, img.h, 4);
  const t3 = performance.now();
  post({
    type: 'done', id: msg.id, w: img.w, h: img.h, ow: img.ow, oh: img.oh, scaled: img.scaled, png,
    opaqueShare: subject / (img.w * img.h), edges, looked,
    decodeMs: Math.round(t1 - t0), cutMs: Math.round(t2 - t1), pngMs: Math.round(t3 - t2),
  });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'preload') {
      await ensureReady(msg.model);
    } else if (msg.type === 'run') {
      await run(msg);
    } else if (msg.type === 'probe') {
      // Used by the test suite to show that this worker can't reach other sites either.
      try {
        await fetch(msg.url, { mode: 'no-cors' });
        post({ type: 'probe', id: msg.id, blocked: false });
      } catch (e) {
        post({ type: 'probe', id: msg.id, blocked: true, error: String(e) });
      }
    } else if (msg.type === 'net') {
      // Used by the test suite: which files this worker fetched, and how many bytes came over the network.
      const list = performance.getEntriesByType('resource').map((e) => ({ name: e.name, transferSize: e.transferSize, bodySize: e.encodedBodySize }));
      post({ type: 'net', id: msg.id, list });
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, code: e.code || 'run', message: String((e && e.message) || e) });
  }
};
post({ type: 'hello', isolated: !!self.crossOriginIsolated, threads: threads() });
