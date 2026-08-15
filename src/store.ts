/**
 * Core store implementation for Drift.
 *
 * Invariants:
 * - The backing `Map` is ordered least- to most-recently-used. `get` and
 *   `set` re-insert the key to refresh recency; `has` deliberately does not
 *   (existence checks should not perturb eviction order).
 * - Expiry is lazy: an expired entry may linger in the map until a read
 *   touches it, `sweep()` runs, or eviction removes it. Every public
 *   observation (`get`/`has`/`keys`/`size`/`isEmpty`) treats expired entries
 *   as gone,
 *   so laziness is never visible through the API. The expiry rules
 *   themselves live in `expiry.ts`; this module only decides *when* they
 *   are applied.
 * - Live-entry counts are enforced against `maxEntries` only after expired
 *   entries have been reclaimed, so a store full of dead entries never
 *   evicts live data.
 * - Namespaces are prefix views over the single backing map: a view with
 *   prefix `"users:"` sees exactly the keys starting with `"users:"`. The
 *   root store is the view with the empty prefix. Because there is one map,
 *   `maxEntries`, LRU order, and persistence are shared across every view.
 */

import { assertValidTtl, isExpired } from "./expiry.js";
import { loadSnapshot, writeSnapshot, type Entry } from "./persistence.js";
import type {
  DriftStore,
  DriftStoreEvent,
  DriftStoreEventPayload,
  DriftStoreListener,
  DriftStoreOptions,
  SetOptions,
} from "./types.js";

/**
 * Delimiter inserted between a namespace name and the keys inside it (and
 * between the segments of nested namespaces). Exposed so callers that
 * inspect the root store's `keys()` can split full keys back into segments.
 */
