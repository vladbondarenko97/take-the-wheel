// Take the Wheel runner: side panel -> claude -p -> opencli. Node >= 20, no deps.
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const HERE = import.meta.dirname, PORT = 19826, SESSION = 'task';
const TOKEN_FILE = join(HERE, '.token');
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(16).toString('hex'), { mode: 0o600 });
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const PROMPT = readFileSync(join(HERE, 'agent-prompt.md'), 'utf8');
const PROMPT_LAB = readFileSync(join(HERE, 'lab-agent-prompt.md'), 'utf8');
const LAB_SESSIONS = ['instructions', 'vm'];
const DENY = JSON.parse(readFileSync(join(HERE, 'denylist.json'), 'utf8'));
// Empty cwd: no stray CLAUDE.md / .mcp.json / hooks. Fixed path, because claude --resume looks sessions up by cwd.
const SANDBOX = join(homedir(), '.take-the-wheel', 'sandbox');
mkdirSync(SANDBOX, { recursive: true });
const SHOTS = join(homedir(), '.take-the-wheel', 'shots'); // the only folder the agent may Read (screenshots from `ttw look`)
mkdirSync(SHOTS, { recursive: true });
const ENV = { ...process.env, PATH: `${join(HERE, 'bin')}${delimiter}${process.env.PATH}` }; // puts `ttw` on the agent's PATH
delete ENV.CLAUDECODE; // allow starting the runner from inside a Claude Code shell
let child = null;

const WIN = process.platform === 'win32'; // npm global installs are .cmd shims on Windows; spawn/execFile need shell:true to resolve them
const run = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 20000, shell: WIN }, (e, out, err) => r(String(out || '') + String(err || ''))));
const unbind = () => run('opencli', ['browser', SESSION, 'unbind']);
const denied = url => { try { const h = new URL(url).hostname; return DENY.some(d => h === d || h.endsWith('.' + d)); } catch { return false; } };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const clip = (s, n = 300) => (s = String(s ?? '')).length > n ? s.slice(0, n) + '…' : s;
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

// Human-readable steps (Comet-style), derived from the agent's commands and ttw digests at no extra token cost.
const OC = { bind: 'Taking control of the tab', click: 'Clicking', dblclick: 'Clicking', check: 'Checking a box', uncheck: 'Unchecking a box',
  fill: 'Typing', type: 'Typing', select: 'Choosing an option', scroll: 'Scrolling', back: 'Going back', state: 'Reading the page',
  extract: 'Reading the page', find: 'Reading the page', get: 'Reading the page', eval: 'Reading the page', frames: 'Reading the page' };
