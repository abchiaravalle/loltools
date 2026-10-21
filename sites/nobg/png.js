/*
  nobg.lol PNG writer. Plain JavaScript, runs in your browser.

  Why not canvas.toBlob? Two reasons:
    1. A canvas stores colors pre-multiplied by transparency, so soft edges
       (hair, fur) lose a little color on the way out. This writes the exact
       pixels the model gave us.
    2. A photo on a solid color should be a normal RGB PNG with no
       transparency channel at all. Browsers always write RGBA.
  It writes no metadata: no location, no camera, no date.
  Compression uses the browser's built-in CompressionStream('deflate').
*/
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/*
  rgba: Uint8Array/Uint8ClampedArray of width*height*4 bytes.
  channels: 4 for RGBA (keeps transparency), 3 for RGB (drops it; only use when every pixel is opaque).
  Each row uses the Paeth filter, which suits photos.
*/
export async function encodePNG(rgba, width, height, channels) {
  const bpp = channels === 3 ? 3 : 4;
  const stride = width * bpp;
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    // Pack this row (dropping alpha for RGB).
    let s = y * width * 4;
    if (bpp === 4) {
      cur.set(rgba.subarray(s, s + width * 4));
    } else {
      for (let x = 0, d = 0; x < width; x++, s += 4, d += 3) {
        cur[d] = rgba[s]; cur[d + 1] = rgba[s + 1]; cur[d + 2] = rgba[s + 2];
      }
    }
    let o = y * (stride + 1);
    raw[o++] = 4; // Paeth
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[o + i] = (cur[i] - pred) & 0xff;
    }
    prev.set(cur);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;                      // 8 bits per channel
  ihdr[9] = bpp === 4 ? 6 : 2;      // 6 = RGBA, 2 = RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  // sRGB chunk (rendering intent: perceptual) so viewers show the colors as the browser did.
  const srgb = chunk('sRGB', new Uint8Array([0]));
  const idat = chunk('IDAT', await deflate(raw));
  return new Blob([sig, chunk('IHDR', ihdr), srgb, idat, chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
