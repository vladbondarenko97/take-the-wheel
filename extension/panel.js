const RUNNER = 'http://127.0.0.1:19826';
const $ = id => document.getElementById(id);
const auth = () => ({ authorization: `Bearer ${$('token').value.trim()}` });
let running = false;

// Conversations: each keeps its claude session id, so follow-ups resume with full memory instead of re-exploring.
let convos = {}, current = null;
const save = () => chrome.storage.local.set({ convos, current });
const cur = () => convos[current];

// Model / effort / search / budget are saved per conversation; a new one starts with the current values.
const readSettings = () => ({ model: $('model').value, effort: $('effort').value, search: $('search').checked, budget: $('budget').value });
function applySettings(st) {
  if (!st) return;
  $('model').value = st.model; $('effort').value = st.effort; $('search').checked = !!st.search; $('budget').value = st.budget;
}
function saveSettings() {
  if (!cur()) return;
  cur().settings = readSettings();
  chrome.storage.local.set({ model: $('model').value, budget: $('budget').value, search: $('search').checked }); // defaults for new conversations
  save();
}

function newConvo() {
  const id = crypto.randomUUID();
  convos[id] = { id, title: 'New conversation', sessionId: null, log: [], updated: Date.now(), settings: readSettings() };
  current = id;
  const ids = Object.keys(convos).sort((a, b) => convos[b].updated - convos[a].updated);
  for (const old of ids.slice(30)) delete convos[old];
  save(); render();
}

function render(keepScroll = false) {
  const stay = keepScroll && !atBottom(), top = $('log').scrollTop;
  applySettings(cur().settings);
  $('convo').replaceChildren(...Object.values(convos).sort((a, b) => b.updated - a.updated).map(c =>
    Object.assign(document.createElement('option'), { value: c.id, textContent: c.title, selected: c.id === current })));
  $('log').replaceChildren();
  for (const [text, cls] of cur().log) addLine(text, cls);
  if (!cur().log.length) addLine('Type a task below. Follow-ups in this conversation keep its memory.', 'empty');
  if (stay) { $('log').scrollTop = top; $('jump').hidden = false; } else toBottom();
  $('go').textContent = cur().sessionId ? 'Continue' : 'Go';
  for (const id of ['convo', 'new', 'del']) $(id).disabled = running;
}

