// node --test test/   (no deps). Unit tests for runner/guard.mjs: what the agent may and may not run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, guardArgs, fixCommand } from '../runner/guard.mjs';

const DENY = ['chase.com', 'mail.google.com'];
// The same allowlists runner.mjs builds: normal task, lab task, lab plan step.
const cfgOf = allowed => JSON.parse(guardArgs(allowed, { shots: '/x/shots', denySites: DENY }).env.TTW_GUARD);
const TASK = cfgOf(['Bash(opencli browser --session task *)', 'Bash(ttw *)', 'Read(//x/shots/**)', 'WebSearch']);
const LAB = cfgOf(['Bash(opencli browser --session task *)', 'Bash(ttw *)', 'Bash(opencli browser --session instructions *)', 'Bash(opencli browser --session vm *)', 'Bash(labctl *)']);
const PLAN = cfgOf(['Bash(opencli browser --session instructions *)', 'Bash(labctl vm look *)']);
const bash = (cfg, command) => check('Bash', { command }, cfg);

test('authorized browser commands still run', () => {
  for (const c of [
    'opencli browser --session task bind && ttw page',
    'opencli browser --session task state',
    'opencli browser --session task check 7 && opencli browser --session task fill 21 "Ada" && opencli browser --session task click 42 && opencli browser --session task wait time 2',
    'opencli browser --session task open https://example.com/a?b=1',
    'opencli browser --session task tab new https://example.com',
    `opencli browser --session task eval "document.title"`,
    'ttw do c2 && ttw note "quiz uses radio buttons; | and ; are fine inside quotes"',
  ]) assert.equal(bash(TASK, c), null, c);
  assert.equal(bash(LAB, `labctl vm type "snort -V | grep x; echo $HOME" && labctl vm key "Enter key"`), null);
  assert.equal(bash(LAB, 'opencli browser --session instructions state'), null);
  assert.equal(bash(PLAN, 'labctl vm look "is a terminal open?"'), null);
});

test('commands outside the allowlist are denied, including the auto-approved read-only ones', () => {
  for (const c of ['pwd', 'whoami', 'ls', 'cat /etc/hosts', 'opencliX', 'FOO=1 opencli browser --session task state', 'ttwx', 'labctl vm look x'])
    assert.notEqual(bash(TASK, c), null, c);
  assert.notEqual(bash(PLAN, 'labctl vm type "x"'), null);
  assert.notEqual(bash(PLAN, 'opencli browser --session task state'), null);
});

test('chaining and shell syntax cannot smuggle a second command', () => {
  for (const c of [
    'opencli browser --session task state && pwd',
    'opencli browser --session task state; pwd',
    'opencli browser --session task state | head',
    'opencli browser --session task state || pwd',
    'opencli browser --session task state & pwd',
    'opencli browser --session task state > /tmp/f',
    'opencli browser --session task state < /etc/hosts',
    'opencli browser --session task fill 1 "$(whoami)"',
    'opencli browser --session task fill 1 `whoami`',
    'opencli browser --session task fill 1 $(whoami)',
    'opencli browser --session task state\npwd',
    'opencli browser --session task fill 1 "unterminated',
    'opencli browser --session task state \\',
    '(pwd)',
  ]) assert.notEqual(bash(TASK, c), null, c);
});

