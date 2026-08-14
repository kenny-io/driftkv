# Drift

**A zero-dependency embedded key-value store for Node.js.**

Drift is an in-process key-value store with TTL expiry, LRU eviction, and
optional JSON persistence — the storage layer you reach for when SQLite is
too much and a bare `Map` is too little. It ships fully typed, has **zero
runtime dependencies**, and the whole store is a single synchronous API you
can learn in two minutes.

Built and maintained by [Polaris Labs](https://github.com/kenny-io).

```ts
import { createStore } from "driftkv";

const cache = createStore<string>({ maxEntries: 1000, defaultTtlMs: 60_000 });

cache.set("session:9f2c", "alice");
cache.get("session:9f2c"); // "alice"
```

## Why Drift?

- **Zero dependencies.** Nothing in your lockfile but Drift itself.
- **TTL expiry.** Per-entry or store-wide time-to-live, checked lazily on
  read with an explicit `sweep()` for eager reclamation.
- **LRU eviction.** Cap the store with `maxEntries` and the
  least-recently-used entry is evicted first.
- **Namespaces.** Carve one store into isolated, scoped views with
  `store.namespace("users")` — no extra stores, no manual key prefixing.
- **Optional persistence.** Point the store at a JSON file and it reloads
  on startup; `flush()` writes atomically (write-then-rename) so a crash
  never corrupts an existing snapshot.
- **Fully typed.** `createStore<T>()` carries your value type through every
  method — no casts, no `any`.
- **Synchronous and embedded.** No server, no sockets, no async ceremony.

## Install

```bash
npm install driftkv
```

Requires Node.js 18 or later. ESM only.

## Quickstart

```ts
import { createStore } from "driftkv";

interface User {
  id: number;
  name: string;
}

const users = createStore<User>({
  maxEntries: 500, // LRU-evict beyond 500 entries
  defaultTtlMs: 5 * 60_000, // entries live 5 minutes by default
  persistPath: "./data/users.json", // reload on startup, write on flush()
});

users.set("u:1", { id: 1, name: "Ada" });
users.set("u:2", { id: 2, name: "Grace" }, { ttlMs: 30_000 }); // custom TTL

users.get("u:1"); // { id: 1, name: "Ada" }
users.has("u:2"); // true
users.keys(); // ["u:1", "u:2"]  (least- to most-recently-used)
users.size(); // 2

users.flush(); // persist current entries to ./data/users.json
```

On the next process start, `createStore` with the same `persistPath` loads
the snapshot back, dropping any entries whose TTL elapsed while the process
was down.

## API reference

### `createStore<T>(options?): DriftStore<T>`

Creates a store instance. `T` is the value type (defaults to `unknown`).
Invalid options throw a `TypeError` immediately, so misconfiguration fails
at startup rather than at first use.

#### Options

| Option         | Type     | Default   | Description                                                                                                                                       |
| -------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxEntries`   | `number` | unlimited | Maximum live entries. When a `set` would exceed it, the least-recently-used entry is evicted. Must be a positive integer.                          |
| `defaultTtlMs` | `number` | none      | Time-to-live in milliseconds applied to every `set` that does not pass its own `ttlMs`. Must be positive. Without it, entries never expire.        |
| `persistPath`  | `string` | none      | Path to a JSON snapshot file. Existing entries load on creation (expired ones are dropped, `maxEntries` is enforced); `flush()` writes back to it. |

### Store methods

| Method                      | Returns          | Description                                                                                                        |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get(key)`                  | `T \| undefined` | Value for `key`, or `undefined` if absent or expired. A hit marks the entry most-recently-used.                     |
| `set(key, value, options?)` | `void`           | Store `value` under `key`. Overwrites refresh both the TTL and LRU recency. May evict when `maxEntries` is reached. |
| `has(key)`                  | `boolean`        | Whether a live entry exists. Does **not** affect LRU recency.                                                       |
| `delete(key)`               | `boolean`        | Remove the entry. `true` if a live entry was removed.                                                               |
| `clear()`                   | `void`           | Remove all entries.                                                                                                 |
| `keys()`                    | `string[]`       | Live keys, ordered least- to most-recently-used.                                                                    |
| `size()`                    | `number`         | Count of live entries.                                                                                              |
| `sweep()`                   | `number`         | Eagerly remove every expired entry; returns how many were removed.                                                  |
| `flush()`                   | `void`           | Synchronously persist current entries to `persistPath`. Throws if the store has no `persistPath`.                   |
| `namespace(name)`           | `DriftNamespace<T>` | A scoped view of the store whose keys are isolated under `name`. See [Namespaces](#namespaces).                  |

#### `set` options

| Option  | Type     | Default        | Description                                                     |
| ------- | -------- | -------------- | --------------------------------------------------------------- |
| `ttlMs` | `number` | `defaultTtlMs` | Time-to-live for this entry, overriding the store-wide default. |

### Namespaces

`store.namespace(name)` returns a **scoped view** of the same store. The
view has the full store API — same methods, same types — but every key is
transparently prefixed with `name` plus the `":"` delimiter, so views with
different names never see each other's entries:

```ts
import { createStore } from "driftkv";

const store = createStore<string>({ maxEntries: 1000 });

const users = store.namespace("users");
const sessions = store.namespace("sessions");

users.set("42", "Ada");
sessions.set("42", "9f2c…"); // no collision with users' "42"

users.get("42"); // "Ada"
users.keys(); // ["42"] — relative to the namespace, prefix stripped
users.size(); // 1
sessions.clear(); // removes only sessions' entries
```

Namespaces nest — call `namespace()` on a view to scope further:

```ts
const euUsers = store.namespace("users").namespace("eu");
euUsers.set("42", "Grace"); // stored under "users:eu:42"
```

A `":"` inside a name is equivalent to nesting: `store.namespace("users:eu")`
and `store.namespace("users").namespace("eu")` address the same entries.

Semantics worth knowing:

- **Views are windows, not copies.** A namespace is a cheap wrapper around
  the parent store; two views with the same name see the same entries, and
  no state is allocated per view.
- **Scoped methods.** `keys()`, `size()`, `clear()`, and `sweep()` operate
  only on the view's entries, and `keys()` returns keys relative to the
  view. A parent view (including the root store) sees nested entries under
  their full prefixed keys.
- **Shared budget.** `maxEntries`, `defaultTtlMs`, and LRU order belong to
  the store, not the view — a `set` in one namespace may evict the
  least-recently-used entry of another.
- **Shared persistence.** `flush()` on any view writes the **entire**
  store, and prefixed keys round-trip through snapshots unchanged.
- **Plain prefixing.** Keys are prefixed with `name + ":"`, nothing more.
  A root-level `store.set("users:42", …)` is therefore visible as `"42"`
  inside `store.namespace("users")` — namespaces are a convention over key
  strings, not a separate keyspace.

The delimiter is exported as `NAMESPACE_DELIMITER`, and the view type as
`DriftNamespace<T>` (structurally identical to `DriftStore<T>`, so views
can be passed anywhere a store is expected).

### TTL semantics

Expiry is **lazy**: an expired entry may occupy memory until a read touches
it, `sweep()` runs, or eviction reclaims it — but it is never observable
through the API. `get` returns `undefined`, `has` returns `false`, and
`keys()`/`size()` exclude expired entries. Long-lived stores that rely on
TTLs should call `sweep()` on an interval to bound memory:

```ts
const store = createStore({ defaultTtlMs: 60_000 });
setInterval(() => store.sweep(), 30_000).unref();
```

### LRU semantics

When `maxEntries` is set and a `set` of a **new** key would exceed it, Drift
first reclaims expired entries; only if the store is still over the limit
does it evict the least-recently-used live entry. `get` and `set` refresh an
entry's recency; `has` deliberately does not, so existence checks never
perturb eviction order.

### Persistence

- `flush()` sweeps expired entries first, so they are never written to disk.
- Writes are atomic: Drift writes a temp file in the same directory and
  renames it over the snapshot, so a crash mid-flush leaves the previous
  snapshot intact. Parent directories are created as needed.
- Snapshots preserve LRU order and absolute expiry deadlines, so remaining
  TTL survives a restart.
- Values must be JSON-serializable (`JSON.stringify` failures propagate).
  Note that JSON round-trips lose identity for types like `Date`, `Map`, or
  `undefined` values inside objects.
- A corrupt or unrecognized snapshot file makes `createStore` throw a
  descriptive error rather than silently starting empty.

### Errors

| Condition                                                | Error                          |
| -------------------------------------------------------- | ------------------------------ |
| Non-positive / non-integer `maxEntries`                   | `TypeError` at `createStore`   |
| Non-positive `defaultTtlMs` or `ttlMs`                    | `TypeError`                    |
| Non-string key passed to `set`                            | `TypeError`                    |
| Empty or non-string name passed to `namespace`            | `TypeError`                    |
| `flush()` without `persistPath`                           | `Error`                        |
| Corrupt / non-snapshot / wrong-version persist file       | `Error` at `createStore`       |

## Development

```bash
npm install
npm run build   # compile to dist/ with tsc
npm test        # run the vitest suite
```

## License

[MIT](./LICENSE) © Polaris Labs
