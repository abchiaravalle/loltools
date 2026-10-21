#!/usr/bin/env python3
"""Which hosts get Cloudflare's Web Analytics beacon injected into their HTML?"""
import urllib.request, sys
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
hosts = sys.argv[1:] or [
    'pdf-lol.pages.dev', 'pdf-lol.amplifi.studio', 'qr-code-lol.amplifi.studio', 'heic-lol.amplifi.studio',
    'findmyip.lol', 'findmyip.amplifi.studio', 'amplifi.studio',
]
for h in hosts:
    try:
        r = urllib.request.urlopen(urllib.request.Request(f'https://{h}/', headers={'User-Agent': UA, 'Accept': 'text/html'}), timeout=20)
        body = r.read().decode('utf-8', 'replace')
        hdr = {k.lower(): v for k, v in r.headers.items()}
        beacon = 'cloudflareinsights' in body
        print(f'{h:32} beacon={"YES" if beacon else "no ":3}  cache-control={hdr.get("cache-control")}')
    except Exception as e:
        print(f'{h:32} ERROR {e}')
