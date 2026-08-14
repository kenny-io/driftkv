/**
 * Event listener tests: store-wide registration, per-event delivery,
 * error-swallowing, off(), and namespace-view behavior.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../src/store.js";
import type { DriftStoreEventPayload } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("store events", () => {
  it("emits set on every write with the full key", () => {
    const store = createStore<number>();
    const seen: string[] = [];
    store.on("set", ({ key }) => seen.push(key));
    store.set("a", 1);
    store.set("a", 2);
    store.namespace("users").set("u1", 3);
    expect(seen).toEqual(["a", "a", "users:u1"]);
  });

  it("emits delete only for live entries", () => {
    const store = createStore<number>();
    const seen: string[] = [];
    store.on("delete", ({ key }) => seen.push(key));
    store.set("a", 1);
    store.delete("a");
    store.delete("missing");
    expect(seen).toEqual(["a"]);
  });

  it("emits expire on lazy reclamation and eager sweep", () => {
    vi.useFakeTimers();
    const store = createStore<number>();
    const seen: string[] = [];
    store.on("expire", ({ key }) => seen.push(key));
    store.set("lazy", 1, { ttlMs: 10 });
    store.set("swept", 2, { ttlMs: 10 });
    vi.advanceTimersByTime(20);
    expect(store.get("lazy")).toBeUndefined();
    expect(seen).toEqual(["lazy"]);
    store.sweep();
    expect(seen).toEqual(["lazy", "swept"]);
  });

  it("emits evict when maxEntries forces LRU removal", () => {
    const store = createStore<number>({ maxEntries: 2 });
    const seen: string[] = [];
    store.on("evict", ({ key }) => seen.push(key));
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3);
    expect(seen).toEqual(["a"]);
    expect(store.keys()).toEqual(["b", "c"]);
  });

  it("clear emits nothing by contract", () => {
    const store = createStore<number>();
    const listener = vi.fn();
    store.on("delete", listener);
    store.set("a", 1);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it("swallows listener errors and still notifies later listeners", () => {
    const store = createStore<number>();
    const seen: string[] = [];
    store.on("set", () => {
      throw new Error("observer bug");
    });
    store.on("set", ({ key }) => seen.push(key));
    expect(() => store.set("a", 1)).not.toThrow();
    expect(seen).toEqual(["a"]);
    expect(store.get("a")).toBe(1);
  });

  it("off removes a listener; duplicate on is idempotent", () => {
    const store = createStore<number>();
    const payloads: DriftStoreEventPayload[] = [];
    const listener = (payload: DriftStoreEventPayload) => payloads.push(payload);
    store.on("set", listener);
    store.on("set", listener);
    store.set("a", 1);
    expect(payloads).toHaveLength(1);
    store.off("set", listener);
    store.set("b", 2);
    expect(payloads).toHaveLength(1);
    expect(() => store.off("set", listener)).not.toThrow();
  });

  it("listeners registered on a view observe store-wide activity", () => {
    const store = createStore<number>();
    const view = store.namespace("jobs");
    const seen: string[] = [];
    view.on("set", ({ key }) => seen.push(key));
    store.set("root", 1);
    view.set("j1", 2);
    expect(seen).toEqual(["root", "jobs:j1"]);
  });
});
