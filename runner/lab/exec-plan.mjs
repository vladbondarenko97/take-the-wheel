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

// Binary (yes/no) checks are far more reliable from a vision model than "read this text
// exactly" + regex matching -- so `expect` is almost always "yes"/"no"; a regex is still
// supported for the rare case of matching a specific known literal (e.g. a version string).
function matches(answer, expect) {
  const a = answer.trim().toLowerCase();
  if (expect === 'yes' || expect === 'no') return a.startsWith(expect);
  return new RegExp(expect, 'i').test(answer);
}

// One retry before declaring failure: absorbs a command still running / a frame mid-render,
// not just real bugs -- a known failure mode here (a prior screenshot caught a mid-transition
// video frame and gave a stale answer).
async function runCheck(step, attempt = 0) {
  await sleep(700); // let the VM settle before reading it
  const answer = labctl(['look', step.question]).trim();
  if (matches(answer, step.expect)) return { ok: true, answer };
  if (attempt === 0) return runCheck(step, 1);
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

let i = 0;
for (const step of plan.steps) {
  try {
    if (step.do === 'check') {
      const result = await runCheck(step);
      if (!result.ok) fail(i, step, { actual: result.answer });
    } else if (step.do === 'type') labctl(['type', step.arg]);
    else if (step.do === 'key') labctl(['key', step.arg]);
    else if (step.do === 'click') labctl(['click', String(step.arg[0]), String(step.arg[1])]);
    else if (step.do === 'locate') labctl(['locate', step.arg]);
    else if (step.do === 'username') labctl(['username']);
    else if (step.do === 'password') labctl(['password']);
    else throw new Error(`unknown step.do: ${step.do}`);
  } catch (e) {
    fail(i, step, { error: cleanError(e) });
  }
  i++;
}
console.log(JSON.stringify({ ok: true, stepsRun: i }));
