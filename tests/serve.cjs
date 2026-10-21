// Local static server for dist/<site>, applying the site's _headers block like Cloudflare Pages does.
// Usage: node serve.cjs <distDir> <port>
const http = require('http');
const fs = require('fs');
const path = require('path');
const [dirArg, port] = process.argv.slice(2);
const dir = path.resolve(dirArg);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/plain', '.xml': 'application/xml', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.gz': 'application/gzip', '.traineddata': 'application/octet-stream', '.bin': 'application/octet-stream', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
const headers = {};
try {
  const lines = fs.readFileSync(path.join(dir, '_headers'), 'utf8').split('\n');
  for (const l of lines) { const m = /^\s+([\w-]+):\s*(.*)$/.exec(l); if (m) headers[m[1]] = m[2]; }
} catch (_) {}
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dir, p);
  if (!f.startsWith(path.resolve(dir)) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', ...headers });
  fs.createReadStream(f).pipe(res);
}).listen(+port, '127.0.0.1', () => console.log('serving', dir, 'on', port));
