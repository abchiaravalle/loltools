# vid2gif.lol (KEY=video): notes for the coordinator

No shared changes are needed. FYI:

- **Why no ffmpeg.wasm.** The site uses the browser's own decoders (a `<video>` element + canvas for
  frames, WebCodecs `AudioDecoder` or Web Audio `decodeAudioData` for sound) plus small encoders:
  gifenc (GIF bytes, ~9 KB) and LAME 3.100 as WebAssembly (MP3, 130 KB). Total `dist/video/` is about
  624 KB in 26 files; the largest file is `vendor/mp4box.min.js` at 177 KB. Nothing comes near the 25 MiB limit.
- **CSP.** Only override is `script-src 'self' 'wasm-unsafe-eval'`, needed to run the LAME WebAssembly.
  `connect-src` stays `'none'`: the wasm is embedded as base64 in `/vendor/lame-mp3-wasm.js` (an ES
  module), so nothing is fetched. No `'unsafe-eval'`. No COOP/COEP headers (no threads, no SharedArrayBuffer).
- **LGPL (LAME).** The wasm is the unmodified `mp3.wasm` from wasm-media-encoders 0.7.0, kept as its own
  file and loaded at run time, so it can be swapped. Its sha256 is in the file header and in the credit.
  Licence text is LAME's own COPYING (LGPL 2), at `/vendor/licenses/LAME.COPYING`.
- **mp4box.js** is the npm package's ESM build, bundled to one file with esbuild 0.28.2 (no code changes),
  so the worker can import it without a bundler step in the repo. Rebuild recipe:
  `export { createFile, Log } from 'mp4box';` then
  `npx esbuild entry.mjs --bundle --format=esm --minify --legal-comments=inline`.
- **Workers.** `gif-worker.js` and `mp3-worker.js` are module workers loaded from `/`. The build's
  `checkRefs` only scans HTML, so it won't notice if one goes missing. The test does check they load.
- `tests/serve.cjs` has no MIME type for `.map` (serves `application/octet-stream`). Harmless: only
  DevTools ever asks for `vendor/gifenc.esm.js.map`.
- The test makes its own fixtures with ffmpeg into `_work/video/fixtures/` (BT.709-tagged, because
  untagged HD video is decoded with different color matrices by ffmpeg (BT.601) and Chrome (BT.709)).
