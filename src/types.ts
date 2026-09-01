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
 * Lifecycle events a store emits. `"set"` fires after every write,
 * `"delete"` after an explicit `delete()` of a live entry, `"expire"` when
 * an expired entry is reclaimed (lazily on read or eagerly via `sweep()`),
 * and `"evict"` when the LRU policy removes an entry to satisfy
 * `maxEntries`. Bulk `clear()` deliberately emits nothing.
 */
export type DriftStoreEvent = "set" | "delete" | "expire" | "evict";

/**
 * Payload delivered to event listeners. `key` is always the full key as
 * stored in the root store — namespace prefixes included — so a single
 * listener can observe activity across every view.
 */
export interface DriftStoreEventPayload {
  key: string;
}

/** Listener registered with {@link DriftStore.on}. */
export type DriftStoreListener = (payload: DriftStoreEventPayload) => void;

/** Store-wide capacity and expiry counters returned by {@link DriftStore.stats}. */
export interface DriftStoreStats {
  /** Number of live entries across the whole backing store. */
  liveEntries: number;

  /** Number of live entries that currently have an expiry deadline. */
  expiringEntries: number;

  /** Configured capacity, or `undefined` when the store is unlimited. */
  maxEntries: number | undefined;

  /** Unused capacity, or `undefined` when the store is unlimited. */
  availableEntries: number | undefined;
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

  /** Return a live value without changing its LRU recency. */
  peek(key: string): T | undefined;

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

  /**
   * Remaining time-to-live for `key` in milliseconds, or `undefined` when
   * the entry is absent, expired, or has no expiry. Does not affect LRU
   * recency, so pollers can inspect freshness without pinning entries.
   */
  ttl(key: string): number | undefined;

  /**
   * Absolute Unix timestamp in milliseconds when `key` will expire, or
   * `undefined` when the entry is absent, expired, or has no expiry. Reading
   * the deadline does not affect LRU recency.
   */
  expiresAt(key: string): number | undefined;

  /**
   * Refresh a live entry's LRU recency without changing its value, and
   * restart its TTL from `options.ttlMs` or the store default when either is
   * set (an existing expiry is otherwise kept). Emits no event. Returns
   * `false` when `key` is absent or expired.
   */
  touch(key: string, options?: SetOptions): boolean;

  /** Remove the entry for `key`. Returns `true` if an entry was removed. */
  delete(key: string): boolean;

  /** Remove all entries. */
  clear(): void;

  /** All live keys, ordered from least- to most-recently-used. */
  keys(): string[];

  /** All live values, ordered from least- to most-recently-used. */
  values(): T[];

  /**
   * All live `[key, value]` pairs, ordered from least- to most-recently-used.
   * Keys are relative to the view, matching `keys()`. Reading does not affect
   * recency.
   */
  entries(): Array<[string, T]>;

  /** Number of live entries. */
  size(): number;

  /** Whether the store or namespace view contains no live entries. */
  isEmpty(): boolean;

  /**
   * Return store-wide capacity and expiry counters after reclaiming expired
   * entries. The snapshot does not change LRU recency. Because namespaces
   * share one backing store and one capacity budget, calling `stats()` on a
   * namespace returns the same store-wide snapshot as calling it on the root.
   */
  stats(): DriftStoreStats;

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
   *
   * Persistence is per-store: calling `flush()` on a namespace view writes
   * the entire store (all namespaces), not just the view's entries.
   */
  flush(): void;

  /**
   * Subscribe to a lifecycle event. Listeners are store-wide regardless of
   * which view they were registered on, fire synchronously in registration
   * order, and receive the full (prefixed) key. A listener that throws is
   * silently ignored so store operations can never fail because of an
   * observer. Registering the same listener twice for one event is a
   * no-op.
   */
  on(event: DriftStoreEvent, listener: DriftStoreListener): void;

  /**
   * Remove a listener previously registered with `on`. Unknown listeners
   * are ignored.
   */
  off(event: DriftStoreEvent, listener: DriftStoreListener): void;

  /**
   * Return a scoped view of this store. The view shares the store's data,
   * `maxEntries` budget, TTL default, and persistence, but every key is
   * transparently prefixed with `name` plus the `":"` delimiter, so views
   * with different names never see each other's entries.
   *
   * `keys()`, `size()`, `clear()`, and `sweep()` on a view are scoped to
   * the view's entries, and `keys()` reports keys relative to the view
   * (the prefix is stripped). Calling `namespace()` on a view nests: keys
   * of `store.namespace("a").namespace("b")` live under `"a:b:"`.
   *
   * `name` must be a non-empty string; otherwise a `TypeError` is thrown.
   */
  namespace(name: string): DriftNamespace<T>;
}

/**
 * A namespaced view of a {@link DriftStore}. Structurally identical to the
 * store itself — every method is available and behaves the same, scoped to
 * the namespace — so a `DriftNamespace<T>` can be passed anywhere a
 * `DriftStore<T>` is expected.
 */
export type DriftNamespace<T = unknown> = DriftStore<T>;
