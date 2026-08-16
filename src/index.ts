/**
 * Drift — a zero-dependency embedded key-value store for Node.js.
 *
 * Public entry point. See README.md for the full API reference.
 */

export { createStore, NAMESPACE_DELIMITER } from "./store.js";
export { createBatch, transaction } from "./batch.js";
export type {
  BatchOperation,
  BatchResult,
  DriftBatch,
  TransactionContext,
} from "./batch.js";
export type {
  DriftNamespace,
  DriftStore,
  DriftStoreEvent,
  DriftStoreEventPayload,
  DriftStoreListener,
  DriftStoreOptions,
  SetOptions,
} from "./types.js";
