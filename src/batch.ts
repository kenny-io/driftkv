/**
 * Atomic multi-key operations.
 *
 * A batch collects writes and applies them in one pass, so a caller never
 * observes half of a related set. Reads inside a transaction see the batch's
 * own pending writes, which is what makes read-modify-write sequences safe
 * without locking the whole store.
 */

import type { DriftStore, SetOptions } from "./types.js";

export type BatchOperation<T> =
  | { kind: "set"; key: string; value: T; options?: SetOptions }
  | { kind: "delete"; key: string };

export interface BatchResult {
  /** Keys written by this batch, in the order they were applied. */
  written: string[];
  /** Keys removed by this batch that held a live entry. */
  removed: string[];
}

export interface DriftBatch<T> {
  /** Queue a write. Overwrites an earlier queued write for the same key. */
  set(key: string, value: T, options?: SetOptions): DriftBatch<T>;
  /** Queue a removal. */
  delete(key: string): DriftBatch<T>;
  /** Number of queued operations. */
  size(): number;
  /** Apply every queued operation to the store, in order. */
  commit(): BatchResult;
}

/** Start a batch against `store`. Nothing is applied until `commit()`. */
export function createBatch<T>(store: DriftStore<T>): DriftBatch<T> {
  const operations: BatchOperation<T>[] = [];
  const batch: DriftBatch<T> = {
    set(key, value, options) {
      operations.push(
        options === undefined
          ? { kind: "set", key, value }
          : { kind: "set", key, value, options },
      );
      return batch;
    },
    delete(key) {
      operations.push({ kind: "delete", key });
      return batch;
    },
    size() {
      return operations.length;
    },
    commit() {
      const written: string[] = [];
      const removed: string[] = [];
      for (const operation of operations) {
        if (operation.kind === "set") {
          store.set(operation.key, operation.value, operation.options);
          written.push(operation.key);
          continue;
        }
        if (store.delete(operation.key)) removed.push(operation.key);
      }
      operations.length = 0;
      return { written, removed };
    },
  };
  return batch;
}

export interface TransactionContext<T> {
  /** Read a key, seeing this transaction's own pending writes first. */
  get(key: string): T | undefined;
  /** Queue a write inside the transaction. */
  set(key: string, value: T, options?: SetOptions): void;
  /** Queue a removal inside the transaction. */
  delete(key: string): void;
}

/**
 * Run `body` against a transaction context and commit its writes atomically.
 *
 * `body` throwing discards every queued write — nothing reaches the store —
 * which is what distinguishes a transaction from a plain batch. The return
 * value of `body` is passed through so a transaction can compute a result.
 */
export function transaction<T, R>(
  store: DriftStore<T>,
  body: (context: TransactionContext<T>) => R,
): R {
  const pending = new Map<string, { value: T; options?: SetOptions } | null>();
  const context: TransactionContext<T> = {
    get(key) {
      if (pending.has(key)) return pending.get(key)?.value;
      return store.get(key);
    },
    set(key, value, options) {
      pending.set(key, options === undefined ? { value } : { value, options });
    },
    delete(key) {
      pending.set(key, null);
    },
  };
  const result = body(context);
  for (const [key, entry] of pending) {
    if (entry === null) store.delete(key);
    else store.set(key, entry.value, entry.options);
  }
  return result;
}
