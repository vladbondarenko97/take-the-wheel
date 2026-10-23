// node --test test/   Telemetry: stats math over the audit log, and OTLP export to a fake collector.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const got = [];
const collector = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got.push({ headers: req.headers, body: JSON.parse(b) }); res.end('{}'); }); });
await new Promise(r => collector.listen(0, '127.0.0.1', r));
process.env.TTW_EVENTS = join(mkdtempSync(join(tmpdir(), 'ttw-')), 'events.jsonl');
process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://127.0.0.1:${collector.address().port}/v1/logs`;
process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = `http://127.0.0.1:${collector.address().port}/v1/traces`;
process.env.OTEL_EXPORTER_OTLP_HEADERS = 'authorization=Bearer test';
const { summarize, tap, stats } = await import('../runner/telemetry.mjs');

const L = (ts, run, k, x = {}) => ({ ts, run, k, ...x });

test('success rate, latency, blocked calls, per-conversation and lifetime cost', () => {
  const s = summarize([
    L(0, 'a', 'start'), L(1, 'a', 'session', { session: 'S1' }),
    L(10, 'a', 'tool'), L(110, 'a', 'out', { blocked: true, error: true }),
    L(200, 'a', 'tool'), L(500, 'a', 'out'),
    L(600, 'a', 'done', { ok: true, cost: 0.05 }), L(601, 'a', 'end'),
    L(1000, 'b', 'start'), L(1001, 'b', 'session', { session: 'S1' }),          // follow-up: claude reports 0.08 cumulative
    L(1010, 'b', 'tool'), L(1210, 'b', 'out'),
    L(1300, 'b', 'done', { ok: true, cost: 0.08 }),
    L(2000, 'c', 'start'), L(2001, 'c', 'session', { session: 'S2' }),
    L(2100, 'c', 'done', { ok: false, cost: 0.02 }),
    L(3000, 'd', 'start'), L(3001, 'd', 'end', { code: 130 }),                  // stopped before any result
    L(4000, 'e', 'start'),                                                      // still running: not counted
  ], 'S1');
  assert.equal(s.tasks, 4);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.medianToolMs, 200);                                           // 100, 200, 300
  assert.equal(s.blocked, 1);
  assert.ok(Math.abs(s.conversationCost - 0.08) < 1e-9);                       // 0.05 + 0.03, not 0.05 + 0.08
  assert.ok(Math.abs(s.lifetimeCost - 0.10) < 1e-9);
  assert.ok(Math.abs(s.avgTaskCost - 0.10 / 3) < 1e-9);
});

test('empty log', () => {
  const s = summarize([], null);
  assert.deepEqual([s.tasks, s.successRate, s.medianToolMs, s.lifetimeCost, s.conversationCost], [0, null, null, 0, null]);
});

test('tap records what the panel sees and exports it as OTLP logs', async () => {
  const sent = [];
  const send = tap({ mode: 'task', model: 'haiku' }, e => sent.push(e));
  for (const e of [{ kind: 'session', id: 'S9' }, { kind: 'tool', text: 'pwd' }, { kind: 'out', text: 'Blocked by Take the Wheel: no', error: true },
    { kind: 'text', text: 'page text is not recorded' }, { kind: 'done', cost: 0.01, turns: 2, subtype: 'success' }, { kind: 'end', code: 0 }]) send(e);
  assert.equal(sent.length, 6);                                                // the panel still gets everything
  await new Promise(r => setTimeout(r, 200));
  const lines = readFileSync(process.env.TTW_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.k), ['start', 'session', 'tool', 'out', 'done', 'end']);
  assert.ok(!JSON.stringify(lines).includes('page text'));
  assert.equal((await stats('S9')).blocked, 1);
  const recs = got.filter(g => g.body.resourceLogs).flatMap(g => g.body.resourceLogs[0].scopeLogs[0].logRecords);
  assert.equal(got[0].headers.authorization, 'Bearer test');
  assert.deepEqual(recs.map(r => r.body.stringValue), lines.map(l => `ttw.${l.k}`));
  assert.equal(recs.find(r => r.body.stringValue === 'ttw.out').severityText, 'WARN');
});

test('a finished task becomes one trace span with GenAI attributes, tool-call events and the guard-block count', async () => {
  const before = got.filter(g => g.body.resourceSpans).length;
  const send = tap({ mode: 'task', provider: 'bedrock', model: 'sonnet', effort: 'low' }, () => {});
  for (const e of [{ kind: 'tool', text: 'opencli browser state' }, { kind: 'out', text: 'Blocked by Take the Wheel: no', error: true },
    { kind: 'tool', text: 'opencli browser click 3' }, { kind: 'out', text: 'ok' },
    { kind: 'done', cost: 0.04, turns: 3, subtype: 'success', usage: { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 150 } }, { kind: 'end', code: 0 }]) send(e);
  await new Promise(r => setTimeout(r, 200));
  const spans = got.filter(g => g.body.resourceSpans).flatMap(g => g.body.resourceSpans[0].scopeSpans[0].spans);
  const sp = spans.at(-1), a = Object.fromEntries(sp.attributes.map(x => [x.key, Object.values(x.value)[0]]));
  assert.match(sp.traceId, /^[0-9a-f]{32}$/); assert.match(sp.spanId, /^[0-9a-f]{16}$/);
  assert.equal(a['gen_ai.provider.name'], 'aws.bedrock'); assert.equal(a['gen_ai.request.model'], 'sonnet');
  assert.equal(a['gen_ai.usage.input_tokens'], 1500); assert.equal(a['gen_ai.usage.output_tokens'], 150);   // cache reads count as input
  assert.equal(a['ttw.tool_calls'], 2); assert.equal(a['ttw.blocked'], 1); assert.equal(a['ttw.ok'], true); assert.equal(a['ttw.cost_usd'], 0.04);
  assert.deepEqual(sp.events.map(e => e.name), ['tool_call', 'tool_call']); assert.equal(sp.status.code, 1);
  assert.equal(got.filter(g => g.body.resourceSpans).length - before, 1, "'end' after 'done' must not emit a second span");
});

after(() => { collector.closeAllConnections(); collector.close(); });
