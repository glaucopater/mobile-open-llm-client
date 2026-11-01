/**
 * Persistence for non-secret app state: provider profiles and the selected model,
 * kept as JSON rows. Credentials never land here — they live in `core/keys.ts`.
 *
 * Native builds use expo-sqlite. The web build cannot, because its SQLite runs in a
 * WASM worker that Metro does not serve (`new URL('./worker', location.href)` resolves
 * to the app's own index.html) and the OPFS-backed VFS needs COOP/COEP headers the dev
 * server cannot add. Web therefore keeps the same key/value contract in localStorage,
 * with an in-memory fallback when storage is blocked (private mode, disabled cookies).
 */
import { Platform } from 'react-native';

import * as SQLite from 'expo-sqlite';

import { webStorage } from './webStorage';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transcript (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
`;

/** Namespace so web storage cannot collide with other apps on the same origin. */
const WEB_PREFIX = 'openllm.kv.';

let database: SQLite.SQLiteDatabase | null = null;

/** Rows that survive only for the current page when localStorage is unavailable. */
const memoryRows = new Map<string, string>();

/** Native-only database handle; the web build has no SQLite, so nothing calls this. */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (database === null) {
    const opened = await SQLite.openDatabaseAsync('app.db');
    await opened.execAsync(SCHEMA);
    database = opened;
  }

  return database;
}

export async function getJson<T>(key: string): Promise<T | null> {
  const storage = webStorage();

  if (storage !== null) {
    const raw = storage.getItem(WEB_PREFIX + key) ?? memoryRows.get(key);

    if (raw === undefined) {
      return null;
    }

    return JSON.parse(raw) as T;
  }

  if (Platform.OS === 'web') {
    const raw = memoryRows.get(key);

    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  const db = await getDatabase();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM kv WHERE key = ?',
    [key],
  );

  if (row === null) {
    return null;
  }

  return JSON.parse(row.value) as T;
}

export async function setJson(key: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  const storage = webStorage();

  if (Platform.OS === 'web') {
    memoryRows.set(key, encoded);

    if (storage !== null) {
      storage.setItem(WEB_PREFIX + key, encoded);
    }

    return;
  }

  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, encoded],
  );
}

export async function deleteKey(key: string): Promise<void> {
  const storage = webStorage();

  if (Platform.OS === 'web') {
    memoryRows.delete(key);

    if (storage !== null) {
      storage.removeItem(WEB_PREFIX + key);
    }

    return;
  }

  const db = await getDatabase();
  await db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
}
