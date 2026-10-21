# loltools: brief for building one site

You're building ONE new site inside the loltools monorepo at `/Users/adamchiaravalle/gits/loltools`.
Other helpers are building other sites in the same repo at the same time. Stay inside your lane.

## Your lane (hard rules)
- Only create or edit files under `sites/<KEY>/` and `tests/<KEY>/`. Use `_work/<KEY>/` for scratch (it's gitignored).
- Do NOT edit `tools.json`, `shared/`, `scripts/`, `vendor/`, `README.md`, or any other site's folder.
  If you need a shared change, write it into `sites/<KEY>/NOTES-FOR-MERGE.md` and work around it locally.
- Do NOT run `git commit`, `git push`, or `scripts/deploy.sh`. Do NOT touch Cloudflare, DNS, or GitHub.
  The coordinator commits and deploys.
- Do NOT run `npm install` in the repo root. Install anything you need under `_work/<KEY>/`, then copy only
  the built browser files you need into `sites/<KEY>/vendor/`.
- Do NOT read or use anything in `~/.hermes/secrets/`. You don't need any credentials.
- Test servers: use ONLY your assigned port. Never kill processes you didn't start.

## The product promise (non-negotiable)
"All anonymous and in browser." Concretely:
1. **No upload, ever.** All processing happens in the visitor's browser tab. No server code (no `functions/`).
2. **No third-party requests.** Every script, wasm, model and font is served from the site's own origin.
   No CDNs, no Google Fonts, no analytics, no cookies. The only storage is `localStorage` for the theme
   (handled by shared `lol.js`) or anything the tool itself needs that stays on the device.
3. **CSP.** Default is `connect-src 'none'`. If your library must `fetch()` its own wasm/model/language files,
   you may set `connect-src 'self'` in `sites/<KEY>/site.json`, and nothing broader. If wasm needs it, add
   `'wasm-unsafe-eval'` to script-src. Never `'unsafe-eval'` unless there's truly no other way, and if so,
   say why in NOTES-FOR-MERGE.md. Never allow any third-party origin.
4. **Prove it.** Your test must record every network request after load and assert that each one is
   same-origin (or blob:/data:). It must also assert that a `fetch('https://example.com/')` from the page
   is blocked.

## How a site is built
Read these first, they're short:
- `scripts/build.mjs` (the header comment documents `site.json`)
- `sites/heic/index.html` + `sites/heic/app.js` (a good reference tool page: dropzone, file list, privacy card, FAQ)
- `sites/qr/index.html` + `sites/qr/qr.css` (a form-driven tool with a live preview)
- `shared/lol.css` + `shared/lol.js` (tokens, components, helpers: `lol.dropzone`, `lol.download`, `lol.el`,
  `lol.setStatus`, `lol.setProgress`, `lol.formatBytes`, `lol.baseName`)
- `tools.json` (your site's entry already exists: name, domain, title, description, emoji, blurb)

Your page `sites/<KEY>/index.html` must contain the 4 partials `<!--@head-->`, `<!--@header-->`,
`<!--@more-->`, `<!--@footer-->`, and a view-source comment at the top listing exactly what the page
loads and that nothing is uploaded. Reference assets with root-absolute paths (`/app.js`, `/vendor/x.js`).
Per-site CSS goes in `sites/<KEY>/<name>.css`. Use the shared tokens, don't invent new colors.

Page structure (same as the other sites): hero (h1 + one-line lede), the tool card, a privacy card
("How your X stays private", 4 items, honest), a FAQ card (4-6 real questions), `<!--@more-->`, footer.

Credits: every third-party library you vendor goes in `site.json` `credits` with name+version, license,
source URL, the served file path, and its licence file (copy the licence text into
`sites/<KEY>/vendor/licenses/`). The build generates `/licenses/` from it.

Build: `node scripts/build.mjs <KEY>` → `dist/<KEY>/`. The build fails on missing refs and on any file over
25 MiB (Cloudflare Pages' limit). Serve locally with the same headers Cloudflare will use:
`node tests/serve.cjs dist/<KEY> <PORT>` (run it in the background; it mimics `_headers`).

## Writing rules (the owner is strict about this)
- Plain words. No jargon in visible copy. Short sentences. Contractions (it's, you're, don't).
- No em dashes anywhere (use commas or periods). No "seamless", "effortless", "powerful", "unleash", etc.
- No small all-caps eyebrow labels above the h1. Card h2s in the existing mono style are fine.
- Every claim must be TRUE. If something has a limit (big files slow on phones, a model download the
  first time, a format you don't support), say so plainly in the FAQ. Don't overstate privacy either:
  Cloudflare keeps standard access logs for any site it hosts, and the other sites already say that.

## Quality bar
- Test in REAL Chrome with Playwright: `require('/tmp/loltest/node_modules/playwright')`,
  `chromium.launch({ channel: 'chrome', headless: true })`. Put your test at `tests/<KEY>/test.cjs`,
  runnable as `node tests/<KEY>/test.cjs http://127.0.0.1:<PORT>/`.
- Test the OUTPUT with an independent tool, not just the page's own UI. Examples on this Mac:
  ImageMagick `magick`, `ffprobe`/`ffmpeg` (check `which`), ghostscript `gs`, `zbarimg`, `sips`, node.
- Cover failure paths (wrong file type, empty input, huge input) with plain-language messages.
- No page errors, no CSP violations in the console, works at 430px wide (screenshot mobile + desktop into
  `_work/<KEY>/` and look at them).
- Keep going until every check passes. If a library can't meet the promise, pick another one, or report
  it honestly. Never fake a pass.

## When you finish, report
- Files created (paths), libraries + versions + licences, total `dist/<KEY>/` size and largest file
- CSP you ended up with and why
- Test results: N/M passed, with the key numbers (e.g. sizes, accuracy, timings)
- Known limits, anything in NOTES-FOR-MERGE.md
- Screenshot paths (desktop + 430px)
