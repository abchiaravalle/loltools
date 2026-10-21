#!/usr/bin/env node
/*
  nobg.lol vendor build. Regenerates sites/nobg/vendor/imgly/ from the upstream packages.
  This is the "how the served files were made" record for the AGPL-licensed parts.

  Inputs (install into _work/nobg/, never the repo root):
    cd _work/nobg
    npm install @imgly/background-removal@1.7.0 onnxruntime-web@1.21.0
    # The model data package for 1.7.0 isn't on npm; IMG.LY publishes it as a tarball
    # (see the "Custom Asset Serving" section of the library README):
    curl -L -o data-1.7.0.tgz https://staticimgly.com/@imgly/background-removal-data/1.7.0/package.tgz
    mkdir -p data170 && tar -xzf data-1.7.0.tgz -C data170

  Run:
    node tests/nobg/build-vendor.mjs                       # -> sites/nobg/vendor/imgly, model isnet_fp16
    node tests/nobg/build-vendor.mjs <outDir> isnet_quint8 isnet_fp16 isnet   # (benchmarking)

  What it does:
    1. Copies @imgly/background-removal/dist/index.mjs with five small patches (listed in
       PATCHES below and written to PATCHES.md next to it).
    2. Copies onnxruntime-web's wasm-only API build (ort.wasm.min.mjs) and its emscripten
       glue (ort-wasm-simd-threaded.mjs). These two and the .wasm all come from the same
       onnxruntime-web 1.21.0 release, so they match each other.
    3. Splits ort-wasm-simd-threaded.wasm into 4 MiB chunks named by SHA-256 (the same scheme
       IMG.LY uses for the model), and copies the chosen model's chunks from the data package.
    4. Writes a resources.json that lists only those files.
*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, '_work/nobg');
const NM = path.join(WORK, 'node_modules');
const DATA = path.join(WORK, 'data170/package/dist');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'sites/nobg/vendor/imgly'));
const variants = process.argv.slice(3).length ? process.argv.slice(3) : ['isnet_fp16'];
const CHUNK = 4 * 1024 * 1024;

const imglyPkg = JSON.parse(fs.readFileSync(path.join(NM, '@imgly/background-removal/package.json'), 'utf8'));
const ortPkg = JSON.parse(fs.readFileSync(path.join(NM, 'onnxruntime-web/package.json'), 'utf8'));
const dataPkg = JSON.parse(fs.readFileSync(path.join(DATA, '../package.json'), 'utf8'));
if (imglyPkg.version !== '1.7.0' || ortPkg.version !== '1.21.0' || dataPkg.version !== '1.7.0') {
  throw new Error(`unexpected versions: imgly ${imglyPkg.version}, ort ${ortPkg.version}, data ${dataPkg.version}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const stripMap = (s) => s.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');

// ---- 1. the library, patched -------------------------------------------------
const PATCHES = [
  {
    why: 'Load the wasm-only onnxruntime build that sits next to this file. Upstream imports the bare specifier "onnxruntime-web", which only works inside a bundler.',
    from: 'ort = (await import("onnxruntime-web")).default;',
    to: 'ort = (await import("./ort.wasm.min.mjs")).default;',
  },
  {
    why: 'Same for the WebGPU branch. nobg.lol always runs on the CPU (device "cpu"), so this branch is never taken, but it must not point at a file we don\'t ship.',
    from: 'ort = (await import("onnxruntime-web/webgpu")).default;',
    to: 'ort = (await import("./ort.wasm.min.mjs")).default;',
  },
  {
    why: 'Upstream turns the wasm and its glue script into blob: URLs, which a strict Content-Security-Policy (script-src \'self\') refuses to run. Instead: fetch the wasm bytes through resources.json (so the download still reports progress) and hand them to onnxruntime directly, and load the glue script from its normal same-origin URL.',
    from: [
      '  const wasmPath = await loadAsUrl(`${baseFilePath}.wasm`, config);',
      '  const mjsPath = await loadAsUrl(`${baseFilePath}.mjs`, config);',
      '  ort2.env.wasm.wasmPaths = {',
      '    mjs: mjsPath,',
      '    wasm: wasmPath',
      '  };',
    ].join('\n'),
    to: [
      '  ort2.env.wasm.wasmBinary = await (await loadAsBlob(`${baseFilePath}.wasm`, config)).arrayBuffer();',
      '  ort2.env.wasm.wasmPaths = { mjs: new URL("ort-wasm-simd-threaded.mjs", config.publicPath).href };',
    ].join('\n'),
  },
  {
    why: 'Threads: use up to 4 when the page is cross-origin isolated (nobg.lol sends COOP/COEP headers), otherwise 1, instead of every core. More than 4 barely helps and makes phones hot; asking for threads without isolation only logs a warning.',
    from: 'var maxNumThreads = () => navigator.hardwareConcurrency ?? 4;',
    to: 'var maxNumThreads = () => globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 4)) : 1;',
  },
  {
    why: 'Default asset location. Upstream defaults to IMG.LY\'s CDN; nobg.lol always passes its own publicPath, and this makes a missing one fail instead of reaching a third party.',
    from: '"https://staticimgly.com/@imgly/background-removal-data/${PACKAGE_VERSION}/dist/"',
    to: '"/vendor/imgly/"',
  },
];
let lib = fs.readFileSync(path.join(NM, '@imgly/background-removal/dist/index.mjs'), 'utf8');

// The bundled ndarray 1.0.19 builds its classes from strings with new Function(), which needs
// script-src 'unsafe-eval'. The library only ever calls ndarray(data, shape) and then reads
// .data/.shape and calls .get()/.set() with plain indexes, so a small hand-written version
// covers it and lets the CSP stay strict.
{
  const start = lib.indexOf('var require_ndarray = __commonJS({');
  const endMark = 'module.exports = wrappedNDArrayCtor;\n  }\n});';
  const end = lib.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error('ndarray module not found');
  const original = lib.slice(start, end + endMark.length);
  const shim = `var require_ndarray = __commonJS({
  "ndarray (CSP-safe replacement written for nobg.lol, no new Function)"(exports, module) {
    function NDArray(data, shape, stride, offset) {
      this.data = data;
      this.shape = shape;
      this.stride = stride;
      this.offset = offset;
      this.dimension = shape.length;
      this.dtype = "generic";
    }
    Object.defineProperty(NDArray.prototype, "size", { get: function() {
      var s = 1;
      for (var i = 0; i < this.shape.length; i++) s *= this.shape[i];
      return s;
    } });
    NDArray.prototype.index = function() {
      var p = this.offset;
      for (var i = 0; i < arguments.length; i++) p += this.stride[i] * arguments[i];
      return p;
    };
    NDArray.prototype.get = function(a, b, c, d) {
      var s = this.stride;
      switch (arguments.length) {
        case 1: return this.data[this.offset + s[0] * a];
        case 2: return this.data[this.offset + s[0] * a + s[1] * b];
        case 3: return this.data[this.offset + s[0] * a + s[1] * b + s[2] * c];
        case 4: return this.data[this.offset + s[0] * a + s[1] * b + s[2] * c + s[3] * d];
        default: return this.data[this.index.apply(this, arguments)];
      }
    };
    NDArray.prototype.set = function(a, b, c, d, e) {
      var s = this.stride;
      switch (arguments.length) {
        case 2: return this.data[this.offset + s[0] * a] = b;
        case 3: return this.data[this.offset + s[0] * a + s[1] * b] = c;
        case 4: return this.data[this.offset + s[0] * a + s[1] * b + s[2] * c] = d;
        case 5: return this.data[this.offset + s[0] * a + s[1] * b + s[2] * c + s[3] * d] = e;
        default: {
          var args = Array.prototype.slice.call(arguments, 0, -1);
          return this.data[this.index.apply(this, args)] = arguments[arguments.length - 1];
        }
      }
    };
    module.exports = function ndarray(data, shape, stride, offset) {
      if (data === void 0) data = [];
      if (shape === void 0) shape = [data.length];
      var d = shape.length;
      if (stride === void 0) {
        stride = new Array(d);
        for (var i = d - 1, sz = 1; i >= 0; --i) { stride[i] = sz; sz *= shape[i]; }
      }
      if (offset === void 0) {
        offset = 0;
        for (var j = 0; j < d; ++j) if (stride[j] < 0) offset -= (shape[j] - 1) * stride[j];
      }
      return new NDArray(data, shape, stride, offset);
    };
  }
});`;
  PATCHES.push({ why: 'Replace the bundled ndarray 1.0.19 module, which compiles code from strings with new Function() (blocked unless the CSP allows \'unsafe-eval\'), with a small equivalent that covers every call the library makes: ndarray(data, shape), .data, .shape, .get(), .set().', from: original, to: shim, summary: true });
}

for (const p of PATCHES) {
  const n = lib.split(p.from).length - 1;
  if (n !== 1) throw new Error(`patch target found ${n} times: ${p.from.slice(0, 60)}`);
  lib = lib.replace(p.from, p.to);
}
if (/staticimgly|img\.ly\//.test(lib.replace(/https:\/\/img\.ly\/showcases[^"]*/g, ''))) throw new Error('library still references the IMG.LY CDN');
const banner = `/*
  @imgly/background-removal ${imglyPkg.version} by IMG.LY GmbH, AGPL-3.0.
  Source: https://github.com/imgly/background-removal-js
  Licence: /vendor/licenses/imgly-background-removal.LICENSE.md
  Modified for nobg.lol: see PATCHES.md in this folder. Built by tests/nobg/build-vendor.mjs in
  https://github.com/abchiaravalle/loltools
*/
`;
fs.writeFileSync(path.join(out, 'background-removal.mjs'), banner + stripMap(lib));
fs.writeFileSync(path.join(out, 'PATCHES.md'), `# Changes to @imgly/background-removal ${imglyPkg.version}

\`background-removal.mjs\` is upstream \`dist/index.mjs\` with these replacements and nothing else
(plus a header comment, and the source-map comment removed):

${PATCHES.map((p, i) => `## ${i + 1}. ${p.why}\n\nBefore:\n\n\`\`\`js\n${p.summary ? p.from.split('\n')[0] + '\n  ... the ndarray 1.0.19 module (' + p.from.split('\n').length + ' lines), see upstream dist/index.mjs ...' : p.from}\n\`\`\`\n\nAfter:\n\n\`\`\`js\n${p.summary ? '(the replacement module, ' + p.to.split('\n').length + ' lines, is in background-removal.mjs; search for \"CSP-safe replacement\")' : p.to}\n\`\`\`\n`).join('\n')}
`);

// ---- 2. onnxruntime-web --------------------------------------------------------
const ORT = path.join(NM, 'onnxruntime-web/dist');
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs']) {
  fs.writeFileSync(path.join(out, f), stripMap(fs.readFileSync(path.join(ORT, f), 'utf8')));
}

// ---- 3. chunks + resources.json ---------------------------------------------------
const resources = {};
const wasm = fs.readFileSync(path.join(ORT, 'ort-wasm-simd-threaded.wasm'));
const chunks = [];
for (let o = 0; o < wasm.length; o += CHUNK) {
  const part = wasm.subarray(o, Math.min(o + CHUNK, wasm.length));
  const hash = crypto.createHash('sha256').update(part).digest('hex');
  fs.writeFileSync(path.join(out, hash), part);
  chunks.push({ hash, name: hash, offsets: [o, o + part.length] });
}
resources['/onnxruntime-web/ort-wasm-simd-threaded.wasm'] = { chunks, size: wasm.length, mime: 'application/wasm' };

const dataRes = JSON.parse(fs.readFileSync(path.join(DATA, 'resources.json'), 'utf8'));
for (const v of variants) {
  const e = dataRes[`/models/${v}`];
  if (!e) throw new Error('no model ' + v);
  for (const c of e.chunks) {
    const buf = fs.readFileSync(path.join(DATA, c.name));
    if (crypto.createHash('sha256').update(buf).digest('hex') !== c.hash) throw new Error('hash mismatch ' + c.name);
    fs.writeFileSync(path.join(out, c.name), buf);
  }
  resources[`/models/${v}`] = e;
}
fs.writeFileSync(path.join(out, 'resources.json'), JSON.stringify(resources, null, 1) + '\n');

let total = 0, biggest = 0;
for (const f of fs.readdirSync(out)) { const s = fs.statSync(path.join(out, f)).size; total += s; biggest = Math.max(biggest, s); }
console.log(`vendor -> ${path.relative(ROOT, out)}: ${fs.readdirSync(out).length} files, ${(total / 1048576).toFixed(1)} MiB, biggest ${(biggest / 1048576).toFixed(2)} MiB, models: ${variants.join(', ')}`);
