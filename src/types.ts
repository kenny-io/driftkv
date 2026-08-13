/**
 * Public type surface for Drift.
 *
 * Everything here is part of the semver contract. The store implementation
 * lives in `store.ts`; this module deliberately contains no runtime code so
 * that consumers can import types without pulling in Node built-ins.
 */

/** Options accepted by {@link createStore}. All fields are optional. */
export interface DriftStoreOptions {
  /**
   * Maximum number of live entries the store may hold. When a `set` would
   * exceed this limit, the least-recently-used entry is evicted first.
   * Must be a positive integer. Unlimited when omitted.
   */
  maxEntries?: number;

  /**
   * Default time-to-live in milliseconds applied to every `set` that does
   * not pass its own `ttlMs`. Must be a positive number. Entries never
   * expire when omitted.
   */
  defaultTtlMs?: number;

  /**
   * Path to a JSON file used for persistence. When provided, the store
   * loads existing entries from this file on creation (expired entries are
   * dropped), and `flush()` writes the current contents back to it.
   */
  persistPath?: string;
}

/** Per-call options for {@link DriftStore.set}. */
export interface SetOptions {
  /**
   * Time-to-live for this entry in milliseconds, overriding the store's
   * `defaultTtlMs`. Must be a positive number.
   */
  ttlMs?: number;
}

/**
 * A Drift store instance. `T` is the value type held by the store; it
 * defaults to `unknown` so untyped usage stays honest.
 */
export interface DriftStore<T = unknown> {
  /**
   * Return the value for `key`, or `undefined` if absent or expired.
   * A hit marks the entry as most-recently-used for LRU purposes.
   */
  get(key: string): T | undefined;

  /**
   * Store `value` under `key`. Overwrites any existing entry and marks the
   * key as most-recently-used. May evict the LRU entry when `maxEntries`
   * would be exceeded.
   */
  set(key: string, value: T, options?: SetOptions): void;

  /**
   * Whether a live (non-expired) entry exists for `key`. Does not affect
   * LRU recency.
   */
  has(key: string): boolean;

  /** Remove the entry for `key`. Returns `true` if an entry was removed. */
  delete(key: string): boolean;

  /** Remove all entries. */
  clear(): void;

  /** All live keys, ordered from least- to most-recently-used. */
  keys(): string[];

  /** Number of live entries. */
  size(): number;

  /**
   * Eagerly remove every expired entry and return how many were removed.
   * Expiry is otherwise lazy (checked on read), so long-lived stores with
   * TTLs should call this periodically to reclaim memory.
   */
  sweep(): number;

  /**
   * Synchronously write the current entries to `persistPath` as JSON.
   * Expired entries are swept first so they are never persisted.
   * Throws if the store was created without `persistPath`.
   */
  flush(): void;
}
