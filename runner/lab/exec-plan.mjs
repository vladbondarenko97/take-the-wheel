#!/usr/bin/env node
// exec-plan: run a JSON plan of labctl actions against a VM session, deterministically and
// at zero LLM cost except the (already-free) local vision model used by `check` steps.
//
// The split this exists for: Claude plans a section once (reads the lab's hints, decides the
// steps) -- that's the only paid call. This script then *executes* that fixed plan, verifying
// as it goes, with no model making decisions turn by turn. It stops at the first failed check
// instead of continuing on a wrong assumption; that structured failure report is the hand-off
// payload for escalating back to the full agentic lab mode to diagnose and fix just that part.
//
// Plan format (JSON): { "goal": "<string>", "steps": [ <step>, ... ] }
//   { "do": "type", "arg": "<text>" }
//   { "do": "key", "arg": "<Exact Key Label>" }
//   { "do": "click", "arg": [vx, vy] }
//   { "do": "locate", "arg": "<description>" }
//   { "do": "username" } / { "do": "password" }
//   { "do": "typeHint", "arg": "<exact text, verbatim from a lab instruction>" } -- click the
//     instructions page's own "Type Text" button for that text instead of typing it character
//     by character; confirmed live, faster and more reliable whenever the text is shown
//     verbatim in the hints. Always runs against the `instructions` session, regardless of
//     which session this plan is otherwise executing against.
//   { "do": "check", "question": "<yes/no question>", "expect": "yes" | "no" | "<regex>" }
//
// Usage: exec-plan <session> <plan.json>
// Exit 0 + {ok:true, stepsRun} on full success.
// Exit 1 + {ok:false, failedStep, step, actual|error} on the first failure.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const [session, planPath] = process.argv.slice(2);
if (!session || !planPath) {
  console.error('usage: exec-plan <session> <plan.json>');
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const LABCTL = join(dirname(fileURLToPath(import.meta.url)), 'labctl.mjs');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const labctl = args => execFileSync('node', [LABCTL, session, ...args], { encoding: 'utf8' });
// typeHint always targets the instructions page's own DOM, regardless of which session (vm,
// normally) this plan otherwise drives -- that's where the "Type Text" buttons live.
const labctlInstructions = args => execFileSync('node', [LABCTL, 'instructions', ...args], { encoding: 'utf8' });

// Binary (yes/no) checks are far more reliable from a vision model than "read this text
// exactly" + regex matching -- so `expect` is almost always "yes"/"no"; a regex is still
// supported for the rare case of matching a specific known literal (e.g. a version string).
function matches(answer, expect) {
  const a = answer.trim().toLowerCase();
  if (expect === 'yes' || expect === 'no') return a.startsWith(expect);
  return new RegExp(expect, 'i').test(answer);
}

// Backoff retries before declaring failure: absorbs real lag, not just a frame mid-render.
// Measured live: on a slow/congested connection, keystrokes and an Enter press were still
// "in flight" *several seconds* after being sent -- a single fixed short wait isn't enough,
// it just reads stale state confidently. Increasing delays (1s, 2s, 4s = 7s max) cost nothing
// extra on a normal responsive VM (the first attempt still succeeds immediately), and only
// spend the extra time in the case that actually needs it.
const CHECK_DELAYS_MS = [1000, 2000, 4000];
async function runCheck(step) {
  let answer = '';
  for (const delay of CHECK_DELAYS_MS) {
    await sleep(delay);
    answer = labctl(['look', step.question]).trim();
    if (matches(answer, step.expect)) return { ok: true, answer };
  }
  return { ok: false, answer };
}

// execFileSync throws with the whole child process's stdout/stderr glued into .message,
// stack trace and all -- pull just the opencli/labctl error line out of that noise so the
// escalation payload is actually readable.
function cleanError(e) {
  const text = String(e.message || e);
  const line = text.split('\n').find(l => /^✖|"error":|^Error:/.test(l.trim()));
  return (line || text.split('\n')[0]).trim();
}

function fail(i, step, extra) {
  console.log(JSON.stringify({ ok: false, failedStep: i, step, ...extra }));
  process.exit(1);
}

// A small pause after every action (not check): measured live that an Enter sent right after
// a typed command could still be "in flight" when the next step fired, racing ahead of the
// command it was meant to submit. Cheap insurance against flooding the same input channel.
const SETTLE_MS = 300;

// One line per completed step, printed as it happens (not just the final result) -- the
// caller (runner.mjs) streams these to the panel so a plan's execution isn't a silent black
// box between "started" and "done 30s later".
const progress = (i, step, extra) => console.log(JSON.stringify({ progress: true, i, step, ...extra }));

let i = 0;
for (const step of plan.steps) {
  try {
    if (step.do === 'check') {
      const result = await runCheck(step);
      if (!result.ok) fail(i, step, { actual: result.answer });
      progress(i, step, { answer: result.answer });
    } else if (step.do === 'type') { labctl(['type', step.arg]); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'key') { labctl(['key', step.arg]); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'click') { labctl(['click', String(step.arg[0]), String(step.arg[1])]); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'locate') { labctl(['locate', step.arg]); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'username') { labctl(['username']); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'password') { labctl(['password']); await sleep(SETTLE_MS); progress(i, step); }
    else if (step.do === 'typeHint') { labctlInstructions(['typeHint', step.arg]); await sleep(SETTLE_MS); progress(i, step); }
    else throw new Error(`unknown step.do: ${step.do}`);
  } catch (e) {
    fail(i, step, { error: cleanError(e) });
  }
  i++;
}
console.log(JSON.stringify({ ok: true, stepsRun: i }));
