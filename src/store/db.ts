/**
 * SQLite persistence.
 *
 * `kv` holds app configuration as JSON (provider profiles, selected model).
 * Sessions and messages land here in phase 5; credentials never do — they stay
 * in SecureStore.
 */
import * as SQLite from 'expo-sqlite';

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`;

let database: SQLite.SQLiteDatabase | null = null;

export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (database === null) {
    const opened = await SQLite.openDatabaseAsync('app.db');
    await opened.execAsync(SCHEMA);
    database = opened;
  }

  return database;
}

export async function getJson<T>(key: string): Promise<T | null> {
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
  const db = await getDatabase();
  await db.runAsync(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

export async function deleteKey(key: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
}
