/*
  loltools shared script. Runs in your browser only.
  The one thing it stores is your light/dark choice, in localStorage on your
  device. No cookies, no analytics, no network calls.
*/
(function () {
  'use strict';

  // ---- Theme ---------------------------------------------------------------
  const KEY = 'loltools-theme';
  const root = document.documentElement;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'light' || stored === 'dark') root.setAttribute('data-theme', stored);
  } catch (_) { /* private mode */ }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const current = root.getAttribute('data-theme')
        || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      const next = current === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (_) { /* ignore */ }
    });
  });

  // ---- Helpers shared by every tool ----------------------------------------
  const lol = {};

  lol.formatBytes = function (n) {
    if (!isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  };

  // Save a Blob to disk with a filename. Object URLs never leave the browser.
  lol.download = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  lol.baseName = function (name) {
    return String(name || 'file').replace(/\.[^.]+$/, '');
  };

  lol.setStatus = function (el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('ok', 'err');
    if (kind) el.classList.add(kind);
  };

  lol.setProgress = function (el, frac) {
    if (!el) return;
    if (frac == null) { el.hidden = true; return; }
    el.hidden = false;
    const bar = el.firstElementChild;
    if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  };

  // Wire a .dropzone: highlight on drag, hand dropped/picked files to onFiles.
  lol.dropzone = function (zone, onFiles) {
    const input = zone.querySelector('input[type="file"]');
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.add('dragging'); }));
    ['dragleave', 'dragend'].forEach((t) => zone.addEventListener(t, (e) => { stop(e); zone.classList.remove('dragging'); }));
    zone.addEventListener('drop', (e) => {
      stop(e);
      zone.classList.remove('dragging');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) onFiles(files);
    });
    if (input) {
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        if (files.length) onFiles(files);
      });
    }
    // Stop the browser from opening a file dropped just outside the zone.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  };

  lol.el = function (tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== false && attrs[k] != null) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
      }
    }
    (children || []).forEach((c) => { if (c) n.append(c); });
    return n;
  };

  window.lol = lol;
})();
