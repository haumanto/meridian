// fetchWithRetry — thin wrapper around fetch() with:
//   - AbortController-based timeout (default 10s)
//   - Exponential backoff on 429 / 5xx (default 3 tries)
//   - Honors `Retry-After` header when present
//   - Throws an Error with .status, .body when all retries exhausted
//
// Usage:
//   const res = await fetchWithRetry(url, { headers: {...} }, { timeoutMs: 8000, retries: 3 });
//   const json = await res.json();
//
// Designed to replace `await fetch(...)` calls at boundaries with no
// in-flight retry behavior. Keep timeouts modest so a single hanging
// upstream can't stall a screening cycle.

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelayMs(attempt, retryAfter, baseDelayMs) {
  // attempt is 1-indexed: 1, 2, 3...
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 8000);
  }
  // Exponential w/ jitter: 350 / 700 / 1400 (± up to 25%)
  const base = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.min(8000, Math.max(50, base + jitter));
}

/**
 * @param {string} url
 * @param {RequestInit} [opts]   - standard fetch options
 * @param {object}      [retryOpts]
 * @param {number}      [retryOpts.timeoutMs]   - per-attempt timeout (default 10s)
 * @param {number}      [retryOpts.retries]     - total attempts (default 3)
 * @param {number}      [retryOpts.baseDelayMs] - first retry backoff (default 350ms)
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, opts = {}, retryOpts = {}) {
  const timeoutMs = retryOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = retryOpts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = retryOpts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timer);
      // Retry on 429 or any 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const retryAfterSec = Number(res.headers.get("retry-after"));
        if (attempt < retries) {
          await sleep(backoffDelayMs(attempt, retryAfterSec, baseDelayMs));
          continue;
        }
        const body = await res.text().catch(() => "");
        const err = new Error(`HTTP ${res.status} after ${retries} attempts: ${url}`);
        err.status = res.status;
        err.body = body.slice(0, 500);
        throw err;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      // Abort = timeout; retry. Network errors also retry.
      const isAbort = err?.name === "AbortError";
      const isNet = err?.code === "ECONNRESET" || err?.code === "ENOTFOUND"
        || err?.code === "ETIMEDOUT" || err?.code === "EAI_AGAIN";
      lastErr = err;
      if ((isAbort || isNet) && attempt < retries) {
        await sleep(backoffDelayMs(attempt, null, baseDelayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`fetchWithRetry exhausted retries: ${url}`);
}

/**
 * Convenience helper: fetchWithRetry + parse JSON in one call.
 * Throws on non-2xx after retries.
 */
export async function fetchJsonWithRetry(url, opts, retryOpts) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status}: ${url}`);
    err.status = res.status;
    err.body = body.slice(0, 500);
    throw err;
  }
  return res.json();
}
