# Changes to @imgly/background-removal 1.7.0

`background-removal.mjs` is upstream `dist/index.mjs` with these replacements and nothing else
(plus a header comment, and the source-map comment removed):

## 1. Load the wasm-only onnxruntime build that sits next to this file. Upstream imports the bare specifier "onnxruntime-web", which only works inside a bundler.

Before:

```js
ort = (await import("onnxruntime-web")).default;
```

After:

```js
ort = (await import("./ort.wasm.min.mjs")).default;
```

## 2. Same for the WebGPU branch. nobg.lol always runs on the CPU (device "cpu"), so this branch is never taken, but it must not point at a file we don't ship.

Before:

```js
ort = (await import("onnxruntime-web/webgpu")).default;
```

After:

```js
ort = (await import("./ort.wasm.min.mjs")).default;
```

## 3. Upstream turns the wasm and its glue script into blob: URLs, which a strict Content-Security-Policy (script-src 'self') refuses to run. Instead: fetch the wasm bytes through resources.json (so the download still reports progress) and hand them to onnxruntime directly, and load the glue script from its normal same-origin URL.

Before:

```js
  const wasmPath = await loadAsUrl(`${baseFilePath}.wasm`, config);
  const mjsPath = await loadAsUrl(`${baseFilePath}.mjs`, config);
  ort2.env.wasm.wasmPaths = {
    mjs: mjsPath,
    wasm: wasmPath
  };
```

After:

```js
  ort2.env.wasm.wasmBinary = await (await loadAsBlob(`${baseFilePath}.wasm`, config)).arrayBuffer();
  ort2.env.wasm.wasmPaths = { mjs: new URL("ort-wasm-simd-threaded.mjs", config.publicPath).href };
```

## 4. Threads: use up to 4 when the page is cross-origin isolated (nobg.lol sends COOP/COEP headers), otherwise 1, instead of every core. More than 4 barely helps and makes phones hot; asking for threads without isolation only logs a warning.

Before:

```js
var maxNumThreads = () => navigator.hardwareConcurrency ?? 4;
```

After:

```js
var maxNumThreads = () => globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency ?? 4)) : 1;
```

## 5. Default asset location. Upstream defaults to IMG.LY's CDN; nobg.lol always passes its own publicPath, and this makes a missing one fail instead of reaching a third party.

Before:

```js
"https://staticimgly.com/@imgly/background-removal-data/${PACKAGE_VERSION}/dist/"
```

After:

```js
"/vendor/imgly/"
```

## 6. Replace the bundled ndarray 1.0.19 module, which compiles code from strings with new Function() (blocked unless the CSP allows 'unsafe-eval'), with a small equivalent that covers every call the library makes: ndarray(data, shape), .data, .shape, .get(), .set().

Before:

```js
var require_ndarray = __commonJS({
  ... the ndarray 1.0.19 module (252 lines), see upstream dist/index.mjs ...
```

After:

```js
(the replacement module, 59 lines, is in background-removal.mjs; search for "CSP-safe replacement")
```

