#!/usr/bin/env python3
"""Verify each loltools host: HTTP 200, title, noindex on all layers, CSP, domain status."""
import json, os, sys, urllib.request

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
env = {}
for line in open(os.path.expanduser('~/.hermes/secrets/cloudflare.env')):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1); env[k.strip()] = v.strip().strip('"').strip("'")
cfg = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'tools.json')))
which = sys.argv[1] if len(sys.argv) > 1 else 'interim'
bad = 0
for key, s in cfg['sites'].items():
    host = s['interim'] if which == 'interim' else s['domain']
    try:
        r = urllib.request.urlopen(urllib.request.Request(f'https://{host}/', headers={'User-Agent': UA}), timeout=20)
        h = {k.lower(): v for k, v in r.headers.items()}
        body = r.read().decode('utf-8', 'replace')
        import re
        title = (re.search(r'<title>([^<]*)', body) or [None, '?'])[1]
        meta = (re.search(r'name="robots" content="([^"]*)', body) or [None, 'MISSING'])[1]
        rob = urllib.request.urlopen(urllib.request.Request(f'https://{host}/robots.txt', headers={'User-Agent': UA}), timeout=20).read().decode()
        csp = h.get('content-security-policy', '')
        print(f'{host}: {r.status} | {title}')
        print(f'   meta robots={meta} | X-Robots-Tag={h.get("x-robots-tag")} | robots.txt Disallow={"Disallow" in rob}')
        print(f'   CSP connect-src none={"connect-src " + chr(39) + "none" + chr(39) in csp}')
        if s['live'] is False and not (meta.startswith('noindex') and (h.get('x-robots-tag') or '').startswith('noindex')):
            bad += 1; print('   !! expected noindex')
    except Exception as e:
        bad += 1; print(f'{host}: ERROR {e}')
    req = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{env["CLOUDFLARE_ACCOUNT_ID"]}/pages/projects/{s["project"]}/domains',
                                 headers={'Authorization': 'Bearer ' + env['CLOUDFLARE_API_TOKEN']})
    d = json.load(urllib.request.urlopen(req, timeout=20))
    print('   domains:', [(x['name'], x['status']) for x in d['result']])
sys.exit(1 if bad else 0)
