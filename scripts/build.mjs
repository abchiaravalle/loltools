#!/usr/bin/env node
/*
  loltools build. No dependencies, plain Node.

    node scripts/build.mjs            # build every site into dist/<site>/
    node scripts/build.mjs pdf qr     # build only some

  Each site is one static folder Cloudflare Pages can serve as-is.

  Inputs per site:
    tools.json  sites.<key>      identity: name, domain, project, interim host, live switch,
                                 title/description for the root page, shared vendor files
    sites/<key>/index.html       page template with <!--@head--> <!--@header--> <!--@more--> <!--@footer-->
                                 and optional {{VARS}}
    sites/<key>/site.json        optional per-site build settings (see below)
    sites/<key>/*                everything else is copied as-is (app.js, css, vendor/, model files...)

  site.json (all fields optional):
    {
      "csp":     { "script-src": "'self' 'wasm-unsafe-eval'", "connect-src": "'self'" },  // overrides
      "headers": { "Cross-Origin-Opener-Policy": "same-origin" },                         // extra headers
      "vendor":  ["pdf-lib.min.js"],              // files from the shared vendor/ dir
      "credits": [{ "name": "x 1.0", "license": "MIT", "url": "https://...", "file": "/vendor/x.js",
                    "licenseFile": "/vendor/licenses/x.LICENSE" }],                   // site-owned libs
      "vars":    { "H1": "..." },                 // {{VARS}} for the root page
      "pages":   [{ "path": "split/", "title": "...", "description": "...", "vars": { "H1": "..." } }]
    }

  A site stays noindex (meta robots + X-Robots-Tag) until tools.json marks it "live": true.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools.json'), 'utf8'));
const only = process.argv.slice(2);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const MARK = read('shared/partials/amplifi-mark.svg').trim();
const BUILD_DATE = new Date().toISOString().slice(0, 10);

const BASE_CSP = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob:",
  'media-src': "'self' blob:",
  'worker-src': "'self' blob:",
  'connect-src': "'none'",
  'font-src': "'self'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
};

const SHARED_CREDITS = {
  'pdf-lib.min.js': ['pdf-lib 1.17.1', 'MIT', 'https://github.com/Hopding/pdf-lib', 'pdf-lib.LICENSE.md'],
  'qrcode-generator.js': ['qrcode-generator 2.0.4 by Kazuhiko Arase', 'MIT', 'https://github.com/kazuhikoarase/qrcode-generator', 'qrcode-generator.LICENSE'],
  'jsqr.js': ['jsQR 1.4.0', 'Apache-2.0', 'https://github.com/cozmo/jsQR', 'jsqr.LICENSE'],
  'heic-to.min.js': ['heic-to 1.6.6 (bundles libheif 1.23.6)', 'LGPL-3.0', 'https://github.com/hoppergee/heic-to', 'heic-to.LICENSE'],
  'fflate.min.js': ['fflate 0.8.3', 'MIT', 'https://github.com/101arrowz/fflate', 'fflate.LICENSE'],
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const host = (site) => (site.live ? site.domain : site.interim);

function siteJson(key) {
  const p = path.join(ROOT, 'sites', key, 'site.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function cspString(sj) {
  const d = { ...BASE_CSP, ...(sj.csp || {}) };
  return Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ');
}

function head(site, page, csp) {
  const url = `https://${host(site)}/${page.path || ''}`;
  const robots = site.live ? 'index, follow' : 'noindex, nofollow';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: page.appName || site.name,
    url,
    description: page.description,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any (runs in your web browser)',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    publisher: { '@type': 'Organization', name: 'amplifi.studio', url: 'https://amplifi.studio' },
  };
  const favicon = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>${site.emoji}</text></svg>`;
  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="referrer" content="no-referrer">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.description)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="${esc(favicon)}">
  <link rel="stylesheet" href="/lol.css?v=${BUILD_DATE}">
  <script src="/lol.js?v=${BUILD_DATE}"></script>
  <script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

function header(site) {
  return `<header class="site-header">
      <a href="/" class="brand" aria-label="${esc(site.name)}, by amplifi.studio">
        ${MARK}
        <span class="domain">/ ${esc(site.name)}</span>
      </a>
      <div class="header-actions">
        <a class="icon-btn" href="${cfg.repo}" target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub" title="View source on GitHub">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        </a>
        <button class="icon-btn" type="button" id="themeToggle" aria-label="Toggle color theme" title="Toggle light/dark">
          <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
          <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
    </header>
    <noscript><div class="noscript-msg"><strong>JavaScript is off.</strong> This tool does all its work in your browser with JavaScript, so it can't run without it. There's no server to fall back to.</div></noscript>`;
}

function moreTools(key) {
  const items = Object.entries(cfg.sites).map(([k, s]) => {
    const href = `https://${host(s)}/`;
    const cur = k === key ? ' aria-current="page"' : '';
    return `<li><a href="${href}"${cur}><span class="t-name">${esc(s.name)}</span><span class="t-desc">${esc(s.blurb)}</span></a></li>`;
  });
  for (const x of cfg.extra_links) {
    items.push(`<li><a href="${x.url}"><span class="t-name">${esc(x.name)}</span><span class="t-desc">${esc(x.blurb)}</span></a></li>`);
  }
  return `<section class="card" aria-labelledby="more-heading">
        <h2 id="more-heading">More free tools, same rules</h2>
        <ul class="tools-grid">
          ${items.join('\n          ')}
        </ul>
      </section>`;
}

function footer() {
  return `<footer class="site-footer">
      Built with ❤️ by <a href="https://amplifi.studio">amplifi.studio</a> · <a href="/licenses/">open-source credits</a>
    </footer>`;
}

function creditRows(site, sj) {
  const rows = [];
  const vendor = [...(site.vendor || []), ...(sj.vendor || [])];
  for (const f of vendor) {
    const c = SHARED_CREDITS[f];
    if (!c) throw new Error('No credit entry for shared vendor file ' + f);
    rows.push(`<li><strong>${esc(c[0])}</strong>, ${esc(c[1])}. <a href="${c[2]}">Source</a> · <a href="/licenses/${c[3]}">License text</a> · served here unmodified as <code>/${f}</code></li>`);
  }
  for (const c of sj.credits || []) {
    const lic = c.licenseFile ? ` · <a href="${esc(c.licenseFile)}">License text</a>` : '';
    const file = c.file ? ` · served from this site as <code>${esc(c.file)}</code>` : '';
    const note = c.note ? ` ${esc(c.note)}` : '';
    rows.push(`<li><strong>${esc(c.name)}</strong>, ${esc(c.license)}. <a href="${esc(c.url)}">Source</a>${lic}${file}${note}</li>`);
  }
  return rows;
}

function licensesPage(site, sj) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Open-source credits · ${esc(site.name)}</title>
  <link rel="stylesheet" href="/lol.css?v=${BUILD_DATE}">
</head>
<body>
  <div class="container">
    <section class="card">
      <h2>Open-source credits</h2>
      <p>${esc(site.name)} runs on these open-source projects. Each one is copied into this site, so your browser loads it from us and never from a third-party CDN.</p>
      <ul>
        ${creditRows(site, sj).join('\n        ') || '<li>No third-party libraries. Everything here is our own code.</li>'}
      </ul>
      <p>The site's own code is MIT licensed: <a href="${cfg.repo}">${cfg.repo}</a></p>
      <p><a href="/">Back to ${esc(site.name)}</a></p>
    </section>
  </div>
</body>
</html>
`;
}

function headersFile(site, sj, csp) {
  const lines = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
    `  Content-Security-Policy: ${csp}; frame-ancestors 'none'`,
  ];
  for (const [k, v] of Object.entries(sj.headers || {})) lines.push(`  ${k}: ${v}`);
  if (!site.live) lines.push('  X-Robots-Tag: noindex, nofollow');
  return lines.join('\n') + '\n';
}

function robotsFile(site) {
  // Always Allow: a Disallow would stop crawlers from ever SEEING the noindex.
  let s = '# Crawl away.\nUser-agent: *\nAllow: /\n';
  if (site.live) s += `\nSitemap: https://${site.domain}/sitemap.xml\n`;
  return s;
}

function sitemapFile(site, pages) {
  const urls = pages.map((p) => `  <url><loc>https://${site.domain}/${p.path || ''}</loc><lastmod>${BUILD_DATE}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

function render(key, site, sj, template, page, csp) {
  let html = template;
  const parts = {
    '<!--@head-->': head(site, page, csp),
    '<!--@header-->': header(site),
    '<!--@more-->': moreTools(key),
    '<!--@footer-->': footer(),
  };
  for (const [tag, val] of Object.entries(parts)) {
    if (!html.includes(tag)) throw new Error(`${key}/index.html is missing ${tag}`);
    html = html.split(tag).join(val);
  }
  const vars = { BUILD_DATE, PATH: page.path || '', ...(sj.vars || {}), ...(page.vars || {}) };
  html = html.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`${key}/${page.path || ''}: no value for {{${k}}}`);
    return vars[k];
  });
  if (/<!--@\w+-->/.test(html)) throw new Error(`${key}: unknown partial ${html.match(/<!--@\w+-->/)[0]}`);
  return html;
}

function checkRefs(key, out, html, pagePath) {
  const refs = [...html.matchAll(/(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)].map((m) => m[1])
    .filter((r) => r !== '' && !r.startsWith('data') && !r.startsWith('//'));
  const missing = refs.filter((r) => {
    let p = r.startsWith('/') ? path.join(out, r) : path.join(out, pagePath || '', r);
    if (r.endsWith('/')) p = path.join(p, 'index.html');
    return !fs.existsSync(p);
  });
  if (missing.length) throw new Error(`${key}/${pagePath || ''}: references missing files: ${missing.join(', ')}`);
}

function buildSite(key) {
  const site = cfg.sites[key];
  const sj = siteJson(key);
  const src = path.join(ROOT, 'sites', key);
  const out = path.join(ROOT, 'dist', key);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'licenses'), { recursive: true });

  // Everything in the site's own folder (app.js, css, vendor/, ...) copies as-is.
  for (const f of fs.readdirSync(src)) {
    if (f === 'index.html' || f === 'site.json') continue;
    fs.cpSync(path.join(src, f), path.join(out, f), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'shared/lol.css'), path.join(out, 'lol.css'));
  fs.copyFileSync(path.join(ROOT, 'shared/lol.js'), path.join(out, 'lol.js'));
  for (const v of [...(site.vendor || []), ...(sj.vendor || [])]) {
    fs.copyFileSync(path.join(ROOT, 'vendor', v), path.join(out, v));
  }
  for (const l of fs.readdirSync(path.join(ROOT, 'vendor/licenses'))) {
    fs.copyFileSync(path.join(ROOT, 'vendor/licenses', l), path.join(out, 'licenses', l));
  }

  const csp = cspString(sj);
  const template = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  const pages = [{ path: '', title: site.title, description: site.description }, ...(sj.pages || [])];
  for (const page of pages) {
    const html = render(key, site, sj, template, page, csp);
    const dir = path.join(out, page.path || '');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), html);
  }
  fs.writeFileSync(path.join(out, 'licenses/index.html'), licensesPage(site, sj));
  fs.writeFileSync(path.join(out, '_headers'), headersFile(site, sj, csp));
  fs.writeFileSync(path.join(out, 'robots.txt'), robotsFile(site));
  if (site.live) fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemapFile(site, pages));

  for (const page of pages) {
    checkRefs(key, out, fs.readFileSync(path.join(out, page.path || '', 'index.html'), 'utf8'), page.path);
  }
  // Pages rejects any single file over 25 MiB.
  const big = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (fs.statSync(p).size > 25 * 1024 * 1024) big.push(path.relative(out, p));
  });
  walk(out);
  if (big.length) throw new Error(`${key}: files over Cloudflare Pages' 25 MiB limit: ${big.join(', ')}`);

  console.log(`built ${key.padEnd(6)} -> dist/${key}/ (${pages.length} page${pages.length > 1 ? 's' : ''}, ${site.live ? 'INDEXABLE' : 'noindex'}, host ${host(site)})`);
}

const keys = only.length ? only : Object.keys(cfg.sites);
for (const k of keys) {
  if (!cfg.sites[k]) throw new Error('unknown site ' + k);
  if (!fs.existsSync(path.join(ROOT, 'sites', k, 'index.html'))) { console.log(`skip  ${k} (no sites/${k}/index.html yet)`); continue; }
  buildSite(k);
}
