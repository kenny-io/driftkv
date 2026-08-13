/**
 * Test suite for namespaced store views.
 *
 * Namespaces are prefix views over one shared backing store, so the tests
 * exercise both sides of that contract: isolation between views, and the
 * store-wide behaviors (LRU budget, persistence) they deliberately share.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStore, NAMESPACE_DELIMITER } from "../src/index.js";

describe("namespace basics", () => {
  it("stores and retrieves values through a view", () => {
    const store = createStore<string>();
    const users = store.namespace("users");
    users.set("u1", "Ada");
    expect(users.get("u1")).toBe("Ada");
    expect(users.has("u1")).toBe(true);
  });

  it("prefixes keys in the underlying store", () => {
    const store = createStore<number>();
    store.namespace("users").set("u1", 1);
    expect(store.keys()).toEqual([`users${NAMESPACE_DELIMITER}u1`]);
    expect(store.get(`users${NAMESPACE_DELIMITER}u1`)).toBe(1);
  });

  it("delete() works through a view and reports liveness", () => {
    const store = createStore<number>();
    const ns = store.namespace("ns");
    ns.set("k", 1);
    expect(ns.delete("k")).toBe(true);
    expect(ns.delete("k")).toBe(false);
    expect(store.size()).toBe(0);
  });

  it("rejects invalid namespace names", () => {
    const store = createStore();
    expect(() => store.namespace("")).toThrow(TypeError);
    expect(() => store.namespace(42 as unknown as string)).toThrow(TypeError);
  });

  it("rejects non-string keys through a view", () => {
    const ns = createStore().namespace("ns");
    expect(() => ns.set(42 as unknown as string, "x")).toThrow(TypeError);
  });
});

describe("namespace isolation", () => {
  it("the same key in different namespaces holds different values", () => {
    const store = createStore<string>();
    const a = store.namespace("a");
    const b = store.namespace("b");
    a.set("k", "from-a");
    b.set("k", "from-b");
    expect(a.get("k")).toBe("from-a");
    expect(b.get("k")).toBe("from-b");
    expect(store.get("k")).toBeUndefined();
  });

  it("a namespace does not see root keys or sibling namespaces", () => {
    const store = createStore<number>();
    store.set("root", 0);
    store.namespace("other").set("k", 1);
    const ns = store.namespace("ns");
    expect(ns.has("root")).toBe(false);
    expect(ns.has("k")).toBe(false);
    expect(ns.keys()).toEqual([]);
    expect(ns.size()).toBe(0);
  });

  it("namespaces whose names share a prefix stay isolated", () => {
    const store = createStore<number>();
    store.namespace("a").set("x", 1);
    store.namespace("ab").set("x", 2);
    expect(store.namespace("a").keys()).toEqual(["x"]);
    expect(store.namespace("ab").keys()).toEqual(["x"]);
    expect(store.namespace("a").get("x")).toBe(1);
    expect(store.namespace("ab").get("x")).toBe(2);
  });

  it("two views of the same namespace share entries", () => {
    const store = createStore<number>();
    store.namespace("shared").set("k", 7);
    expect(store.namespace("shared").get("k")).toBe(7);
  });
});

describe("scoped keys(), size(), and clear()", () => {
  it("keys() reports only the view's keys, prefix stripped, in LRU order", () => {
    const store = createStore<number>();
    const ns = store.namespace("ns");
    store.set("root", 0);
    ns.set("a", 1);
    ns.set("b", 2);
    ns.get("a"); // "b" becomes the namespace's LRU
    expect(ns.keys()).toEqual(["b", "a"]);
    expect(ns.size()).toBe(2);
  });

  it("clear() empties only the namespace", () => {
    const store = createStore<number>();
    store.set("root", 0);
    store.namespace("keep").set("k", 1);
    const doomed = store.namespace("doomed");
    doomed.set("a", 1);
    doomed.set("b", 2);

    doomed.clear();

    expect(doomed.size()).toBe(0);
    expect(store.has("root")).toBe(true);
    expect(store.namespace("keep").has("k")).toBe(true);
    expect(store.size()).toBe(2);
  });

  it("clear() on the root store removes namespaced entries too", () => {
    const store = createStore<number>();
    store.namespace("ns").set("k", 1);
    store.clear();
    expect(store.namespace("ns").has("k")).toBe(false);
    expect(store.size()).toBe(0);
  });
});

describe("nested namespaces", () => {
  it("namespace() on a view nests under the parent prefix", () => {
    const store = createStore<string>();
    const inner = store.namespace("a").namespace("b");
    inner.set("k", "v");
    expect(inner.get("k")).toBe("v");
    expect(store.keys()).toEqual([
      `a${NAMESPACE_DELIMITER}b${NAMESPACE_DELIMITER}k`,
    ]);
  });

  it("a delimiter in the name is equivalent to nesting", () => {
    const store = createStore<string>();
    store.namespace(`a${NAMESPACE_DELIMITER}b`).set("k", "v");
    expect(store.namespace("a").namespace("b").get("k")).toBe("v");
  });

  it("parent views see nested entries; siblings do not", () => {
    const store = createStore<number>();
    const parent = store.namespace("a");
    parent.namespace("b").set("k", 1);
    expect(parent.keys()).toEqual([`b${NAMESPACE_DELIMITER}k`]);
    expect(parent.size()).toBe(1);
    expect(store.namespace("c").size()).toBe(0);
  });

  it("clear() on a parent namespace clears nested namespaces", () => {
    const store = createStore<number>();
    const parent = store.namespace("a");
    parent.namespace("b").set("k", 1);
    parent.set("direct", 2);
    parent.clear();
    expect(parent.size()).toBe(0);
    expect(parent.namespace("b").has("k")).toBe(false);
  });
});

describe("TTL in namespaces", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("entries expire inside a namespace", () => {
    const ns = createStore<string>().namespace("ns");
    ns.set("k", "v", { ttlMs: 100 });
    expect(ns.get("k")).toBe("v");
    vi.advanceTimersByTime(101);
    expect(ns.get("k")).toBeUndefined();
    expect(ns.has("k")).toBe(false);
  });

  it("the store's defaultTtlMs applies through views", () => {
    const store = createStore<string>({ defaultTtlMs: 50 });
    const ns = store.namespace("ns");
    ns.set("k", "v");
    vi.advanceTimersByTime(51);
    expect(ns.get("k")).toBeUndefined();
  });

  it("sweep() on a view only reclaims the view's expired entries", () => {
    const store = createStore<number>();
    const ns = store.namespace("ns");
    store.set("root-dead", 0, { ttlMs: 10 });
    ns.set("ns-dead", 1, { ttlMs: 10 });
    ns.set("ns-alive", 2);
    vi.advanceTimersByTime(11);

    expect(ns.sweep()).toBe(1); // only "ns-dead"
    expect(store.sweep()).toBe(1); // "root-dead" was left for the root sweep
    expect(ns.has("ns-alive")).toBe(true);
  });
});

describe("shared LRU budget", () => {
  it("maxEntries is enforced across namespaces, evicting the global LRU", () => {
    const store = createStore<number>({ maxEntries: 2 });
    const a = store.namespace("a");
    const b = store.namespace("b");
    a.set("k1", 1);
    a.set("k2", 2);
    b.set("k1", 3); // store-wide eviction: a's "k1" is the global LRU
    expect(a.has("k1")).toBe(false);
    expect(a.has("k2")).toBe(true);
    expect(b.has("k1")).toBe(true);
  });

  it("get() through a view refreshes global recency", () => {
    const store = createStore<number>({ maxEntries: 2 });
    const a = store.namespace("a");
    a.set("k1", 1);
    store.set("root", 2);
    a.get("k1"); // "root" is now the global LRU
    a.set("k2", 3); // evicts "root", not a:k1
    expect(a.has("k1")).toBe(true);
    expect(store.has("root")).toBe(false);
  });
});

describe("persistence with namespaces", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "driftkv-ns-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("namespaced entries survive a flush/load round trip", () => {
    const path = join(dir, "store.json");
    const a = createStore<string>({ persistPath: path });
    a.namespace("users").set("u1", "Ada");
    a.set("root", "r");
    a.flush();

    const b = createStore<string>({ persistPath: path });
    expect(b.namespace("users").get("u1")).toBe("Ada");
    expect(b.get("root")).toBe("r");
  });

  it("flush() on a view persists the whole store", () => {
    const path = join(dir, "store.json");
    const a = createStore<string>({ persistPath: path });
    a.set("root", "r");
    const ns = a.namespace("ns");
    ns.set("k", "v");
    ns.flush();

    const b = createStore<string>({ persistPath: path });
    expect(b.get("root")).toBe("r");
    expect(b.namespace("ns").get("k")).toBe("v");
  });

  it("flush() through a view still requires persistPath", () => {
    const ns = createStore().namespace("ns");
    expect(() => ns.flush()).toThrow(/persistPath/);
  });
});
