// atomicWriteJson — write a JSON file atomically: write to a unique temp
// file in the same directory, fsync, then rename. If the process is
// SIGKILLed mid-write the target file is left in its pre-write state
// rather than truncated/empty.
//
// All Meridian JSON state files (state.json, lessons.json, pool-memory.json,
// decision-log.json, signal-weights.json, strategy-library.json,
// token-blacklist.json, smart-wallets.json, dev-blocklist.json) route
// through this helper.

import fs from "fs";
import path from "path";

/**
 * @param {string} targetPath - absolute or cwd-relative path to the target file
 * @param {any} data - JSON-serializable value to write (pretty-printed with 2 spaces)
 * @throws on stringify failure or filesystem error — caller decides how to handle
 */
export function atomicWriteJson(targetPath, data) {
  const dir = path.dirname(targetPath);
  const tmpName = `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const serialized = JSON.stringify(data, null, 2);

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, serialized);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // rename is atomic on POSIX filesystems within the same dir
  fs.renameSync(tmpPath, targetPath);
}
