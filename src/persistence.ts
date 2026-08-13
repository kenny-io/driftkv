/**
 * JSON persistence for Drift stores.
 *
 * The on-disk format is a versioned envelope so future releases can migrate
 * old snapshot files instead of rejecting them:
 *
 *   { "version": 1, "entries": [[key, { "value": ..., "expiresAt": ms? }], ...] }
 *
 * Entries are stored as an array of pairs (not an object) to preserve the
 * store's LRU ordering across a flush/load round trip. Writes go through a
 * temp file followed by `rename` so a crash mid-write never truncates an
 * existing snapshot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Internal shape of a single stored entry. */
export interface Entry<T> {
  value: T;
  /** Absolute epoch-ms deadline; `undefined` means the entry never expires. */
  expiresAt?: number;
}

interface SnapshotFile<T> {
  version: number;
  entries: Array<[string, Entry<T>]>;
}

/** Current snapshot format version. Bump when the envelope shape changes. */
export const SNAPSHOT_VERSION = 1;

/**
 * Load entries from `persistPath`. Returns `undefined` when the file does
 * not exist (a fresh store). Throws a descriptive error for unreadable or
 * malformed files — silently ignoring a corrupt snapshot would look like
 * data loss to the caller.
 */
export function loadSnapshot<T>(
  persistPath: string,
): Array<[string, Entry<T>]> | undefined {
  let raw: string;
  try {
    raw = readFileSync(persistPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `driftkv: persist file at "${persistPath}" is not valid JSON`,
    );
  }

  if (!isSnapshotFile(parsed)) {
    throw new Error(
      `driftkv: persist file at "${persistPath}" is not a Drift snapshot`,
    );
  }
  if (parsed.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `driftkv: persist file at "${persistPath}" has unsupported version ` +
        `${parsed.version} (expected ${SNAPSHOT_VERSION})`,
    );
  }

  return parsed.entries as Array<[string, Entry<T>]>;
}

/**
 * Atomically write `entries` to `persistPath`, creating parent directories
 * as needed. Values must be JSON-serializable; `JSON.stringify` failures
 * (e.g. circular references, BigInt) propagate to the caller.
 */
export function writeSnapshot<T>(
  persistPath: string,
  entries: Array<[string, Entry<T>]>,
): void {
  const snapshot: SnapshotFile<T> = { version: SNAPSHOT_VERSION, entries };
  const json = JSON.stringify(snapshot);

  mkdirSync(dirname(persistPath), { recursive: true });

  // Write-then-rename keeps the previous snapshot intact if the process
  // dies mid-write. The temp file lives in the same directory so the
  // rename stays on one filesystem (rename across devices is not atomic).
  const tmpPath = join(
    dirname(persistPath),
    `.drift-${process.pid}-${Date.now()}.tmp`,
  );
  writeFileSync(tmpPath, json, "utf8");
  renameSync(tmpPath, persistPath);
}

function isSnapshotFile(value: unknown): value is SnapshotFile<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["version"] === "number" &&
    Array.isArray(candidate["entries"]) &&
    candidate["entries"].every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "object" &&
        pair[1] !== null,
    )
  );
}
