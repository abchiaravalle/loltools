/*
  vid2gif.lol GIF core. Runs in a Web Worker in your browser.

  gifenc (MIT, vendored) writes the GIF bytes (LZW). The color work is ours:
    1. One shared palette for the whole clip, built from frames sampled
       across it (median cut on a 262,144-bin color histogram, then two
       rounds of k-means), so colors don't flicker from frame to frame.
    2. Dithering, so gradients don't band. "Smooth" uses error diffusion
       (Sierra Lite), "Pattern" uses a fixed 8x8 Bayer matrix.
    3. A pixel that would get the same palette color as the one already on
       screen is left transparent, so the previous frame shows through.
       That part is lossless and makes the file much smaller.
*/
import { GIFEncoder } from './vendor/gifenc.esm.js';

const BITS = 6;
const SH = 8 - BITS;
const BINS = 1 << (3 * BITS);
const key6 = (r, g, b) => ((r >> SH) << (2 * BITS)) | ((g >> SH) << BITS) | (b >> SH);

const BAYER8 = (() => {
  const m = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38,
    60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
  return Float32Array.from(m, (v) => (v + 0.5) / 64 - 0.5);
})();

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
export class Histogram {
  constructor() {
    this.n = new Float64Array(BINS);
    this.r = new Float64Array(BINS);
    this.g = new Float64Array(BINS);
    this.b = new Float64Array(BINS);
  }
  add(rgba) {
    const { n, r, g, b } = this;
    for (let i = 0; i < rgba.length; i += 4) {
      const R = rgba[i], G = rgba[i + 1], B = rgba[i + 2];
      const k = key6(R, G, B);
      n[k]++; r[k] += R; g[k] += G; b[k] += B;
    }
  }
}