// Follow new lines only while the user is at the bottom; otherwise offer a "↓ Latest" button.
const atBottom = () => { const l = $('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; };
const toBottom = () => { $('log').scrollTop = $('log').scrollHeight; $('jump').hidden = true; };
function addLine(text, cls = '') {
  const follow = atBottom();
  const d = document.createElement('div');
  d.className = cls; d.textContent = text;
  $('log').append(d);
  if (follow) toBottom(); else $('jump').hidden = false;
  return d;
}

function log(convo, text, cls = '') {
  convo.log.push([text, cls]);
  if (convo.log.length > 400) convo.log.splice(0, convo.log.length - 400);
  if (convo.id === current) addLine(text, cls);
}

async function health() {
  try {
    const r = await fetch(`${RUNNER}/health`, { headers: auth() });
    const h = await r.json();
    $('dot').className = r.ok && h.ok ? 'ok' : 'bad';
    $('dot').title = r.ok ? `${h.claude}\n${h.opencli}` : h.error;
  } catch { $('dot').className = 'bad'; $('dot').title = 'runner not reachable: run `node runner/runner.mjs`'; }
}

const show = {
  session: (e, c) => { c.sessionId = e.id; },
  start: (e, c) => log(c, `● ${e.text}`, 'step'),
  text: (e, c) => log(c, e.text, 'say'),
  q: (e, c) => log(c, e.text, 'q'),
  step: (e, c) => log(c, e.text, 'step'),
  think: (e, c) => log(c, '💭 ' + e.text, 'think'),
  tool: (e, c) => log(c, '▶ ' + e.text.replaceAll('opencli browser task ', ''), 'tool'),
  out: (e, c) => log(c, '  ↳ ' + e.text, e.error ? 'err' : 'out'),
  error: (e, c) => log(c, '✗ ' + e.text, 'err'),
  done: (e, c) => {
    // The final assistant message becomes the result card (it already arrived as a text line).
    const cls = /Waiting for you:/i.test(e.text ?? '') ? 'result wait' : 'result';
    const last = c.log.findLastIndex(([t, k]) => k === 'say' && t === e.text);
    if (last >= 0) c.log.splice(last, 1);
    if (e.text) log(c, e.text, cls);
    // claude reports cost cumulatively over a resumed session; show this run's share and the conversation total.
    const total = e.cost ?? 0, prev = c.cost ?? 0, run = total >= prev ? total - prev : total;
    c.cost = total;
    log(c, `${e.error ? '✗' : '✓'} ${e.subtype === 'success' ? 'done' : e.subtype} — $${run.toFixed(3)} est., ${e.turns} turns` + (prev ? ` (conversation $${total.toFixed(3)})` : ''), e.error ? 'err' : 'done');
    if (c.id === current) render(true);
  },
  end: () => {},
};

async function go() {
  const task = $('task').value.trim();
  if (!task || running) return;
  const c = cur();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await chrome.tabs.update(tab.id, { active: true }); // opencli binds the active tab
  running = true; $('go').disabled = true; render();
  if (!c.sessionId) c.title = task.slice(0, 60);
  c.updated = Date.now();
  log(c, task, 'task');
  $('task').value = '';
  if (tab) await fx(tab.id, true);
  try {
    const r = await fetch(`${RUNNER}/task`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ task, tabUrl: tab?.url, model: $('model').value, maxBudgetUsd: Number($('budget').value), sessionId: c.sessionId, effort: $('effort').value, search: $('search').checked }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parts = (buf += value).split('\n\n'); buf = parts.pop();
      for (const p of parts) if (p.startsWith('data: ')) { const e = JSON.parse(p.slice(6)); show[e.kind]?.(e, c); }
      save();
    }
  } catch (err) { log(c, '✗ ' + err.message, 'err'); }
  if (tab) await fx(tab.id, false);
  running = false; $('go').disabled = false;
  save(); render();
}

// Aura + click cards in the driven tab (extension/fx.js). Injected here too for tabs opened before the extension loaded.
async function fx(tabId, on) {
  if (on) await chrome.storage.local.set({ drivingTab: tabId });
  else await chrome.storage.local.remove('drivingTab');
  if (on) await chrome.scripting.executeScript({ target: { tabId }, files: ['fx.js'] }).catch(() => {});
  await chrome.tabs.sendMessage(tabId, { ttw: on ? 'on' : 'off' }).catch(() => {});
}

async function stop() {
  try { await fetch(`${RUNNER}/stop`, { method: 'POST', headers: auth() }); log(cur(), '■ stop sent', 'err'); }
  catch (err) { log(cur(), '✗ ' + err.message, 'err'); }
}

let effortByModel = {};
const showEffort = () => { $('effort').value = effortByModel[$('model').value] || 'low'; };
chrome.storage.local.get(['token', 'model', 'budget', 'convos', 'current', 'search', 'effortByModel'], s => {
  if (s.token) $('token').value = s.token;
  if (s.model) $('model').value = s.model;
  if (s.budget) $('budget').value = s.budget;
  $('search').checked = !!s.search;
  effortByModel = s.effortByModel || {};
  showEffort();
  convos = s.convos ?? {};
  current = convos[s.current] ? s.current : null;
  if (!current) newConvo(); else render();
  health();
});
$('token').addEventListener('change', () => { chrome.storage.local.set({ token: $('token').value }); health(); });
$('convo').onchange = () => { current = $('convo').value; save(); render(); };
$('new').onclick = newConvo;
$('del').onclick = () => {
  if (!confirm(`Delete "${cur().title}"?`)) return;
  delete convos[current];
  current = Object.values(convos).sort((a, b) => b.updated - a.updated)[0]?.id;
  if (!current) newConvo(); else { save(); render(); }
};
chrome.runtime.connect({ name: 'panel' }); // background turns effects off if the panel closes mid-run
chrome.runtime.onMessage.addListener(m => { if (m === 'ttw:stop' && running) stop(); }); // × on the page's driving pill
$('gear').onclick = () => { $('settings').hidden = !$('settings').hidden; };
chrome.storage.local.get(['fxCorner', 'details'], s => {
  $('fxCorner').value = s.fxCorner || 'tr';
  $('details').checked = !!s.details; document.body.classList.toggle('details', !!s.details);
});
// Switching model within a conversation picks that model's last effort.
$('model').onchange = () => { showEffort(); saveSettings(); };
$('effort').onchange = () => { effortByModel[$('model').value] = $('effort').value; chrome.storage.local.set({ effortByModel }); saveSettings(); };
$('search').onchange = saveSettings;
$('budget').onchange = saveSettings;
$('details').onchange = () => { chrome.storage.local.set({ details: $('details').checked }); document.body.classList.toggle('details', $('details').checked); };
$('fxCorner').onchange = () => chrome.storage.local.set({ fxCorner: $('fxCorner').value });
$('jump').onclick = toBottom;
$('log').addEventListener('scroll', () => { if (atBottom()) $('jump').hidden = true; });
$('go').onclick = go;
$('stop').onclick = stop;
$('task').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); });
setInterval(() => running || health(), 30000);

// Dev auto-reload: panel-only edits reload just this panel; anything else reloads the whole extension.
setInterval(async () => {
  const { devSnapshot: snap } = await chrome.storage.local.get('devSnapshot');
  if (running || !snap) return;
  const now = {};
  for (const f in snap) now[f] = await (await fetch(f, { cache: 'no-store' })).text();
  const changed = Object.keys(snap).filter(f => now[f] !== snap[f]);
  if (!changed.length) return;
  if (changed.every(f => f.startsWith('panel.'))) {
    await chrome.storage.local.set({ devSnapshot: { ...snap, ...now } });
    location.reload();
  } else chrome.runtime.reload();
}, 2000);
