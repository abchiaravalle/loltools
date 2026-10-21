#!/usr/bin/env python3
"""Attach <sub>.amplifi.studio to each loltools Pages project + create a proxied CNAME.
Reads the real pages.dev subdomain from the project API (never guessed)."""
import json, os, urllib.request, urllib.error

env = {}
with open(os.path.expanduser('~/.hermes/secrets/cloudflare.env')) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
TOKEN, ACCT = env['CLOUDFLARE_API_TOKEN'], env['CLOUDFLARE_ACCOUNT_ID']
ZONE = '32cf1aeeefef7e01d2cce901f9185c60'  # amplifi.studio
BASE = 'https://api.cloudflare.com/client/v4'


def api(path, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method or ('POST' if data else 'GET'))
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.load(e)


cfg = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'tools.json')))
existing = api(f'/zones/{ZONE}/dns_records?per_page=500')
names = {r['name']: r for r in existing.get('result') or []}

for key, s in cfg['sites'].items():
    proj, host = s['project'], s['interim']
    sub = host.split('.')[0]
    p = api(f'/accounts/{ACCT}/pages/projects/{proj}')
    target = (p.get('result') or {}).get('subdomain')
    print(f'== {key}: project {proj} -> {target}')
    if not target:
        print('   project lookup failed', p.get('errors')); continue
    r = api(f'/accounts/{ACCT}/pages/projects/{proj}/domains', {'name': host})
    print('   attach', host, r.get('success'), [(e.get('code'), e.get('message')) for e in r.get('errors') or []])
    if host in names:
        print('   DNS already exists:', names[host]['type'], names[host]['content'])
    else:
        r2 = api(f'/zones/{ZONE}/dns_records', {'type': 'CNAME', 'name': sub, 'content': target, 'proxied': True})
        res = r2.get('result') or {}
        print('   DNS', r2.get('success'), res.get('name'), '->', res.get('content'), [(e.get('code'), e.get('message')) for e in r2.get('errors') or []])
