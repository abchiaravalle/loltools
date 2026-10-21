#!/usr/bin/env node
/*
  loltools build. No dependencies, plain Node.

    node scripts/build.mjs            # build every site into dist/<site>/
    node scripts/build.mjs pdf qr     # build only some

  Each site is one static folder Cloudflare Pages can serve as-is:
  index.html + app.js + the shared CSS/JS + only the vendor files it needs.

  A site stays noindex (meta robots + X-Robots-Tag) until tools.json marks
  it "live": true. That's the launch switch.
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

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function host(site) {
  return site.live ? site.domain : site.interim;
}

function head(key, site) {
  const url = `https://${host(site)}/`;
  const robots = site.live ? 'index, follow' : 'noindex, nofollow';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: site.name,
    url,
    description: site.description,
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
  <meta http-equiv="Content-Security-Policy" content="${CSP}">
  <meta name="referrer" content="no-referrer">
  <title>${esc(site.title)}</title>
  <meta name="description" content="${esc(site.description)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${url}">
  <meta property="og:title" content="${esc(site.title)}">
  <meta property="og:description" content="${esc(site.description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url}">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="${esc(favicon)}">
  <link rel="stylesheet" href="lol.css?v=${BUILD_DATE}">
  <script src="lol.js?v=${BUILD_DATE}"></script>
  <script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

function header(key, site) {
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
      Built with ❤️ by <a href="https://amplifi.studio">amplifi.studio</a> · <a href="licenses/">open-source credits</a>
    </footer>`;
}

function licensesPage(key, site, vendorFiles) {
  const credits = {
    'pdf-lib.min.js': ['pdf-lib 1.17.1', 'MIT', 'https://github.com/Hopding/pdf-lib', 'pdf-lib.LICENSE.md'],
    'qrcode-generator.js': ['qrcode-generator 2.0.4 by Kazuhiko Arase', 'MIT', 'https://github.com/kazuhikoarase/qrcode-generator', 'qrcode-generator.LICENSE'],
    'jsqr.js': ['jsQR 1.4.0', 'Apache-2.0', 'https://github.com/cozmo/jsQR', 'jsqr.LICENSE'],
    'heic-to.min.js': ['heic-to 1.6.6 (bundles libheif 1.23.6)', 'LGPL-3.0', 'https://github.com/hoppergee/heic-to', 'heic-to.LICENSE'],
    'fflate.min.js': ['fflate 0.8.3', 'MIT', 'https://github.com/101arrowz/fflate', 'fflate.LICENSE'],
  };
  const rows = vendorFiles.map((f) => {
    const c = credits[f];
    if (!c) throw new Error('No credit entry for vendor file ' + f);
    return `<li><strong>${esc(c[0])}</strong>, ${esc(c[1])}. <a href="${c[2]}">Source</a> · <a href="${c[3]}">License text</a> · served here unmodified as <code>/${f}</code></li>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Open-source credits · ${esc(site.name)}</title>
  <link rel="stylesheet" href="../lol.css?v=${BUILD_DATE}">
</head>
<body>
  <div class="container">
    <section class="card">
      <h2>Open-source credits</h2>
      <p>${esc(site.name)} runs on these libraries. Each one is copied into this site unmodified, so your browser loads it from us and never from a third-party CDN.</p>
      <ul>
        ${rows.join('\n        ')}
      </ul>
      <p>The site's own code is MIT licensed: <a href="${cfg.repo}">${cfg.repo}</a></p>
      <p><a href="../">Back to ${esc(site.name)}</a></p>
    </section>
  </div>
</body>
</html>
`;
}

function headersFile(site) {
  const lines = [
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()',
    `  Content-Security-Policy: ${CSP}; frame-ancestors 'none'`,
  ];
  if (!site.live) lines.push('  X-Robots-Tag: noindex, nofollow');
  return lines.join('\n') + '\n';
}

function robotsFile(site) {
  // Always Allow: a Disallow would stop crawlers from ever SEEING the noindex.
  let s = '# Crawl away.\nUser-agent: *\nAllow: /\n';
  if (site.live) s += `\nSitemap: https://${site.domain}/sitemap.xml\n`;
  return s;
}

function sitemapFile(site) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://${site.domain}/</loc><lastmod>${BUILD_DATE}</lastmod></url>
</urlset>
`;
}

function buildSite(key) {
  const site = cfg.sites[key];
  const src = path.join(ROOT, 'sites', key);
  const out = path.join(ROOT, 'dist', key);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'licenses'), { recursive: true });

  let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  const parts = {
    '<!--@head-->': head(key, site),
    '<!--@header-->': header(key, site),
    '<!--@more-->': moreTools(key),
    '<!--@footer-->': footer(),
  };
  for (const [tag, val] of Object.entries(parts)) {
    if (!html.includes(tag)) throw new Error(`${key}/index.html is missing ${tag}`);
    html = html.split(tag).join(val);
  }
  html = html.replace(/\{\{BUILD_DATE\}\}/g, BUILD_DATE);
  if (/<!--@\w+-->/.test(html)) throw new Error(`${key}: unknown partial ${html.match(/<!--@\w+-->/)[0]}`);
  fs.writeFileSync(path.join(out, 'index.html'), html);

  // Everything else in the site's own folder (app.js, og.png, ...) copies as-is.
  for (const f of fs.readdirSync(src)) {
    if (f === 'index.html') continue;
    fs.cpSync(path.join(src, f), path.join(out, f), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'shared/lol.css'), path.join(out, 'lol.css'));
  fs.copyFileSync(path.join(ROOT, 'shared/lol.js'), path.join(out, 'lol.js'));

  for (const v of site.vendor) {
    fs.copyFileSync(path.join(ROOT, 'vendor', v), path.join(out, v));
  }
  for (const l of fs.readdirSync(path.join(ROOT, 'vendor/licenses'))) {
    fs.copyFileSync(path.join(ROOT, 'vendor/licenses', l), path.join(out, 'licenses', l));
  }
  fs.writeFileSync(path.join(out, 'licenses/index.html'), licensesPage(key, site, site.vendor));
  fs.writeFileSync(path.join(out, '_headers'), headersFile(site));
  fs.writeFileSync(path.join(out, 'robots.txt'), robotsFile(site));
  if (site.live) fs.writeFileSync(path.join(out, 'sitemap.xml'), sitemapFile(site));

  // Every script/link the page references must exist in the output.
  const refs = [...html.matchAll(/(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)].map((m) => m[1])
    .filter((r) => !r.startsWith('/') && !r.startsWith('data') && r !== '' && !r.endsWith('/'));
  const missing = refs.filter((r) => !fs.existsSync(path.join(out, r)));
  if (missing.length) throw new Error(`${key}: index.html references missing files: ${missing.join(', ')}`);

  const n = fs.readdirSync(out).length;
  console.log(`built ${key.padEnd(5)} -> dist/${key}/ (${n} entries, ${site.live ? 'INDEXABLE' : 'noindex'}, host ${host(site)})`);
}

const keys = only.length ? only : Object.keys(cfg.sites);
for (const k of keys) {
  if (!cfg.sites[k]) throw new Error('unknown site ' + k);
  buildSite(k);
}