test('allowed binary, dangerous arguments', () => {
  for (const c of [
    'opencli gh api user',                                       // other opencli commands run real CLIs with your credentials
    'opencli plugin install github:someone/plugin',
    'opencli external install x',
    'opencli daemon stop',
    'opencli gmail search x',
    'opencli browser --session other bind', // a session the run doesn't own
    'opencli browser --window background --session task state', // anything that shifts the session position
    'opencli browser --session task state --session other',     // commander takes the last --session
    'opencli browser --session task state --session=other',
    'opencli browser --session task state --profile Work',      // another Chrome profile's logins
    'opencli browser --session task upload 3 /Users/me/.ssh/id_ed25519',   // attach local files to a page
    'opencli browser --session task open file:///etc/hosts',
    'opencli browser --session task open chrome://settings',
    'opencli browser --session task open javascript:alert(1)',
    'opencli browser --session task open https://chase.com/login',         // denylist applies mid-task, not just at start
    'opencli browser --session task open https://secure.chase.com',
    'opencli browser --session task open "https://mail.google.com"',
    'opencli browser --session task tab new https://chase.com',
    "opencli browser --session task 'open' 'file:///etc/hosts'",           // quoting doesn't hide the subcommand
  ]) assert.notEqual(bash(TASK, c), null, c);
});

test('screenshots are allowed, but only saved into the shots folder', () => {
  for (const c of ['opencli browser --session task screenshot', 'opencli browser --session task screenshot /x/shots/p.png --full-page',
    'opencli browser --session task screenshot --width 800 /x/shots/p.png', 'opencli browser --session task screenshot --tab abc --annotate /x/shots/p.png'])
    assert.equal(bash(TASK, c), null, c);
  assert.equal(bash(LAB, 'opencli browser --session vm screenshot /x/shots/vm.png'), null);
  for (const c of [
    'opencli browser --session task screenshot /Users/me/.zshrc',          // would overwrite the file with a PNG
    'opencli browser --session task screenshot ~/.zshrc',
    'opencli browser --session task screenshot /x/shots/../../etc/x.png',
    'opencli browser --session task screenshot /x/shotsevil/p.png',
    'opencli browser --session task screenshot p.png',                     // relative: resolves against a cwd we don't control
    'opencli browser --session task screenshot --width 800 /tmp/p.png',
  ]) assert.notEqual(bash(TASK, c), null, c);
});

test('Read is limited to the screenshots folder', () => {
  assert.equal(check('Read', { file_path: '/x/shots/a.png' }, TASK), null);
  for (const f of ['/x/shots/../sandbox/plan.json', '/x/sandbox/plan.json', '/x/shotsevil/a.png', 'plan.json'])
    assert.notEqual(check('Read', { file_path: f }, TASK), null, f);
  assert.notEqual(check('Read', { file_path: '/x/shots/a.png' }, PLAN), null); // no Read rule -> no reads
});

test('local model acts only through ttw; ttw run via opencli gets a pointer', () => {
  const LOCAL = JSON.parse(guardArgs(['Bash(opencli browser --session task *)', 'Bash(ttw *)'], { shots: '/x/shots', denySites: DENY, ttwActs: true }).env.TTW_GUARD);
  assert.match(bash(TASK, 'opencli browser --session task ttw do c2 a1'), /run `ttw do c2 a1` directly/);
  for (const c of ['opencli browser --session task bind && ttw page', 'ttw do c2 a1', 'opencli browser --session task state', 'opencli browser --session task extract', 'opencli browser --session task open https://example.com'])
    assert.equal(bash(LOCAL, c), null, c);
  for (const c of ['opencli browser --session task click 5', 'opencli browser --session task state && opencli browser --session task check 3', 'opencli browser --session task keys Enter'])
    assert.match(bash(LOCAL, c), /disabled for this model/, c);
  assert.equal(bash(TASK, 'opencli browser --session task click 5'), null); // Claude models keep raw clicks
});

test('`opencli … ttw …` is rewritten to the ttw command it means', () => {
  assert.equal(fixCommand('opencli browser --session task ttw do c1 a1'), 'ttw do c1 a1');
  assert.equal(fixCommand('opencli browser --session task bind && opencli browser --session task ttw page'), 'opencli browser --session task bind && ttw page');
  assert.equal(fixCommand('opencli browser --session task click 3'), 'opencli browser --session task click 3');
  assert.equal(fixCommand('ttw note "opencli browser --session task ttw is wrong"'), 'ttw note "opencli browser --session task ttw is wrong"');
});
