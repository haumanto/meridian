// Deploy rate-limit: in-memory sliding window tracking deploy_position
// successes. Pulled into its own module so tests can import it without
// loading the Solana SDK / RPC client / Meteora DLMM.

const _deployTimestamps = [];

function prune(now) {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  while (_deployTimestamps.length && _deployTimestamps[0] < dayAgo) {
    _deployTimestamps.shift();
  }
}

export function getDeployRateState(now = Date.now()) {
  prune(now);
  const hourAgo = now - 60 * 60 * 1000;
  const lastHour = _deployTimestamps.filter((t) => t >= hourAgo).length;
  return { lastHour, lastDay: _deployTimestamps.length };
}

export function recordDeployForRateLimit(now = Date.now()) {
  _deployTimestamps.push(now);
}

// Test-only: reset the counter
export function _resetDeployRateLimit() {
  _deployTimestamps.length = 0;
}
