# imgtotext.lol (ocr): notes for merge

Nothing here blocks the merge. These are suggestions for shared files I'm not allowed to edit.

## 1. Long cache for the engine files (build.mjs `_headers`)
`_headers` sets `Cache-Control: public, max-age=0, must-revalidate, no-transform` on `/*`, so every
visit revalidates the ~4 MB engine file and the ~2 MB English file (Cloudflare answers with a 304,
so it's a round trip rather than a re-download). The files under `/vendor/tesseract/` never change
for a given version, so a path rule would make repeat visits faster:

```
/vendor/tesseract/*
  Cache-Control: public, max-age=31536000, immutable, no-transform
```

If you add this, bump the folder name (e.g. `/vendor/tesseract-7.0.0/`) on upgrades. It would need
build.mjs to support per-path header blocks; `site.json` `headers` only applies to `/*` today.

## 2. tests/serve.cjs
Works as-is for this site (it already knows `.gz` and `.wasm`). No change needed.

## 3. Why the CSP is what it is (sites/ocr/site.json)
- `script-src 'self' 'wasm-unsafe-eval'`: the engine is WebAssembly embedded in
  `tesseract-core-*.wasm.js`; compiling it needs `'wasm-unsafe-eval'`. No `'unsafe-eval'`
  (the test records zero CSP violations).
- `connect-src 'self'`: the worker `fetch()`es the language file from `/vendor/tesseract/lang/`.
- `worker-src 'self'` (tighter than the base `'self' blob:`): the app sets `workerBlobURL: false`,
  so tesseract.js starts its worker straight from `/vendor/tesseract/worker.min.js` and never
  makes a `blob:` worker. The worker loads the core with `importScripts` from the same origin.

## 4. Known small things
- `tesseract.esm.min.js` and `worker.min.js` end with a `sourceMappingURL` comment. The `.map`
  files aren't shipped (kept the dist files unmodified), so DevTools shows a 404 for them when it's
  open. Normal visitors never request them.
- The three core builds (relaxed-SIMD, SIMD, plain) are all shipped because tesseract.js picks one
  based on what the browser supports. Current Chrome loads only the relaxed-SIMD one. Each is
  about 3.9 MB, well under the 25 MiB limit. The non-LSTM ("legacy engine") builds aren't shipped
  because the app always uses the LSTM engine.
