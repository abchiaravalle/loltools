#!/usr/bin/env python3
"""Audit built sites: third-party URLs baked into shipped code, and em dashes in visible copy."""
import os, re, sys, collections
ROOT = '/Users/adamchiaravalle/gits/loltools'
IGNORE = ('127.0.0.1', 'localhost', 'amplifi.studio', 'github.com', 'www.w3.org', 'schema.org', 'findmyip.lol',
          'eff.org', 'creativecommons.org', 'opensource.org', 'apache.org', 'gnu.org', 'fsf.org', 'mozilla.org',
          'npmjs.com', 'npmjs.org', 'unicode.org', 'ietf.org', 'whatwg.org')
URL = re.compile(r'https?://[a-zA-Z0-9.-]+')
for k in sys.argv[1:]:
    d = os.path.join(ROOT, 'dist', k)
    hits = collections.Counter()
    for dp, _, fs in os.walk(d):
        if '/licenses' in dp:
            continue
        for f in fs:
            if not f.endswith(('.js', '.mjs', '.html')):
                continue
            s = open(os.path.join(dp, f), errors='ignore').read()
            for u in URL.findall(s):
                host = u.split('://', 1)[1]
                if not any(host == i or host.endswith('.' + i) for i in IGNORE):
                    hits[(host, os.path.relpath(os.path.join(dp, f), d))] += 1
    print(f'== {k}: {len(hits)} distinct (host, file) pairs outside the ignore list')
    for (h, f), n in hits.most_common(12):
        print(f'   {n:3}x {h:40} {f}')
    html = open(os.path.join(ROOT, 'sites', k, 'index.html')).read()
    visible = re.sub(r'<!--.*?-->', '', html, flags=re.S)
    visible = re.sub(r'<script.*?</script>', '', visible, flags=re.S)
    print(f'   em dashes in visible page copy: {visible.count(chr(0x2014))}')