function describe(cmd, st) {
  const steps = [];
  let advanced = false; // ttw refuses any further `ttw do` after an advance in the same command
  for (const part of cmd.split(/\s*(?:&&|;|\|\|)\s*/)) {
    let m;
    if (advanced && /^ttw do /.test(part)) { steps.push('⛔ Blocked: must read the next question first'); break; }
    if ((m = part.match(/^ttw do (.+)/))) {
      advanced = /\b(a\d+|next)\b/.test(m[1]);
      steps.push(m[1].split(/\s+/).filter(x => x !== '--finish').map(id =>
        /^c\d+$/.test(id) ? `☑ Selecting "${st.labels[id] ?? id}"` : /^(a\d+|next)$/.test(id) ? `Next →` : /^f\d+$/.test(id) ? `Submitting` : id).join(' · '));
    } else if ((m = part.match(/^ttw fill (\S+) (.+)/))) steps.push(`⌨ Typing ${m[2]} into "${st.labels[m[1]] ?? m[1]}"`);
    else if (/^ttw page/.test(part)) steps.push('Reading the page');
    else if (/^ttw note/.test(part)) steps.push('📝 Saving notes about this site');
    else if ((m = part.match(/^labctl \S+ type (.+)/))) steps.push(`⌨ Typing ${m[1]}`);
    else if ((m = part.match(/^labctl \S+ key (.+)/))) steps.push(`Pressing ${m[1]}`);
    else if ((m = part.match(/^labctl \S+ locate (.+)/))) steps.push(`👁 Finding (local vision): ${m[1]}`);
    else if ((m = part.match(/^labctl \S+ look (.+)/))) steps.push(`👁 Looking at the VM (local vision): ${m[1]}`);
    else if (/^labctl \S+ click/.test(part)) steps.push('Clicking the VM screen');
    else if (/^labctl \S+ username/.test(part)) steps.push('Typing the lab username');
    else if (/^labctl \S+ password/.test(part)) steps.push('Typing the lab password');
    else if (/^labctl \S+ shot/.test(part)) steps.push('Screenshotting the VM screen');
    else if ((m = part.match(/^opencli browser \S+ open\s+["']?([^"'\s]+)/))) { try { steps.push(`Opening ${new URL(m[1]).hostname}`); } catch { steps.push('Opening a page'); } }
    else if ((m = part.match(/^opencli browser \S+ keys\s+(\S+)/))) steps.push(`Pressing ${m[1]}`);
    else if ((m = part.match(/^opencli browser \S+ (\w+)/)) && OC[m[1]]) steps.push(OC[m[1]]);
  }
  return steps.filter((x, i) => x !== steps[i - 1]);
}
// Remember choice labels and the current question from each ttw digest.
function learn(out, st) {
  if (!/^(PROGRESS|CHOICES)/m.test(out)) return [];
  const labels = {};
  for (const m of out.matchAll(/^\s+(c\d+) [* ] (.+?)(?: \[(?:button|clickable)\])?(?: \[page marks: \w+\])?$/gm)) labels[m[1]] = m[2];
  for (const m of out.matchAll(/^(?:INPUT|ADVANCE|FINISH) ([iaf]\d+): "?(.+?)"?(?: =|$)/gm)) labels[m[1]] = m[2];
  st.labels = labels;
  const prog = out.match(/^PROGRESS: question (\d+)(?: of (\d+))?/m);
  const q = (out.match(/^QUESTION\/TEXT: (.*)$/m) || [])[1] || '';
  const many = (out.match(/^\s+Q \S+:/gm) || []).length;
  const asked0 = (out.match(/^ASKED: (.*)$/m) || [])[1];
  const key = many > 1 ? `many:${many}` : `${prog?.[1] ?? ''}|${asked0 ?? q}`; // not raw page text: it changes when an answer is selected
  if (!key || key === st.q) return [];
  st.q = key;
  if (many > 1) return [{ kind: 'q', text: `${many} questions on this page` }];
  const asked = (out.match(/^ASKED: (.*)$/m) || [])[1];
  const label = prog ? `Q${prog[1]}${prog[2] ? '/' + prog[2] : ''}` : 'Q';
  return asked || prog ? [{ kind: 'q', text: asked ? `${label} · ${asked}` : label }] : [];
}

// Reduce claude's stream-json to the events the panel shows.
function* events(msg, st) {
  if (msg.type === 'system' && msg.subtype === 'init') yield { kind: 'session', id: msg.session_id };
  if (msg.type === 'assistant') for (const c of msg.message?.content ?? []) {
    if (c.type === 'thinking' && c.thinking?.trim()) yield { kind: 'think', text: clip(c.thinking.trim(), 500) };
    if (c.type === 'text' && c.text.trim()) yield { kind: 'text', text: c.text };
    if (c.type === 'tool_use') {
      const cmd = c.input?.command ?? '';
      yield { kind: 'tool', text: c.name === 'WebSearch' ? `WebSearch ${c.input?.query}` : c.name === 'Read' ? 'Read screenshot' : cmd || JSON.stringify(c.input) };
      const steps = c.name === 'WebSearch' ? [`🔎 Searching: ${c.input?.query}`] : c.name === 'Read' ? ['👁 Looking at the page (frontier vision)'] : describe(cmd, st);
      for (const t of steps) yield { kind: 'step', text: t };
    }
  }
  if (msg.type === 'user') for (const c of msg.message?.content ?? []) if (c.type === 'tool_result') {
    const t = Array.isArray(c.content) ? c.content.map(x => x.text ?? '').join('') : String(c.content ?? '');
    yield* learn(t, st);
    // Errors are always visible in the panel, so send just the reason line, not a whole page digest.
    const lines = t.split('\n').map(l => l.trim()).filter(l => l && !/^Exit code \d+$/.test(l));
    const reason = lines.find(l => /^(refused|unknown id|WARNING|The browser stopped|no ADVANCE|usage:)|failed:/.test(l)) || lines[0];
    yield { kind: 'out', text: c.is_error ? clip(reason, 200) : clip(t), error: !!c.is_error };
  }
  if (msg.type === 'result') {
    const limit = /hit your .*limit/i.test(msg.result ?? ''); // plan usage limit comes back as a "successful" result
    yield { kind: 'done', text: msg.result, cost: msg.total_cost_usd, turns: msg.num_turns, error: msg.is_error || limit, subtype: limit ? 'usage limit' : msg.subtype };
  }
}

function startTask(res, { task, tabUrl = '', model = 'haiku', maxBudgetUsd = 0.5, sessionId, effort = 'low', search = false, lab = false, localVision = false }) {
  if (!['low', 'medium', 'high'].includes(effort)) effort = 'low';
  // Submitting is only unlocked by the user's own words.
  const allowFinish = /\b(submit|finish|turn (it )?in|hand (it )?in)\b/i.test(task) && !/\b(don'?t|do not|never|without|not)\b[^.]{0,25}\b(submit|finish)/i.test(task);
  if (search) task = `SEARCH MODE is on. ${task}`;
  // Lab mode: the panel already bound `instructions` and `vm` to their tabs (focus-switch +
  // bind has to happen from the extension, which is the only side with chrome.tabs/windows
  // access) before this request was sent, so the agent must not bind/unbind either itself.
  const tab = lab
    ? `Sessions "instructions" and "vm" are already bound to their tabs.`
    : `Current tab: ${tabUrl || 'unknown'}. First run: opencli browser ${SESSION} bind`;
  // Only meaningful in lab mode: without it, "Read is denied" would otherwise look like a bug
  // to the agent instead of the deliberate point of the checkbox.
  const visionNote = lab && localVision ? ' Local vision is ON: the Read tool is unavailable here, use `labctl vm look`/`locate` for everything visual.' : '';
  const wrapped = sessionId
    ? `Follow-up in the same conversation. ${lab ? tab : `${tab} again (the tab was released between messages)`} and re-read the page before acting.${visionNote} User: ${task}`
    : `${lab ? '' : `Session name: ${SESSION}. `}${tab}.${visionNote} Task: ${task}`;
  const grantRead = !(lab && localVision); // local vision mode: no Read tool at all, so the agent can't even attempt frontier-model vision
  const tools = ['Bash', ...(grantRead ? ['Read'] : []), ...(search ? ['WebSearch'] : [])].join(',');
  child = spawn('claude', ['-p', wrapped, ...(sessionId ? ['--resume', sessionId] : []),
    '--model', ['sonnet', 'opus'].includes(model) ? model : 'haiku', '--effort', effort,
    '--system-prompt', lab ? PROMPT_LAB : PROMPT, '--tools', tools,
    '--allowedTools', 'Bash(opencli *)', 'Bash(ttw *)', ...(lab ? ['Bash(labctl *)'] : []), ...(grantRead ? [`Read(/${SHOTS}/**)`] : []), ...(search ? ['WebSearch'] : []),
    '--disallowedTools', 'Bash(opencli browser task screenshot *)', // screenshots only via `ttw look`, into SHOTS (lab mode uses labctl's own screenshot path instead)
    '--permission-mode', 'dontAsk', '--max-turns', '60', '--max-budget-usd', String(Number(maxBudgetUsd) || 0.5),
    '--system-prompt-snapshot', 'off', // follow-ups use the current prompt, not the one recorded when the conversation began
    '--output-format', 'stream-json', '--verbose'],
    { cwd: SANDBOX, env: { ...ENV, TTW_RUN_ID: randomBytes(6).toString('hex'), TTW_ALLOW_FINISH: allowFinish ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'], shell: WIN });
  const me = child;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ kind: 'start', text: `${model} · ${effort} effort · search ${search ? 'on' : 'off'}${lab ? ' · lab mode' : ''}${lab && localVision ? ' · local vision' : ''} · $${maxBudgetUsd} cap` });
  let buf = '', errBuf = '';
  const st = { labels: {}, q: '' };
  me.stdout.on('data', d => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { try { for (const ev of events(JSON.parse(l), st)) send(ev); } catch {} }
  });
  me.stderr.on('data', d => errBuf += d);
  me.on('close', async code => {
    if (code && errBuf.trim()) send({ kind: 'error', text: clip(errBuf, 600) });
    await unbind(); send({ kind: 'end', code }); res.end();
    if (child === me) child = null;
  });
  res.on('close', () => { if (child === me) me.kill('SIGINT'); }); // panel closed -> stop driving
}

http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) return json(res, 403, { error: 'bad origin' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'bad token' });
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && path === '/health') {
    const [doc, ver] = await Promise.all([run('opencli', ['doctor']), run('claude', ['--version'])]);
    return json(res, 200, { ok: !/\[(MISSING|FAIL)\]/.test(doc) && /\d/.test(ver), opencli: doc.trim(), claude: ver.trim(), busy: !!child });
  }
  if (req.method === 'POST' && path === '/task') {
    const body = await readBody(req);
    if (!body.task?.trim()) return json(res, 400, { error: 'empty task' });
    if (body.sessionId && !/^[0-9a-f-]{36}$/.test(body.sessionId)) return json(res, 400, { error: 'bad sessionId' });
    if (denied(body.tabUrl)) return json(res, 403, { error: `denylisted site: ${new URL(body.tabUrl).hostname}` });
    if (child) return json(res, 409, { error: 'a task is already running' });
    return startTask(res, body);
  }
  if (req.method === 'POST' && path === '/lab/bind') {
    const body = await readBody(req);
    if (!LAB_SESSIONS.includes(body.session)) return json(res, 400, { error: `session must be one of: ${LAB_SESSIONS.join(', ')}` });
    // Binds whatever tab is currently active -- the panel must have focused the right
    // window/tab (chrome.windows.update + chrome.tabs.update) immediately before this call.
    const out = await run('opencli', ['browser', body.session, 'bind']);
    try { return json(res, 200, JSON.parse(out)); } catch { return json(res, 502, { error: out.trim() }); }
  }
  if (req.method === 'POST' && path === '/stop') {
    if (child) child.kill('SIGINT');
    await unbind();
    for (const s of LAB_SESSIONS) await run('opencli', ['browser', s, 'unbind']);
    return json(res, 200, { stopped: true });
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, '127.0.0.1', () => console.log(`Take the Wheel runner on http://127.0.0.1:${PORT}\nToken (paste into the side panel): ${TOKEN}`));