export const NAMESPACE_DELIMITER = ":";

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

  // One store-wide listener registry shared by every view. Sets keep
  // duplicate registrations idempotent and make off() O(1).
  const listeners = new Map<DriftStoreEvent, Set<DriftStoreListener>>();

  /**
   * Notify listeners for `event`. Listener exceptions are swallowed: an
   * observer must never be able to corrupt or abort a store operation.
   */
  function emit(event: DriftStoreEvent, payload: DriftStoreEventPayload): void {
    const registered = listeners.get(event);
    if (registered === undefined) return;
    for (const listener of registered) {
      try {
        listener(payload);
      } catch {
        // Deliberately ignored — see the contract on DriftStore.on().
      }
    }
  }

  // Rehydrate from disk before applying limits: loaded entries count toward
  // maxEntries exactly like freshly set ones, oldest-first.
  if (persistPath !== undefined) {
    const loaded = loadSnapshot<T>(persistPath);
    if (loaded !== undefined) {
      const now = Date.now();
      for (const [key, entry] of loaded) {
        if (isExpired(entry, now)) continue;
        entries.set(key, entry);
      }
      if (maxEntries !== undefined) evictDownTo(entries, maxEntries);
    }
  }

  /** Read an entry, reclaiming it if expired. Returns undefined on miss. */
  function readLiveEntry(key: string): Entry<T> | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (isExpired(entry, Date.now())) {
      entries.delete(key);
      emit("expire", { key });
      return undefined;
    }
    return entry;
  }

  /**
   * Remove every expired entry whose key starts with `prefix`; returns the
   * number removed. The empty prefix sweeps the whole store. Each reclaimed
   * entry emits `"expire"` (the loop is local rather than delegated to
   * expiry.ts precisely so reclamation stays observable).
   */
  function sweepPrefix(prefix: string): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of entries) {
      if ((prefix === "" || key.startsWith(prefix)) && isExpired(entry, now)) {
        entries.delete(key);
        emit("expire", { key });
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Build the store view for `prefix`. Every method operates on the shared
   * backing map with `prefix` prepended to caller keys; the root store is
   * simply `makeView("")`. Views are cheap closures — no per-view state.
   */
  function makeView(prefix: string): DriftStore<T> {
    return {
      get(key) {
        const fullKey = prefix + key;
        const entry = readLiveEntry(fullKey);
        if (entry === undefined) return undefined;
        // Refresh LRU recency: Map preserves insertion order, so delete +
        // re-set moves the key to the most-recently-used end.
        entries.delete(fullKey);
        entries.set(fullKey, entry);
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
        const fullKey = prefix + key;
        const existed = entries.delete(fullKey);
        entries.set(fullKey, entry);
        emit("set", { key: fullKey });

        // Capacity is a property of the whole store, not the view, so the
        // reclaim/evict pass always runs store-wide: a set in one namespace
        // may evict the LRU entry of another.
        if (maxEntries !== undefined && !existed && entries.size > maxEntries) {
          // Prefer reclaiming expired entries over evicting live ones.
          if (sweepPrefix("") === 0 || entries.size > maxEntries) {
            evictDownTo(entries, maxEntries, (evictedKey) =>
              emit("evict", { key: evictedKey }),
            );
          }
        }
      },

      has(key) {
        return readLiveEntry(prefix + key) !== undefined;
      },

      ttl(key) {
        const entry = readLiveEntry(prefix + key);
        if (entry?.expiresAt === undefined) return undefined;
        // readLiveEntry already dropped anything at or past expiry, so the
        // remainder is strictly positive here.
        return entry.expiresAt - Date.now();
      },

      touch(key, touchOptions?: SetOptions) {
        const fullKey = prefix + key;
        const entry = readLiveEntry(fullKey);
        if (entry === undefined) return false;
        const ttlMs = touchOptions?.ttlMs ?? defaultTtlMs;
        if (touchOptions?.ttlMs !== undefined) {
          assertValidTtl(touchOptions.ttlMs, "ttlMs");
        }
        // Without any TTL to apply the existing expiry (if any) is kept;
        // touch never turns an expiring entry into a permanent one.
        if (ttlMs !== undefined) entry.expiresAt = Date.now() + ttlMs;
        // Map preserves insertion order, so delete + re-set moves the key to
        // the most-recently-used end. No event: the value did not change.
        entries.delete(fullKey);
        entries.set(fullKey, entry);
        return true;
      },

      delete(key) {
        // An expired entry no longer exists as far as callers are concerned,
        // so deleting one reports `false` even though it frees the slot.
        const fullKey = prefix + key;
        const wasLive = readLiveEntry(fullKey) !== undefined;
        entries.delete(fullKey);
        if (wasLive) emit("delete", { key: fullKey });
        return wasLive;
      },

      clear() {
        if (prefix === "") {
          entries.clear();
          return;
        }
        for (const key of entries.keys()) {
          if (key.startsWith(prefix)) entries.delete(key);
        }
      },

      keys() {
        sweepPrefix(prefix);
        if (prefix === "") return [...entries.keys()];
        const scoped: string[] = [];
        for (const key of entries.keys()) {
          // Views report keys relative to their prefix, mirroring how the
          // caller wrote them.
          if (key.startsWith(prefix)) scoped.push(key.slice(prefix.length));
        }
        return scoped;
      },

      size() {
        sweepPrefix(prefix);
        if (prefix === "") return entries.size;
        let count = 0;
        for (const key of entries.keys()) {
          if (key.startsWith(prefix)) count += 1;
        }
        return count;
      },

      isEmpty() {
        sweepPrefix(prefix);
        if (prefix === "") return entries.size === 0;
        for (const key of entries.keys()) {
          if (key.startsWith(prefix)) return false;
        }
        return true;
      },

      sweep() {
        return sweepPrefix(prefix);
      },

      flush() {
        if (persistPath === undefined) {
          throw new Error(
            "driftkv: flush() requires the store to be created with persistPath",
          );
        }
        // Persistence is per-store, not per-view: a flush from any namespace
        // snapshots the whole backing map (with full, prefixed keys).
        sweepPrefix("");
        writeSnapshot(persistPath, [...entries.entries()]);
      },

      on(event, listener) {
        let registered = listeners.get(event);
        if (registered === undefined) {
          registered = new Set();
          listeners.set(event, registered);
        }
        registered.add(listener);
      },

      off(event, listener) {
        listeners.get(event)?.delete(listener);
      },

      namespace(name) {
        if (typeof name !== "string" || name.length === 0) {
          throw new TypeError(
            `driftkv: namespace name must be a non-empty string, got ${
              typeof name === "string" ? "an empty string" : typeof name
            }`,
          );
        }
        return makeView(prefix + name + NAMESPACE_DELIMITER);
      },
    };
  }

  return makeView("");
}

/**
 * Evict least-recently-used entries until the map holds at most `limit`.
 * `onEvict` (when provided) observes each removed key — used by the store
 * to emit `"evict"` events; load-time trimming passes nothing since no
 * listener can exist before `createStore` returns.
 */
function evictDownTo(
  entries: Map<string, unknown>,
  limit: number,
  onEvict?: (key: string) => void,
): void {
  while (entries.size > limit) {
    const oldest = entries.keys().next();
    if (oldest.done === true) break;
    entries.delete(oldest.value);
    onEvict?.(oldest.value);
  }
}
