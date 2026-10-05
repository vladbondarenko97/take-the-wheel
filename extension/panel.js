const RUNNER = 'http://127.0.0.1:19826';
const $ = id => document.getElementById(id);
const auth = () => ({ authorization: `Bearer ${$('token').value.trim()}` });
let running = false;

// Conversations: each keeps its claude session id, so follow-ups resume with full memory instead of re-exploring.
let convos = {}, current = null;
const save = () => chrome.storage.local.set({ convos, current });
const cur = () => convos[current];

// Model / effort / search / budget are saved per conversation; a new one starts with the current values.
const readSettings = () => ({ model: $('model').value, effort: $('effort').value, search: $('search').checked, lab: $('lab').checked, localVision: $('localVision').checked, planMode: $('planMode').checked, useVision: $('useVision').checked, budget: $('budget').value });
function applySettings(st) {
  if (!st) return;
  $('model').value = st.model; $('effort').value = st.effort; $('search').checked = !!st.search; $('lab').checked = !!st.lab; $('localVision').checked = !!st.localVision; $('planMode').checked = !!st.planMode;
  $('useVision').checked = st.useVision !== false; // defaults ON, unlike the others -- undefined (older saved settings) must stay ON, not OFF
  $('budget').value = st.budget;
}
function saveSettings() {
  if (!cur()) return;
  cur().settings = readSettings();
  chrome.storage.local.set({ model: $('model').value, budget: $('budget').value, search: $('search').checked, lab: $('lab').checked, localVision: $('localVision').checked, planMode: $('planMode').checked, useVision: $('useVision').checked }); // defaults for new conversations
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

// Minimal, safe markdown -> HTML for the message-like log lines (Claude's own answers, not
// raw command output). Escapes first so nothing in the source text -- including a URL a web
// search quoted verbatim -- can break out of a tag or attribute; the only real `<`/`>`/`"`
// in the result come from the fixed replacement strings below, never from the input.
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function mdInline(s) {
  s = escapeHtml(s);
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'); // [text](http…) only -- javascript: etc. never matches, stays literal text
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  return s;
}
const mdToHtml = text => text.split('\n').map(line => {
  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  return bullet ? `${bullet[1]}• ${mdInline(bullet[2])}` : mdInline(line);
}).join('\n');
const MD_CLASSES = new Set(['say', 'result', 'result wait', 'vision', 'q']);

// Follow new lines only while the user is at the bottom; otherwise offer a "↓ Latest" button.
const atBottom = () => { const l = $('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 40; };
const toBottom = () => { $('log').scrollTop = $('log').scrollHeight; $('jump').hidden = true; };
function addLine(text, cls = '') {
  const follow = atBottom();
  const d = document.createElement('div');
  d.className = cls;
  if (MD_CLASSES.has(cls)) d.innerHTML = mdToHtml(text); else d.textContent = text;
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
    if (h.vision) { $('ollamaUrl').placeholder = h.vision.url + ' (default)'; $('visionModel').placeholder = h.vision.model + ' (default)'; }
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
  vision: (e, c) => log(c, '👁 ' + e.text, 'vision'),
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Lab mode drives two tabs at once: the lab platform's own tab (Instructions/Resources —
// real readable DOM) and the VM console's "Open in New Window" popout (a canvas with no DOM,
// driven by labctl). opencli's `bind` always attaches to "whatever tab is currently active",
// and only the extension can change OS-level tab/window focus -- so this focuses each tab in
// turn and binds it to its session name right then, before the agent ever starts.
async function prepareLab() {
  const tabs = await chrome.tabs.query({});
  const instructions = tabs.find(t => t.url?.includes('/LabClient/'));
  const vm = tabs.find(t => t.url?.includes('/VirtualizationClient/') && t.url.includes('vmOnly=1'));
  if (!instructions || !vm) {
    const missing = [!instructions && 'the lab tab', !vm && "the VM's \"Open in New Window\" popout"].filter(Boolean).join(' and ');
    throw new Error(`Lab mode: couldn't find ${missing}. Open the lab, then its Resources tab -> Open in New Window, then try again.`);
  }
  // Small window: the console typically renegotiates the guest's own display resolution to
  // fit it ("Fit Machine to Window"), so this also shrinks every screenshot the vision model
  // has to process -- faster and cheaper per look/locate call, not just tidier on screen.
  await chrome.windows.update(vm.windowId, { width: 800, height: 600 });
  for (const [session, tab] of [['instructions', instructions], ['vm', vm]]) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(250); // let Chrome actually finish switching before opencli binds "the active tab"
    const r = await fetch(`${RUNNER}/lab/bind`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ session }) });
    if (!r.ok) throw new Error(`Lab mode: failed to bind ${session}: ${(await r.json()).error ?? r.status}`);
  }
  return { instructionsUrl: instructions.url, vmTabId: vm.id };
}

