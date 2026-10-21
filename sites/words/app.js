/*
  wordcounter.lol page script. Runs in your browser only.
  Uses count.js (words, characters, sentences) and xcount.js (X post length).
  Stores nothing unless you tick "Keep my draft in this browser". Then your
  text goes into localStorage on this device only. Clear or untick deletes it.
*/
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ta = $('text');
  var NF = new Intl.NumberFormat('en-US');
  var fmt = function (n) { return NF.format(n); };
  var plural = function (n, one, many) { return n === 1 ? one : many; };

  var READ_WPM = 238, SPEAK_WPM = 130;
  var DRAFT_KEY = 'wordcounter-draft', SAVE_KEY = 'wordcounter-save';
  var BIG = 300000; // characters. Above this, counts update after a short pause.
  var MAX_FILE = 5 * 1024 * 1024;

  if (!wcount.hasSegmenter) $('fallbackNote').hidden = false;

  // ---- Output helpers ------------------------------------------------------
  function setText(id, v) { var el = $(id); if (el.textContent !== v) el.textContent = v; }
  function duration(words, wpm) {
    if (!words) return '0 sec';
    var s = Math.max(1, Math.round(words / wpm * 60));
    if (s < 60) return s + ' sec';
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return h + ' hr ' + m + ' min';
    return m + ' min' + (r ? ' ' + r + ' sec' : '');
  }

  function setLimit(key, n, max, opts) {
    opts = opts || {};
    var li = $('lim-' + key), bar = $(key + '-bar');
    setText(key + '-n', fmt(n));
    bar.firstElementChild.style.width = Math.min(100, max ? n / max * 100 : 0) + '%';
    bar.setAttribute('aria-valuenow', String(n));
    bar.setAttribute('aria-valuemax', String(max));
    var state = n > max ? 'over' : (opts.warnAt != null ? n >= opts.warnAt : n >= max * 0.9) && n > 0 ? 'warn' : 'ok';
    if (opts.state) state = opts.state;
    li.classList.toggle('over', state === 'over');
    li.classList.toggle('warn', state === 'warn');
    li.dataset.state = state;
    var msg = opts.message || (n > max ? fmt(n - max) + ' over' : fmt(max - n) + ' left');
    setText(key + '-st', msg);
  }

  // ---- Main update -----------------------------------------------------------
  var last = null;
  function update() {
    var t0 = performance.now();
    var text = ta.value;
    var r = wcount.analyze(text, { full: true, includeCommon: $('includeCommon').checked });
    last = r;

    setText('s-words', fmt(r.words));
    setText('s-chars', fmt(r.chars));
    setText('s-nospace', fmt(r.charsNoSpaces));
    setText('s-sentences', fmt(r.sentences));
    setText('s-paragraphs', fmt(r.paragraphs));
    setText('s-lines', fmt(r.lines));
    setText('s-read', duration(r.words, READ_WPM));
    setText('s-speak', duration(r.words, SPEAK_WPM));
    setText('s-avg', r.avgWordLength ? (Math.round(r.avgWordLength * 10) / 10).toFixed(1) : '0');
    setText('s-longest', r.longestWord || 'none yet');
    $('s-longest').title = r.longestWord || '';
    setText('s-longest-n', r.longestWord ? r.longestLen + ' ' + plural(r.longestLen, 'letter', 'letters') : '\u00a0');
    setText('mini', fmt(r.words) + ' ' + plural(r.words, 'word', 'words') + ' · ' + fmt(r.chars) + ' ' + plural(r.chars, 'character', 'characters'));

    // Limits
    var x = xcount.xLength(text);
    setLimit('x', x.weightedLength, 280);
    setLimit('ig', r.chars, 2200);
    setLimit('li', r.chars, 3000);
    var metaState = r.chars > 160 ? 'over' : r.chars >= 155 ? 'warn' : 'ok';
    setLimit('meta', r.chars, 160, {
      state: metaState,
      message: r.chars > 160 ? fmt(r.chars - 160) + ' over' : r.chars >= 155 ? 'May get cut off' : fmt(160 - r.chars) + ' left',
    });
    var s = wcount.sms(text);
    setText('sms-max', String(s.single));
    setText('sms-note', s.gsm
      ? '160 per message. One emoji or special character drops that to 70.'
      : 'Has an emoji or special character, so it\u2019s 70 per message' + (s.parts > 1 ? ', 67 per part when split.' : '.'));
    setLimit('sms', s.units, s.single, {
      state: s.parts > 1 ? 'over' : s.units >= s.single * 0.9 ? 'warn' : 'ok',
      message: s.parts > 1 ? 'Sends as ' + s.parts + ' texts' : fmt(s.single - s.units) + ' left',
    });
    $('lim-sms').dataset.gsm = s.gsm ? '1' : '0';
    $('lim-sms').dataset.parts = String(s.parts);
    updateCustom();

    // Top words
    var ol = $('topWords');
    ol.textContent = '';
    for (var i = 0; i < r.top.length; i++) {
      var li = document.createElement('li');
      var w = document.createElement('span'); w.className = 'tw-word'; w.textContent = r.top[i][0];
      var c = document.createElement('span'); c.className = 'tw-n'; c.textContent = '\u00d7' + fmt(r.top[i][1]);
      li.append(w, c);
      ol.appendChild(li);
    }
    $('topEmpty').hidden = r.top.length > 0;

    updateSelection();
    scheduleSave();
    var ms = performance.now() - t0;
    // For tests and the curious: how long the last update took, and which text it counted.
    var dl = document.querySelector('.wc-stats');
    dl.dataset.ms = ms.toFixed(2);
    dl.dataset.len = String(text.length);
    dl.dataset.done = String(performance.now());
  }

  function updateCustom() {
    if (!last) return;
    var max = Math.floor(Number($('customMax').value));
    var valid = isFinite(max) && max >= 1;
    if (!valid) max = 0;
    var unit = $('customUnit').value;
    var n = unit === 'words' ? last.words : last.chars;
    setText('custom-max', valid ? fmt(max) : '?');
    if (!valid) {
      setLimit('custom', n, 0, { state: 'ok', message: 'Type a limit of 1 or more' });
      $('custom-bar').firstElementChild.style.width = '0%';
      return;
    }
    var left = max - n;
    setLimit('custom', n, max, {
      message: n > max ? fmt(n - max) + ' ' + (unit === 'words' ? plural(n - max, 'word', 'words') : plural(n - max, 'character', 'characters')) + ' over'
        : fmt(left) + ' left',
    });
  }

  // ---- Selection -------------------------------------------------------------
  var selKey = '';
  function updateSelection() {
    var a = ta.selectionStart, b = ta.selectionEnd;
    var box = $('selInfo');
    // Only while the box has focus: an unfocused textarea doesn't show its selection.
    if (a == null || b == null || b <= a || document.activeElement !== ta) {
      box.hidden = true; selKey = ''; return;
    }
    var key = a + ':' + b + ':' + ta.value.length;
    if (key === selKey && !box.hidden) return;
    selKey = key;
    var r = wcount.analyze(ta.value.slice(a, b));
    setText('sel-words', fmt(r.words)); setText('sel-words-u', plural(r.words, 'word', 'words'));
    setText('sel-chars', fmt(r.chars)); setText('sel-chars-u', plural(r.chars, 'character', 'characters'));
    setText('sel-nospace', fmt(r.charsNoSpaces));
    setText('sel-sentences', fmt(r.sentences)); setText('sel-sentences-u', plural(r.sentences, 'sentence', 'sentences'));
    box.hidden = false;
  }
  ['select', 'keyup', 'mouseup', 'touchend', 'focus', 'blur'].forEach(function (t) { ta.addEventListener(t, updateSelection); });
  document.addEventListener('selectionchange', function () { if (document.activeElement === ta) updateSelection(); });

  // ---- Input scheduling ------------------------------------------------------
  // Each keystroke or paste recounts right away, inside the input event, so the
  // numbers change in the same frame as the text. If more input events arrive in
  // that same go (some paste, dictation and IME paths send one per line), they're
  // folded into one more recount right after, instead of one per event.
  // Huge texts wait for a short pause instead.
  var timer = 0, busy = false, dirty = false, lastRun = 0;
  function settle() {
    busy = false;
    if (dirty) { dirty = false; update(); lastRun = performance.now(); }
  }
  function onInput() {
    if (ta.value.length > BIG) {
      clearTimeout(timer);
      timer = setTimeout(update, 150);
      return;
    }
    // Still inside a burst: wait for it to end, but never let the numbers fall
    // more than a couple of frames behind.
    if (busy && performance.now() - lastRun < 32) { dirty = true; return; }
    busy = true;
    dirty = false;
    update();
    lastRun = performance.now();
    setTimeout(settle, 0);
  }
  ta.addEventListener('input', onInput);
  $('includeCommon').addEventListener('change', update);
  $('customMax').addEventListener('input', updateCustom);
  $('customUnit').addEventListener('change', updateCustom);

  // ---- Local draft (off by default) -----------------------------------------
  var status = $('status');
  function store(fn) { try { return fn(window.localStorage); } catch (_) { return undefined; } }
  var saveTimer = 0;
  function saveNow() {
    if (!$('saveToggle').checked) return;
    try {
      if (ta.value) localStorage.setItem(DRAFT_KEY, ta.value);
      else localStorage.removeItem(DRAFT_KEY);
      if (status.dataset.kind === 'save-err') lol.setStatus(status, '');
    } catch (_) {
      // Don't leave an older draft behind that would come back instead of this one.
      store(function (s) { s.removeItem(DRAFT_KEY); });
      lol.setStatus(status, 'Your text is too long to save in this browser, so no copy is saved right now. It\u2019s still here in this tab. Copy it somewhere safe before you close it.', 'err');
      status.dataset.kind = 'save-err';
    }
  }
  function scheduleSave() {
    if (!$('saveToggle').checked) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }
  $('saveToggle').addEventListener('change', function () {
    if (this.checked) {
      store(function (s) { s.setItem(SAVE_KEY, '1'); });
      saveNow();
      if (status.dataset.kind !== 'save-err') { lol.setStatus(status, 'Your draft is now kept in this browser on this device.', 'ok'); status.dataset.kind = ''; }
    } else {
      clearTimeout(saveTimer);
      store(function (s) { s.removeItem(SAVE_KEY); s.removeItem(DRAFT_KEY); });
      lol.setStatus(status, 'Saving is off. The saved copy is deleted from this browser.', 'ok');
      status.dataset.kind = '';
    }
  });
  window.addEventListener('pagehide', saveNow);

  // ---- Clear and undo ------------------------------------------------------
  var undoText = null;
  function offerUndo(prev) {
    undoText = prev;
    $('undoBtn').hidden = !prev;
  }
  $('clearBtn').addEventListener('click', function () {
    var prev = ta.value;
    ta.value = '';
    clearTimeout(saveTimer);
    store(function (s) { s.removeItem(DRAFT_KEY); });
    update();
    offerUndo(prev);
    lol.setStatus(status, prev ? 'Cleared' + ($('saveToggle').checked ? ', and the saved copy in this browser is deleted.' : '.') : 'Nothing to clear.', 'ok');
    status.dataset.kind = '';
    ta.focus();
  });
  $('undoBtn').addEventListener('click', function () {
    if (undoText == null) return;
    ta.value = undoText;
    offerUndo(null);
    update();
    lol.setStatus(status, 'Your text is back.', 'ok');
    ta.focus();
  });

  // ---- Open a text file ------------------------------------------------------
  var TEXT_EXT = /\.(txt|text|md|markdown)$/i;
  function openFile(file) {
    if (!file) return;
    if (!TEXT_EXT.test(file.name) && !/^text\/(plain|markdown)/.test(file.type)) {
      lol.setStatus(status, '\u201c' + file.name + '\u201d isn\u2019t a .txt or .md file. For Word, PDF or Google Docs, copy the text and paste it here.', 'err');
      return;
    }
    if (file.size > MAX_FILE) {
      lol.setStatus(status, '\u201c' + file.name + '\u201d is ' + lol.formatBytes(file.size) + '. The limit is 5 MB, which is already about 800,000 words. Paste part of it instead.', 'err');
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { lol.setStatus(status, 'Your browser couldn\u2019t read \u201c' + file.name + '\u201d. Try opening it again.', 'err'); };
    reader.onload = function () {
      var text = String(reader.result || '');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      if (/\u0000/.test(text) || (text.match(/\uFFFD/g) || []).length > Math.max(8, text.length / 100)) {
        lol.setStatus(status, '\u201c' + file.name + '\u201d doesn\u2019t look like plain text, so it wasn\u2019t opened.', 'err');
        return;
      }
      var prev = ta.value;
      ta.value = text;
      update();
      offerUndo(prev || null);
      lol.setStatus(status, 'Opened \u201c' + file.name + '\u201d (' + lol.formatBytes(file.size) + ').' + (prev ? ' It replaced the text that was here. Undo brings that back.' : ''), 'ok');
      status.dataset.kind = '';
    };
    reader.readAsText(file);
  }
  $('openBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    openFile(f);
  });
  var drop = $('dropArea');
  var hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { if (!hasFiles(e)) return; e.preventDefault(); drop.classList.add('dragging'); });
  });
  ['dragleave', 'dragend'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('dragging'); }); });
  drop.addEventListener('drop', function (e) {
    drop.classList.remove('dragging');
    if (!hasFiles(e)) return;
    e.preventDefault();
    openFile(e.dataTransfer.files[0]);
  });
  // A file dropped just outside the box shouldn't make the browser open it.
  window.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', function (e) { if (hasFiles(e)) e.preventDefault(); });

  // ---- Start -------------------------------------------------------------------
  if (store(function (s) { return s.getItem(SAVE_KEY); }) === '1') {
    $('saveToggle').checked = true;
    var saved = store(function (s) { return s.getItem(DRAFT_KEY); });
    if (saved) { ta.value = saved; lol.setStatus(status, 'Your saved draft is back. It\u2019s kept only in this browser.', 'ok'); }
  }
  update();
})();
