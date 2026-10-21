# loltools

Small, free web tools that do all their work in your browser. No uploads, no accounts, no trackers. Built by [amplifi.studio](https://amplifi.studio), same rules as [findmyip.lol](https://findmyip.lol).

- **pdf.lol**: merge PDFs (and JPG/PNG pages) and compress PDFs
- **qr-code.lol**: QR codes for links, text, Wi-Fi, contacts, email and phone that never expire
- **heic.lol**: convert iPhone HEIC photos to JPG or PNG, in batches, with GPS stripped

## How the privacy promise holds

- Each site is static files on Cloudflare Pages. There is no server code at all: no Functions, no database, no API.
- Every page ships a Content-Security-Policy with `connect-src 'none'`. Once the page loads, the browser refuses every fetch, XHR, beacon and WebSocket the page tries, ours included. Your files can't leave your device, and you can check that in DevTools.
- Every library is copied into the site and served from the site's own domain. No CDNs, no Google Fonts.
- No analytics, no cookies. The light/dark choice sits in `localStorage` on your device.
- Cloudflare keeps its standard edge access logs for any site it hosts. We don't add anything to that.

## What each tool does

**pdf.lol** uses [pdf-lib](https://github.com/Hopding/pdf-lib).
- Merge copies the pages into a new PDF in the order you set. Photos are turned upright using their EXIF orientation.
- Compress decodes each RGB or grayscale photo in the PDF, resizes it, and re-saves it as JPEG. It also deflates any uncompressed streams and drops objects nothing points to. Text, fonts and vector art stay untouched. CMYK, spot-color, indexed and masked images stay untouched too, since re-encoding them can shift colors. If the copy isn't at least 2% smaller, the page tells you to keep your original.
- Locked (password) PDFs are refused with a plain message.

**qr-code.lol** uses [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) to draw codes and [jsQR](https://github.com/cozmo/jsQR) to read each one back before you download it. Codes are static: the content goes straight into the pattern, with no redirect link in between. Text is encoded as UTF-8. Wi-Fi and vCard payloads escape the characters that phones misread.

**heic.lol** uses [heic-to](https://github.com/hoppergee/heic-to), which bundles [libheif](https://github.com/strukturag/libheif) compiled to JavaScript and runs it in a Web Worker. Output keeps the pixels and, optionally, the date taken. GPS, camera model and every other metadata field are dropped. ZIPs are built with [fflate](https://github.com/101arrowz/fflate).

## Layout

```
tools.json            one entry per site: name, domain, Pages project, launch switch
shared/               lol.css, lol.js, header partials shared by every site
sites/<site>/         index.html (with <!--@partials-->) + app.js
vendor/               the libraries, unmodified, plus their licence files
scripts/build.mjs     builds dist/<site>/ (no dependencies)
scripts/deploy.sh     builds and deploys to Cloudflare Pages with wrangler
```

```bash
node scripts/build.mjs          # build all sites into dist/
npx serve dist/pdf              # or any static server
scripts/deploy.sh pdf           # deploy one site
```

### Launch switch

Each site stays `noindex` (meta robots + `X-Robots-Tag`) and canonicalises to its interim `*.amplifi.studio` host until `tools.json` sets `"live": true`. Flipping it makes the real domain canonical, removes the noindex headers, and writes a `sitemap.xml`.

## Licence

The site code is MIT. Bundled libraries keep their own licences, listed on each site's `/licenses/` page: pdf-lib (MIT), qrcode-generator (MIT), jsQR (Apache-2.0), fflate (MIT), heic-to and libheif (LGPL-3.0, served unmodified with source links).
