// node --test test/   Bedrock: throttling retries and the approved-model gate. No AWS calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, check, APPROVED, retryPolicy } from '../runner/bedrock.mjs';

class Throttle extends Error { status = 429; constructor(retryAfter) { super('Too many requests'); this.headers = new Map(retryAfter ? [['retry-after', String(retryAfter)]] : []); } }
class BadRequest extends Error { status = 400; }
const opts = waits => ({ isThrottle: e => e instanceof Throttle, isRetryable: e => e instanceof Throttle || e.status >= 500, sleep: async ms => { waits.push(ms); } });
const failing = (...errors) => { let n = 0; return async () => { if (n < errors.length) throw errors[n++]; return 'ok'; }; };

test('retries throttling with capped exponential backoff, then succeeds', async () => {
  const waits = [];
  const r = await withRetry(failing(new Throttle(), new Throttle(), Object.assign(new Error('503'), { status: 503 })), opts(waits));
  assert.deepEqual([r.value, r.attempts, r.throttled], ['ok', 4, 2]);
  assert.equal(waits.length, 3);
  waits.forEach((w, i) => assert.ok(w >= 0 && w <= 400 * 2 ** i, `wait ${i} = ${w}`)); // full jitter under 400ms, 800ms, 1600ms
});

test('honors retry-after', async () => {
  const waits = [];
  await withRetry(failing(new Throttle(3)), opts(waits));
  assert.deepEqual(waits, [3000]);
});

test('does not retry a bad request', async () => {
  const waits = [];
  await assert.rejects(withRetry(failing(new BadRequest('no model access')), opts(waits)), e => e.attempts === 1);
  assert.equal(waits.length, 0);
});

test('gives up after the retry limit and reports how often it was throttled', async () => {
  const waits = [];
  await assert.rejects(withRetry(failing(...Array(10).fill(0).map(() => new Throttle())), { ...opts(waits), retries: 2 }), e => e.attempts === 3 && e.throttled === 3);
});

test('retry policy: throttling, 5xx and network blips retry; expired credentials and 4xx do not', () => {
  class RateLimitError extends Error {} class InternalServerError extends Error {} class APIConnectionError extends Error {}
  const p = retryPolicy({ RateLimitError, InternalServerError, APIConnectionError });
  const credErr = Object.assign(new APIConnectionError('Connection error.'), { cause: Object.assign(new Error('Your session has expired.'), { name: 'CredentialsProviderError' }) });
  assert.deepEqual([new RateLimitError(), new InternalServerError(), new APIConnectionError(), credErr, new BadRequest()].map(p.isRetryable), [true, true, true, false, false]);
  assert.deepEqual([new RateLimitError(), new InternalServerError()].map(p.isThrottle), [true, false]);
});

test('only approved models can be invoked', async () => {
  const r = await check('gpt-5');
  assert.equal(r.ok, false);
  assert.match(r.error, /not an approved model/);
  assert.deepEqual(Object.keys(APPROVED), ['haiku', 'sonnet', 'opus']);
});
