// The Voynich word search's engine: queries in voynichese.com's syntax run over
// data/search/text.json (written by writing/voynich/tools/web-search.py). It holds no
// page code, so the page and node both use it:
//   node search.js --self-test
//   node search.js --index data/search/text.json --query otedy --reader VT --exact
(function (root) {
  'use strict';

  // ---- the syntax ------------------------------------------------------------------
  // As voynichese.com's QueryBasics: EVA letters; * one or more letters; ^ a word's start,
  // $ its end; Exact wraps the query in ^ and $. Consecutive *s are one.
  function parse(query, exact) {
    let q = String(query).trim().toLowerCase().replace(/-/g, '*').replace(/\*+/g, '*');
    if (!q || /[^a-z*^$?@]/.test(q)) throw new Error('A query is EVA letters, with * ^ $ only');
    if (exact) q = (q.startsWith('^') ? '' : '^') + q + (q.endsWith('$') ? '' : '$');
    const body = q.replace(/^\^/, '').replace(/\$$/, '');
    if (/[\^$]/.test(body)) throw new Error('^ and $ stand only at the start and end');
    const re = (q.startsWith('^') ? '^' : '') +
      body.split('').map(c => c === '*' ? '.+' : c.replace(/[?@]/, '\\$&')).join('') +
      (q.endsWith('$') ? '$' : '');
    return { text: q, re: new RegExp(re, 'g'), anchored: q.startsWith('^') || q.endsWith('$'),
             plain: !/[*]/.test(body), body };
  }

  // ---- a word's letters ---------------------------------------------------------------
  // One character a letter: a one-off sign (@123;) is @, an unreadable one ?, the first of an
  // alternate [cth:oto] taken, braces and uncertain spaces (,) left out of the letters.
  function letters(word) {
    const w = String(word).replace(/\[([^:\]]*)(?::[^\]]*)?\]/g, '$1').replace(/[{}]/g, '');
    return (w.match(/@\d+;|[a-zA-Z?*]/g) || []).map(t => t.startsWith('@') ? '@' : t.toLowerCase()).join('');
  }
  // A key letter's name as its EVA letters: c+t+h, letters stacked as one glyph, is c, t, h.
  const keyLetters = name => String(name).split('+').map(p => p.startsWith('@') ? '@' : p.toLowerCase()).join('');

  // ---- the index, made ready once -----------------------------------------------------
  // For each reader, every word as { locus, i, text, zl (the ZL word it reads), at (line start,
  // line end, paragraph start, paragraph end, folio start, folio end) } in manuscript order.
  const PARA_START = new Set(['@', '*', '&']), PARA_END = new Set(['=', '&']);
  function prepare(index) {
    // text.json keeps a reader whose words are ZL's own as 1 and a line-up only where it is not
    // word for word (web-search.py's compact()); here each locus gets every reader's words again
    index = { ...index, loci: index.loci.map(([id, page, type, position, zl, others, lined]) => {
      const texts = { ZL: zl }, maps = {};
      for (const [r, ws] of Object.entries(others)) { texts[r] = ws === 1 ? zl : ws; maps[r] = lined[r] || texts[r].map((_, i) => i); }
      return [id, page, type, position, texts, maps];
    }) };
    const lociById = new Map(index.loci.map(l => [l[0], l]));
    const pages = {};
    for (const [page, quire, illustration, currier, hand, currierHand] of index.pages)
      pages[page] = { page, quire, illustration, currier, hand, currierHand };
    const words = {};
    for (const w of index.words) words[`${w[0]}.${w[1]}`] = w;
    const readers = {};
    for (const reader of ['ZL', 'IT', 'RF', 'VT']) {
      const list = [];
      for (const [id, page, type, position, texts, maps] of index.loci) {
        const ws = texts[reader] || [];
        ws.forEach((w, i) => list.push({
          locus: id, page, type, i, raw: w, text: letters(w),
          zl: reader === 'ZL' ? i : (maps[reader] || [])[i],
          lineStart: i === 0, lineEnd: i === ws.length - 1,
          paraStart: i === 0 && PARA_START.has(position), paraEnd: i === ws.length - 1 && PARA_END.has(position),
        }));
      }
      // a page's first and last word
      for (let k = 0; k < list.length; k++) {
        list[k].folioStart = k === 0 || list[k - 1].page !== list[k].page;
        list[k].folioEnd = k === list.length - 1 || list[k + 1].page !== list[k].page;
      }
      const freq = {};
      for (const w of list) freq[w.text] = (freq[w.text] || 0) + 1;
      readers[reader] = { list, freq };
    }
    readers.BEST = best(readers, words, index);
    return { pages, words, readers, raw: index, lociById };
  }

  // The best reading of each word, the search's default, on the owner's word of 11 November 2026,
  // 1:42pm ("shouldnt we keep what the best has for each thing?"): the owner's answer where the
  // owner settled the word; else the key's letters where every one was traced or checked by hand on
  // the scan; else ZL; and where ZL has no line at all, the first other reader that has it.
  function best(readers, words, index) {
    const others = ['VT', 'IT', 'RF'];
    const list = [];
    const byLocus = {};
    for (const r of others) for (const w of readers[r].list) (byLocus[r + w.locus] = byLocus[r + w.locus] || []).push(w);
    let zl = readers.ZL.list, k = 0;
    for (const [id] of index.loci) {
      const line = [];
      while (k < zl.length && zl[k].locus === id) line.push(zl[k++]);
      if (line.length) {
        for (const w of line) {
          const key = words[`${w.locus}.${w.i + 1}`];
          let text = w.text, from = 'ZL';
          if (key && key[6]) { text = key[6].map(keyLetters).join(''); from = 'owner'; }
          else if (key && key[7].length && [...key[8]].every(c => c === 'h' || c === 'c')) { text = key[7].map(keyLetters).join(''); from = 'key'; }
          list.push({ ...w, text, from });
        }
      } else {
        const r = others.find(r => byLocus[r + id]);
        if (r) for (const w of byLocus[r + id]) list.push({ ...w, zl: -1, from: r });
      }
    }
    const freq = {};
    for (const w of list) freq[w.text] = (freq[w.text] || 0) + 1;
    return { list, freq };
  }

  // ---- one search ---------------------------------------------------------------------
  // opts: { reader: 'ZL'|'IT'|'RF'|'VT', exact, across (letter runs across spaces, ZL only),
  //         filter(pageMeta) -> bool, stacked (only hits inside a stacked glyph) }
  // Returns hits, each { page, locus, words: [ZL word numbers], spans: [[ZL word, from, to)] ... ] }
  // and the counts voynichese.com gives plus the splits by section, quire, language and hand.
  function search(ready, query, opts = {}) {
    const q = parse(query, opts.exact);
    const name = opts.reader || 'BEST', reader = ready.readers[name];
    if (!reader) throw new Error('No such transcription: ' + opts.reader);
    const keep = w => !opts.filter || opts.filter(ready.pages[w.page] || {});
    const hits = [];
    if (opts.across) {
      if (name !== 'ZL' && name !== 'BEST') throw new Error('Runs across spaces are searched on the best reading or ZL');
      if (q.anchored) throw new Error('^ and $ mark a word\'s ends, so a run across spaces takes neither');
      // each locus's letters run together, every letter knowing its word
      let k = 0;
      const list = reader.list;
      while (k < list.length) {
        const loc = list[k].locus, line = [];
        for (; k < list.length && list[k].locus === loc; k++) line.push(list[k]);
        if (!keep(line[0])) continue;
        let text = '';
        const owner = [];
        line.forEach(w => { for (let c = 0; c < w.text.length; c++) { text += w.text[c]; owner.push([w, c]); } });
        const re = new RegExp(q.re.source, 'g');
        let m;
        while ((m = re.exec(text))) {
          if (!m[0].length) { re.lastIndex++; continue; }
          const spans = [];
          for (let c = m.index; c < m.index + m[0].length; c++) {
            const [w, at] = owner[c];
            const s = spans.find(s => s[0] === w);
            if (s) s[2] = at + 1; else spans.push([w, at, at + 1]);
          }
          hits.push({ page: line[0].page, locus: loc, words: spans.map(s => s[0]), spans: spans.map(s => [s[0].zl, s[1], s[2], s[0].text]),
                      across: spans.length > 1 });
          re.lastIndex = m.index + 1;
        }
      }
    } else {
      for (const w of reader.list) {
        if (!keep(w)) continue;
        const re = new RegExp(q.re.source, 'g');
        const m = re.exec(w.text);
        if (!m) continue;
        // where the query's letters stand inside the word, for the page to light them
        const same = name === 'ZL' || name === 'BEST';
        hits.push({ page: w.page, locus: w.locus, words: [w], spans: [[w.zl, same ? m.index : null, same ? m.index + m[0].length : null, w.text]] });
      }
    }
    let out = hits;
    if (opts.stacked) out = hits.filter(h => h.spans.some(([zl, a, b]) => inStack(ready, h.locus, zl, a, b)));
    return { query: q.text, reader: name, hits: out, counts: counts(ready, reader, q, out) };
  }

  // whether a hit's letters fall inside one of the word's stacked glyphs
  function inStack(ready, locus, zl, a, b) {
    const w = ready.words[`${locus}.${zl + 1}`];
    if (!w || a == null) return false;
    let at = 0;
    for (const name of w[7]) {
      const n = keyLetters(name).length;
      if (name.includes('+') && a < at + n && b > at) return true;
      at += n;
    }
    return false;
  }

  // The key letters a hit lights in one ZL word: the letters whose EVA overlaps [a, b). Where the
  // key's letters don't spell the ZL word's letters, the whole word is lit by its box instead.
  function litLetters(ready, locus, zl, a, b, text) {
    const w = ready.words[`${locus}.${zl + 1}`];
    if (!w) return null;
    const ls = w[7];
    if (!ls.length || a == null) return { word: w, box: true, letters: [] };
    const zlText = text != null ? text : letters((ready.lociById.get(locus) || [])[4]?.ZL?.[zl] || '');
    const keyText = ls.map(keyLetters).join('');
    if (keyText !== zlText) return { word: w, box: true, letters: [] };
    // the key letters lit, by their number in the word; where each stands on the page is in the
    // page's own file (data/search/pages/<page>.json), fetched when the page is opened
    const out = [];
    let at = 0;
    ls.forEach((name, i) => {
      const n = keyLetters(name).length;
      if (a < at + n && b > at) out.push({ i, name, source: w[8][i] });
      at += n;
    });
    return { word: w, box: false, letters: out };
  }

  function counts(ready, reader, q, hits) {
    const words = hits.flatMap(h => h.words);
    const c = {
      total: hits.length,
      folios: new Set(hits.map(h => h.page)).size,
      a: 0, b: 0, folioStart: 0, folioEnd: 0, paragraphStart: 0, paragraphEnd: 0, lineStart: 0, lineEnd: 0,
      distinct: new Set(words.map(w => w.text)).size,
      unique: [...new Set(words.map(w => w.text))].filter(t => reader.freq[t] === 1).length,
      bySection: {}, byQuire: {}, byLanguage: {}, byHand: {},
    };
    for (const h of hits) {
      const p = ready.pages[h.page] || {};
      if (p.currier === 'A') c.a++;
      if (p.currier === 'B') c.b++;
      const first = h.words[0], last = h.words[h.words.length - 1];
      if (first.folioStart) c.folioStart++;
      if (last.folioEnd) c.folioEnd++;
      if (first.paraStart) c.paragraphStart++;
      if (last.paraEnd) c.paragraphEnd++;
      if (first.lineStart) c.lineStart++;
      if (last.lineEnd) c.lineEnd++;
      for (const [key, v] of [['bySection', p.illustration], ['byQuire', p.quire], ['byLanguage', p.currier], ['byHand', p.hand]])
        c[key][v || '?'] = (c[key][v || '?'] || 0) + 1;
    }
    // words one letter away (inserted, dropped or changed), for an exact query with no *
    if (q.plain && q.text.startsWith('^') && q.text.endsWith('$')) {
      const t = q.body, near = new Set();
      for (const w of Object.keys(reader.freq)) if (w !== t && oneEdit(w, t)) near.add(w);
      c.variants = [...near].reduce((n, w) => n + reader.freq[w], 0);
    }
    return c;
  }

  function oneEdit(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) === 1;
  }

  // ---- self-test ------------------------------------------------------------------------
  function selfTest() {
    let fails = 0;
    const expect = (name, ok) => { console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name); if (!ok) fails++; };
    const index = {
      pages: [['p1', 'A', 'H', 'A', '1', '1'], ['p2', 'A', 'S', 'B', '3', '2']],
      loci: [
        ['p1.1', 'p1', 'P', '@', ['qotedy', 'chedy', 'ot,edy'], { IT: ['qotedy', 'chedy', 'otedy'], RF: [], VT: ['qotedy', 'chedy', 'ot', 'edy'] }, { VT: [0, 1, 2, 2] }],
        ['p1.2', 'p1', 'P', '=', ['[cth:oto]res', 'otedy'], { IT: [], RF: [], VT: [] }, {}],
        ['p2.1', 'p2', 'P', '@', ['ot', 'edy', 'daiin'], { IT: 1, RF: [], VT: [] }, {}],
      ],
      words: [
        ['p1.2', 1, 0, 0, 10, 10, 0, ['c+t+h', 'r', 'e', 's'], 'hhhh'],
        ['p1.2', 2, 20, 0, 30, 10, 0, ['o', 't', 'e', 'd', 'y'], 'mmmmm'],
      ],
    };
    const r = prepare(index);
    expect('a plain query matches inside words, as voynichese.com does',
      search(r, 'otedy').hits.length === 3 && search(r, 'edy').hits.length === 5);
    expect('Exact matches whole words only, and an uncertain space stays inside its word',
      search(r, 'otedy', { exact: true }).hits.length === 2);
    expect('* is one or more letters, ^ a start and $ an end',
      search(r, '^qo*$').hits.length === 1 && search(r, '*edy$').hits.length === 4 && search(r, '^*dy$').hits.length === 5);
    expect('each reader counts its own words: VT splits ot.edy and finds edy apart, and IT stored as 1 reads ZL\'s words',
      search(r, 'edy', { reader: 'VT', exact: true }).hits.length === 1 && search(r, 'edy', { reader: 'IT', exact: true }).hits.length === 1);
    const run = search(r, 'otedy', { across: true });
    expect('a run across spaces finds otedy written as ot edy on p2, and says so',
      run.hits.length === 4 && run.hits.filter(h => h.across).length === 1);
    expect('an alternate is read as its first choice', search(r, 'cthres', { exact: true }).hits.length === 1);
    const lit = litLetters(r, 'p1.2', 1, 1, 3);
    expect('a hit on otedy\'s te lights only those two key letters', lit && !lit.box && lit.letters.map(l => l.name).join('') === 'te' && lit.letters.map(l => l.i).join() === '1,2');
    const st = litLetters(r, 'p1.2', 0, 1, 2);
    expect('a hit on the t of a stacked c+t+h lights the whole stacked glyph', st && st.letters.length === 1 && st.letters[0].name === 'c+t+h' && st.letters[0].source === 'h');
    expect('a query for cth finds the stacked glyph, and "stacked only" keeps it',
      search(r, 'cth').hits.length === 1 && search(r, 'cth', { stacked: true }).hits.length === 1 && search(r, 'res', { stacked: true }).hits.length === 0);
    const c = search(r, 'otedy', { exact: true }).counts;
    expect('the counts: total, folios, Currier A and B, line and paragraph ends',
      c.total === 2 && c.folios === 1 && c.a === 2 && c.b === 0 && c.lineEnd === 2 && c.paragraphEnd === 1 && c.lineStart === 0);
    expect('distinct, unique and one-letter variants',
      c.distinct === 1 && c.unique === 0 && c.variants === 1);
    expect('a filter keeps only the pages it passes',
      search(r, 'edy', { filter: p => p.illustration === 'S' }).hits.length === 1);
    const b2 = JSON.parse(JSON.stringify(index));
    b2.words[0][7][1] = 'o';                       // the hand key reads cthoes where ZL reads cthres
    b2.words[1][6] = ['o', 'k', 'e', 'd', 'y'];    // the owner settled ZL's otedy as okedy
    b2.words[1][8] = 'hhhhh';                       // and the key, hand-traced, still spells otedy
    b2.loci.push(['p2.9', 'p2', '?', '?', [], { IT: [], RF: [], VT: ['dso'] }, { VT: [-1] }]);
    const rb = prepare(b2);
    expect('the best reading takes the owner\'s answer over the key and ZL',
      search(rb, 'okedy', { exact: true }).hits.length === 1 && search(rb, 'okedy', { exact: true, reader: 'ZL' }).hits.length === 0);
    expect('then the hand-traced key over ZL',
      search(rb, 'cthoes', { exact: true }).hits.length === 1 && search(rb, 'cthres', { exact: true }).hits.length === 0);
    expect('and a line ZL lacks is read from the reader that has it',
      search(rb, 'dso', { exact: true }).hits.length === 1 && search(rb, 'dso', { exact: true, reader: 'ZL' }).hits.length === 0);
    const bl = litLetters(rb, 'p1.2', 0, 3, 4, search(rb, 'cthoes', { exact: true }).hits[0].spans[0][3]);
    expect('a best-reading hit lights the key letters it reads', bl && !bl.box && bl.letters.map(l => l.name).join('') === 'o');
    let refused = 0;
    for (const bad of ['ot edy', 'o^t', '']) try { parse(bad); } catch { refused++; }
    expect('a space, a ^ inside and an empty query are refused', refused === 3);
    console.log(`self-test: ${fails} failures`);
    return fails;
  }

  const api = { parse, letters, keyLetters, prepare, search, litLetters, oneEdit, selfTest };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    if (require.main === module) {
      const args = process.argv.slice(2);
      if (args.includes('--self-test')) process.exit(selfTest() ? 1 : 0);
      const at = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
      const fs = require('fs');
      const ready = prepare(JSON.parse(fs.readFileSync(at('--index') || __dirname + '/data/search/text.json', 'utf8')));
      const res = search(ready, at('--query'), { reader: at('--reader') || 'BEST', exact: args.includes('--exact'), across: args.includes('--across') });
      const { bySection, byQuire, byLanguage, byHand, ...main } = res.counts;
      console.log(JSON.stringify({ query: res.query, reader: res.reader, ...main }));
    }
  } else {
    root.VoynichSearch = api;
  }
})(typeof window !== 'undefined' ? window : this);
