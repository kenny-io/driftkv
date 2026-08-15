/**
 * Test suite for the Drift store.
 *
 * TTL tests use vitest's fake timers (Date.now is mocked) so expiry is
 * deterministic — no real sleeping.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStore } from "../src/index.js";

describe("basic operations", () => {
  it("stores and retrieves values", () => {
    const store = createStore<string>();
    store.set("greeting", "hello");
    expect(store.get("greeting")).toBe("hello");
  });

  it("returns undefined for missing keys", () => {
    const store = createStore();
    expect(store.get("nope")).toBeUndefined();
  });

  it("overwrites existing keys", () => {
    const store = createStore<number>();
    store.set("n", 1);
    store.set("n", 2);
    expect(store.get("n")).toBe(2);
    expect(store.size()).toBe(1);
  });

  it("has() reports live entries", () => {
    const store = createStore();
    store.set("a", 1);
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
  });

  it("delete() removes entries and reports whether one existed", () => {
    const store = createStore();
    store.set("a", 1);
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.has("a")).toBe(false);
  });

  it("clear() empties the store", () => {
    const store = createStore();
    store.set("a", 1);
    store.set("b", 2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it("keys() and size() reflect contents", () => {
    const store = createStore();
    store.set("a", 1);
    store.set("b", 2);
    expect(store.keys()).toEqual(["a", "b"]);
    expect(store.size()).toBe(2);
  });

  it("stores falsy and complex values faithfully", () => {
    const store = createStore<unknown>();
    store.set("zero", 0);
    store.set("empty", "");
    store.set("false", false);
    store.set("null", null);
    store.set("obj", { nested: [1, 2, 3] });
    expect(store.get("zero")).toBe(0);
    expect(store.get("empty")).toBe("");
    expect(store.get("false")).toBe(false);
    expect(store.get("null")).toBeNull();
    expect(store.get("obj")).toEqual({ nested: [1, 2, 3] });
    expect(store.has("null")).toBe(true);
  });

  it("rejects non-string keys at runtime", () => {
    const store = createStore();
    expect(() => store.set(42 as unknown as string, "x")).toThrow(TypeError);
  });
});

describe("generics", () => {
  it("preserves the value type through get", () => {
    interface User {
      id: number;
      name: string;
    }
    const store = createStore<User>();
    store.set("u1", { id: 1, name: "Ada" });
    const user = store.get("u1");
    // Type-level check: `user` is User | undefined.
    expect(user?.name).toBe("Ada");
  });
});

describe("TTL expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires entries after ttlMs", () => {
    const store = createStore<string>();
    store.set("k", "v", { ttlMs: 1000 });
    expect(store.get("k")).toBe("v");
    vi.advanceTimersByTime(1001);
    expect(store.get("k")).toBeUndefined();
    expect(store.has("k")).toBe(false);
  });

  it("reports remaining ttl without touching recency", () => {
    const store = createStore<string>({ maxEntries: 2 });
    store.set("a", "1", { ttlMs: 1000 });
    store.set("b", "2");
    vi.advanceTimersByTime(400);
    expect(store.ttl("a")).toBe(600);
    expect(store.ttl("b")).toBeUndefined();
    expect(store.ttl("missing")).toBeUndefined();
    // Inspecting "a" must not make it most-recently-used: the next insert
    // evicts "a", not "b".
    store.set("c", "3");
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    vi.advanceTimersByTime(601);
    expect(store.ttl("a")).toBeUndefined();
  });

  it("touch() refreshes ttl and recency without changing the value", () => {
    const store = createStore<string>({ maxEntries: 2 });
    store.set("a", "1", { ttlMs: 1000 });
    store.set("b", "2");
    vi.advanceTimersByTime(800);
    expect(store.touch("a")).toBe(true);
    // No TTL supplied and no store default: the original expiry stands.
    expect(store.ttl("a")).toBe(200);
    expect(store.touch("a", { ttlMs: 1000 })).toBe(true);
    expect(store.ttl("a")).toBe(1000);
    expect(store.get("a")).toBe("1");
    // "a" is now most-recently-used, so the next insert evicts "b".
    store.set("c", "3");
    expect(store.has("b")).toBe(false);
    expect(store.touch("missing")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(store.touch("a")).toBe(false);
  });

  it("applies defaultTtlMs when set() passes no ttl", () => {
    const store = createStore<string>({ defaultTtlMs: 500 });
    store.set("k", "v");
    vi.advanceTimersByTime(501);
    expect(store.get("k")).toBeUndefined();
  });

  it("per-call ttlMs overrides defaultTtlMs", () => {
    const store = createStore<string>({ defaultTtlMs: 100 });
    store.set("long", "v", { ttlMs: 10_000 });
    vi.advanceTimersByTime(5000);
    expect(store.get("long")).toBe("v");
  });

  it("expired entries vanish from keys() and size()", () => {
    const store = createStore();
    store.set("short", 1, { ttlMs: 10 });
    store.set("forever", 2);
    vi.advanceTimersByTime(11);
    expect(store.keys()).toEqual(["forever"]);
    expect(store.size()).toBe(1);
  });

  it("delete() on an expired entry returns false", () => {
    const store = createStore();
    store.set("k", 1, { ttlMs: 10 });
    vi.advanceTimersByTime(11);
    expect(store.delete("k")).toBe(false);
  });

  it("overwriting an entry resets its TTL", () => {
    const store = createStore<string>();
    store.set("k", "v1", { ttlMs: 100 });
    vi.advanceTimersByTime(90);
    store.set("k", "v2", { ttlMs: 100 });
    vi.advanceTimersByTime(90);
    expect(store.get("k")).toBe("v2");
  });

  it("sweep() removes expired entries and returns the count", () => {
    const store = createStore();
    store.set("a", 1, { ttlMs: 10 });
    store.set("b", 2, { ttlMs: 10 });
    store.set("c", 3);
    vi.advanceTimersByTime(11);
    expect(store.sweep()).toBe(2);
    expect(store.sweep()).toBe(0);
    expect(store.keys()).toEqual(["c"]);
  });

  it("rejects invalid TTLs", () => {
    const store = createStore();
    expect(() => store.set("k", 1, { ttlMs: 0 })).toThrow(TypeError);
    expect(() => store.set("k", 1, { ttlMs: -5 })).toThrow(TypeError);
    expect(() => store.set("k", 1, { ttlMs: Number.NaN })).toThrow(TypeError);
    expect(() => createStore({ defaultTtlMs: -1 })).toThrow(TypeError);
  });
});

describe("LRU eviction", () => {
  it("evicts the least-recently-used entry when maxEntries is exceeded", () => {
    const store = createStore<number>({ maxEntries: 2 });
    store.set("a", 1);
    store.set("b", 2);
    store.set("c", 3); // evicts "a"
    expect(store.has("a")).toBe(false);
    expect(store.keys()).toEqual(["b", "c"]);
  });

  it("get() refreshes recency", () => {
    const store = createStore<number>({ maxEntries: 2 });
    store.set("a", 1);
    store.set("b", 2);
    store.get("a"); // "b" is now LRU
    store.set("c", 3); // evicts "b"
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
  });

  it("set() on an existing key refreshes recency without evicting", () => {
    const store = createStore<number>({ maxEntries: 2 });
    store.set("a", 1);
    store.set("b", 2);
    store.set("a", 10); // overwrite, no eviction; "b" is now LRU
    expect(store.size()).toBe(2);
    store.set("c", 3); // evicts "b"
    expect(store.keys()).toEqual(["a", "c"]);
  });

  it("has() does not refresh recency", () => {
    const store = createStore<number>({ maxEntries: 2 });
    store.set("a", 1);
    store.set("b", 2);
    store.has("a"); // must NOT rescue "a" from eviction
    store.set("c", 3); // evicts "a"
    expect(store.has("a")).toBe(false);
  });

  it("prefers reclaiming expired entries over evicting live ones", () => {
    vi.useFakeTimers();
    try {
      const store = createStore<number>({ maxEntries: 2 });
      store.set("dead", 1, { ttlMs: 10 });
      store.set("live", 2);
      vi.advanceTimersByTime(11);
      store.set("new", 3); // reclaims "dead" instead of evicting "live"
      expect(store.has("live")).toBe(true);
      expect(store.has("new")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("works with maxEntries of 1", () => {
    const store = createStore<number>({ maxEntries: 1 });
    store.set("a", 1);
    store.set("b", 2);
    expect(store.keys()).toEqual(["b"]);
  });

  it("rejects invalid maxEntries", () => {
    expect(() => createStore({ maxEntries: 0 })).toThrow(TypeError);
    expect(() => createStore({ maxEntries: -3 })).toThrow(TypeError);
    expect(() => createStore({ maxEntries: 1.5 })).toThrow(TypeError);
  });
});

describe("persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driftkv-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flush() writes and a new store loads the data back", () => {
    const path = join(dir, "store.json");
    const a = createStore<string>({ persistPath: path });
    a.set("k1", "v1");
    a.set("k2", "v2");
    a.flush();

    const b = createStore<string>({ persistPath: path });
    expect(b.get("k1")).toBe("v1");
    expect(b.get("k2")).toBe("v2");
    expect(b.size()).toBe(2);
  });

  it("starts empty when the persist file does not exist", () => {
    const store = createStore({ persistPath: join(dir, "missing.json") });
    expect(store.size()).toBe(0);
  });

  it("creates missing parent directories on flush", () => {
    const path = join(dir, "deeply", "nested", "store.json");
    const store = createStore<number>({ persistPath: path });
    store.set("n", 42);
    store.flush();
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("drops expired entries on load and never persists them", () => {
    vi.useFakeTimers();
    try {
      const path = join(dir, "store.json");
      const a = createStore<string>({ persistPath: path });
      a.set("dead", "x", { ttlMs: 10 });
      a.set("alive", "y");
      a.flush(); // both persisted; "dead" not yet expired

      vi.advanceTimersByTime(11);
      const b = createStore<string>({ persistPath: path });
      expect(b.has("dead")).toBe(false);
      expect(b.get("alive")).toBe("y");

      b.flush(); // expired entry must not survive a re-flush
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.entries.map((e: [string, unknown]) => e[0])).toEqual([
        "alive",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves remaining TTL across a flush/load round trip", () => {
    vi.useFakeTimers();
    try {
      const path = join(dir, "store.json");
      const a = createStore<string>({ persistPath: path });
      a.set("k", "v", { ttlMs: 1000 });
      a.flush();

      vi.advanceTimersByTime(500);
      const b = createStore<string>({ persistPath: path });
      expect(b.get("k")).toBe("v");
      vi.advanceTimersByTime(501);
      expect(b.get("k")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves LRU order across a round trip", () => {
    const path = join(dir, "store.json");
    const a = createStore<number>({ persistPath: path });
    a.set("a", 1);
    a.set("b", 2);
    a.get("a"); // "b" becomes LRU
    a.flush();

    const b = createStore<number>({ persistPath: path, maxEntries: 2 });
    b.set("c", 3); // must evict "b", the loaded LRU
    expect(b.has("a")).toBe(true);
    expect(b.has("b")).toBe(false);
  });

  it("respects maxEntries when loading a larger snapshot", () => {
    const path = join(dir, "store.json");
    const a = createStore<number>({ persistPath: path });
    a.set("a", 1);
    a.set("b", 2);
    a.set("c", 3);
    a.flush();

    const b = createStore<number>({ persistPath: path, maxEntries: 2 });
    expect(b.size()).toBe(2);
    expect(b.keys()).toEqual(["b", "c"]); // oldest loaded entry evicted
  });

  it("flush() throws without persistPath", () => {
    const store = createStore();
    expect(() => store.flush()).toThrow(/persistPath/);
  });

  it("throws a descriptive error for corrupt persist files", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    expect(() => createStore({ persistPath: path })).toThrow(/not valid JSON/);

    writeFileSync(path, JSON.stringify({ hello: "world" }), "utf8");
    expect(() => createStore({ persistPath: path })).toThrow(
      /not a Drift snapshot/,
    );

    writeFileSync(
      path,
      JSON.stringify({ version: 99, entries: [] }),
      "utf8",
    );
    expect(() => createStore({ persistPath: path })).toThrow(
      /unsupported version/,
    );
  });

  it("rejects an empty persistPath", () => {
    expect(() => createStore({ persistPath: "" })).toThrow(TypeError);
  });
});
