/**
 * Internal TTL/expiry bookkeeping for Drift stores.
 *
 * This module is NOT part of the public API — it exists so `store.ts` can
 * stay focused on LRU ordering and the public method surface while the
 * expiry rules live in one place. The invariant these helpers encode: an
 * entry is expired exactly when `expiresAt` is set and `expiresAt <= now`
 * (deadlines are inclusive, matching the behavior the test suite pins).
 */

import type { Entry } from "./persistence.js";

/** Whether `entry` is past its deadline at `now` (epoch ms). */
export function isExpired<T>(entry: Entry<T>, now: number): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt <= now;
}

/**
 * Validate a TTL value, throwing the store's standard `TypeError` when it
 * is not a positive number. `name` is the option name shown in the message
 * (`defaultTtlMs` or `ttlMs`) so callers see which knob they misused.
 */
export function assertValidTtl(ttlMs: number, name: string): void {
  if (typeof ttlMs !== "number" || Number.isNaN(ttlMs) || ttlMs <= 0) {
    throw new TypeError(
      `driftkv: ${name} must be a positive number of milliseconds, got ${ttlMs}`,
    );
  }
}

/**
 * Remove every expired entry from `entries`; returns the number removed.
 * Deleting during iteration is safe: `Map` iterators tolerate removal of
 * the current (and any other) key.
 */
export function sweepExpired<T>(entries: Map<string, Entry<T>>): number {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of entries) {
    if (isExpired(entry, now)) {
      entries.delete(key);
      removed += 1;
    }
  }
  return removed;
}
