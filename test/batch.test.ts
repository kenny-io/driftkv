/**
 * Batch and transaction tests.
 */

import { describe, expect, it } from "vitest";

import { createBatch, createStore, transaction } from "../src/index.js";

describe("createBatch", () => {
  it("applies queued writes and removals in order on commit", () => {
    const store = createStore<string>();
    store.set("stale", "old");
    const batch = createBatch(store)
      .set("a", "1")
      .set("b", "2")
      .delete("stale")
      .delete("never-existed");

    expect(batch.size()).toBe(4);
    expect(store.get("a")).toBeUndefined();

    const result = batch.commit();

    expect(result.written).toEqual(["a", "b"]);
    expect(result.removed).toEqual(["stale"]);
    expect(store.get("a")).toBe("1");
    expect(store.has("stale")).toBe(false);
    expect(batch.size()).toBe(0);
  });

  it("carries set options through to the store", () => {
    const store = createStore<string>();
    createBatch(store).set("temp", "v", { ttlMs: 5_000 }).commit();
    expect(store.ttl("temp")).toBeGreaterThan(0);
  });
});

describe("transaction", () => {
  it("reads its own pending writes and commits them together", () => {
    const store = createStore<number>();
    store.set("counter", 1);

    const next = transaction(store, (tx) => {
      const current = tx.get("counter") ?? 0;
      tx.set("counter", current + 1);
      // The transaction sees its own write, not the store's stale value.
      return tx.get("counter");
    });

    expect(next).toBe(2);
    expect(store.get("counter")).toBe(2);
  });

  it("discards every write when the body throws", () => {
    const store = createStore<string>();
    store.set("keep", "original");

    expect(() =>
      transaction(store, (tx) => {
        tx.set("keep", "changed");
        tx.set("added", "new");
        throw new Error("rollback");
      }),
    ).toThrow("rollback");

    expect(store.get("keep")).toBe("original");
    expect(store.has("added")).toBe(false);
  });

  it("applies deletes queued inside the transaction", () => {
    const store = createStore<string>();
    store.set("gone", "value");
    transaction(store, (tx) => {
      tx.delete("gone");
      expect(tx.get("gone")).toBeUndefined();
    });
    expect(store.has("gone")).toBe(false);
  });
});