export function buildPalette(hist, maxColors = 255) {
  // Gather the non-empty bins as weighted points.
  const idx = [];
  for (let k = 0; k < BINS; k++) if (hist.n[k]) idx.push(k);
  const m = idx.length;
  const W = new Float64Array(m), P = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];
  for (let i = 0; i < m; i++) {
    const k = idx[i], c = hist.n[k];
    W[i] = c; P[0][i] = hist.r[k] / c; P[1][i] = hist.g[k] / c; P[2][i] = hist.b[k] / c;
  }
  if (m <= maxColors) {
    return Array.from({ length: m }, (_, i) => [Math.round(P[0][i]), Math.round(P[1][i]), Math.round(P[2][i])]);
  }

  // Median cut: keep splitting the box with the largest weighted variance.
  const order = new Int32Array(m);
  for (let i = 0; i < m; i++) order[i] = i;
  const stats = (lo, hi) => {
    let w = 0; const s = [0, 0, 0], q = [0, 0, 0];
    for (let j = lo; j < hi; j++) {
      const i = order[j], c = W[i];
      w += c;
      for (let a = 0; a < 3; a++) { const v = P[a][i]; s[a] += c * v; q[a] += c * v * v; }
    }
    const varA = [0, 1, 2].map((a) => q[a] - (s[a] * s[a]) / w);
    let axis = 0;
    if (varA[1] > varA[axis]) axis = 1;
    if (varA[2] > varA[axis]) axis = 2;
    return { lo, hi, w, mean: s.map((x) => x / w), score: hi - lo > 1 ? varA[0] + varA[1] + varA[2] : -1, axis };
  };
  const boxes = [stats(0, m)];
  while (boxes.length < maxColors) {
    let bi = 0;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[bi].score) bi = i;
    const bx = boxes[bi];
    if (bx.score <= 0) break;
    const a = bx.axis, arr = P[a];
    const sub = Array.from(order.subarray(bx.lo, bx.hi)).sort((x, y) => arr[x] - arr[y]);
    order.set(sub, bx.lo);
    let acc = 0, cut = bx.lo + 1;
    for (let j = bx.lo; j < bx.hi - 1; j++) {
      acc += W[order[j]];
      if (acc >= bx.w / 2) { cut = j + 1; break; }
      cut = j + 2;
    }
    cut = Math.min(Math.max(cut, bx.lo + 1), bx.hi - 1);
    boxes.splice(bi, 1, stats(bx.lo, cut), stats(cut, bx.hi));
  }
  let pal = boxes.map((bx) => bx.mean.slice());

  // Two rounds of weighted k-means to pull each color to the middle of its pixels.
  const assign = new Int32Array(m);
  for (let round = 0; round < 2; round++) {
    const k = pal.length;
    const pr = Float64Array.from(pal, (c) => c[0]), pg = Float64Array.from(pal, (c) => c[1]), pb = Float64Array.from(pal, (c) => c[2]);
    for (let i = 0; i < m; i++) {
      const r = P[0][i], g = P[1][i], b = P[2][i];
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const dr = pr[j] - r, dg = pg[j] - g, db = pb[j] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = j; }
      }
      assign[i] = best;
    }
    const sw = new Float64Array(k), sr = new Float64Array(k), sg = new Float64Array(k), sb = new Float64Array(k);
    for (let i = 0; i < m; i++) { const j = assign[i], c = W[i]; sw[j] += c; sr[j] += c * P[0][i]; sg[j] += c * P[1][i]; sb[j] += c * P[2][i]; }
    pal = pal.map((c, j) => (sw[j] ? [sr[j] / sw[j], sg[j] / sw[j], sb[j] / sw[j]] : c));
  }
  return pal.map((c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------
export class GifBuilder {
  constructor(width, height, palette, opts = {}) {
    this.w = width;
    this.h = height;
    this.n = width * height;
    this.dither = opts.dither || 'smooth'; // 'smooth' | 'pattern' | 'none'
    this.diff = opts.diff !== false;
    this.T = palette.length;                // transparent index, one past the colors
    this.table = palette.concat([[0, 0, 0]]);
    this.pr = Int32Array.from(palette, (c) => c[0]);
    this.pg = Int32Array.from(palette, (c) => c[1]);
    this.pb = Int32Array.from(palette, (c) => c[2]);
    this.gif = GIFEncoder();
    this.idx = new Uint8Array(this.n);
    this.shown = new Uint8Array(this.n);    // palette index currently on screen per pixel
    this.cache = new Int16Array(BINS).fill(-1);
    this.err = this.dither === 'smooth' ? [new Float32Array((width + 2) * 3), new Float32Array((width + 2) * 3)] : null;
    this.frames = 0;
  }

  nearest(r, g, b) {
    const k = key6(r, g, b);
    let c = this.cache[k];
    if (c >= 0) return c;
    const R = ((r >> SH) << SH) + (1 << (SH - 1)), G = ((g >> SH) << SH) + (1 << (SH - 1)), B = ((b >> SH) << SH) + (1 << (SH - 1));
    const { pr, pg, pb, T } = this;
    let best = 0, bd = 1e9;
    for (let i = 0; i < T; i++) {
      const dr = pr[i] - R, dg = pg[i] - G, db = pb[i] - B;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    this.cache[k] = best;
    return best;
  }

  addFrame(rgba, delayCs) {
    const { w, h, idx, shown, T, pr, pg, pb } = this;
    const first = this.frames === 0;
    const diff = this.diff && !first;
    const mode = this.dither;
    let p = 0;
    if (mode === 'smooth') {
      // Sierra Lite error diffusion: 2/4 right, 1/4 down-left, 1/4 down.
      let [cur, nxt] = this.err;
      cur.fill(0);
      for (let y = 0; y < h; y++) {
        nxt.fill(0);
        for (let x = 0; x < w; x++, p++) {
          const s = p << 2, e = (x + 1) * 3;
          let r = rgba[s] + cur[e], g = rgba[s + 1] + cur[e + 1], b = rgba[s + 2] + cur[e + 2];
          r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
          g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
          b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
          let k = this.nearest(r, g, b);
          // If what's already on screen is just as close, keep it (transparent).
          if (diff && k !== shown[p]) {
            const o = shown[p];
            const d1 = (pr[k] - r) ** 2 + (pg[k] - g) ** 2 + (pb[k] - b) ** 2;
            const d0 = (pr[o] - r) ** 2 + (pg[o] - g) ** 2 + (pb[o] - b) ** 2;
            if (d0 <= d1 + 12) k = o;
          }
          const er = r - pr[k], eg = g - pg[k], eb = b - pb[k];
          cur[e + 3] += er * 0.5; cur[e + 4] += eg * 0.5; cur[e + 5] += eb * 0.5;
          nxt[e - 3] += er * 0.25; nxt[e - 2] += eg * 0.25; nxt[e - 1] += eb * 0.25;
          nxt[e] += er * 0.25; nxt[e + 1] += eg * 0.25; nxt[e + 2] += eb * 0.25;
          if (diff && k === shown[p]) idx[p] = T;
          else { idx[p] = k; shown[p] = k; }
        }
        const t = cur; cur = nxt; nxt = t;
      }
      this.err = [cur, nxt];
    } else {
      const amp = mode === 'pattern' ? 28 : 0;
      for (let y = 0; y < h; y++) {
        const row = (y & 7) << 3;
        for (let x = 0; x < w; x++, p++) {
          const s = p << 2;
          let r = rgba[s], g = rgba[s + 1], b = rgba[s + 2];
          if (amp) {
            const o = BAYER8[row | (x & 7)] * amp;
            r += o; g += o; b += o;
            r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
            g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
            b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
          }
          const k = this.nearest(r, g, b);
          if (diff && k === shown[p]) idx[p] = T;
          else { idx[p] = k; shown[p] = k; }
        }
      }
    }
    this.gif.writeFrame(idx, w, h, {
      palette: first ? this.table : undefined,
      delay: delayCs * 10,
      transparent: diff,
      transparentIndex: T,
      dispose: 1,
      repeat: 0,
    });
    this.frames++;
  }

  get size() {
    return this.gif.bytesView().length;
  }

  finish() {
    this.gif.finish();
    return this.gif.bytes();
  }
}
