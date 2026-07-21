// Project model (spec v2 Part II): the tool opens like an editor, not a
// drop-target. A project is a directory (File System Access API, or a local
// bridge for browsers without it) with an explicit project.json manifest.
// Files group into runs; a run's files merge by t in the core. Each run owns
// a .heapa in the project that auto-saves the whole analysis + workspace.
//
// main.js owns the viewer; this module owns storage + the landing screen and
// talks to main.js through the hooks passed to init().

const $ = (id) => document.getElementById(id);

let H = null; // hooks from main.js: {loadBuffers, buildMarks, applyMarks, status}

const P = {
  backend: null,      // active storage backend, or null (ephemeral mode)
  manifest: null,     // parsed project.json
  run: null,          // active run entry {name, files, heapa}
  pendingMarks: null, // .heapa content to apply after the trace loads
  lastSaved: '',      // JSON of the last .heapa written (change detection)
  quickLook: null,    // ephemeral source: {files: File[]} | {url}
};

export function isRunOpen() { return !!(P.backend && P.run); }
export function projectLabel() {
  return P.backend ? `${P.backend.name}:${P.run ? P.run.name : ''}` : null;
}

// ---------------------------------------------------------------------------
// storage backends — one interface, two transports
// ---------------------------------------------------------------------------

class DirBackend {
  constructor(handle) {
    this.handle = handle;
    this.name = handle.name;
    this.kind = 'dir';
  }
  async _walk(path, create) {
    let dir = this.handle;
    const parts = path.split('/').filter(Boolean);
    const file = parts.pop();
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
    return { dir, file };
  }
  async list(path = '') {
    let dir = this.handle;
    for (const p of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(p);
    }
    const out = [];
    for await (const [name, h] of dir.entries()) {
      out.push({ name, dir: h.kind === 'directory' });
    }
    return out;
  }
  async readFile(path) {
    const { dir, file } = await this._walk(path, false);
    const fh = await dir.getFileHandle(file);
    return (await fh.getFile()).arrayBuffer();
  }
  async readText(path) {
    return new TextDecoder().decode(await this.readFile(path));
  }
  async writeText(path, text) {
    const { dir, file } = await this._walk(path, true);
    const fh = await dir.getFileHandle(file, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async writeFile(path, buf) {
    const { dir, file } = await this._walk(path, true);
    const fh = await dir.getFileHandle(file, { create: true });
    const w = await fh.createWritable();
    await w.write(buf);
    await w.close();
  }
  async exists(path) {
    try { await this._walk(path, false).then(({ dir, file }) => dir.getFileHandle(file)); return true; }
    catch { return false; }
  }
}

// Talks to bridge/heapviz-bridge.py — same interface over HTTP for browsers
// without the File System Access API.
class BridgeBackend {
  constructor(base, token, name) {
    this.base = base.replace(/\/+$/, '');
    this.token = token;
    this.name = name;
    this.kind = 'bridge';
  }
  _url(ep, path) {
    const u = new URL(`${this.base}/api/${ep}`);
    if (path !== undefined) u.searchParams.set('path', path);
    u.searchParams.set('token', this.token);
    return u;
  }
  async _fetch(ep, path, opts) {
    const r = await fetch(this._url(ep, path), opts);
    if (!r.ok) throw new Error(`bridge: ${r.status} ${await r.text().catch(() => '')}`);
    return r;
  }
  async list(path = '') { return (await this._fetch('list', path)).json(); }
  async readFile(path) { return (await this._fetch('file', path)).arrayBuffer(); }
  async readText(path) { return (await this._fetch('file', path)).text(); }
  async writeText(path, text) { await this._fetch('file', path, { method: 'PUT', body: text }); }
  async writeFile(path, buf) { await this._fetch('file', path, { method: 'PUT', body: buf }); }
  async exists(path) {
    try { await this._fetch('stat', path); return true; } catch { return false; }
  }
}

// ---------------------------------------------------------------------------
// recent projects (IndexedDB: directory handles aren't serializable to
// localStorage; bridge entries ride along in the same store)
// ---------------------------------------------------------------------------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('heapviz', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('projects', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAll() {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction('projects').objectStore('projects').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function idbPut(rec) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(rec);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function idbDel(key) {
  const db = await idb();
  return new Promise((resolve) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').delete(key);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

function rememberProject() {
  const b = P.backend;
  if (!b) return;
  const rec = b.kind === 'dir'
    ? { key: `dir:${b.name}`, kind: 'dir', name: b.name, handle: b.handle, used: Date.now() }
    : { key: `bridge:${b.base}`, kind: 'bridge', name: b.name, base: b.base, token: b.token, used: Date.now() };
  idbPut(rec);
}

// ---------------------------------------------------------------------------
// manifest (project.json) — explicit, hand-editable; generated by a scan on
// first open of a directory that has none
// ---------------------------------------------------------------------------

const TRACE_RE = /\.(heapl|jsonl)$/i;

async function scanForRuns(backend) {
  const runs = [];
  const top = await backend.list('');
  for (const e of top.filter((x) => !x.dir && TRACE_RE.test(x.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    runs.push({ name: e.name.replace(TRACE_RE, ''), files: [e.name] });
  }
  for (const d of top.filter((x) => x.dir).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const inner = (await backend.list(d.name))
        .filter((x) => !x.dir && TRACE_RE.test(x.name))
        .map((x) => `${d.name}/${x.name}`)
        .sort();
      if (inner.length) runs.push({ name: d.name, files: inner });
    } catch { /* unreadable subdir: skip */ }
  }
  return runs;
}

async function loadManifest(backend) {
  try {
    const m = JSON.parse(await backend.readText('project.json'));
    if (m && m.heapVisualizerProject === 1 && Array.isArray(m.runs)) return m;
  } catch { /* absent or invalid: generate below */ }
  const runs = await scanForRuns(backend);
  const m = { heapVisualizerProject: 1, name: backend.name, runs };
  try {
    await backend.writeText('project.json', JSON.stringify(m, null, 2));
  } catch (e) {
    H.status(`could not write project.json: ${e.message}`);
  }
  return m;
}

function heapaPath(run) {
  return run.heapa || `${run.name.replace(/[^\w.-]+/g, '_')}.heapa`;
}

// ---------------------------------------------------------------------------
// opening projects & runs
// ---------------------------------------------------------------------------

async function openBackend(backend) {
  P.backend = backend;
  P.run = null;
  P.manifest = await loadManifest(backend);
  rememberProject();
  renderLanding();
  showLanding(true);
}

export async function openProjectDir() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await openBackend(new DirBackend(handle));
  } catch (e) {
    if (e.name !== 'AbortError') H.status(`open project failed: ${e.message}`);
  }
}

async function connectBridge(urlStr) {
  try {
    const u = new URL(urlStr.includes('://') ? urlStr : `http://${urlStr}`);
    const token = u.searchParams.get('token') || '';
    const base = `${u.protocol}//${u.host}`;
    const r = await fetch(`${base}/api/info?token=${encodeURIComponent(token)}`);
    if (!r.ok) throw new Error(`${r.status}`);
    const info = await r.json();
    await openBackend(new BridgeBackend(base, token, info.name || u.host));
  } catch (e) {
    H.status(`bridge connect failed: ${e.message} — is heapviz-bridge running?`);
  }
}

async function reopenRecent(rec) {
  try {
    if (rec.kind === 'dir') {
      const perm = await rec.handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { H.status('permission denied'); return; }
      await openBackend(new DirBackend(rec.handle));
    } else {
      await connectBridge(`${rec.base}/?token=${encodeURIComponent(rec.token)}`);
    }
  } catch (e) {
    H.status(`could not reopen project: ${e.message}`);
  }
}

export async function openRun(run) {
  if (!P.backend) return;
  P.run = run;
  P.pendingMarks = null;
  P.lastSaved = '';
  H.status(`loading run ${run.name}…`);
  try {
    const buffers = [];
    for (const f of run.files) buffers.push(await P.backend.readFile(f));
    // pick up the paired .heapa before the trace load completes
    try {
      P.pendingMarks = JSON.parse(await P.backend.readText(heapaPath(run)));
    } catch { P.pendingMarks = null; /* first open: none yet */ }
    showLanding(false);
    H.loadBuffers(buffers, `${P.backend.name}:${run.name}`);
  } catch (e) {
    P.run = null;
    H.status(`run load failed: ${e.message}`);
  }
}

// called by main.js from onLoaded() when a project run produced the trace
export function afterTraceLoaded() {
  if (P.pendingMarks) {
    H.applyMarks(P.pendingMarks);
    P.lastSaved = JSON.stringify(P.pendingMarks);
    P.pendingMarks = null;
  }
}

// ---------------------------------------------------------------------------
// .heapa auto-persist — called from main.js's autosave timer; writes only
// when the analysis actually changed
// ---------------------------------------------------------------------------

let saving = false;

export async function autosave() {
  if (!isRunOpen() || saving) return;
  saving = true;
  try {
    const marks = await H.buildMarks();
    const json = JSON.stringify(marks);
    if (json !== P.lastSaved) {
      await P.backend.writeText(heapaPath(P.run), json);
      P.lastSaved = json;
    }
  } catch (e) {
    H.status(`analysis autosave failed: ${e.message}`);
  } finally {
    saving = false;
  }
}

// ---------------------------------------------------------------------------
// quick-look (ephemeral) mode & save-as-project
// ---------------------------------------------------------------------------

export function noteQuickLook(source) {
  // dropping a file leaves any open project run (but not the project)
  P.run = null;
  P.quickLook = source;
  updateToolbar();
}

export async function saveAsProject() {
  if (!window.showDirectoryPicker) {
    H.status('this browser has no directory access — run the bridge (bridge/heapviz-bridge.py) and connect to it instead');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const backend = new DirBackend(handle);
    // copy the trace in, so the project directory is self-contained
    const files = [];
    if (P.quickLook?.files) {
      for (const f of P.quickLook.files) {
        await backend.writeFile(f.name, await f.arrayBuffer());
        files.push(f.name);
      }
    } else if (P.quickLook?.url) {
      const name = P.quickLook.url.split('/').pop();
      const resp = await fetch(P.quickLook.url, { cache: 'no-cache' });
      await backend.writeFile(name, await resp.arrayBuffer());
      files.push(name);
    }
    if (!files.length) { H.status('nothing to save — reload the trace first'); return; }
    const runName = files[0].replace(TRACE_RE, '');
    const run = { name: runName, files };
    const manifest = { heapVisualizerProject: 1, name: backend.name, runs: [run] };
    await backend.writeText('project.json', JSON.stringify(manifest, null, 2));
    P.backend = backend;
    P.manifest = manifest;
    P.run = run;
    P.lastSaved = '';
    rememberProject();
    await autosave();
    updateToolbar();
    H.status(`saved as project “${backend.name}” — analysis now auto-saves there`);
  } catch (e) {
    if (e.name !== 'AbortError') H.status(`save as project failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// landing screen
// ---------------------------------------------------------------------------

export function showLanding(on) {
  $('landing').hidden = !on;
  if (on) renderLanding();
  updateToolbar();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function renderLanding() {
  // runs of the open project
  const runsBox = $('lp-runs');
  const runsTitle = $('lp-runs-title');
  if (P.backend && P.manifest) {
    runsTitle.hidden = false;
    runsTitle.textContent = `runs in ${P.manifest.name || P.backend.name}`;
    runsBox.innerHTML = P.manifest.runs.length
      ? P.manifest.runs.map((r, i) => `
        <div class="lp-row" data-run="${i}">
          <span class="lp-name">${esc(r.name)}</span>
          <span class="lp-sub">${r.files.length} file${r.files.length === 1 ? '' : 's'}</span>
        </div>`).join('')
      : '<div class="lp-empty">no .heapl files found — drop traces into the folder and reopen</div>';
    runsBox.querySelectorAll('[data-run]').forEach((row) => {
      row.onclick = () => openRun(P.manifest.runs[+row.dataset.run]);
    });
  } else {
    runsTitle.hidden = true;
    runsBox.innerHTML = '';
  }

  // recent projects
  const recent = (await idbAll()).sort((a, b) => b.used - a.used).slice(0, 8);
  $('lp-recent').innerHTML = recent.length
    ? recent.map((r, i) => `
      <div class="lp-row" data-recent="${i}">
        <span class="lp-name">${r.kind === 'bridge' ? '⇄ ' : '▸ '}${esc(r.name)}</span>
        <span class="lp-sub">${r.kind === 'bridge' ? esc(r.base) : 'folder'}</span>
        <button class="x" data-forget="${esc(r.key)}" title="forget">×</button>
      </div>`).join('')
    : '<div class="lp-empty">none yet</div>';
  $('lp-recent').querySelectorAll('[data-recent]').forEach((row) => {
    row.onclick = (e) => {
      if (e.target.dataset.forget) return;
      reopenRecent(recent[+row.dataset.recent]);
    };
  });
  $('lp-recent').querySelectorAll('[data-forget]').forEach((btn) => {
    btn.onclick = async () => { await idbDel(btn.dataset.forget); renderLanding(); };
  });
}

function updateToolbar() {
  const projBtn = $('btn-project');
  projBtn.textContent = P.backend ? `⌂ ${P.backend.name}` : '⌂ Project';
  const save = $('btn-saveproj');
  // offer save-as-project only in ephemeral mode with something loaded
  save.hidden = !(H && H.isLoaded() && !isRunOpen() && P.quickLook);
  buildProjectPanel();
}

// the in-workspace Project window: current project, its runs (click to
// open), the active run's files — the landing overlay is only for
// opening/switching projects
function buildProjectPanel() {
  const body = $('project-body');
  if (!body) return;
  let html = '';
  if (P.backend && P.manifest) {
    html += `<div class="group-title">project · ${esc(P.manifest.name || P.backend.name)}
      ${P.backend.kind === 'bridge' ? '<span class="dim">(bridge)</span>' : ''}</div>`;
    html += P.manifest.runs.map((r, i) => {
      const active = P.run && r.name === P.run.name;
      return `<div class="lp-row${active ? ' active' : ''}" data-prun="${i}"
        title="${active ? 'this run is open' : 'open this run'}">
        <span class="lp-name">${active ? '▶ ' : ''}${esc(r.name)}</span>
        <span class="lp-sub">${r.files.length} file${r.files.length === 1 ? '' : 's'}</span>
      </div>`;
    }).join('') || '<div class="lp-empty">no runs — drop .heapl files into the folder and rescan</div>';
    if (P.run) {
      html += `<div class="group-title">files in ${esc(P.run.name)}</div>`;
      html += P.run.files.map((f) => `<div class="pp-file">${esc(f)}</div>`).join('');
      html += `<div class="pp-file dim">${esc(heapaPath(P.run))} · analysis (auto-saved)</div>`;
    }
  } else {
    html += '<div class="lp-empty">no project open — analysis stays in this browser only</div>';
  }
  html += `<div class="actions" style="margin-top:8px">
    <button id="pp-projects">Projects…</button>
    ${P.backend ? '<button id="pp-rescan" title="Re-scan the folder and regenerate project.json">rescan</button>' : ''}
  </div>`;
  body.innerHTML = html;
  body.querySelectorAll('[data-prun]').forEach((row) => {
    row.onclick = () => openRun(P.manifest.runs[+row.dataset.prun]);
  });
  body.querySelector('#pp-projects').onclick = () => showLanding(true);
  const rescan = body.querySelector('#pp-rescan');
  if (rescan) {
    rescan.onclick = async () => {
      const runs = await scanForRuns(P.backend);
      P.manifest.runs = runs;
      try { await P.backend.writeText('project.json', JSON.stringify(P.manifest, null, 2)); } catch { /* read-only: view still updates */ }
      buildProjectPanel();
      renderLanding();
    };
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function init(hooks) {
  H = hooks;
  const hasFsa = !!window.showDirectoryPicker;
  $('lp-open-dir').hidden = !hasFsa;
  if (!hasFsa) $('lp-no-fsa').hidden = false;
  $('lp-open-dir').onclick = openProjectDir;
  $('lp-open-file').onclick = () => $('file-input').click();
  $('lp-demo').onclick = () => { showLanding(false); hooks.loadDemo(); };
  $('lp-bridge').onclick = () => {
    const box = $('lp-bridge-row');
    box.hidden = !box.hidden;
    if (!box.hidden) $('lp-bridge-url').focus();
  };
  const connect = () => {
    const v = $('lp-bridge-url').value.trim();
    if (v) connectBridge(v);
  };
  $('lp-bridge-go').onclick = connect;
  $('lp-bridge-url').onkeydown = (e) => { if (e.key === 'Enter') connect(); };
  // the toolbar button opens the dockable Project window; the landing
  // overlay (project switcher) opens from there or when nothing is loaded
  $('btn-project').onclick = () => {
    const p = $('project-panel');
    if (p.hidden) {
      buildProjectPanel();
      H.showPanel('project-panel'); // docks left by default, like the rest
    } else {
      p.hidden = true;
      H.panelClosed(p);
    }
  };
  $('btn-saveproj').onclick = saveAsProject;
  $('landing').addEventListener('click', (e) => {
    // click outside the box closes the landing overlay (if a trace is open)
    if (e.target === $('landing') && H.isLoaded()) showLanding(false);
  });
  showLanding(true);
  updateToolbar();
}

export function onTraceLoaded() {
  updateToolbar();
}
