/*
  wordcounter.lol counting rules. Runs in your browser only, no network.

  Words       Intl.Segmenter (granularity "word", isWordLike), the browser's own
              Unicode word rules plus its dictionaries for Chinese, Japanese and
              Thai. On top of that: hyphenated words (well-known), dotted words
              (U.S.A., example.com), AT&T and times (10:30) count as one word, and every
              link or email address counts as one word. Dashes and slashes split
              words. Emoji and punctuation on their own aren't words.
  Characters  Intl.Segmenter (granularity "grapheme"), so a family emoji, a flag
              or an accented letter typed as two code points counts as 1.
              Line breaks count as 1 each.
  Sentences   Intl.Segmenter (granularity "sentence"), skipping pieces with no
              letters or numbers, and not breaking after titles like Mr. or Dr.
              or a single initial like J.
  Paragraphs  lines that have any text on them (blank lines don't count).
  Lines       every line, blank or not, the way an editor numbers them.

  If the browser has no Intl.Segmenter, simpler regular expressions take over
  and the page says counts may be approximate for emoji and Chinese/Japanese.
*/
(function () {
  'use strict';

  var HAS_SEG = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';
  var WORD_SEG, GRAPH_SEG, SENT_SEG;
  if (HAS_SEG) {
    try {
      WORD_SEG = new Intl.Segmenter(undefined, { granularity: 'word' });
      GRAPH_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      SENT_SEG = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    } catch (_) { HAS_SEG = false; }
  }

  // Links (with a scheme or www.) and email addresses count as one word each.
  var LINK_RE = /(?:\b(?:https?|ftp):\/\/|\bwww\.)[^\s<>"'`]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu;
  var LINK_TRAIL = /[.,;:!?'"’”)\]}>]+$/;
  var HAS_WORDCHAR = /[\p{L}\p{N}]/u;
  var ASCII_ONLY = /^[\x00-\x7F]*$/;
  var SIMPLE_WORD = /^[A-Za-z0-9]+$/;
  var LETTER_OR_NUM = /[\p{L}\p{N}]/gu;
  // A sentence piece ending in one of these doesn't end the sentence.
  var ABBR_END = /(?:^|[\s(“"‘'])(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Fr|Gen|Lt|Col|Capt|Sgt|Gov|Sen|Rep|Mt|vs|e\.g|i\.e|cf|Fig|Vol|pp|(?!I\.)\p{Lu})\.[ \t\u00A0]*$/u;

  // ---- Words ---------------------------------------------------------------
  // Glue that keeps one word together when there's no space around it:
  // well-known, U.S.A., example.com, 10:30. (Chrome splits at dots between
  // letters and Safari and Firefox don't, so we join them ourselves to get the
  // same count in every browser.)
  var GLUE = { '-': 1, '\u2010': 1, '\u2011': 1, '.': 1, ':': 1, '&': 1 };
  function canJoin(a, j, b) {
    if (j === ':') return /\d$/.test(a) && /^\d/.test(b);
    return true;
  }

  function segmentWords(piece, out) {
    if (!piece || !HAS_WORDCHAR.test(piece)) return;
    var cur = null, joiner = null;
    for (var it = WORD_SEG.segment(piece)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
      var s = r.value;
      if (s.isWordLike) {
        if (cur !== null && joiner !== null && canJoin(cur, joiner, s.segment)) cur += joiner + s.segment;
        else { if (cur !== null) out.push(cur); cur = s.segment; }
        joiner = null;
      } else if (cur !== null && joiner === null && GLUE[s.segment]) {
        joiner = s.segment;
      } else {
        if (cur !== null) out.push(cur);
        cur = null; joiner = null;
      }
    }
    if (cur !== null) out.push(cur);
  }

  // Fallback without Intl.Segmenter. Han and kana characters count one each.
  // (No lookbehind in these patterns: older Safari can't parse it.)
  var FB_WORD = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{M}\p{N}_])+(?:[\-'’.:&\u00B7\u2010\u2011](?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{M}\p{N}_])+)*/gu;
  function fallbackWords(piece, out) {
    if (!piece) return;
    var m = piece.match(FB_WORD);
    if (!m) return;
    for (var i = 0; i < m.length; i++) {
      // A colon only joins numbers (10:30), so "Note:This" is two words.
      var parts = m[i].split(':'), cur = parts[0];
      for (var k = 1; k < parts.length; k++) {
        if (/\d$/.test(cur) && /^\d/.test(parts[k])) cur += ':' + parts[k];
        else { out.push(cur); cur = parts[k]; }
      }
      out.push(cur);
    }
  }

  // Returns { words: [strings, links left out], links: n, plain: text with each
  // link swapped for the word "link" so a ? or . inside it can't end a sentence }
  function wordTokens(text) {
    var words = [], links = 0, last = 0, m, plain = null;
    var seg = HAS_SEG ? segmentWords : fallbackWords;
    if (text.indexOf('@') >= 0 || text.indexOf('//') >= 0 || /www\./i.test(text)) {
      LINK_RE.lastIndex = 0;
      plain = '';
      while ((m = LINK_RE.exec(text))) {
        var u = m[0].replace(LINK_TRAIL, '');
        if (!u || !HAS_WORDCHAR.test(u)) continue;
        seg(text.slice(last, m.index), words);
        plain += text.slice(last, m.index) + 'link';
        links++;
        last = m.index + u.length;
        LINK_RE.lastIndex = last;
      }
      plain += text.slice(last);
    }
    seg(text.slice(last), words);
    return { words: words, links: links, plain: plain === null ? text : plain };
  }

  // ---- Characters ----------------------------------------------------------
  function graphemes(text) {
    if (!text) return 0;
    if (ASCII_ONLY.test(text)) return text.length - countCRLF(text);
    if (HAS_SEG) {
      var n = 0;
      for (var it = GRAPH_SEG.segment(text)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) n++;
      return n;
    }
    return fallbackGraphemes(text);
  }
  function countCRLF(t) {
    var n = 0, i = -1;
    while ((i = t.indexOf('\r\n', i + 1)) >= 0) n++;
    return n;
  }
  // Rough grapheme count: code points, minus marks, joiners and what they join,
  // variation selectors, skin tones, tag characters, and half of each flag pair.
  function fallbackGraphemes(t) {
    var cps = Array.from(t), n = 0, ri = 0;
    for (var i = 0; i < cps.length; i++) {
      var c = cps[i], cp = c.codePointAt(0);
      if (cp === 0x200D) { i++; ri = 0; continue; }
      if (/\p{M}/u.test(c) || (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0x1F3FB && cp <= 0x1F3FF) || (cp >= 0xE0020 && cp <= 0xE007F)) continue;
      if (c === '\n' && cps[i - 1] === '\r') continue;
      if (cp >= 0x1F1E6 && cp <= 0x1F1FF) { ri++; if (ri % 2 === 0) continue; } else ri = 0;
      n++;
    }
    return n;
  }
  // Whitespace (Unicode White_Space) characters are their own grapheme (CR+LF is one).
  var SPACE_RE = /\r\n|\p{White_Space}/gu;
  function spaceGraphemes(t) {
    var m = t.match(SPACE_RE);
    return m ? m.length : 0;
  }

  // ---- Sentences -------------------------------------------------------------
  function sentences(text) {
    if (!HAS_WORDCHAR.test(text)) return 0;
    var n = 0, join = false, s;
    if (HAS_SEG) {
      for (var it = SENT_SEG.segment(text)[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
        s = r.value.segment;
        if (!HAS_WORDCHAR.test(s)) continue;
        if (!join) n++;
        join = ABBR_END.test(s);
      }
      return n;
    }
    var parts = text
      .replace(/([.!?…]+["'”’)\]]*)\s+/gu, '$1\u0000')
      .replace(/([。！？]+["'”’」』）]*)/gu, '$1\u0000')
      .split(/\u0000|\n+/);
    for (var i = 0; i < parts.length; i++) {
      s = parts[i];
      if (!HAS_WORDCHAR.test(s)) continue;
      if (!join) n++;
      join = ABBR_END.test(s);
    }
    return n;
  }

  // ---- Lines and paragraphs -----------------------------------------------
  function lineStats(text) {
    if (!text) return { lines: 0, paragraphs: 0 };
    var lines = 1, paragraphs = 0, start = 0, i;
    while (true) {
      i = text.indexOf('\n', start);
      var line = i < 0 ? text.slice(start) : text.slice(start, i);
      if (/\S/.test(line)) paragraphs++;
      if (i < 0) break;
      lines++;
      start = i + 1;
    }
    return { lines: lines, paragraphs: paragraphs };
  }

  // ---- Word stats ------------------------------------------------------------
  function letterLen(w) {
    if (SIMPLE_WORD.test(w)) return w.length;
    var m = w.match(LETTER_OR_NUM);
    return m ? m.length : 0;
  }

  var STOP = new Set(('a an the and or but nor if then else so of to in on at by for with from as into onto about ' +
    'over under after before than that this these those there here is are was were be been being am do does did done ' +
    'have has had having it its it\'s i me my mine we us our you your yours he him his she her hers they them their ' +
    'what which who whom whose not no yes can could will would shall should may might must just also very all any ' +
    'some more most up down out off how when where why too only own same such both each few other s t don\'t i\'m ' +
    'you\'re we\'re they\'re that\'s there\'s can\'t won\'t isn\'t aren\'t wasn\'t didn\'t doesn\'t let\'s one get got ' +
    'like').split(' '));

  function topWords(words, includeCommon, limit) {
    var freq = new Map();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (!/\p{L}/u.test(w)) continue;
      if (w.length === 1 && /[\p{Lu}\p{Ll}]/u.test(w)) continue; // lone letters like the "J" in J. R. R.
      w = w.toLowerCase().replace(/’/g, "'");
      if (!includeCommon && STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
    var arr = [];
    freq.forEach(function (n, w) { if (n >= 2) arr.push([w, n]); });
    arr.sort(function (a, b) { return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); });
    return arr.slice(0, limit || 10);
  }

  // ---- Main ----------------------------------------------------------------
  function analyze(text, opts) {
    opts = opts || {};
    text = text || '';
    var wt = wordTokens(text);
    var chars = graphemes(text);
    var ls = lineStats(text);
    var res = {
      words: wt.words.length + wt.links,
      links: wt.links,
      chars: chars,
      charsNoSpaces: chars - spaceGraphemes(text),
      sentences: sentences(wt.plain),
      paragraphs: ls.paragraphs,
      lines: ls.lines,
    };
    if (opts.full) {
      var total = 0, longest = '', longestLen = 0;
      for (var i = 0; i < wt.words.length; i++) {
        var w = wt.words[i], n = letterLen(w);
        total += n;
        if (n > longestLen) { longestLen = n; longest = w; }
      }
      res.avgWordLength = wt.words.length ? total / wt.words.length : 0;
      res.longestWord = longest;
      res.longestLen = longestLen;
      res.top = topWords(wt.words, !!opts.includeCommon, 10);
      res.tokens = wt.words;
    }
    return res;
  }

  // ---- Text messages (SMS) -------------------------------------------------
  // GSM 03.38 basic set (1 unit each) and extension set (2 units each).
  var GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
  var GSM_EXT = '^{}\\[~]|€\f';
  var BASIC = new Set(GSM_BASIC), EXT = new Set(GSM_EXT);
  function sms(text) {
    var units = 0, gsm = true, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (BASIC.has(c)) units += 1;
      else if (EXT.has(c)) units += 2;
      else { gsm = false; break; }
    }
    if (!gsm) units = text.length; // UCS-2: UTF-16 code units, so most emoji take 2
    var single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
    var parts = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
    return { units: units, gsm: gsm, single: single, multi: multi, parts: parts };
  }

  var api = { analyze: analyze, sms: sms, graphemes: graphemes, hasSegmenter: HAS_SEG, STOP: STOP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else self.wcount = api;
})();
