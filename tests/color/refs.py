#!/usr/bin/env python3
"""
Independent reference values for the colorpicker.lol test.

Uses Python's standard-library colorsys for HSL and HSV, the plain CMYK formula,
and the WCAG 2 luminance formula written out here from the spec. OKLCH comes
from ImageMagick (`-colorspace Oklch`), not from this file, so the page's OKLab
code is checked against a third implementation.

Usage: python3 refs.py '#336699' '#f5c26b' ...   (prints JSON)
"""
import colorsys
import json
import subprocess
import sys
import math


def parse_hex(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lin(c8):
    c = c8 / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = (lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def oklch_imagemagick(hexstr):
    out = subprocess.check_output([
        'magick', 'xc:' + hexstr, '-colorspace', 'Oklch',
        '-format', '%[fx:u.r] %[fx:u.g] %[fx:u.b]', 'info:'
    ]).decode().split()
    L, C, H = (float(x) for x in out)
    # ImageMagick 7 reports this hue in radians; convert to degrees.
    H = math.degrees(H) % 360
    if C < 2e-4:
        H = 0.0
    return {'l': L * 100, 'c': C, 'h': H}


def cmyk_imagemagick(hexstr):
    out = subprocess.check_output([
        'magick', xc(hexstr), '-colorspace', 'CMYK',
        '-format', '%[fx:u.c*100] %[fx:u.m*100] %[fx:u.y*100] %[fx:u.k*100]', 'info:'
    ]).decode().split()
    return [float(x) for x in out]


def xc(h):
    return 'xc:' + h


def ref(hexstr):
    rgb = parse_hex(hexstr)
    r, g, b = (v / 255.0 for v in rgb)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    hv, sv, vv = colorsys.rgb_to_hsv(r, g, b)
    k = 1 - max(r, g, b)
    if k >= 1:
        cmyk = [0, 0, 0, 100]
    else:
        cmyk = [(1 - r - k) / (1 - k) * 100, (1 - g - k) / (1 - k) * 100, (1 - b - k) / (1 - k) * 100, k * 100]
    return {
        'hex': '#%02x%02x%02x' % rgb,
        'rgb': list(rgb),
        'hsl': [h * 360, s * 100, l * 100],
        'hsv': [hv * 360, sv * 100, vv * 100],
        'cmyk': cmyk,
        'cmyk_im': cmyk_imagemagick(hexstr),
        'oklch': oklch_imagemagick(hexstr),
        'lum': luminance(rgb),
        'vs_white': contrast(rgb, (255, 255, 255)),
        'vs_black': contrast(rgb, (0, 0, 0)),
    }


if __name__ == '__main__':
    args = sys.argv[1:]
    out = {'colors': {h: ref(h) for h in args if not h.startswith('pair:')}, 'pairs': {}}
    for a in args:
        if a.startswith('pair:'):
            x, y = a[5:].split(',')
            out['pairs'][a[5:]] = contrast(parse_hex(x), parse_hex(y))
    print(json.dumps(out))
