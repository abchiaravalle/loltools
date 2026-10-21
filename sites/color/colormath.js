/*
  colorpicker.lol color math. Plain JavaScript, no libraries, no network.
  Loaded by the page (as window.colormath) and by palette-worker.js (as self.colormath).

  Every color the page works with is an 8-bit sRGB color: r, g, b and a are
  whole numbers from 0 to 255. All the other formats are worked out from those.

  Formulas used:
  - HSL and HSV/HSB: the standard hexcone formulas (same as Python's colorsys
    and the CSS Color 4 spec).
  - CMYK: the simple K = 1 - max(R,G,B) formula. It's a screen-to-print
    approximation, not a print-accurate conversion with an ICC profile.
  - OKLCH: Bjorn Ottosson's OKLab matrices (as used by CSS Color 4), from
    linear sRGB.
  - Relative luminance and contrast ratio: WCAG 2.x. Linearization uses the
    sRGB standard threshold 0.04045. WCAG 2.0's text says 0.03928; no 8-bit
    value falls between the two (10/255 = 0.0392 is below both, 11/255 = 0.0431
    is above both), so the results are identical for every 8-bit color.
  - Contrast ratio = (L1 + 0.05) / (L2 + 0.05), with L1 the lighter color.
*/
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const byte = (v) => clamp(Math.round(v), 0, 255);
  const hex2 = (n) => n.toString(16).padStart(2, '0');

  // Round to d decimals and drop trailing zeros: 66.66667 -> "66.7", 50 -> "50".
  function num(v, d) {
    const f = Math.pow(10, d);
    let r = Math.round(v * f) / f;
    if (Object.is(r, -0)) r = 0;
    return String(r);
  }

  // ---- CSS named colors (CSS Color 4, all 148 plus transparent) -------------
  const NAMES = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
    beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
    blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
    chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
    darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
    darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
    darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
    deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff',
    firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
    ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000',
    greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
    indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
    lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff',
    lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1',
    lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
    lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6',
    magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
    mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
    mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
    navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23',
    orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98',
    paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f',
    pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
    red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
    sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0',
    skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
    springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8',
    tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
    whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
  };
  // Reverse lookup for "this color has a CSS name". Prefer the spelling people use most.
  const PREFER = { '00ffff': 'cyan', 'ff00ff': 'magenta', 'a9a9a9': 'darkgray', '2f4f4f': 'darkslategray', '696969': 'dimgray',
    '808080': 'gray', 'd3d3d3': 'lightgray', '778899': 'lightslategray', '708090': 'slategray' };
  const BY_HEX = {};
  for (const [n, h] of Object.entries(NAMES)) if (!BY_HEX[h]) BY_HEX[h] = n;
  Object.assign(BY_HEX, PREFER);

  // ---- sRGB <-> linear ------------------------------------------------------
  function toLinear(c8) {
    const c = c8 / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function fromLinear(l) {
    const c = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return c * 255;
  }

  // ---- RGB -> other spaces ----------------------------------------------------
  function hue(r, g, b, max, d) {
    if (d === 0) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }
  function rgbToHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h: hue(r, g, b, max, d), s: s * 100, l: l * 100 };
  }
  function rgbToHsv(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    return { h: hue(r, g, b, max, d), s: max === 0 ? 0 : (d / max) * 100, v: max * 100 };
  }
  function rgbToCmyk(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const k = 1 - Math.max(r, g, b);
    if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
    return { c: ((1 - r - k) / (1 - k)) * 100, m: ((1 - g - k) / (1 - k)) * 100, y: ((1 - b - k) / (1 - k)) * 100, k: k * 100 };
  }
  function linToOklab(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return {
      L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    };
  }
  function rgbToOklab(c) { return linToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b)); }
  function rgbToOklch(c) {
    const o = rgbToOklab(c);
    const C = Math.hypot(o.a, o.b);
    let h = Math.atan2(o.b, o.a) * 180 / Math.PI;
    if (h < 0) h += 360;
    // Grays have no hue. Below this chroma the angle is just float noise.
    if (C < 2e-4) h = 0;
    return { l: o.L, c: C, h };
  }

  // ---- other spaces -> RGB ----------------------------------------------------
  function hslToRgb(h, s, l) { // h deg, s/l 0..1, returns floats 0..255
    h = ((h % 360) + 360) % 360;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  }
  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5) * 255, f(3) * 255, f(1) * 255];
  }
  function oklabToLinear(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }

  // ---- WCAG 2.x -----------------------------------------------------------------
  function luminance(c) {
    return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  }
  // Put a see-through color on top of an opaque one (WCAG says to blend first).
  function over(fg, bg) {
    const a = fg.a / 255;
    return { r: byte(fg.r * a + bg.r * (1 - a)), g: byte(fg.g * a + bg.g * (1 - a)), b: byte(fg.b * a + bg.b * (1 - a)), a: 255 };
  }
  function contrast(fg, bg) {
    const bgo = bg.a < 255 ? over(bg, { r: 255, g: 255, b: 255, a: 255 }) : bg;
    const fgo = fg.a < 255 ? over(fg, bgo) : fg;
    const l1 = luminance(fgo), l2 = luminance(bgo);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  // Two decimals, but never show a number that looks like a pass when it isn't
  // (4.499 would round to 4.50, so it shows as 4.49).
  function formatRatio(r) {
    let s = (Math.round(r * 100) / 100).toFixed(2);
    for (const t of [3, 4.5, 7]) if (r < t && parseFloat(s) >= t) s = (Math.floor(r * 100) / 100).toFixed(2);
    return s;
  }
  function wcag(ratio) {
    return {
      ratio,
      text: formatRatio(ratio),
      aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5, ui: ratio >= 3,
    };
  }

  // ---- Parsing ------------------------------------------------------------------
  const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
  function splitArgs(inner, channels) {
    // Accepts "1, 2, 3", "1 2 3", "1 2 3 / 50%", "1, 2, 3, 0.5".
    inner = inner.trim();
    let alpha = null;
    const slash = inner.split('/');
    if (slash.length > 2) return null;
    if (slash.length === 2) { alpha = slash[1].trim(); inner = slash[0].trim(); if (!alpha) return null; }
    const commas = inner.includes(',');
    const parts = (commas ? inner.split(',') : inner.split(/\s+/)).map((x) => x.trim());
    if (parts.some((x) => x === '')) return null;
    if (alpha === null && parts.length === channels + 1) alpha = parts.pop();
    if (parts.length !== channels) return null;
    return { parts, alpha };
  }
  const isNum = (s) => new RegExp('^' + NUM + '$', 'i').test(s);
  const isPct = (s) => new RegExp('^' + NUM + '%$', 'i').test(s);
  function parseAlpha(s) {
    if (s == null) return 255;
    if (s === 'none') return 0;
    if (isPct(s)) return byte(clamp(parseFloat(s) / 100, 0, 1) * 255);
    if (isNum(s)) return byte(clamp(parseFloat(s), 0, 1) * 255);
    return NaN;
  }
  function parseHue(s) {
    if (s === 'none') return 0;
    const m = new RegExp('^(' + NUM + ')(deg|grad|rad|turn)?$', 'i').exec(s);
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    switch ((m[2] || 'deg').toLowerCase()) {
      case 'grad': return v * 0.9;
      case 'rad': return v * 180 / Math.PI;
      case 'turn': return v * 360;
      default: return v;
    }
  }
  // "50%" or "50" both mean 50 percent here (CSS allows bare numbers in the new syntax).
  function parsePct(s) {
    if (s === 'none') return 0;
    if (isPct(s)) return parseFloat(s);
    if (isNum(s)) return parseFloat(s);
    return NaN;
  }

  function fromHex(h) {
    if (h.length === 3 || h.length === 4) h = h.split('').map((ch) => ch + ch).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 255 };
  }

  // Returns { r, g, b, a } (0..255 integers), plus clipped: true when the input
  // was outside sRGB and had to be pulled back in. Returns null if it's not a color.
  function parse(input) {
    if (input == null) return null;
    let s = String(input).trim().toLowerCase().replace(/;$/, '').trim();
    if (!s) return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (NAMES[s]) return fromHex(NAMES[s]);
    let m = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) return fromHex(m[1]);
    m = /^([a-z]+)\s*\((.*)\)$/.exec(s);
    if (!m) return null;
    const fn = m[1];
    const isCmyk = fn === 'cmyk' || fn === 'device-cmyk';
    const args = splitArgs(m[2], isCmyk ? 4 : 3);
    if (!args) return null;
    const p = args.parts;
    const a = parseAlpha(args.alpha);
    if (Number.isNaN(a)) return null;
    let rgb;
    let clipped = false;
    if (fn === 'rgb' || fn === 'rgba') {
      rgb = p.map((x) => {
        if (x === 'none') return 0;
        if (isPct(x)) return parseFloat(x) * 2.55;
        if (isNum(x)) return parseFloat(x);
        return NaN;
      });
      if (rgb.some((v) => v < -0.5 || v > 255.5)) clipped = true;
    } else if (fn === 'hsl' || fn === 'hsla') {
      const h = parseHue(p[0]), sat = parsePct(p[1]), l = parsePct(p[2]);
      if ([h, sat, l].some(Number.isNaN)) return null;
      rgb = hslToRgb(h, clamp(sat, 0, 100) / 100, clamp(l, 0, 100) / 100);
    } else if (fn === 'hsv' || fn === 'hsb') {
      const h = parseHue(p[0]), sat = parsePct(p[1]), v = parsePct(p[2]);
      if ([h, sat, v].some(Number.isNaN)) return null;
      rgb = hsvToRgb(h, clamp(sat, 0, 100) / 100, clamp(v, 0, 100) / 100);
    } else if (isCmyk) {
      // cmyk(c, m, y, k) with percentages, or plain numbers from 0 to 1.
      const v = p.map((x) => (isPct(x) ? parseFloat(x) / 100 : isNum(x) ? parseFloat(x) : NaN));
      if (v.some(Number.isNaN)) return null;
      const [c, mm, y, k] = v.map((x) => clamp(x, 0, 1));
      rgb = [255 * (1 - c) * (1 - k), 255 * (1 - mm) * (1 - k), 255 * (1 - y) * (1 - k)];
    } else if (fn === 'oklch' || fn === 'oklab') {
      let L = p[0] === 'none' ? 0 : isPct(p[0]) ? parseFloat(p[0]) / 100 : isNum(p[0]) ? parseFloat(p[0]) : NaN;
      let A, B;
      if (fn === 'oklch') {
        const C = p[1] === 'none' ? 0 : isPct(p[1]) ? parseFloat(p[1]) / 100 * 0.4 : isNum(p[1]) ? parseFloat(p[1]) : NaN;
        const h = parseHue(p[2]);
        if ([L, C, h].some(Number.isNaN)) return null;
        A = Math.max(0, C) * Math.cos(h * Math.PI / 180);
        B = Math.max(0, C) * Math.sin(h * Math.PI / 180);
      } else {
        const ab = (x) => (x === 'none' ? 0 : isPct(x) ? parseFloat(x) / 100 * 0.4 : isNum(x) ? parseFloat(x) : NaN);
        A = ab(p[1]); B = ab(p[2]);
        if ([L, A, B].some(Number.isNaN)) return null;
      }
      L = clamp(L, 0, 1);
      rgb = oklabToLinear(L, A, B).map(fromLinear);
      if (rgb.some((v) => v < -0.5 || v > 255.5)) clipped = true;
    } else {
      return null;
    }
    if (rgb.some(Number.isNaN)) return null;
    const out = { r: byte(rgb[0]), g: byte(rgb[1]), b: byte(rgb[2]), a };
    if (clipped) out.clipped = true;
    return out;
  }

  // ---- Formatting -------------------------------------------------------------
  const alphaStr = (a) => num(a / 255, 3);
  function toHex(c) {
    return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b) + (c.a < 255 ? hex2(c.a) : '');
  }
  function formats(c) {
    const hsl = rgbToHsl(c), hsv = rgbToHsv(c), cmyk = rgbToCmyk(c), lch = rgbToOklch(c);
    const A = c.a < 255;
    // A hue that rounds to 360 is shown as 0.
    const h1 = (h) => { const s = num(h, 1); return s === '360' ? '0' : s; };
    const h2 = (h) => { const s = num(h, 2); return s === '360' ? '0' : s; };
    return {
      hex: toHex(c),
      rgb: A ? `rgba(${c.r}, ${c.g}, ${c.b}, ${alphaStr(c.a)})` : `rgb(${c.r}, ${c.g}, ${c.b})`,
      hsl: A ? `hsla(${h1(hsl.h)}, ${num(hsl.s, 1)}%, ${num(hsl.l, 1)}%, ${alphaStr(c.a)})` : `hsl(${h1(hsl.h)}, ${num(hsl.s, 1)}%, ${num(hsl.l, 1)}%)`,
      hsv: `hsv(${h1(hsv.h)}, ${num(hsv.s, 1)}%, ${num(hsv.v, 1)}%)`,
      cmyk: `cmyk(${num(cmyk.c, 0)}%, ${num(cmyk.m, 0)}%, ${num(cmyk.y, 0)}%, ${num(cmyk.k, 0)}%)`,
      oklch: `oklch(${num(lch.l * 100, 2)}% ${num(lch.c, 4)} ${h2(lch.h)}${A ? ' / ' + alphaStr(c.a) : ''})`,
      name: c.a === 255 ? (BY_HEX[toHex(c).slice(1)] || null) : (c.a === 0 && c.r === 0 && c.g === 0 && c.b === 0 ? 'transparent' : null),
    };
  }

  // Distance in OKLab (handy "how different do these look" number).
  function deltaOk(c1, c2) {
    const a = rgbToOklab(c1), b = rgbToOklab(c2);
    return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
  }

  // ---- Palette: the k most common color groups in an image ------------------
  // data: RGBA bytes (ImageData.data). Pixels under 50% opacity are skipped.
  // 1. Count pixels into 32x32x32 boxes (5 bits per channel).
  // 2. Weighted k-means on those boxes in OKLab, seeded deterministically
  //    (biggest box first, then the box with the largest count x distance^2).
  // 3. Each group is shown as the average of its single most common box, so the
  //    swatch is a color that's really in the image, not a muddy blend.
  // Returns [{ r, g, b, a: 255, share }] sorted biggest first.
  function palette(data, k) {
    k = clamp(k | 0, 1, 16);
    const BITS = 5, SH = 8 - BITS, N = 1 << (3 * BITS);
    const cnt = new Uint32Array(N), sr = new Float64Array(N), sg = new Float64Array(N), sb = new Float64Array(N);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const idx = ((r >> SH) << (2 * BITS)) | ((g >> SH) << BITS) | (b >> SH);
      cnt[idx]++; sr[idx] += r; sg[idx] += g; sb[idx] += b; total++;
    }
    if (!total) return [];
    const bins = [];
    for (let i = 0; i < N; i++) {
      if (!cnt[i]) continue;
      const c = { r: sr[i] / cnt[i], g: sg[i] / cnt[i], b: sb[i] / cnt[i] };
      const lab = linToOklab(toLinear(c.r), toLinear(c.g), toLinear(c.b));
      bins.push({ w: cnt[i], c, L: lab.L, A: lab.a, B: lab.b, k: 0 });
    }
    const d2 = (p, q) => (p.L - q.L) ** 2 + (p.A - q.A) ** 2 + (p.B - q.B) ** 2;
    // Seeding.
    let first = bins[0];
    for (const p of bins) if (p.w > first.w) first = p;
    const centers = [{ L: first.L, A: first.A, B: first.B }];
    const minD = bins.map((p) => d2(p, first));
    while (centers.length < k) {
      let best = -1, score = 0;
      for (let i = 0; i < bins.length; i++) {
        const s = bins[i].w * minD[i];
        if (s > score) { score = s; best = i; }
      }
      if (best < 0 || minD[best] < 1e-6) break; // fewer distinct colors than k
      const c = bins[best];
      centers.push({ L: c.L, A: c.A, B: c.B });
      for (let i = 0; i < bins.length; i++) minD[i] = Math.min(minD[i], d2(bins[i], c));
    }
    // Lloyd iterations.
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (const p of bins) {
        let bi = 0, bd = Infinity;
        for (let j = 0; j < centers.length; j++) { const d = d2(p, centers[j]); if (d < bd) { bd = d; bi = j; } }
        if (p.k !== bi) { p.k = bi; moved = true; }
      }
      const acc = centers.map(() => ({ L: 0, A: 0, B: 0, w: 0 }));
      for (const p of bins) { const a = acc[p.k]; a.L += p.L * p.w; a.A += p.A * p.w; a.B += p.B * p.w; a.w += p.w; }
      acc.forEach((a, j) => { if (a.w) centers[j] = { L: a.L / a.w, A: a.A / a.w, B: a.B / a.w }; });
      if (!moved && it > 0) break;
    }
    const groups = centers.map(() => ({ w: 0, peak: null }));
    for (const p of bins) {
      const g = groups[p.k];
      g.w += p.w;
      if (!g.peak || p.w > g.peak.w) g.peak = p;
    }
    let out = groups.filter((g) => g.w > 0).sort((x, y) => y.w - x.w).map((g) => ({
      r: byte(g.peak.c.r), g: byte(g.peak.c.g), b: byte(g.peak.c.b), a: 255, share: g.w / total,
    }));
    // Two groups can land on the same box color; fold them together.
    const merged = [];
    for (const c of out) {
      const twin = merged.find((m) => deltaOk(m, c) < 0.02);
      if (twin) twin.share += c.share; else merged.push(c);
    }
    out = merged.sort((x, y) => y.share - x.share);
    return out;
  }

  root.colormath = {
    NAMES, parse, toHex, formats, rgbToHsl, rgbToHsv, rgbToCmyk, rgbToOklab, rgbToOklch, linToOklab, toLinear, fromLinear,
    hslToRgb, hsvToRgb, luminance, contrast, formatRatio, wcag, over, deltaOk, palette,
  };
})(typeof self !== 'undefined' ? self : this);
