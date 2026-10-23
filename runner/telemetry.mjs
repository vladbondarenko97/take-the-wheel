// Run telemetry: one compact JSON line per task event in ~/.take-the-wheel/events.jsonl (the local
// audit log the panel's stats read), optionally shipped to an OpenTelemetry collector as OTLP/HTTP
// JSON logs. Set OTEL_EXPORTER_OTLP_LOGS_ENDPOINT (e.g. http://collector:4318/v1/logs) and, if the
// backend needs auth, OTEL_EXPORTER_OTLP_HEADERS ("k=v,k2=v2"), the standard OpenTelemetry names.
// Set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (or OTEL_EXPORTER_OTLP_ENDPOINT, which gets /v1/traces appended) to also
// get one trace span per task: GenAI attributes (model, tokens), cost, turns, tool calls and guard blocks.
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const EVENTS = process.env.TTW_EVENTS || join(homedir(), '.take-the-wheel', 'events.jsonl'); // override for tests
const OTLP = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
const OTLP_HEADERS = Object.fromEntries((process.env.OTEL_EXPORTER_OTLP_HEADERS || '').split(',').filter(Boolean).map(h => h.split('=').map(s => s.trim())));
const OTLP_BASE = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, '');
const OTLP_TRACES = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (OTLP_BASE && `${OTLP_BASE}/v1/traces`);
let queue = [];
const spans = new Map(); // run -> what the task's span needs once it finishes
const attr = (k, v) => ({ key: k, value: typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });

// The subset of each panel event worth keeping: no page text, commands clipped.
function record(e) {
  switch (e.kind) {
    case 'session': return { k: 'session', session: e.id };
    case 'tool': return { k: 'tool', cmd: String(e.text).slice(0, 200) };
    case 'out': return { k: 'out', error: !!e.error, blocked: !!e.error && /^Blocked by Take the Wheel/.test(e.text ?? '') };
    case 'done': return { k: 'done', ok: !e.error && e.subtype === 'success', cost: e.cost ?? 0, turns: e.turns ?? 0, subtype: e.subtype,
      inTok: (e.usage?.input_tokens ?? 0) + (e.usage?.cache_read_input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0), outTok: e.usage?.output_tokens ?? 0, apiMs: e.apiMs };
    case 'end': return { k: 'end', code: e.code };
  }
}

// Appends one record to the audit log (and the OTLP queue).
export function emit(run, r) {
  const line = { ts: Date.now(), run, ...r };
  try { appendFileSync(EVENTS, JSON.stringify(line) + '\n'); } catch {} // sync: concurrent async appends can reorder lines
  trace(run, line);
  if (OTLP) { queue.push(line); if (r.k === 'end' || r.k === 'done' || r.k === 'bedrock_check' || queue.length >= 100) flush(); }
}

// Wraps a run's SSE `send` so everything the panel sees is also recorded. `meta` lands on the start line.
export function tap(meta, send) {
  const run = Math.random().toString(36).slice(2, 10);
  emit(run, { k: 'start', ...meta });
  return ev => { const r = record(ev); if (r) emit(run, r); send(ev); };
}

function flush() {
  const lines = queue; queue = [];
  const body = { resourceLogs: [{
    resource: { attributes: [attr('service.name', 'take-the-wheel-runner'), attr('host.name', hostname())] },
    scopeLogs: [{ scope: { name: 'take-the-wheel' }, logRecords: lines.map(({ ts, k, ...rest }) => ({
      timeUnixNano: String(ts * 1e6), severityText: rest.blocked ? 'WARN' : rest.error || rest.ok === false ? 'ERROR' : 'INFO',
      body: { stringValue: `ttw.${k}` }, attributes: Object.entries(rest).filter(([, v]) => v != null).map(([a, v]) => attr(`ttw.${a}`, v)),
    })) }],
  }] };
  fetch(OTLP, { method: 'POST', headers: { 'content-type': 'application/json', ...OTLP_HEADERS }, body: JSON.stringify(body) }).catch(() => {}); // ponytail: no retry; a down collector loses that batch (the JSONL keeps it)
}

