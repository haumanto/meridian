// Deploy rate-limit: sliding window of successful deploys, backed by
// state.json so PM2 restart cannot silently bypass the cap.

import { getDeployTimestamps, setDeployTimestamps } from "../state.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function pruneWithin24h(timestamps, now) {
  const dayAgo = now - DAY_MS;
  return timestamps.filter((t) => t >= dayAgo);
}

export function getDeployRateState(now = Date.now()) {
  const timestamps = pruneWithin24h(getDeployTimestamps(), now);
  const hourAgo = now - HOUR_MS;
  const lastHour = timestamps.filter((t) => t >= hourAgo).length;
  return { lastHour, lastDay: timestamps.length };
}

export function recordDeployForRateLimit(now = Date.now()) {
  const pruned = pruneWithin24h(getDeployTimestamps(), now);
  pruned.push(now);
  setDeployTimestamps(pruned);
}

// Test-only: reset the counter
export function _resetDeployRateLimit() {
  setDeployTimestamps([]);
}
