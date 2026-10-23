// Amazon Bedrock: the approved-model allowlist (used both for agent runs and the direct check), a
// throttling-aware retry wrapper, and a verified check that invokes an approved model once and reports
// latency, token usage, retries and whether the answer was right. Credentials come from the standard
// AWS chain (aws login / SSO / profile / env keys) or an AWS_BEARER_TOKEN_BEDROCK API key.
// @anthropic-ai/bedrock-sdk is an optional dependency, loaded only when Bedrock is used.

// Global cross-region inference profiles (AWS routes for capacity; regional us./eu. ones cost 10% more).
// Override per deployment, e.g. a regional prefix for data residency or an application inference profile ARN.
export const APPROVED = {
  haiku: process.env.TTW_BEDROCK_HAIKU || 'global.anthropic.claude-haiku-5-5',
  sonnet: process.env.TTW_BEDROCK_SONNET || 'global.anthropic.claude-sonnet-5-5',
  opus: process.env.TTW_BEDROCK_OPUS || 'global.anthropic.claude-opus-5-5',
};
export const region = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';

// Retries throttling (429), server errors (5xx) and dropped connections with exponential backoff and
// full jitter, honoring a retry-after header. Anything else (bad request, no model access) fails at once.
export async function withRetry(fn, { retries = 4, baseMs = 400, maxMs = 8000, isThrottle, isRetryable, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  let throttled = 0, waitedMs = 0;
  for (let attempt = 1; ; attempt++) {
    try { return { value: await fn(), attempts: attempt, throttled, waitedMs }; }
    catch (e) {
      if (isThrottle(e)) throttled++;
      if (attempt > retries || !isRetryable(e)) throw Object.assign(e, { attempts: attempt, throttled, waitedMs });
      const after = Number(e.headers?.get?.('retry-after'));
      const wait = after > 0 ? Math.min(after * 1000, maxMs) : Math.random() * Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      waitedMs += wait;
      await sleep(wait);
    }
  }
}

// Which SDK errors are worth retrying. Missing or expired AWS credentials arrive as a connection error
// whose cause is a CredentialsProviderError; retrying can't fix those.
export const retryPolicy = B => ({
  isThrottle: e => e instanceof B.RateLimitError,
  isRetryable: e => e instanceof B.RateLimitError || e instanceof B.InternalServerError
    || (e instanceof B.APIConnectionError && e.cause?.name !== 'CredentialsProviderError'),
});

let client;
async function bedrock() {
  if (!client) {
    let AnthropicBedrock;
    try { ({ AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')); }
    catch { throw new Error('Bedrock SDK not installed: run `npm install` in the repo'); }
    client = new AnthropicBedrock({ awsRegion: region(), maxRetries: 0 }); // retries are ours, so they can be counted
  }
  return client;
}

export async function check(alias = 'haiku') {
  const model = APPROVED[alias];
  if (!model) return { provider: 'bedrock', ok: false, alias, error: `"${alias}" is not an approved model (${Object.keys(APPROVED).join(', ')})` };
  let B;
  try { B = (await bedrock()).constructor; } catch (e) { return { provider: 'bedrock', ok: false, alias, model, error: e.message }; }
  const a = 100 + Math.floor(Math.random() * 900), b = 10 + Math.floor(Math.random() * 90); // fresh each time: can't be cached or guessed
  const t0 = performance.now();
  const base = { provider: 'bedrock', region: region(), alias, model };
  try {
    const { value: msg, attempts, throttled, waitedMs } = await withRetry(async () => (await bedrock()).messages.create({
      model, max_tokens: 4000,
      messages: [{ role: 'user', content: `What is ${a} × ${b}? Reply with only the number.` }],
    }), retryPolicy(B));
    const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    const answer = Number(text.replace(/[^\d.-]/g, ''));
    return {
      ...base, ok: answer === a * b, latencyMs: Math.round(performance.now() - t0), attempts, throttled, waitedMs: Math.round(waitedMs),
      inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, stopReason: msg.stop_reason,
      question: `${a} × ${b}`, expected: a * b, answer: text.slice(0, 40),
    };
  } catch (e) {
    return { ...base, ok: false, latencyMs: Math.round(performance.now() - t0), attempts: e.attempts ?? 1, throttled: e.throttled ?? 0, status: e.status,
      error: e.cause?.name === 'CredentialsProviderError' ? `AWS credentials: ${e.cause.message} Run \`aws login\` (or set AWS_PROFILE / AWS_BEARER_TOKEN_BEDROCK).`
        : /not allowed for this account/i.test(e.message) ? `${e.message}. Submit Anthropic's one-time use-case form: Bedrock console → Model catalog → any Claude model.`
        : String(e.message).slice(0, 300) };
  }
}