async function go() {
  const task = $('task').value.trim();
  if (!task || running) return;
  const c = cur();
  const lab = $('lab').checked;
  let tab, labInfo;
  if (lab) {
    try { labInfo = await prepareLab(); }
    catch (err) { log(c, '✗ ' + err.message, 'err'); return; }
    tab = { id: labInfo.vmTabId, url: labInfo.instructionsUrl };
  } else {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.update(tab.id, { active: true }); // opencli binds the active tab
  }
  running = true; $('go').disabled = true; render();
  if (!c.sessionId) c.title = task.slice(0, 60);
  c.updated = Date.now();
  log(c, task, 'task');
  $('task').value = '';
  if (tab) await fx(tab.id, true);
  const planMode = lab && $('planMode').checked;
  try {
    const r = await fetch(`${RUNNER}${planMode ? '/lab/plan' : '/task'}`, {
      method: 'POST', headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ task, tabUrl: tab?.url, model: $('model').value, maxBudgetUsd: Number($('budget').value), sessionId: c.sessionId, effort: $('effort').value, search: $('search').checked, lab, localVision: $('localVision').checked, useVision: $('useVision').checked, ...visionBody() }),
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
chrome.storage.local.get(['token', 'model', 'budget', 'convos', 'current', 'search', 'lab', 'localVision', 'planMode', 'useVision', 'effortByModel'], s => {
  if (s.token) $('token').value = s.token;
  if (s.model) $('model').value = s.model;
  if (s.budget) $('budget').value = s.budget;
  $('search').checked = !!s.search;
  $('lab').checked = !!s.lab;
  $('localVision').checked = !!s.localVision;
  $('planMode').checked = !!s.planMode;
  $('useVision').checked = s.useVision !== false; // defaults ON (see applySettings)
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
$('gear').onclick = () => { $('settings').hidden = $('visionSettings').hidden = !$('settings').hidden; };
// Local vision server/model: global settings (not per conversation); empty = the runner's defaults.
const visionBody = () => ({ ollamaUrl: $('ollamaUrl').value.trim(), visionModel: $('visionModel').value.trim() });
chrome.storage.local.get(['ollamaUrl', 'visionModel'], s => { $('ollamaUrl').value = s.ollamaUrl || ''; $('visionModel').value = s.visionModel || ''; });
for (const id of ['ollamaUrl', 'visionModel']) $(id).onchange = () => chrome.storage.local.set({ [id]: $(id).value.trim() });
$('visionTest').onclick = async () => {
  $('visionResult').textContent = '…';
  try {
    const r = await (await fetch(`${RUNNER}/lab/vision/test`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(visionBody()) })).json();
    $('visionResult').textContent = !r.reachable ? `✗ can't reach ${r.base}` : r.hasModel ? `✓ ${r.model} ready` : `⚠ reachable, but no ${r.model} (${r.models} models)`;
    $('visionResult').title = r.error || r.base;
  } catch (err) { $('visionResult').textContent = '✗ runner not reachable'; }
};
chrome.storage.local.get(['fxCorner', 'details'], s => {
  $('fxCorner').value = s.fxCorner || 'tr';
  $('details').checked = !!s.details; document.body.classList.toggle('details', !!s.details);
});
// Switching model within a conversation picks that model's last effort.
$('model').onchange = () => { showEffort(); saveSettings(); };
$('effort').onchange = () => { effortByModel[$('model').value] = $('effort').value; chrome.storage.local.set({ effortByModel }); saveSettings(); };
$('useVision').onchange = saveSettings;
$('search').onchange = saveSettings;
$('lab').onchange = saveSettings;
$('planMode').onchange = saveSettings;
$('localVision').onchange = () => {
  saveSettings();
  // Unchecking means "I'm done with this for now" -- free the ~20GB right away. Reloading
  // later costs ~2s (measured), so there's no reason to keep it warm on the chance of reuse.
  if (!$('localVision').checked) fetch(`${RUNNER}/lab/vision/unload`, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(visionBody()) }).catch(() => {});
};
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
