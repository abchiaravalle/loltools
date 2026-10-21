# pwgen.lol (pw): notes for merge

Nothing in shared/, scripts/ or tools.json needs to change for this site to build and pass.
Two small things the coordinator may want to know:

1. **`/licenses/` asks for `/favicon.ico` (404).** `licensesPage()` in `scripts/build.mjs` has no
   `<link rel="icon">`, so Chrome requests `/favicon.ico` there. Harmless, affects every site.
   Fix if wanted: add the same `data:` emoji favicon the main page gets. `tests/pw/test.cjs`
   ignores favicon.ico on the credits page only; the tool page itself has zero failed requests.

2. **Chrome logs a *verbose* `[DOM] Password field is not contained in a form`** for the
   "check a password" box. Deliberate: wrapping it in a `<form>` would make Enter try to submit,
   which `form-action 'none'` blocks with a CSP violation in the console. It's verbose level,
   not a warning or error.

How the wordlist was made (for re-builds): `curl` the EFF file into `_work/pw/`, then
`node _work/pw/mkwordlist.cjs` writes `sites/pw/vendor/eff-large-wordlist.js` and the licence
file. The test re-hashes the served list against the EFF file's SHA-256
(`addd3553…6b903e`), so any change to the words fails the test.

CSP: the default (`connect-src 'none'`), no overrides. No `site.json` csp/headers entries.
