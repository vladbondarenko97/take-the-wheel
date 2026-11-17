#!/usr/bin/env node
// PreToolUse hook: the hard boundary on what the agent may run. --allowedTools alone isn't one:
// Claude Code auto-approves read-only commands like `pwd`/`whoami` and reads inside cwd before it
// consults the allowlist, and a prefix rule like `Bash(opencli *)` also admits `opencli gh …`,
// `opencli plugin install …` and every other opencli subcommand. Hooks run first and a deny wins.
// Config comes from TTW_GUARD (see guardArgs); missing or bad config denies everything.
import { resolve, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const BLOCKED_SUBCOMMANDS = ['upload']; // attaches local files (say ~/.ssh keys) to a page
const RAW_ACTIONS = ['click', 'dblclick', 'check', 'uncheck', 'fill', 'type', 'select', 'keys', 'drag'];
const VALUE_FLAGS = ['--tab', '--width', '--height']; // screenshot flags that take a value, so it isn't mistaken for the path

export const deniedHost = (url, deny) => {
  try { const h = new URL(url).hostname; return deny.some(d => h === d || h.endsWith('.' + d)); } catch { return false; }
};

// Splits on && outside quotes. null = anything else bash would treat as code (; | & > < $ ` ( ) …
// outside quotes, `$(`/backticks inside double quotes, unbalanced quotes). Single quotes are literal.
export function segments(cmd) {
  const segs = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { cur += c; if (c === "'") q = null; continue; }
    if (c === '\\') { if (i + 1 >= cmd.length) return null; cur += c + cmd[++i]; continue; }
    if (q === '"') { if (c === '`' || (c === '$' && cmd[i + 1] === '(')) return null; if (c === '"') q = null; cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '&' && cmd[i + 1] === '&') { segs.push(cur.trim()); cur = ''; i++; continue; }
    if (/[;|&<>`$(){}\n\r]/.test(c)) return null;
    cur += c;
  }
  if (q) return null;
  segs.push(cur.trim());
  return segs;
}

// The argv bash would pass for one segment that segments() already accepted: quotes removed, escapes resolved.
export function words(seg) {
  const out = []; let cur = '', q = null, has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (c === '\\') { cur += seg[++i]; has = true; continue; }
    if (q === '"') { if (c === '"') q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

function checkSegment(w, cfg) {
  const prefix = cfg.bash.map(p => p.split(' ')).find(p => p.every((x, i) => w[i] === x));
  if (!prefix) return `not an allowed command: "${w.join(' ').slice(0, 80)}". Allowed: ${cfg.bash.join(', ')}`;
  if (w[0] !== 'opencli') return null; // ttw/labctl are our own scripts with fixed subcommands
  const [sub, ...rest] = w.slice(4); // opencli browser --session <session> <sub> …
  if (sub === 'ttw') return `ttw is its own command, not an opencli one: run \`ttw ${rest.join(' ')}\` directly`;
  if (BLOCKED_SUBCOMMANDS.includes(sub)) return `\`${sub}\` is blocked`;
  // ponytail: small local models skip ttw's submit refusal by clicking raw refs, so they only act through ttw; a site ttw can't read stalls instead
  if (cfg.ttwActs && RAW_ACTIONS.includes(sub)) return `\`${sub}\` is disabled for this model: act through \`ttw do <ids>\` / \`ttw fill <id> <text>\` (run \`ttw page\` for ids). If ttw can't see the control, stop and tell the user.`;
  // commander honours the last --session, so a second one would escape the run's session; --profile switches Chrome profile
  if (rest.some(a => /^--(session|profile)(=|$)/.test(a))) return '`--session`/`--profile` can only be set by the runner';
  if (sub === 'screenshot') return screenshotPath(rest, cfg.shots);
  const urls = sub === 'open' ? rest : sub === 'tab' && rest[0] === 'new' ? rest.slice(1) : [];
  for (const u of urls.filter(x => !x.startsWith('-') || x.includes(':'))) {
    if (!/^https?:\/\//i.test(u)) return `only http(s) URLs can be opened, got "${u.slice(0, 80)}"`;
    if (deniedHost(u, cfg.denySites)) return `denylisted site: ${new URL(u).hostname}`;
  }
  return null;
}

// `screenshot [path]` writes wherever it's told, so a path must land in the shots folder (the one the
// agent may Read). No path is fine: opencli returns base64 instead of writing a file.
function screenshotPath(args, shots) {
  const paths = args.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(args[i - 1]));
  for (const p of paths) {
    const abs = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p; // bash expands a leading ~/, so we do too
    if (!isAbsolute(abs) || !resolve(abs).startsWith(resolve(shots) + sep)) return `screenshots can only be saved under ${shots}/ (got "${p.slice(0, 80)}")`;
  }
  return null;
}

// Small models write `opencli browser --session task ttw do c1 a1`. That can only mean `ttw do c1 a1`, so the hook runs
// that instead of spending a whole (slow) turn on a refusal. The rewritten command still goes through check().
export const fixCommand = cmd => cmd.replace(/(^|&&\s*)opencli\s+browser\s+--session\s+\S+\s+(?=ttw\s)/g, '$1');

export function check(tool, input, cfg) {
  if (tool === 'Bash') {
    const segs = segments(String(input.command ?? ''));
    if (!segs) return 'only plain commands chained with && are allowed (no pipes, redirects, ;, $() or backticks)';
    for (const s of segs) { const why = checkSegment(words(s), cfg); if (why) return why; }
    return null;
  }
  if (tool === 'Read') {
    const f = resolve(String(input.file_path ?? ''));
    return cfg.read.some(d => f.startsWith(resolve(d) + sep)) ? null : 'Read is limited to screenshots from `ttw look`';
  }
  return null; // other tools are already limited by --tools
}

// What the runner adds to a `claude` spawn: the allowlist itself plus this hook enforcing the same rules.
export function guardArgs(allowedTools, { shots, denySites, ttwActs = false }) {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash|Read', hooks: [{ type: 'command', command: `"${process.execPath}" "${import.meta.filename}"` }] }] } };
  const cfg = {
    bash: allowedTools.filter(t => t.startsWith('Bash(')).map(t => t.slice(5, -1).replace(/ \*$/, '')),
    read: allowedTools.some(t => t.startsWith('Read(')) ? [shots] : [],
    shots,
    denySites,
    ttwActs,
  };
  // No allowlist (writing mode: no tools at all) -> no --allowedTools flag; the hook still denies everything.
  return { args: [...(allowedTools.length ? ['--allowedTools', ...allowedTools] : []), '--settings', JSON.stringify(settings)], env: { TTW_GUARD: JSON.stringify(cfg) } };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  let raw = '';
  for await (const d of process.stdin) raw += d;
  let reason;
  try {
    const cfg = JSON.parse(process.env.TTW_GUARD);
    const { tool_name, tool_input = {} } = JSON.parse(raw);
    const fixed = tool_name === 'Bash' && fixCommand(String(tool_input.command ?? ''));
    if (fixed && fixed !== tool_input.command && !check(tool_name, { ...tool_input, command: fixed }, cfg)) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...tool_input, command: fixed } } }));
      process.exit(0);
    }
    reason = check(tool_name, tool_input, cfg);
  } catch (e) { reason = `guard misconfigured: ${e.message}`; }
  if (reason) { process.stderr.write(`Blocked by Take the Wheel: ${reason}`); process.exit(2); }
}
