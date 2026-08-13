/**
 * Core store implementation for Drift.
 *
 * Invariants:
 * - The backing `Map` is ordered least- to most-recently-used. `get` and
 *   `set` re-insert the key to refresh recency; `has` deliberately does not
 *   (existence checks should not perturb eviction order).
 * - Expiry is lazy: an expired entry may linger in the map until a read
 *   touches it, `sweep()` runs, or eviction removes it. Every public
 *   observation (`get`/`has`/`keys`/`size`) treats expired entries as gone,
 *   so laziness is never visible through the API.
 * - Live-entry counts are enforced against `maxEntries` only after expired
 *   entries have been reclaimed, so a store full of dead entries never
 *   evicts live data.
 */

import { loadSnapshot, writeSnapshot, type Entry } from "./persistence.js";
import type { DriftStore, DriftStoreOptions, SetOptions } from "./types.js";

/**
 * Create a Drift store.
 *
 * @typeParam T - Value type held by the store. Defaults to `unknown`.
 * @param options - See {@link DriftStoreOptions}. Invalid options throw
 *   synchronously so misconfiguration fails at startup, not first use.
 */
export function createStore<T = unknown>(
  options: DriftStoreOptions = {},
): DriftStore<T> {
  const { maxEntries, defaultTtlMs, persistPath } = options;

  if (maxEntries !== undefined) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(
        `driftkv: maxEntries must be a positive integer, got ${maxEntries}`,
      );
    }
  }
  if (defaultTtlMs !== undefined) {
    assertValidTtl(defaultTtlMs, "defaultTtlMs");
  }
  if (persistPath !== undefined && persistPath.length === 0) {
    throw new TypeError("driftkv: persistPath must be a non-empty string");
  }

  const entries = new Map<string, Entry<T>>();

  // Rehydrate from disk before applying limits: loaded entries count toward
  // maxEntries exactly like freshly set ones, oldest-first.
  if (persistPath !== undefined) {
    const loaded = loadSnapshot<T>(persistPath);
    if (loaded !== undefined) {
      const now = Date.now();
      for (const [key, entry] of loaded) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now) continue;
        entries.set(key, entry);
      }
      if (maxEntries !== undefined) evictDownTo(entries, maxEntries);
    }
  }

  function isExpired(entry: Entry<T>, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  /** Read an entry, reclaiming it if expired. Returns undefined on miss. */
  function readLive(key: string): Entry<T> | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (isExpired(entry, Date.now())) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Remove every expired entry; returns the number removed. */
  function sweep(): number {
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

  return {
    get(key) {
      const entry = readLive(key);
      if (entry === undefined) return undefined;
      // Refresh LRU recency: Map preserves insertion order, so delete +
      // re-set moves the key to the most-recently-used end.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },

    set(key, value, setOptions?: SetOptions) {
      if (typeof key !== "string") {
        throw new TypeError(
          `driftkv: keys must be strings, got ${typeof key}`,
        );
      }
      const ttlMs = setOptions?.ttlMs ?? defaultTtlMs;
      if (setOptions?.ttlMs !== undefined) {
        assertValidTtl(setOptions.ttlMs, "ttlMs");
      }

      const entry: Entry<T> = { value };
      if (ttlMs !== undefined) entry.expiresAt = Date.now() + ttlMs;

      // Delete first so an overwrite refreshes recency instead of keeping
      // the key's old position in the map.
      const existed = entries.delete(key);
      entries.set(key, entry);

      if (maxEntries !== undefined && !existed && entries.size > maxEntries) {
        // Prefer reclaiming expired entries over evicting live ones.
        if (sweep() === 0 || entries.size > maxEntries) {
          evictDownTo(entries, maxEntries);
        }
      }
    },

    has(key) {
      return readLive(key) !== undefined;
    },

    delete(key) {
      // An expired entry no longer exists as far as callers are concerned,
      // so deleting one reports `false` even though it frees the slot.
      const wasLive = readLive(key) !== undefined;
      entries.delete(key);
      return wasLive;
    },

    clear() {
      entries.clear();
    },

    keys() {
      sweep();
      return [...entries.keys()];
    },

    size() {
      sweep();
      return entries.size;
    },

    sweep,

    flush() {
      if (persistPath === undefined) {
        throw new Error(
          "driftkv: flush() requires the store to be created with persistPath",
        );
      }
      sweep();
      writeSnapshot(persistPath, [...entries.entries()]);
    },
  };
}

function assertValidTtl(ttlMs: number, name: string): void {
  if (typeof ttlMs !== "number" || Number.isNaN(ttlMs) || ttlMs <= 0) {
    throw new TypeError(
      `driftkv: ${name} must be a positive number of milliseconds, got ${ttlMs}`,
    );
  }
}

/** Evict least-recently-used entries until the map holds at most `limit`. */
function evictDownTo(entries: Map<string, unknown>, limit: number): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
  }
}
