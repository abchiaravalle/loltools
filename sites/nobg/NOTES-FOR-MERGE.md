# nobg.lol: notes for the coordinator

Nothing here needs a shared-file change to work. These are things worth knowing at merge/deploy time.

## 1. Size: 97 MiB, 52 files, biggest 4.00 MiB

`dist/nobg/` is about 97 MiB because it carries the AI model (IS-Net fp16, 88 MB in 22 pieces) and
ONNX Runtime's wasm (12.7 MB in 4 pieces). Every piece is ≤ 4 MiB, far under Pages' 25 MiB limit.
Cloudflare Pages allows 20,000 files per deploy. The total size isn't a limit, but the first
`wrangler pages deploy` will take a little while to upload. Later deploys skip unchanged files,
since the pieces are named by SHA-256.

## 2. Extra headers (in site.json, applied by build.mjs, nothing shared changed)

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

These make the page cross-origin isolated, so ONNX Runtime can use 4 threads (SharedArrayBuffer).
Without them it falls back to 1 thread and still works, just slower. COEP require-corp would block any
cross-origin subresource, but the site has none. The "More free tools" links are plain `<a>`
navigations, which COEP doesn't affect.

## 3. CSP

`script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'`, everything else BASE_CSP.
- `connect-src 'self'`: the worker fetch()es its own model pieces from /vendor/imgly/.
- `'wasm-unsafe-eval'`: compiles the ONNX Runtime wasm.
- `worker-src 'self'`: tighter than the base `'self' blob:`. No blob: workers are used.
- No `'unsafe-eval'`. The upstream library bundles `ndarray`, which calls `new Function()`. The vendor build
  swaps it for a small no-eval equivalent (patch 6 in `vendor/imgly/PATCHES.md`).

## 4. The library is patched. That's fine under the AGPL, and here's how it's disclosed

`sites/nobg/vendor/imgly/background-removal.mjs` = upstream `@imgly/background-removal@1.7.0/dist/index.mjs`
with 6 documented replacements (see `PATCHES.md` next to it): load ort from the same folder; no blob: URLs
for the wasm glue (CSP); threads capped at 4; default publicPath is `/vendor/imgly/`, not IMG.LY's CDN;
no-eval ndarray. `tests/nobg/build-vendor.mjs` regenerates the whole `vendor/imgly/` folder from the
npm packages + IMG.LY's data tarball, so anyone can rebuild it. That's the AGPL "corresponding source".

The 1.7.0 model data isn't on npm (npm's `@imgly/background-removal-data` stops at 1.4.5). It comes from
IMG.LY's published tarball, `https://staticimgly.com/@imgly/background-removal-data/1.7.0/package.tgz`
(this URL is in the library's README). It was downloaded once at build time into `_work/`. The site itself
never contacts IMG.LY, and the test checks that.

## 5. Licence wording on /licenses/

build.mjs's licences page ends with "The site's own code is MIT licensed". That's true for our code. The
nobg credit rows say the bundled library is AGPL-3.0 and link its licence. If you want the page to say
more, a site.json field for an extra licence note would be the shared change. Not required.

## 6. Test hooks in app.js

`window.__nobg` (timings), `window.__nobgProbe(url)` (asks the worker to try a cross-site fetch, which
the CSP blocks), and `window.__nobgNet()` (the worker's Resource Timing list) exist for
`tests/nobg/test.cjs`. They read state only and send nothing anywhere.