// One span per task, sent when the task finishes (done = the result; end = the process exited, so only a stopped or crashed run still needs one).
function trace(run, { ts, k, ...r }) {
  if (!OTLP_TRACES) return;
  if (k === 'start') spans.set(run, { t0: ts, meta: r, events: [], blocked: 0 });
  const s = spans.get(run); if (!s) return;
  if (k === 'tool' && s.events.length < 50) s.events.push({ name: 'tool_call', timeUnixNano: String(ts * 1e6), attributes: [attr('ttw.cmd', r.cmd)] });
  if (k === 'out' && r.blocked) s.blocked++;
  if (k !== 'done' && k !== 'end') return;
  spans.delete(run);
  const ok = k === 'done' ? r.ok : false, m = s.meta;
  const span = {
    traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), name: `invoke_agent take-the-wheel`, kind: 1,
    startTimeUnixNano: String(s.t0 * 1e6), endTimeUnixNano: String(ts * 1e6), events: s.events,
    attributes: [attr('gen_ai.operation.name', 'invoke_agent'), attr('gen_ai.provider.name', m.provider === 'bedrock' ? 'aws.bedrock' : 'anthropic'),
      attr('ttw.mode', m.mode ?? 'task'), attr('ttw.ok', !!ok), attr('ttw.tool_calls', s.events.length), attr('ttw.blocked', s.blocked),
      ...(m.model ? [attr('gen_ai.request.model', m.model)] : []), ...(m.effort ? [attr('ttw.effort', m.effort)] : []),
      ...(k === 'done' ? [attr('gen_ai.usage.input_tokens', r.inTok ?? 0), attr('gen_ai.usage.output_tokens', r.outTok ?? 0), attr('ttw.cost_usd', r.cost ?? 0), attr('ttw.turns', r.turns ?? 0), attr('ttw.subtype', r.subtype ?? '')] : [attr('ttw.exit_code', r.code ?? -1)])],
    status: ok ? { code: 1 } : { code: 2, message: k === 'done' ? String(r.subtype ?? 'error') : 'stopped before a result' },
  };
  const body = { resourceSpans: [{ resource: { attributes: [attr('service.name', 'take-the-wheel-runner'), attr('host.name', hostname())] },
    scopeSpans: [{ scope: { name: 'take-the-wheel' }, spans: [span] }] }] };
  fetch(OTLP_TRACES, { method: 'POST', headers: { 'content-type': 'application/json', ...OTLP_HEADERS }, body: JSON.stringify(body) }).catch(() => {}); // ponytail: no retry, like the logs
}

// Aggregates the audit log. Claude reports cost cumulatively per session, so each run's cost is its
// increase over the previous run in the same conversation (session).
export function summarize(lines, session) {
  const runs = new Map();
  for (const l of lines) {
    const r = runs.get(l.run) ?? runs.set(l.run, { tools: [], latencies: [], blocked: 0 }).get(l.run);
    if (l.k === 'start') r.ts = l.ts;
    else if (l.k === 'session') r.session ??= l.session;
    else if (l.k === 'tool') r.tools.push(l.ts);
    else if (l.k === 'out') { const t = r.tools.shift(); if (t != null) r.latencies.push(l.ts - t); if (l.blocked) r.blocked++; }
    else if (l.k === 'done') Object.assign(r, { finished: true, ok: l.ok, total: l.cost, inTok: l.inTok ?? 0, outTok: l.outTok ?? 0 });
    else if (l.k === 'end') r.finished = true;
  }
  const last = new Map(); let lifetime = 0, convo = 0, costed = 0, ok = 0, finished = 0, blocked = 0, inTok = 0, outTok = 0;
  const lat = [];
  for (const r of [...runs.values()].sort((a, b) => a.ts - b.ts)) {
    lat.push(...r.latencies); blocked += r.blocked;
    if (!r.finished) continue;
    finished++; if (r.ok) ok++; inTok += r.inTok ?? 0; outTok += r.outTok ?? 0;
    if (r.total == null) continue;
    const prev = last.get(r.session) ?? 0;
    const cost = r.total >= prev ? r.total - prev : r.total;
    if (r.session) last.set(r.session, r.total);
    lifetime += cost; costed++;
    if (session && r.session === session) convo += cost;
  }
  lat.sort((a, b) => a - b);
  return {
    tasks: finished, successRate: finished ? ok / finished : null,
    medianToolMs: lat.length ? lat[lat.length >> 1] : null, toolCalls: lat.length, blocked,
    inputTokens: inTok, outputTokens: outTok,
    avgTaskCost: costed ? lifetime / costed : null, lifetimeCost: lifetime, conversationCost: session ? convo : null,
  };
}

export async function stats(session) {
  const text = await readFile(EVENTS, 'utf8').catch(() => '');
  const lines = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return summarize(lines, session); // ponytail: rereads the whole log per request; roll up per day if it reaches tens of MB
}
