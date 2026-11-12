// Trace the Voynich: check and fix the computer's tracing one letter at a
// time, see every version and examples of each letter, look at whole pages,
// and add the words the tracing missed. Saves two seconds after each change.
(() => {
  const API = 'https://voynich-tracing.norml.workers.dev';
  const COLORS = [[230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240],
    [240, 50, 230], [128, 128, 0], [0, 0, 128], [170, 110, 40], [128, 0, 0], [0, 128, 128], [0, 255, 0],
    [255, 100, 0], [255, 0, 160], [0, 80, 255], [150, 220, 0], [220, 0, 100], [0, 180, 230], [100, 0, 220]];
  const NEW_MARGIN = 30;
  const $ = id => document.getElementById(id);
  const color = k => COLORS[(k - 1) % COLORS.length];
  // a letter's color as one 32-bit pixel (canvas bytes are r, g, b, a in memory), so a
  // whole tracing is filled with plain integer writes instead of an array a pixel
  const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const packed = (c, a) => LITTLE ? ((a << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0 : ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | a) >>> 0;
  const pixel = (k, a) => packed(color(k), a);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  const fromLink = /(?:^|[&#])t=([a-z0-9-]{12,64})/.exec(location.hash);
  if (fromLink) { store.set('voynich-tracer', fromLink[1]); location.hash = '#/'; }
  let tracer = store.get('voynich-tracer');
  if (!tracer) {
    tracer = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('voynich-tracer', tracer);
  }

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function inflate(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const getJSON = async url => { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status); return r.json(); };
  const cropURL = (iiif, x, y, w, h) => `${iiif}/${x},${y},${w},${h}/full/0/default.jpg`;
  function loadImage(src) {
    return new Promise((ok, bad) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = bad; i.src = src; });
  }

  let pagesData = null, examplesData = null;
  // the promise is kept, so callers at the same moment share one download
  const pages = () => pagesData || (pagesData = getJSON('data/pages.json').catch(e => { pagesData = null; throw e; }));
  const examples = () => examplesData || (examplesData = getJSON('data/examples.json').catch(e => { examplesData = null; throw e; }));

  function views(name) {
    for (const v of ['letter-view', 'page-view', 'pages-view']) $(v).hidden = v !== name;
  }

  // The whole book's progress under the header: the letters people have checked,
  // filling toward the next goal so the bar moves with every few letters.
  const GOALS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  // /api/progress is asked for once and shared by the header and the page list for 10 seconds
  let progressAsk = null, progressAt = 0;
  function progressData() {
    if (!progressAsk || Date.now() - progressAt > 10000) {
      progressAt = Date.now();
      progressAsk = getJSON(API + '/api/progress').catch(e => { progressAsk = null; throw e; });
    }
    return progressAsk;
  }
  // Letters this visitor checks first are added to the bar at once. A count fetched after
  // a check already holds it, so only checks made since the last fetch began are added.
  const book = { checked: 0, total: 0, worked: 0, letters: 0, at: 0 };
  let bumps = [];
  function bump() { bumps.push(Date.now()); drawBook(); }
  async function stats() {
    const at = Date.now();
    const prog = await progressData().catch(() => null);
    if (!prog) return;
    let checked = 0, total = 0, worked = 0, letters = 0;
    for (const p of Object.values(prog)) { checked += p.checked || 0; total += p.total || 0; worked += p.worked; letters += p.letters; }
    if (!total) return;
    Object.assign(book, { checked, total, worked, letters, at: Math.min(at, progressAt) });
    drawBook();
  }
  function drawBook() {
    if (!book.total) return;
    bumps = bumps.filter(t => t >= book.at);
    const n = x => (x || 0).toLocaleString();
    const { total, worked, letters } = book, checked = Math.min(total, book.checked + bumps.length);
    const goals = [...GOALS.filter(g => g < total), total];
    const at = goals.findIndex(g => checked < g), goal = at < 0 ? total : goals[at], from = at > 0 ? goals[at - 1] : 0;
    $('book').hidden = false;
    $('book-count').textContent = n(checked);
    $('book-goal').innerHTML = at < 0 ? 'Every letter checked!'
      : `<b>${n(goal - checked)}</b> to go to ${n(goal)}${goal === total ? ', the whole book' : ''}`;
    $('book-steps').textContent = `Goal ${at < 0 ? goals.length : at + 1} of ${goals.length}`;
    $('book-reached').textContent = from ? `${n(from)} reached` : '';
    requestAnimationFrame(() => { $('book-bar').style.width = `${Math.min(100, checked / goal * 100)}%`; });
    $('stats').textContent = `${n(worked)} words worked on · ${n(letters)} letters verified by two people · ${(checked / total * 100).toFixed(2)}% of the book's ${n(total)} letters checked`;
  }

  // ---- the letter task ----------------------------------------------------
  const L = { word: null, k: 1, labels: null, reading: [], checked: [], start: null, zoom: 3, brush: 2, erasing: false,
    hidden: false, moving: false, space: false, undo: [], stroke: null, anchor: null, dirty: false, timer: null, add: null, versions: [], changed: false };
  const wstage = $('word-stage'), wlayer = $('word-layer'), crop = $('crop'), paint = $('paint'), pg = paint.getContext('2d');

  function say(text, bad = false) { $('status').textContent = text; $('status').classList.toggle('bad', bad); }

  // The word's tracing, drawn at most once a frame however fast the pointer moves.
  let wordImage = null, wordFrame = 0;
  function drawWordNow() {
    wordFrame = 0;
    const { word, labels, k } = L;
    if (!wordImage || wordImage.width !== word.w || wordImage.height !== word.h) wordImage = pg.createImageData(word.w, word.h);
    const px = new Uint32Array(wordImage.data.buffer);
    px.fill(0);
    if (!L.hidden) {
      const bright = pixel(k, 215), faint = [];
      for (let i = 0; i < labels.length; i++) {
        const v = labels[i];
        if (!v) continue;
        px[i] = v === k ? bright : (faint[v] || (faint[v] = pixel(v, 45)));
      }
    }
    pg.putImageData(wordImage, 0, 0);
  }
  function drawWord() { if (!wordFrame) wordFrame = requestAnimationFrame(drawWordNow); }
  function sizeWord() { wlayer.style.width = L.word.w * L.zoom + 'px'; wlayer.style.height = L.word.h * L.zoom + 'px'; }
  function fitWord() {
    L.zoom = Math.max(0.5, Math.min(10, (wstage.clientWidth - 20) / L.word.w, (wstage.clientHeight - 20) / L.word.h));
    sizeWord();
  }
  function zoomWord(f) {
    const cx = (wstage.scrollLeft + wstage.clientWidth / 2) / L.zoom, cy = (wstage.scrollTop + wstage.clientHeight / 2) / L.zoom;
    L.zoom = Math.max(0.25, Math.min(16, L.zoom * f));
    sizeWord();
    wstage.scrollLeft = cx * L.zoom - wstage.clientWidth / 2;
    wstage.scrollTop = cy * L.zoom - wstage.clientHeight / 2;
  }
  function marks() {
    $('erase').classList.toggle('on', L.erasing);
    $('move').classList.toggle('on', L.moving);
    $('hide').classList.toggle('on', L.hidden);
    wstage.classList.toggle('moving', L.moving || L.space);
    document.querySelectorAll('.sz').forEach(b => b.classList.toggle('on', +b.dataset.s === L.brush));
    $('go').textContent = L.changed ? 'Save and next →' : 'Looks right →';
  }

  async function names() {
    const ex = await examples();
    const all = Object.keys(ex).sort((a, b) => (a.startsWith('@') - b.startsWith('@')) || a.localeCompare(b));
    const sel = $('name');
    sel.replaceChildren();
    const current = L.reading[L.k - 1];
    for (const n of all.includes(current) ? all : [current, ...all]) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.append(o);
    }
    sel.value = current;
  }

  function ask() {
    const c = color(L.k);
    $('ask-text').innerHTML = `Letter ${L.k} of ${L.reading.length} in <span class="hint">${L.reading.map((n, i) => i + 1 === L.k ? `<b style="color:rgb(${c})">${n}</b>` : n).join(' ')}</span> — color its ink`;
    $('where').textContent = `${L.word.id}${(L.word.verified || '')[L.k - 1] === '1' ? ' · this letter is verified' : ''}`;
    // one Stack menu: the letters this one can join, by name, and Unstack when it is stacked
    const before = L.reading[L.k - 2], after = L.reading[L.k], menu = $('stack');
    menu.replaceChildren(new Option('Stack', ''));
    if (before) menu.append(new Option(`with ${before} (before)`, 'left'));
    if (after) menu.append(new Option(`with ${after} (after)`, 'right'));
    if (L.reading[L.k - 1].includes('+')) menu.append(new Option('Unstack', 'unstack'));
    menu.value = '';
  }

  async function examplesFor(name) {
    $('example-name').textContent = name;
    const box = $('examples');
    box.replaceChildren();
    const list = (await examples())[name] || [];
    if (!list.length) { box.textContent = 'No examples yet'; return; }
    for (const e of list) {
      const fig = document.createElement('figure'), cv = document.createElement('canvas'), cap = document.createElement('figcaption');
      cap.textContent = e.page;
      fig.append(cv, cap);
      fig.title = `${name} in ${e.word}`;
      fig.onclick = () => { location.hash = `#/p/${e.page}`; };
      box.append(fig);
      Promise.all([loadImage(e.img || cropURL(e.iiif, e.x, e.y, e.w, e.h)), inflate(e.grid)]).then(([img, grid]) => {
        cv.width = e.w; cv.height = e.h;
        const g = cv.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, e.w, e.h);
        const px = new Uint32Array(d.data.buffer), red = packed([230, 25, 75], 255);
        for (let i = 0; i < grid.length; i++) if (grid[i]) px[i] = red;
        g.putImageData(d, 0, 0);
        cv.style.width = Math.round(64 * e.w / e.h) + 'px';
      }).catch(() => {});
    }
  }

  function versionStrip() {
    const box = $('versions');
    box.replaceChildren();
    const k = L.k;
    for (const v of L.versions) {
      const fig = document.createElement('figure'), cv = document.createElement('canvas'), cap = document.createElement('figcaption');
      const name = v.reading[k - 1];
      cap.textContent = `${v.label}${name !== undefined && name !== L.reading[k - 1] ? ' · ' + name : ''}${v.checked && v.checked.includes(k) ? ' ✓' : ''}`;
      fig.append(cv, cap);
      fig.classList.toggle('on', v === L.start);
      fig.title = 'Start this letter from this version';
      box.append(fig);
      cv.width = L.word.w; cv.height = L.word.h;
      const g = cv.getContext('2d');
      const paintIt = () => {
        g.drawImage(crop, 0, 0);
        const d = g.getImageData(0, 0, L.word.w, L.word.h);
        const px = new Uint32Array(d.data.buffer), c = pixel(k, 255);
        for (let i = 0; i < v.labels.length; i++) if (v.labels[i] === k) px[i] = c;
        g.putImageData(d, 0, 0);
      };
      crop.complete && crop.naturalWidth ? paintIt() : crop.addEventListener('load', paintIt, { once: true });
      cv.style.width = Math.round(64 * L.word.w / L.word.h) + 'px';
      fig.onclick = () => {
        // take this version's pixels of this letter, keep the rest of the word as it is
        L.undo.push(L.labels.slice());
        for (let i = 0; i < L.labels.length; i++) {
          if (L.labels[i] === k) L.labels[i] = 0;
          if (v.labels[i] === k) L.labels[i] = k;
        }
        L.start = v;
        if (v.reading[k - 1] !== undefined && v.reading.length === L.reading.length) L.reading[k - 1] = v.reading[k - 1];
        changed(); drawWord(); versionStrip(); names(); ask(); examplesFor(L.reading[k - 1]);
      };
    }
  }

  async function openLetter(id, k) {
    views('letter-view');
    const sameWord = L.word && L.word.id === id;
    const load = L.load = (L.load || 0) + 1;
    if (!sameWord) say('Loading…');
    save();
    let data;
    const pending = JSON.parse(sessionStorage.getItem('voynich-add:' + id) || 'null');
    // the next letter of the word already open needs nothing new from the server
    if (sameWord && L.versions.length) return showLetter(k, true);
    const early = wordAhead.get(id);
    wordAhead.clear();
    try { data = early && Date.now() - early.at < 60000 ? early.data : await getJSON(`${API}/api/word/${encodeURIComponent(id)}?tracer=${tracer}`); } catch (e) {
      if (!pending) { say('Could not open that word: ' + e.message, true); return; }
      data = { word: pending.word, versions: [] };
    }
    const word = data.word;
    L.add = pending && !data.versions.length ? pending.add : null;
    const [ai, ...grids] = await Promise.all([word.ai, ...data.versions.map(v => v.labels)].map(inflate));
    const versions = [{ label: word.kind === 'new' ? 'Added' : 'Computer', labels: ai, reading: word.reading, checked: [] }];
    let mine = null, n = 0;
    for (const [j, v] of data.versions.entries()) {
      const labels = grids[j];
      const item = { label: v.mine ? 'Yours' : `Person ${++n}`, labels, reading: v.reading, checked: v.checked };
      if (v.mine) mine = item;
      versions.push(item);
    }
    if (load !== L.load) return;  // another letter was opened while this one loaded
    L.word = word;
    L.versions = versions;
    if (!sameWord) {
      const draft = JSON.parse(store.get('voynich-draft:' + id) || 'null');
      // a word someone added has a blank computer version: start from the latest person's instead
      const base = mine || (word.kind === 'new' && versions.length > 1 ? versions[versions.length - 1] : versions[0]);
      L.labels = draft ? Uint8Array.from(draft.labels) : base.labels.slice();
      L.reading = draft ? draft.reading : base.reading.slice();
      L.checked = draft ? draft.checked : (mine ? mine.checked.slice() : []);
      L.start = base;
      L.undo = [];
      L.anchor = null;
      L.changed = !!draft;
      crop.src = cropURL(word.iiif, word.x, word.y, word.w, word.h);
      paint.width = word.w; paint.height = word.h;
      fitWord();
      if (draft) { L.dirty = true; L.timer = setTimeout(save, 2000); }
    }
    showLetter(k, sameWord);
  }
  function showLetter(k, sameWord) {
    const word = L.word;
    L.k = Math.max(1, Math.min(k, L.reading.length));
    if (sameWord) L.changed = false;
    $('to-page').href = `#/p/${word.page}`;
    marks(); ask(); drawWord(); versionStrip(); names(); examplesFor(L.reading[L.k - 1]);
    if (!sameWord) { wordUV(); if (!word.done) fetchAhead(); }
    if (word.done) { say('This word is done: two people agreed on every letter. Press Skip for another.'); return; }
    say(L.checked.includes(L.k) ? 'You checked this letter already; change it if you like' : 'Paint over this letter\'s ink, or press Looks right');
  }

  function pointWord(e) {
    const r = paint.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / L.zoom), y: Math.floor((e.clientY - r.top) / L.zoom) };
  }
  function dab(x, y) {
    const { w, h } = L.word;
    for (let yy = y; yy < y + L.brush; yy++) {
      if (yy < 0 || yy >= h) continue;
      for (let xx = x; xx < x + L.brush; xx++) {
        if (xx < 0 || xx >= w) continue;
        const i = yy * w + xx;
        if (L.erasing) { if (L.labels[i] === L.k) L.labels[i] = 0; } else L.labels[i] = L.k;
      }
    }
  }
  function strokeTo(a, b) {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let i = 0; i <= n; i++) dab(Math.round(a.x + (b.x - a.x) * i / n), Math.round(a.y + (b.y - a.y) * i / n));
  }
  function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ } }

  wstage.addEventListener('pointerdown', e => {
    if (!L.word) return;
    if (L.moving || L.space || e.button === 1) {
      L.stroke = { pan: true, x: e.clientX, y: e.clientY, l: wstage.scrollLeft, t: wstage.scrollTop };
      capture(wstage, e); return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const before = L.labels.slice();
    before.anchor = L.anchor;
    L.undo.push(before);
    if (L.undo.length > 60) L.undo.shift();
    const p = pointWord(e);
    // Shift-click draws a straight line from where the last stroke ended, as in Glyph Painter
    const straight = !!(e.shiftKey && L.anchor);
    L.stroke = { last: p, straight };
    if (straight) strokeTo(L.anchor, p); else dab(p.x, p.y);
    drawWord(); capture(wstage, e);
  });
  // the cursor is a box the size of the brush, on the pixels a dab would paint
  const ring = $('ring');
  let lastPointer = null;
  function showRing(e) {
    if (e) lastPointer = e;
    e = lastPointer;
    if (!e || !L.word || L.moving || L.space || (L.stroke && L.stroke.pan)) { ring.style.display = 'none'; return; }
    const r = paint.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / L.zoom), y = Math.floor((e.clientY - r.top) / L.zoom);
    if (x < 0 || y < 0 || x >= L.word.w || y >= L.word.h) { ring.style.display = 'none'; return; }
    Object.assign(ring.style, { display: 'block', left: r.left + x * L.zoom - 1 + 'px', top: r.top + y * L.zoom - 1 + 'px',
      width: L.brush * L.zoom + 'px', height: L.brush * L.zoom + 'px' });
  }
  wstage.addEventListener('pointerleave', () => { ring.style.display = 'none'; lastPointer = null; });
  wstage.addEventListener('scroll', () => showRing());
  function setBrush(n) { L.brush = Math.max(1, Math.min(4, n)); marks(); showRing(); }
  wstage.addEventListener('pointermove', e => {
    showRing(e);
    const s = L.stroke;
    if (!s) return;
    if (s.pan) { wstage.scrollLeft = s.l - (e.clientX - s.x); wstage.scrollTop = s.t - (e.clientY - s.y); return; }
    if (s.straight) return;
    const p = pointWord(e);
    strokeTo(s.last, p); s.last = p; drawWord();
  });
  const endStroke = () => { if (L.stroke && !L.stroke.pan) { L.anchor = L.stroke.last; changed(); } L.stroke = null; };
  wstage.addEventListener('pointerup', endStroke);
  wstage.addEventListener('pointercancel', endStroke);
  wstage.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomWord(e.deltaY < 0 ? 1.25 : 0.8); } }, { passive: false });

  function changed() {
    L.changed = true; L.dirty = true;
    store.set('voynich-draft:' + L.word.id, JSON.stringify({ labels: Array.from(L.labels), reading: L.reading, checked: L.checked }));
    say('Saving soon…'); marks();
    clearTimeout(L.timer);
    L.timer = setTimeout(save, 2000);
  }

  // Saves go out in the background, one waiting save per word, newest wins; a save the
  // network drops is tried again, so nobody waits on the server to move to the next letter.
  const outbox = new Map();
  let retry = 0;
  async function send(id) {
    const job = outbox.get(id);
    if (!job || job.sending) return job && job.sending;
    const { body, word } = job;
    job.sending = (async () => {
      try {
        const text = JSON.stringify(body);  // keepalive lets a save finish after the tab closes, for bodies under 64 KB
        const r = await fetch(API + '/api/trace', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: text, keepalive: text.length < 60000 });
        const j = await r.json().catch(() => ({}));
        if (r.ok) {
          if (outbox.get(id) === job) { outbox.delete(id); store.set('voynich-draft:' + id, null); }
          if (body.add) sessionStorage.removeItem('voynich-add:' + id);
          if (j.verified) word.verified = j.verified;
          if (word === L.word && !L.dirty) say(j.done ? 'Every letter of this word is verified. Thank you!' : 'Saved');
          if (j.done) progressAsk = null;
        } else if (r.status >= 500 || r.status === 429) {
          throw new Error(j.error || r.status);
        } else {
          if (outbox.get(id) === job) outbox.delete(id);
          say('Not saved: ' + (j.error || r.status), true);
        }
      } catch {
        say('Not saved — no connection. It will try again.', true);
        clearTimeout(retry); retry = setTimeout(() => { for (const k of outbox.keys()) send(k); }, 10000);
      } finally {
        job.sending = null;
        const now = outbox.get(id);
        if (now && now !== job && !now.sending) send(id);  // a newer save came in while this one went out
      }
    })();
    return job.sending;
  }
  // nothing differs from the version the visitor started from: no pixel, no letter name
  function unchanged() {
    const a = L.labels, b = L.start && L.start.labels;
    if (L.add || !b || a.length !== b.length || L.reading.join() !== L.start.reading.join()) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function save() {
    clearTimeout(L.timer);
    if (!L.dirty || !L.word) return;
    L.dirty = false;
    // a word opened and left as it was is not saved, so it goes to the next person as if never served
    if (unchanged()) return;
    // everything is copied before the first wait, since the next word may open meanwhile
    const word = L.word, labels = L.labels.slice();
    const body = { word: word.id, tracer, labels: null, reading: L.reading.slice(), checked: L.checked.slice() };
    if (L.add) { body.add = L.add; L.add = null; }
    body.labels = await deflate(labels);
    const old = outbox.get(word.id);
    if (old && old.body.add && !body.add) body.add = old.body.add;  // a word added on the page goes with its box until it lands
    outbox.set(word.id, { body, word, sending: null });
    if (old && old.sending) return old.sending;  // sent as soon as the one going out lands
    return send(word.id);
  }

  async function goNext() {
    // the first check of this letter by anyone moves the book's bar now
    if (!unchanged() && !L.checked.includes(L.k) && !L.versions.some(v => v.checked && v.checked.includes(L.k))) bump();
    if (!L.checked.includes(L.k)) L.checked.push(L.k);
    L.dirty = true;
    save();
    // the next letter of this word not verified and not yet checked by you, else another word
    for (let k = L.k + 1; k <= L.reading.length; k++) {
      if ((L.word.verified || '')[k - 1] !== '1' && !L.checked.includes(k)) { location.hash = `#/w/${L.word.id}/${k}`; return; }
    }
    nextTask();
  }
  const skipped = [];
  // The word after this one is fetched while the visitor works on this one, its crop
  // too, so the next word opens at once. Kept a minute at most.
  let ahead = null;
  const wordAhead = new Map();
  function askNext(skip) {
    return getJSON(`${API}/api/next?tracer=${tracer}&with=word&skip=${skip.slice(-50).join(',')}`).then(j => {
      if (j.data) { wordAhead.set(j.word, { data: j.data, at: Date.now() }); const w = j.data.word; loadImage(cropURL(w.iiif, w.x, w.y, w.w, w.h)).catch(() => {}); }
      return j;
    });
  }
  function fetchAhead() {
    if (!L.word) return;
    const current = L.word.id;
    const p = askNext([...skipped, current]).then(async j => {
      if (!j.word || j.word === current || j.data) return j;
      const data = await getJSON(`${API}/api/word/${encodeURIComponent(j.word)}?tracer=${tracer}`);
      wordAhead.set(j.word, { data, at: Date.now() });
      const w = data.word;
      loadImage(cropURL(w.iiif, w.x, w.y, w.w, w.h)).catch(() => {});
      return j;
    });
    p.catch(() => {});
    ahead = { from: current, at: Date.now(), p };
  }
  async function nextTask() {
    say('Finding the next letter…');
    try {
      const pre = ahead && ahead.from === (L.word && L.word.id) && Date.now() - ahead.at < 60000 ? ahead.p : null;
      ahead = null;
      let j = pre ? await pre.catch(() => null) : null;
      if (!j || !j.word || skipped.includes(j.word) || (L.word && j.word === L.word.id)) j = await askNext(skipped);
      if (!j.word) { say('Nothing left for you to check. Thank you!'); return; }
      location.hash = `#/w/${j.word}/${j.letter}`;
    } catch (e) { say('Could not reach the server: ' + e.message, true); }
    stats();
  }

  $('go').onclick = goNext;
  $('skip').onclick = async () => { save(); if (L.word) skipped.push(L.word.id); nextTask(); };
  $('erase').onclick = () => { L.erasing = !L.erasing; L.moving = false; marks(); };
  $('move').onclick = () => { L.moving = !L.moving; marks(); };
  $('hide').onclick = () => { L.hidden = !L.hidden; drawWord(); marks(); };
  $('undo').onclick = () => { if (L.undo.length) { const u = L.undo.pop(); if ('anchor' in u) L.anchor = u.anchor; L.labels = u; drawWord(); changed(); } };
  $('zoomin').onclick = () => zoomWord(1.25);
  $('zoomout').onclick = () => zoomWord(0.8);
  $('fit').onclick = fitWord;
  document.querySelectorAll('.sz').forEach(b => b.onclick = () => setBrush(+b.dataset.s));
  $('name').onchange = () => {
    L.reading[L.k - 1] = $('name').value;
    changed(); ask(); versionStrip(); examplesFor($('name').value); $('name').blur();
  };
  $('remove-letter').onclick = () => {
    if (L.reading.length < 2) { say('A word needs at least one letter', true); return; }
    if (!confirm(`Take "${L.reading[L.k - 1]}" out of this word? Its pixels go too.`)) return;
    L.undo.push(L.labels.slice());
    for (let i = 0; i < L.labels.length; i++) {
      const v = L.labels[i];
      L.labels[i] = v === L.k ? 0 : v > L.k ? v - 1 : v;
    }
    L.reading.splice(L.k - 1, 1);
    L.checked = L.checked.filter(c => c !== L.k).map(c => c > L.k ? c - 1 : c);
    L.word.verified = '';
    changed();
    const to = `#/w/${L.word.id}/${Math.min(L.k, L.reading.length)}`;
    if (location.hash === to) openLetter(L.word.id, Math.min(L.k, L.reading.length)); else location.hash = to;
  };
  // A stacked glyph, letters written over one another as one shape (a bench gallows), is one letter
  // whose name lists its parts: c+t+h. "← Stack" joins this letter with the one before, "Stack →" with
  // the one after; Unstack splits it again. Stacking remembers, in this browser, which pixels were which
  // part, so Unstack gives each letter its own ink back (ink erased or painted since stays as it is now).
  // A stack made elsewhere has no such record, and its ink stays on its first letter to be painted apart.
  const stackKey = id => 'voynich-stacks:' + id;
  const stackMemos = id => { try { return JSON.parse(store.get(stackKey(id)) || '{}'); } catch { return {}; } };
  function stackAt(a) {
    // letters a and a + 1 (counted from 1) become one stacked letter at a
    const left = L.reading[a - 1], right = L.reading[a], joined = `${left}+${right}`;
    if (joined.length > 20) { say('That stack is too long to save', true); return; }
    const memos = stackMemos(L.word.id), ml = memos[left] && new Map(memos[left]), mr = memos[right] && new Map(memos[right]);
    const nl = left.split('+').length, memo = [];
    L.undo.push(L.labels.slice());
    for (let i = 0; i < L.labels.length; i++) {
      const v = L.labels[i];
      if (v === a) memo.push([i, ml ? ml.get(i) || 0 : 0]);
      else if (v === a + 1) memo.push([i, nl + (mr ? mr.get(i) || 0 : 0)]);
      L.labels[i] = v === a + 1 ? a : v > a + 1 ? v - 1 : v;
    }
    memos[joined] = memo;
    store.set(stackKey(L.word.id), JSON.stringify(memos));
    L.reading.splice(a - 1, 2, joined);
    L.checked = L.checked.filter(c => c !== a && c !== a + 1).map(c => c > a + 1 ? c - 1 : c);
    L.word.verified = '';
    changed();
    const to = `#/w/${L.word.id}/${a}`;
    if (location.hash === to) openLetter(L.word.id, a); else location.hash = to;
  }
  $('stack').onchange = () => {
    const pick = $('stack').value;
    $('stack').value = '';
    $('stack').blur();
    if (pick === 'left' && L.k > 1) stackAt(L.k - 1);
    else if (pick === 'right' && L.k < L.reading.length) stackAt(L.k);
    else if (pick === 'unstack') unstack();
  };
  function unstack() {
    const name = L.reading[L.k - 1], parts = name.split('+'), add = parts.length - 1;
    if (!add) { say('This letter is not stacked', true); return; }
    if (L.reading.length + add > 20) { say('A word holds at most 20 letters', true); return; }
    const memos = stackMemos(L.word.id), memo = memos[name] && new Map(memos[name]);
    L.undo.push(L.labels.slice());
    for (let i = 0; i < L.labels.length; i++) {
      const v = L.labels[i];
      if (v === L.k) L.labels[i] = L.k + Math.min(add, memo ? memo.get(i) || 0 : 0);
      else if (v > L.k) L.labels[i] = v + add;
    }
    delete memos[name];
    store.set(stackKey(L.word.id), Object.keys(memos).length ? JSON.stringify(memos) : null);
    L.reading.splice(L.k - 1, 1, ...parts);
    L.checked = L.checked.filter(c => c !== L.k).map(c => c > L.k ? c + add : c);
    L.word.verified = '';
    changed();
    const to = `#/w/${L.word.id}/${L.k}`;
    if (location.hash === to) openLetter(L.word.id, L.k); else location.hash = to;
    if (!memo) say(`No record of which ink was whose here, so it all stays on ${parts[0]}: paint ${parts.slice(1).join(' and ')} again`, true);
  }
  $('add-letter').onclick = () => {
    if (L.reading.length >= 20) return;
    L.undo.push(L.labels.slice());
    for (let i = 0; i < L.labels.length; i++) if (L.labels[i] > L.k) L.labels[i]++;
    L.reading.splice(L.k, 0, '?');
    L.checked = L.checked.map(c => c > L.k ? c + 1 : c);
    L.word.verified = '';
    changed();
    location.hash = `#/w/${L.word.id}/${L.k + 1}`;
  };

  // ---- the page view ------------------------------------------------------
  const P = { page: null, info: null, words: [], scale: 1, zoom: 1, hidden: false, boxing: false, drag: null, box: null, untraced: [] };
  const pstage = $('page-stage'), player = $('page-layer'), ptrace = $('page-trace'), hoverbox = $('hoverbox'), drawbox = $('drawbox');

  async function openPage(page) {
    views('page-view');
    await save();
    const list = await pages();
    const i = list.findIndex(p => p.page === page);
    if (i < 0) { $('p-status').textContent = 'No such page'; return; }
    const info = list[i];
    $('page-name').textContent = page;
    $('prev-page').href = i ? `#/p/${list[i - 1].page}` : '#/pages';
    $('next-page').href = i + 1 < list.length ? `#/p/${list[i + 1].page}` : '#/pages';
    $('p-status').textContent = 'Loading the page…';
    const load = P.load = (P.load || 0) + 1;
    P.page = page; P.info = info;
    P.scale = Math.min(1, 2400 / info.width);
    player.querySelectorAll('img').forEach(i => i.remove());
    for (const im of info.images) {
      const img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      // a small scan first, which Yale sends in half a second, then the sharp one in its place
      const sharp = `${im.iiif}/full/${Math.round(im.w * P.scale)},/0/default.jpg`;
      const preview = `${im.iiif}/full/600,/0/default.jpg`;
      img.src = preview; img.dataset.yale = sharp;
      loadImage(sharp).then(() => { if (img.isConnected && img.getAttribute('src') === preview) img.src = sharp; }).catch(() => {});
      img.dataset.offset = im.offset; img.dataset.w = im.w; img.dataset.h = im.h;
      player.insertBefore(img, ptrace);
    }
    const [data, own, untraced] = await Promise.all([getJSON(`${API}/api/page/${page}`),
      getJSON(`${API}/api/mine/${page}?tracer=${tracer}`).catch(() => ({ mine: {}, latest: {} })), getJSON(`data/untraced/${page}.json`).catch(() => [])]);
    for (const w of data.words) { w.mine = own.mine[w.id]; w.latest = own.latest[w.id]; }
    const grids = await Promise.all(data.words.map(w => inflate(w.mine || w.latest || w.ai)));
    if (load !== P.load) return;  // another page was opened while this one loaded
    P.untraced = untraced;
    ptrace.width = Math.round(info.width * P.scale); ptrace.height = Math.round(info.height * P.scale);
    const g = ptrace.getContext('2d');
    g.clearRect(0, 0, ptrace.width, ptrace.height);
    P.words = [];
    // every word's pixels written into one image the size of the page, then drawn once:
    // a word's crop is mostly margin, so only its inked pixels are touched
    const W = info.width, H = info.height;
    const sheet = new ImageData(W, H), out = new Uint32Array(sheet.data.buffer);
    const alpha = [];
    for (const [j, w] of data.words.entries()) {
      // your own version where you have one, else the latest for a word someone added, else the computer's
      const grid = grids[j];
      const im = info.images.find(m => m.iiif === w.iiif) || info.images[0];
      const px = w.x + im.offset;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0, i = 0; y < w.h; y++) {
        const row = (w.y + y) * W + px;
        for (let x = 0; x < w.w; x++, i++) {
          const v = grid[i];
          if (!v) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          if (w.y + y < H && px + x < W) out[row + x] = alpha[v] || (alpha[v] = pixel(v, 190));
        }
      }
      const box = x1 >= 0 ? { x0: px + x0, y0: w.y + y0, x1: px + x1 + 1, y1: w.y + y1 + 1 }
        : w.box ? { x0: w.box[0], y0: w.box[1], x1: w.box[2], y1: w.box[3] } : { x0: px, y0: w.y, x1: px + w.w, y1: w.y + w.h };
      P.words.push({ ...box, id: w.id, reading: w.reading, verified: w.verified, done: w.done, mine: !!w.mine });
    }
    const tmp = document.createElement('canvas');
    tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(sheet, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(tmp, 0, 0, ptrace.width, ptrace.height);
    // done words under a see-through green box, so nobody spends time on them; your words outlined in gold
    for (const b of P.words) {
      if (!b.done && !b.mine) continue;
      const x = (b.x0 - 3) * P.scale, y = (b.y0 - 3) * P.scale, bw = (b.x1 - b.x0 + 6) * P.scale, bh = (b.y1 - b.y0 + 6) * P.scale;
      g.lineWidth = Math.max(4, 9 * P.scale);
      g.fillStyle = b.done ? 'rgba(40, 200, 90, 0.45)' : 'rgba(255, 200, 40, 0.22)';
      g.strokeStyle = b.done ? 'rgb(40, 200, 90)' : 'rgb(255, 200, 40)';
      g.fillRect(x, y, bw, bh);
      g.strokeRect(x, y, bw, bh);
    }
    fitPage();
    pageUV();
    const missing = untraced.length;
    const mineN = P.words.filter(b => b.mine).length, doneN = P.words.filter(b => b.done).length;
    $('p-status').textContent = `${data.words.length} words traced${missing ? `, ${missing} missing — add them with "+ Add a missing word"` : ''}. Click a word to check its letters.`
      + (mineN ? ` Gold boxes: the ${mineN} you worked on.` : '') + (doneN ? ` Green boxes: ${doneN} done, no need to check them.` : '');
  }
  function sizePage() {
    const W = P.info.width * P.zoom, H = P.info.height * P.zoom;
    player.style.width = W + 'px'; player.style.height = H + 'px';
    for (const im of player.querySelectorAll('img')) {
      im.style.left = im.dataset.offset * P.zoom + 'px';
      im.style.width = im.dataset.w * P.zoom + 'px'; im.style.height = im.dataset.h * P.zoom + 'px';
    }
    ptrace.style.visibility = P.hidden ? 'hidden' : 'visible';
    if (P.box) drawBox();
  }
  function fitPage() {
    P.zoom = Math.min((pstage.clientWidth - 20) / P.info.width, (pstage.clientHeight - 20) / P.info.height);
    sizePage(); pstage.scrollTop = 0; pstage.scrollLeft = 0;
  }
  function zoomPage(f) {
    const cx = (pstage.scrollLeft + pstage.clientWidth / 2) / P.zoom, cy = (pstage.scrollTop + pstage.clientHeight / 2) / P.zoom;
    P.zoom = Math.max(0.05, Math.min(3, P.zoom * f));
    sizePage();
    pstage.scrollLeft = cx * P.zoom - pstage.clientWidth / 2; pstage.scrollTop = cy * P.zoom - pstage.clientHeight / 2;
  }
  function pagePoint(e) {
    const r = player.getBoundingClientRect();
    return { x: (e.clientX - r.left) / P.zoom, y: (e.clientY - r.top) / P.zoom };
  }
  function hit(p) {
    const hits = P.words.filter(b => p.x >= b.x0 - 4 && p.x <= b.x1 + 4 && p.y >= b.y0 - 4 && p.y <= b.y1 + 4);
    hits.sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
    return hits[0] || null;
  }
  function hover(b) {
    hoverbox.style.display = b ? 'block' : 'none';
    if (!b) return;
    Object.assign(hoverbox.style, { left: b.x0 * P.zoom + 'px', top: b.y0 * P.zoom + 'px', width: Math.max(8, (b.x1 - b.x0) * P.zoom) + 'px', height: Math.max(8, (b.y1 - b.y0) * P.zoom) + 'px' });
    hoverbox.title = b.id;
    $('p-status').textContent = `${b.id}: ${b.reading.join(' ')}${b.done ? ' · done, two people agreed on every letter' : `${b.mine ? ' · you worked on this one' : ''} — click to check it`}`;
  }
  function drawBox() {
    const b = P.box;
    Object.assign(drawbox.style, { display: 'block', left: b.x0 * P.zoom + 'px', top: b.y0 * P.zoom + 'px', width: (b.x1 - b.x0) * P.zoom + 'px', height: (b.y1 - b.y0) * P.zoom + 'px' });
  }
  function toggleBoxing() {
    P.boxing = !P.boxing;
    $('p-add').classList.toggle('on', P.boxing);
    pstage.classList.toggle('boxing', P.boxing);
    if (!P.boxing) cancelAdd();
    else $('p-status').textContent = 'Draw a box round a word that has no colors';
  }
  function cancelAdd() { P.box = null; P.drag = null; drawbox.style.display = 'none'; $('addpanel').hidden = true; }
  function guesses() {
    const b = P.box, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, num = id => +id.split('.w').pop();
    return P.untraced.map(u => {
      const line = P.words.filter(w => w.id.startsWith(u.locus + '.w'));
      if (!line.length) return { u, score: 1e9 + u.n };
      const ys = line.map(w => (w.y0 + w.y1) / 2).sort((a, c) => a - c), yc = ys[ys.length >> 1];
      const before = line.filter(w => num(w.id) < u.n).sort((a, c) => num(c.id) - num(a.id))[0];
      const after = line.filter(w => num(w.id) > u.n).sort((a, c) => num(a.id) - num(c.id))[0];
      const lo = before ? before.x1 : -1e9, hi = after ? after.x0 : 1e9, dx = cx < lo ? lo - cx : cx > hi ? cx - hi : 0;
      return { u, score: Math.abs(cy - yc) + dx * 0.5 };
    }).sort((a, c) => a.score - c.score).map(g => g.u);
  }
  function openAddPanel() {
    const sel = $('addword');
    sel.replaceChildren();
    const list = guesses();
    if (!list.length) { $('p-status').textContent = 'Every word of this page\'s transcription is traced'; cancelAdd(); return; }
    list.forEach((u, i) => { const o = document.createElement('option'); o.value = u.word; o.textContent = `${u.word}  ·  ${u.reading.join(' ')}${i ? '' : '   (best guess)'}`; sel.append(o); });
    sel.selectedIndex = 0;
    const r = drawbox.getBoundingClientRect(), panel = $('addpanel');
    panel.hidden = false;
    panel.style.left = Math.max(8, Math.min(innerWidth - panel.offsetWidth - 8, r.left)) + 'px';
    panel.style.top = (r.bottom + 8 + panel.offsetHeight < innerHeight ? r.bottom + 8 : Math.max(8, r.top - panel.offsetHeight - 8)) + 'px';
    sel.focus();
  }
  async function addWord() {
    const id = $('addword').value, u = P.untraced.find(x => x.word === id), b = P.box;
    if (!u || !b) return;
    const box = [b.x0, b.y0, b.x1, b.y1].map(Math.round);
    const im = P.info.images.find(m => box[0] >= m.offset && box[2] <= m.offset + m.w);
    if (!im) { $('p-status').textContent = 'Draw the box inside one picture'; return; }
    const lx0 = Math.max(0, box[0] - im.offset - NEW_MARGIN), ly0 = Math.max(0, box[1] - NEW_MARGIN);
    const lx1 = Math.min(im.w, box[2] - im.offset + NEW_MARGIN), ly1 = Math.min(im.h, box[3] + NEW_MARGIN);
    const add = { iiif: im.iiif, box: [box[0] - im.offset, box[1], box[2] - im.offset, box[3]], crop: [lx0, ly0, lx1 - lx0, ly1 - ly0] };
    const blank = await deflate(new Uint8Array((lx1 - lx0) * (ly1 - ly0)));
    const word = { id, page: P.page, iiif: im.iiif, x: lx0, y: ly0, w: lx1 - lx0, h: ly1 - ly0, reading: u.reading, ai: blank, kind: 'new', box: add.box, verified: '', done: false };
    sessionStorage.setItem('voynich-add:' + id, JSON.stringify({ word, add }));
    cancelAdd(); toggleBoxing();
    L.word = null;
    location.hash = `#/w/${id}/1`;
  }

  pstage.addEventListener('pointerdown', e => {
    if (!P.info) return;
    if (P.boxing && e.button === 0) {
      e.preventDefault(); $('addpanel').hidden = true;
      const p = pagePoint(e); P.drag = p; P.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; drawBox(); capture(pstage, e); return;
    }
    P.pan = { x: e.clientX, y: e.clientY, l: pstage.scrollLeft, t: pstage.scrollTop, moved: false };
    capture(pstage, e);
  });
  pstage.addEventListener('pointermove', e => {
    if (!P.info) return;
    if (P.drag) {
      const p = pagePoint(e);
      P.box = { x0: Math.min(P.drag.x, p.x), y0: Math.min(P.drag.y, p.y), x1: Math.max(P.drag.x, p.x), y1: Math.max(P.drag.y, p.y) };
      drawBox(); return;
    }
    if (P.pan) {
      if (Math.hypot(e.clientX - P.pan.x, e.clientY - P.pan.y) > 5) P.pan.moved = true;
      if (P.pan.moved) { pstage.scrollLeft = P.pan.l - (e.clientX - P.pan.x); pstage.scrollTop = P.pan.t - (e.clientY - P.pan.y); }
      return;
    }
    if (!P.boxing) hover(hit(pagePoint(e)));
  });
  pstage.addEventListener('pointerup', e => {
    if (P.drag) {
      P.drag = null;
      if (P.box.x1 - P.box.x0 < 6 || P.box.y1 - P.box.y0 < 6) { cancelAdd(); return; }
      openAddPanel(); return;
    }
    const clicked = P.pan && !P.pan.moved;
    P.pan = null;
    if (clicked && !P.boxing) {
      const b = hit(pagePoint(e));
      if (b && b.done) { $('p-status').textContent = `${b.id} is done: two people agreed on every letter. Pick a word without a green box.`; return; }
      if (b) {
        const open = [...b.reading.keys()].find(i => (b.verified || '')[i] !== '1');
        L.word = null;
        location.hash = `#/w/${b.id}/${(open ?? 0) + 1}`;
      }
    }
  });
  pstage.addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomPage(e.deltaY < 0 ? 1.25 : 0.8); } }, { passive: false });
  $('p-zoomin').onclick = () => zoomPage(1.25);
  $('p-zoomout').onclick = () => zoomPage(0.8);
  $('p-fit').onclick = fitPage;
  $('p-hide').onclick = () => { P.hidden = !P.hidden; $('p-hide').classList.toggle('on', P.hidden); sizePage(); };
  $('p-add').onclick = toggleBoxing;
  $('addgo').onclick = addWord;
  $('addcancel').onclick = cancelAdd;
  $('addword').ondblclick = addWord;
  $('addword').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); addWord(); } if (e.key === 'Escape') cancelAdd(); };

  // ---- the page list ------------------------------------------------------
  async function openPages() {
    views('pages-view');
    save();
    const list = await pages();
    const box = $('page-list');
    if (!box.childElementCount) {
      for (const p of list) {
        const a = document.createElement('a');
        a.href = `#/p/${p.page}`;
        a.dataset.page = p.page;
        a.innerHTML = `<b>${p.page}</b>${p.uv ? '<i class="uvtag" title="This page has UV scans">UV</i>' : ''}<span class="count">${p.words} words</span><span class="done"></span><span class="meter"><span></span></span>`;
        box.append(a);
      }
    }
    // how far each page has got, from the Worker; a page list without it still works
    let prog;
    try { prog = await progressData(); } catch { return; }
    let started = 0, finished = 0;
    for (const a of box.children) {
      const p = prog[a.dataset.page];
      if (!p || !p.words) continue;
      const share = p.done / p.words;
      a.classList.toggle('started', p.worked > 0);
      a.classList.toggle('finished', p.done === p.words);
      a.querySelector('.done').textContent = p.done ? `${p.done} done` : p.worked ? `${p.worked} in progress` : '';
      a.querySelector('.meter span').style.width = `${Math.max(share, p.worked ? 0.03 : 0) * 100}%`;
      a.title = `${p.done} of ${p.words} words done, ${p.worked} worked on, ${p.letters} letters verified`;
      if (p.worked) started++;
      if (p.done === p.words) finished++;
    }
    $('pages-hint').textContent = started
      ? `${started} of ${list.length} pages started${finished ? `, ${finished} finished` : ''}. Pick any page, or one nobody has touched yet.`
      : 'Pick a page to see its tracings. Nobody has started any yet, so any page is a first.';
  }

  // ---- the UV scans -------------------------------------------------------
  // The pages with 2014 multispectral scans carry "uv": {kind: label} in pages.json,
  // their views in data/uv/<page>-<kind>.jpg in the Yale image's pixels, and each
  // word's small shift onto them in data/uv/<page>.json (null: the scan misses it).
  // Every other page shows no UV control at all.
  const UV = { on: store.get('voynich-uv') === '1', kind: store.get('voynich-uv-kind') || 'glow', images: {}, shifts: {} };
  const uvImage = (page, kind) => UV.images[page + kind] || (UV.images[page + kind] = loadImage(`data/uv/${page}-${kind}.jpg`));
  const uvShifts = page => UV.shifts[page] || (UV.shifts[page] = getJSON(`data/uv/${page}.json`).catch(() => ({})));
  const uvKinds = async page => ((await pages()).find(p => p.page === page) || {}).uv || null;
  function uvControls(group, button, select, kinds) {
    $(group).hidden = !kinds;
    if (!kinds) return;
    if (!kinds[UV.kind]) UV.kind = Object.keys(kinds)[0];
    const sel = $(select);
    if (sel.dataset.kinds !== Object.keys(kinds).join()) {
      // glow first: an object puts the key "365" before "glow"
      sel.replaceChildren(...Object.entries(kinds).sort(([a], [b]) => (a !== 'glow') - (b !== 'glow')).map(([k, label]) => { const o = document.createElement('option'); o.value = k; o.textContent = label; return o; }));
      sel.dataset.kinds = Object.keys(kinds).join();
    }
    sel.value = UV.kind;
    $(button).classList.toggle('on', UV.on);
  }
  async function wordUV() {
    const word = L.word, layer = $('uvcrop');
    if (!word) return;
    const kinds = await uvKinds(word.page);
    const shift = kinds ? (await uvShifts(word.page))[word.id] : null;
    const usable = kinds && shift !== null ? kinds : null;  // a word the scan misses, or a page with none
    if (L.word !== word) return;
    uvControls('uv-group', 'uv', 'uv-kind', usable);
    if (!usable || !UV.on) { layer.hidden = true; return; }
    const [dx, dy] = shift || [0, 0];
    const kind = UV.kind;
    const img = await uvImage(word.page, kind).catch(() => null);
    if (L.word !== word || UV.kind !== kind || !UV.on) return;
    if (!img) { layer.hidden = true; say('The UV scan did not load', true); return; }
    layer.width = word.w; layer.height = word.h;
    const g = layer.getContext('2d');
    g.fillStyle = '#282828';
    g.fillRect(0, 0, word.w, word.h);
    g.drawImage(img, word.x - dx, word.y - dy, word.w, word.h, 0, 0, word.w, word.h);
    layer.hidden = false;
  }
  async function pageUV() {
    const info = P.info;
    if (!info) return;
    const kinds = info.uv && info.images.length === 1 ? info.uv : null;
    uvControls('p-uv-group', 'p-uv', 'p-uv-kind', kinds);
    const img = player.querySelector('img');
    if (!img) return;
    if (!img.dataset.yale) img.dataset.yale = img.src;
    // Yale's scan, small or sharp, stays as it is unless a UV view is on or coming off
    const src = img.getAttribute('src');
    if (kinds && UV.on) { const want = `data/uv/${info.page}-${UV.kind}.jpg`; if (src !== want) img.src = want; }
    else if (src.startsWith('data/uv/')) img.src = img.dataset.yale;
  }
  function refreshUV() {
    store.set('voynich-uv', UV.on ? '1' : '0');
    store.set('voynich-uv-kind', UV.kind);
    if (!$('letter-view').hidden) wordUV();
    if (!$('page-view').hidden) pageUV();
  }
  const toggleUV = () => { UV.on = !UV.on; refreshUV(); };
  $('uv').onclick = toggleUV;
  $('p-uv').onclick = toggleUV;
  for (const id of ['uv-kind', 'p-uv-kind']) $(id).onchange = e => { UV.kind = e.target.value; UV.on = true; e.target.blur(); refreshUV(); };
  // a tap of Shift on its own, as in Glyph Painter, shows or hides the UV scan where there is one
  let shiftTap = false;
  document.addEventListener('keydown', e => { shiftTap = e.key === 'Shift' && !e.repeat; }, true);
  document.addEventListener('pointerdown', () => { shiftTap = false; }, true);
  document.addEventListener('keyup', e => {
    if (e.key !== 'Shift' || !shiftTap) return;
    shiftTap = false;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || $('help').open || $('credit').open || $('credits').open) return;
    const group = !$('letter-view').hidden ? 'uv-group' : !$('page-view').hidden ? 'p-uv-group' : null;
    if (group && !$(group).hidden) toggleUV();
  }, true);

  // ---- keys and routes ----------------------------------------------------
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' || $('help').open) return;
    const inLetter = !$('letter-view').hidden, inPage = !$('page-view').hidden;
    // hold H to see the page under the tracing
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (inLetter && L.word && !L.hidden) { L.hidden = true; drawWord(); }
      if (inPage && P.info && !P.hidden) { P.hidden = true; sizePage(); }
      return;
    }
    // Esc goes back: from a letter to its page, from a page to the list of pages
    if (e.key === 'Escape') {
      if (inLetter && L.word) { e.preventDefault(); location.hash = `#/p/${L.word.page}`; return; }
      if (inPage && P.info) {
        e.preventDefault();
        if (P.boxing) toggleBoxing(); else location.hash = '#/pages';
        return;
      }
    }
    if (inLetter && L.word) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undo').click(); return; }
      if (e.code === 'Space') { e.preventDefault(); L.space = true; marks(); return; }
      if (e.key === '+' || e.key === '=') zoomWord(1.25);
      if (e.key === '-') zoomWord(0.8);
      if (e.key === 'e' || e.key === 'E') $('erase').click();
      if (e.key === '[') setBrush(L.brush - 1);
      if (e.key === ']') setBrush(L.brush + 1);
      if (e.key === 'Enter') goNext();
    }
    if (inPage && P.info) {
      if (e.key === '+' || e.key === '=') zoomPage(1.25);
      if (e.key === '-') zoomPage(0.8);
      if (e.key === 'b' || e.key === 'B') toggleBoxing();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') { L.space = false; marks(); }
    if (e.key === 'h' || e.key === 'H') {
      if (L.word) { L.hidden = $('hide').classList.contains('on'); drawWord(); }
      if (P.info) { P.hidden = $('p-hide').classList.contains('on'); sizePage(); }
    }
  });
  window.addEventListener('blur', () => { L.space = false; marks(); });
  window.addEventListener('pagehide', () => { if (L.dirty) save(); for (const k of outbox.keys()) send(k); });

  async function route() {
    const h = location.hash;
    let m;
    if ((m = /^#\/w\/([^/]+)\/(\d+)$/.exec(h))) return openLetter(decodeURIComponent(m[1]), +m[2]);
    if ((m = /^#\/p\/([^/]+)$/.exec(h))) return openPage(decodeURIComponent(m[1]));
    if (h === '#/pages') return openPages();
    views('letter-view');
    return nextTask();
  }
  window.addEventListener('hashchange', route);
  $('help-open').onclick = () => $('help').showModal();
  // the Credits list: every name left under "Get credited", most agreed letters first
  $('credits-open').onclick = async () => {
    $('credits-list').className = 'hint';
    $('credits-list').textContent = 'Loading…';
    $('credits').showModal();
    try {
      const { names } = await getJSON(`${API}/api/credit-list`);
      $('credits-list').className = '';
      $('credits-list').textContent = names.length ? names.join(' · ') : 'No one has left a name yet.';
    } catch (e) { $('credits-list').className = 'hint bad'; $('credits-list').textContent = `Couldn't load the credits: ${e.message}`; }
  };

  // The name for the credits, kept on the Worker against this browser's tracer id.
  const creditLink = `${location.origin}${location.pathname}#t=${tracer}`;
  $('credit-link').textContent = creditLink;
  $('credit-link').href = creditLink;
  // The header says the name the Worker holds, so a visitor sees at once if it was lost.
  function showCredit(name) {
    $('credit-open').textContent = name ? `Credited as ${name}` : 'Get credited';
    $('credit-open').title = name ? 'Change or remove your name for the credits' : 'Leave a name for the credits';
  }
  showCredit(store.get('voynich-credit') || '');
  getJSON(`${API}/api/name?tracer=${tracer}`).then(r => { store.set('voynich-credit', r.name || null); showCredit(r.name); }).catch(() => {});
  $('credit-open').onclick = async () => {
    $('credit-status').textContent = '';
    $('credit-status').className = 'hint';
    $('credit-name').value = store.get('voynich-credit') || '';
    $('credit').showModal();
    try { $('credit-name').value = (await getJSON(`${API}/api/name?tracer=${tracer}`)).name; } catch { /* leave it as typed */ }
  };
  $('credit-close').onclick = () => $('credit').close();
  $('credit-link').onclick = e => { e.preventDefault(); navigator.clipboard?.writeText(creditLink).then(() => { $('credit-status').textContent = 'Link copied.'; }); };
  $('credit-save').onclick = async () => {
    const name = $('credit-name').value.trim();
    try {
      const r = await fetch(`${API}/api/name`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tracer, name }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.status);
      $('credit-status').className = 'hint';
      $('credit-status').textContent = name ? `Saved. You'll be credited as ${j.name}.` : 'Saved. You stay anonymous.';
      store.set('voynich-credit', j.name || null);
      showCredit(j.name);
    } catch (e) {
      $('credit-status').className = 'hint bad';
      $('credit-status').textContent = `Not saved: ${e.message}`;
    }
  };
  $('credit-name').onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') $('credit-save').click(); };
  $('credit-name').onkeyup = e => e.stopPropagation();
  if (!store.get('voynich-seen-help')) { store.set('voynich-seen-help', '1'); $('help').showModal(); }
  route();
  stats();
})();
