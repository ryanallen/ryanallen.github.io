// The search page: the query box, the grid of pages with their hits, and a page opened with
// its hits lit at the ink. The engine is search.js; the data is data/search/ (web-search.py).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const S = window.VoynichSearch;
  const THUMB = 150;                       // a thumbnail's width
  const SOURCE = { h: '#ff3b5c', c: '#ff9f1c', m: '#c77dff' };
  const BOX = '#7fd3ff';
  let ready = null, pages = null, last = null;

  const loadImage = src => new Promise((ok, bad) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  const iiif = (im, w) => `${im.iiif}/full/${w},/0/default.jpg`;

  // ---- the state lives in the address, so a search can be sent: #q=otedy&r=BEST&m=exact&p=f46r
  const readHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
  function writeHash(extra = {}) {
    const h = { q: $('q').value.trim(), r: $('reader').value, m: $('match').value, ...extra };
    for (const k of Object.keys(h)) if (!h[k] || (k === 'r' && h[k] === 'BEST') || (k === 'm' && h[k] === 'any')) delete h[k];
    const s = new URLSearchParams(h).toString();
    if (location.hash.slice(1) !== s) history.replaceState(null, '', s ? '#' + s : location.pathname);
  }

  // ---- what a hit lights ------------------------------------------------------------------------
  // On a thumbnail, each hit's word box: at 150 pixels a letter and its word are a few pixels
  // apart, and the boxes come with the text, so the grid needs no letter places at all.
  function hitBoxes(hit) {
    const out = [];
    for (const [zl] of hit.spans) {
      const w = zl != null && zl >= 0 && ready.words[`${hit.locus}.${zl + 1}`];
      if (w) out.push(w.slice(2, 6));
    }
    return out;
  }
  // On an opened page, the key letters hit, each [x0, y0, x1, y1, ink, source] from the page's own
  // file of letter places (data/search/pages/<page>.json), or the word's box where it has none.
  function lit(hit, places) {
    const letters = [], boxes = [];
    for (const [zl, a, b, text] of hit.spans) {
      if (zl == null || zl < 0) continue;
      const got = S.litLetters(ready, hit.locus, zl, a, b, text);
      if (!got) continue;
      const place = places[`${hit.locus}.${zl + 1}`];
      if (got.box || !place) { boxes.push(got.word.slice(2, 6)); continue; }
      for (const l of got.letters) place[l.i] ? letters.push([...place[l.i], l.source]) : boxes.push(got.word.slice(2, 6));
    }
    return { letters, boxes };
  }

  // ---- the grid ----------------------------------------------------------------------------
  function run() {
    const q = $('q').value.trim();
    writeHash();
    $('grid').replaceChildren();
    if (!q) { $('summary').innerHTML = 'Type EVA letters. <b>*</b> is one or more letters, <b>^</b> a word\'s start, <b>$</b> its end.'; return; }
    let res;
    try {
      res = S.search(ready, q, { reader: $('reader').value, exact: $('match').value === 'exact', across: $('match').value === 'across' });
    } catch (e) { $('summary').textContent = e.message; return; }
    last = res;
    const c = res.counts, byPage = new Map();
    for (const h of res.hits) (byPage.get(h.page) || byPage.set(h.page, []).get(h.page)).push(h);
    const parts = [`<b>${c.total.toLocaleString()}</b> ${c.total === 1 ? 'match' : 'matches'} on <b>${c.folios}</b> ${c.folios === 1 ? 'page' : 'pages'}`,
      `Currier A ${c.a}, B ${c.b}`, `${c.distinct} distinct, ${c.unique} found once`,
      `line start ${c.lineStart}, line end ${c.lineEnd}`, `paragraph start ${c.paragraphStart}, end ${c.paragraphEnd}`];
    if (c.variants != null) parts.push(`${c.variants} one letter away`);
    $('summary').innerHTML = parts.join(' · ');
    for (const p of pages) {
      const hits = byPage.get(p.page);
      if (!hits) continue;
      const b = document.createElement('button');
      b.className = 'thumb';
      b.title = `${p.page}: ${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`;
      // the page's own thumbnail (data/search/thumbs/, 2.4 KB a page, made by web-search.py
      // --images), fetched by the browser only as it nears the view and dropped with the grid
      // on a new search; the hits drawn on a canvas over it at once
      const s = THUMB / p.width, h = Math.round(p.height * s);
      const pic = document.createElement('span'), img = document.createElement('img'), cv = document.createElement('canvas'), label = document.createElement('span');
      pic.className = 'pic';
      img.loading = 'lazy'; img.decoding = 'async'; img.alt = ''; img.width = THUMB; img.height = h;
      img.src = `data/search/thumbs/${p.page}.webp`;
      cv.width = THUMB; cv.height = h;
      pic.append(img, cv);
      label.textContent = `${p.page} · ${hits.length}`;
      b.append(pic, label);
      b.onclick = () => openPage(p.page);
      $('grid').append(b);
      drawHits(cv.getContext('2d'), hits, s);
    }
  }

  function drawHits(g, hits, s) {
    g.fillStyle = '#ffe600';
    for (const h of hits) {
      for (const r of hitBoxes(h)) {
        const [x0, y0, x1, y1] = r;
        g.fillRect(x0 * s - 1, y0 * s - 1, Math.max(3, (x1 - x0) * s + 2), Math.max(3, (y1 - y0) * s + 2));
      }
    }
  }

  // ---- a page opened, its hits lit at the ink -------------------------------------------------
  async function openPage(page) {
    const p = pages.find(x => x.page === page);
    if (!p || !last) return;
    writeHash({ p: page });
    const hits = last.hits.filter(h => h.page === page);
    $('view-title').textContent = `${page} · ${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for ${last.query}`;
    $('view').hidden = false;
    const W = Math.min(2000, Math.max(900, Math.round(innerWidth * 1.4))), s = W / p.width;
    const cv = $('view-canvas'), scan = cv.getContext('2d'), top = $('view-ink'), g = top.getContext('2d');
    const opened = (openPage.serial = (openPage.serial || 0) + 1);
    for (const c of [cv, top]) { c.width = W; c.height = Math.round(p.height * s); c.style.width = Math.min(W, innerWidth - 24) + 'px'; }
    scan.fillStyle = '#2a2620'; scan.fillRect(0, 0, cv.width, cv.height);
    // the scan fills in underneath while the hits are drawn on their own layer above it
    (async () => {
      for (const im of p.images) {
        try {
          const img = await loadImage(iiif(im, Math.round(im.w * s)));
          if (opened === openPage.serial) scan.drawImage(img, im.offset * s, 0, im.w * s, im.h * s);
        } catch { /* drawn without the scan */ }
      }
    })();
    // the page's letter places hold each traced letter's pixels as a bitmask of its bounds,
    // base64'd (web-search.py's pack()): each lit letter is drawn as the runs along its rows, a
    // few dozen rectangles, with no picture to fetch or read
    const boxes = [];
    let places = {};
    try { places = await (await fetch(`data/search/pages/${page}.json`)).json(); } catch { /* a page with no traced letters */ }
    if (opened !== openPage.serial) return;
    for (const h of hits) {
      const l = lit(h, places);
      boxes.push(...l.boxes);
      for (const [x0, y0, x1, y1, packed, src] of l.letters) {
        g.fillStyle = SOURCE[src] || SOURCE.m;
        const bits = atob(packed), w = x1 - x0, hgt = y1 - y0;
        const on = k => (bits.charCodeAt(k >> 3) >> (7 - (k & 7))) & 1;
        for (let y = 0; y < hgt; y++) {
          let x = 0;
          while (x < w) {
            if (!on(y * w + x)) { x++; continue; }
            const from = x;
            while (x < w && on(y * w + x)) x++;
            g.fillRect((x0 + from) * s, (y0 + y) * s, (x - from) * s, Math.max(1, s));
          }
        }
      }
    }
    // a word with no traced letters yet: its box, filled faintly and ringed, so it reads at a glance
    g.fillStyle = 'rgba(127,211,255,.22)'; g.strokeStyle = BOX; g.lineWidth = 3; g.setLineDash([8, 5]);
    for (const [x0, y0, x1, y1] of boxes) {
      g.fillRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
      g.strokeRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    }
    g.setLineDash([]);
  }
  function closePage() { $('view').hidden = true; writeHash(); }
  $('view-close').onclick = e => { e.preventDefault(); closePage(); };
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('view').hidden) closePage(); });

  // ---- start ---------------------------------------------------------------------------------
  let timer = null;
  $('search-bar').onsubmit = e => { e.preventDefault(); run(); };
  $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(run, 350); };
  $('reader').onchange = run;
  $('match').onchange = run;
  (async () => {
    $('summary').textContent = 'Loading the text…';
    const [index, pj] = await Promise.all([fetch('data/search/text.json').then(r => r.json()), fetch('data/pages.json').then(r => r.json())]);
    ready = S.prepare(index);
    pages = pj;
    // the page follows its address: a link to a search, Back, or an edited address all run it
    const follow = () => {
      const h = readHash();
      $('q').value = h.q || '';
      $('reader').value = h.r || 'BEST';
      $('match').value = h.m || 'any';
      run();
      if (h.p && h.q) openPage(h.p); else $('view').hidden = true;
    };
    addEventListener('hashchange', follow);
    follow();
    $('q').focus();
  })().catch(e => { $('summary').textContent = 'The text did not load: ' + e.message; });
})();
