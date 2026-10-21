# wordcounter.lol: notes for merge

No shared changes needed. Nothing outside `sites/words/` and `tests/words/` was touched.

## What's here
- `index.html`, `words.css`, `app.js`: the page.
- `count.js`: all counting (words, graphemes, sentences, paragraphs, lines, SMS units). Plain JS,
  uses `Intl.Segmenter` with a regex fallback. Works in Node too (`require('./count.js')`).
- `xcount.js`: X (Twitter) weighted length. **Generated**, don't hand-edit. It's a plain-JS port of
  `parseTweet()` from twitter-text 3.1.0 (Apache-2.0) with the package's URL/TLD regexes copied
  unchanged. Credit + licence are in `site.json` and `vendor/licenses/twitter-text.LICENSE`.
  To regenerate (e.g. a newer TLD list):
  ```
  cd _work/words && npm install twitter-text@3.1.0
  node tests/words/gen-xcount.cjs
  ```
- CSP: the default (`connect-src 'none'`), no overrides. `site.json` only has credits.

## Test
`node tests/words/test.cjs http://127.0.0.1:<PORT>/`

- Uses `swift` (Xcode CLT) as an independent grapheme counter and `wc -w` for word counts.
- X-length checks compare against the real `twitter-text` npm package if it's installed in
  `_work/words/node_modules`. Without it those checks are reported as SKIP (not counted as passes),
  and four hand-computed X cases still run.
- Pastes use real Cmd/Ctrl+V into headless Chrome. Headless Chrome's clipboard is in-memory, so it
  doesn't touch the Mac's clipboard (checked with `pbpaste` before/after).

## Candidates for shared/ later (not done, just noticed)
- `.btn-ghost.sm` and `.check-row` are now defined in both `sites/pdf/pdf.css` and
  `sites/words/words.css` with near-identical rules.
