// Trace the Voynich: one word at a time, painted letter by letter on Yale's
// scan, saved two seconds after the last stroke.
(() => {
  const API = 'https://voynich-tracing.norml.workers.dev';
  const COLORS = [[230, 25, 75], [60, 180, 75], [0, 130, 200], [245, 130, 48], [145, 30, 180], [70, 240, 240],
    [240, 50, 230], [128, 128, 0], [0, 0, 128], [170, 110, 40], [128, 0, 0], [0, 128, 128], [0, 255, 0],
    [255, 100, 0], [255, 0, 160], [0, 80, 255], [150, 220, 0], [220, 0, 100], [0, 180, 230], [100, 0, 220]];
  const $ = id => document.getElementById(id);
  const stage = $('stage'), layer = $('layer'), scan = $('scan'), canvas = $('paint'), g = canvas.getContext('2d');
  const status = $('status');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  // the tracer id: made once, or set from a link ending #t=<id>
  const fromLink = /(?:^|&)t=([a-z0-9-]{12,64})/.exec(location.hash.slice(1));
  if (fromLink) { store.set('voynich-tracer', fromLink[1]); history.replaceState(null, '', location.pathname); }
  let tracer = store.get('voynich-tracer');
  if (!tracer) {
    tracer = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    store.set('voynich-tracer', tracer);
  }

  let word = null, labels = null, cur = 1, brush = 2, erasing = false, zoom = 2, undo = [], stroke = null;
  let moving = false, spaceHeld = false, hidden = false, dirty = false, timer = null, saving = null;
  const skipped = [];

  function say(text, bad = false) { status.textContent = text; status.classList.toggle('bad', bad); }

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

  function draw() {
    const img = g.createImageData(word.w, word.h);
    if (!hidden) {
      for (let i = 0; i < labels.length; i++) {
        const k = labels[i];
        if (!k) continue;
        const c = COLORS[(k - 1) % COLORS.length];
        img.data.set([c[0], c[1], c[2], 200], i * 4);
      }
    }
    g.putImageData(img, 0, 0);
  }

  function size() {
    if (!word) return;
    layer.style.width = word.w * zoom + 'px';
    layer.style.height = word.h * zoom + 'px';
  }
  function fit() {
    zoom = Math.max(1, Math.min(8, (stage.clientWidth - 24) / word.w, (stage.clientHeight - 24) / word.h));
    size();
  }
  function setZoom(f) {
    const cx = (stage.scrollLeft + stage.clientWidth / 2) / zoom, cy = (stage.scrollTop + stage.clientHeight / 2) / zoom;
    zoom = Math.max(1, Math.min(16, zoom * f));
    size();
    stage.scrollLeft = cx * zoom - stage.clientWidth / 2;
    stage.scrollTop = cy * zoom - stage.clientHeight / 2;
  }

  function letterButtons() {
    const box = $('letters');
    box.replaceChildren();
    word.reading.forEach((name, i) => {
      const b = document.createElement('button');
      const c = COLORS[i % COLORS.length];
      b.className = 'letter';
      b.dataset.k = i + 1;
      b.title = `Letter ${i + 1}: ${name}`;
      b.innerHTML = `<i style="background:rgb(${c})"></i>`;
      b.append(name);
      b.onclick = () => pick(i + 1);
      box.append(b);
    });
    pick(1);
  }
  function pick(k) {
    cur = k; erasing = false; moving = false; marks();
  }
  function marks() {
    document.querySelectorAll('.letter').forEach(b => b.classList.toggle('on', !erasing && +b.dataset.k === cur));
    $('erase').classList.toggle('on', erasing);
    $('move').classList.toggle('on', moving);
    stage.classList.toggle('moving', moving || spaceHeld);
    document.querySelectorAll('.size').forEach(b => b.classList.toggle('on', +b.dataset.s === brush));
    $('hide').classList.toggle('on', hidden);
  }

  function point(e) {
    const r = canvas.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / zoom), y: Math.floor((e.clientY - r.top) / zoom) };
  }
  function dab(x, y) {
    const half = Math.floor(brush / 2);
    for (let yy = y - half; yy < y - half + brush; yy++) {
      if (yy < 0 || yy >= word.h) continue;
      for (let xx = x - half; xx < x - half + brush; xx++) {
        if (xx < 0 || xx >= word.w) continue;
        labels[yy * word.w + xx] = erasing ? 0 : cur;
      }
    }
  }
  function line(a, b) {
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let i = 0; i <= n; i++) dab(Math.round(a.x + (b.x - a.x) * i / n), Math.round(a.y + (b.y - a.y) * i / n));
  }

  stage.addEventListener('pointerdown', e => {
    if (!word || moving || spaceHeld || e.button !== 0) {
      if (word && (moving || spaceHeld || e.button === 1)) {
        stroke = { pan: true, x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
        stage.setPointerCapture(e.pointerId);
      }
      return;
    }
    e.preventDefault();
    undo.push(labels.slice());
    if (undo.length > 60) undo.shift();
    const p = point(e);
    stroke = { last: p };
    dab(p.x, p.y);
    draw();
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!stroke) return;
    if (stroke.pan) {
      stage.scrollLeft = stroke.l - (e.clientX - stroke.x);
      stage.scrollTop = stroke.t - (e.clientY - stroke.y);
      return;
    }
    const p = point(e);
    line(stroke.last, p);
    stroke.last = p;
    draw();
  });
  const end = () => {
    if (stroke && !stroke.pan) changed();
    stroke = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(e.deltaY < 0 ? 1.25 : 0.8); }
  }, { passive: false });

  function changed() {
    dirty = true;
    store.set('voynich-draft:' + word.id, JSON.stringify(Array.from(labels.entries()).filter(([, v]) => v)));
    say('Saving soon…');
    clearTimeout(timer);
    timer = setTimeout(save, 2000);
  }

  async function save() {
    clearTimeout(timer);
    if (!dirty || !word) return saving;
    dirty = false;
    const sent = word;
    const body = JSON.stringify({ word: sent.id, tracer, labels: await deflate(labels) });
    saving = (async () => {
      try {
        const r = await fetch(API + '/api/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        const j = await r.json().catch(() => ({}));
        if (sent !== word) return;
        if (j.done) { say('Your tracing matches another — this word is done. Thank you!'); store.set('voynich-draft:' + sent.id, null); }
        else if (r.ok) say(j.saved ? 'Saved' : 'Nothing painted yet');
        else { say('Not saved: ' + (j.error || r.status), true); if (r.status >= 500) dirty = true; }
      } catch {
        dirty = true;
        say('Not saved — no connection. It will try again.', true);
        timer = setTimeout(save, 10000);
      }
    })();
    return saving;
  }

  async function load(next) {
    say('Loading a word…');
    let j;
    try {
      const r = await fetch(next ? `${API}/api/next?tracer=${tracer}&skip=${skipped.slice(-40).join(',')}`
        : `${API}/api/word/${encodeURIComponent(store.get('voynich-word'))}?tracer=${tracer}`);
      j = await r.json();
    } catch {
      say('Could not reach the server. Try again in a minute.', true);
      return;
    }
    if (!next && (!j.word || j.word.done)) return load(true);
    if (!j.word) { say('Every word is done or traced by you. Thank you!'); return; }
    word = j.word;
    store.set('voynich-word', word.id);
    labels = new Uint8Array(word.w * word.h);
    const draft = store.get('voynich-draft:' + word.id);
    if (draft) for (const [i, v] of JSON.parse(draft)) labels[i] = v;
    else if (j.mine) labels = await inflate(j.mine);
    undo = [];
    canvas.width = word.w;
    canvas.height = word.h;
    scan.src = `${word.iiif}/${word.x},${word.y},${word.w},${word.h}/full/0/default.jpg`;
    $('word').textContent = `Word ${word.id} · ${word.reading.join(' ')}`;
    letterButtons();
    fit();
    draw();
    stage.scrollLeft = (layer.offsetWidth - stage.clientWidth) / 2;
    stage.scrollTop = 0;
    say(draft ? 'Your unsaved painting is back' : 'Pick a letter, then paint over its ink');
    if (draft) { dirty = true; timer = setTimeout(save, 2000); }
  }

  async function stats() {
    try {
      const s = await (await fetch(API + '/api/stats')).json();
      $('stats').textContent = `${(s.done || 0).toLocaleString()} words done · ${(s.tracings || 0).toLocaleString()} tracings so far`;
    } catch { /* stats are a nicety */ }
  }

  $('next').onclick = async () => { await save(); await load(true); stats(); };
  $('skip').onclick = async () => { await save(); if (word) skipped.push(word.id); await load(true); };
  $('erase').onclick = () => { erasing = true; moving = false; marks(); };
  $('move').onclick = () => { moving = !moving; marks(); };
  $('hide').onclick = () => { hidden = !hidden; draw(); marks(); };
  $('undo').onclick = () => { if (undo.length) { labels = undo.pop(); draw(); changed(); } };
  $('zoomin').onclick = () => setZoom(1.25);
  $('zoomout').onclick = () => setZoom(0.8);
  document.querySelectorAll('.size').forEach(b => b.onclick = () => { brush = +b.dataset.s; marks(); });

  document.addEventListener('keydown', e => {
    if (!word) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('undo').click(); return; }
    if (e.code === 'Space') { e.preventDefault(); spaceHeld = true; marks(); return; }
    if (e.key === 'Alt') { e.preventDefault(); hidden = true; draw(); return; }
    if (e.key === '+' || e.key === '=') return setZoom(1.25);
    if (e.key === '-') return setZoom(0.8);
    if (e.key === 'e' || e.key === 'E') { if (!word.reading.includes(e.key)) { $('erase').click(); return; } }
    const k = word.reading.indexOf(e.key);
    if (k >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // the same letter twice in a word: each press moves to its next one
      const all = word.reading.map((n, i) => n === e.key ? i + 1 : 0).filter(Boolean);
      pick(all[(all.indexOf(cur) + 1) % all.length] || all[0]);
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') { spaceHeld = false; marks(); }
    if (e.key === 'Alt') { hidden = false; draw(); }
  });
  window.addEventListener('blur', () => { spaceHeld = false; marks(); });
  window.addEventListener('pagehide', () => { if (dirty) save(); });
  window.addEventListener('resize', () => word && size());

  load(!store.get('voynich-word'));
  stats();
})();
