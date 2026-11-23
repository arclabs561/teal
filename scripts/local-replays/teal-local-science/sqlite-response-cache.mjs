import { DatabaseSync } from "node:sqlite";

const namespace = "musicbrainz-success-v2";

export function openResponseCache(path) {
  const database = new DatabaseSync(path, { timeout: 5000 });
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_responses (
        namespace TEXT NOT NULL,
        request_key TEXT NOT NULL,
        results TEXT NOT NULL,
        PRIMARY KEY (namespace, request_key)
      ) STRICT
    `);
    const select = database.prepare(`
      SELECT results FROM evaluation_responses WHERE namespace = ? AND request_key = ?
    `);
    const upsert = database.prepare(`
      INSERT INTO evaluation_responses (namespace, request_key, results) VALUES (?, ?, ?)
      ON CONFLICT (namespace, request_key) DO UPDATE SET results = excluded.results
    `);
    return {
      get(key) {
        const row = select.get(namespace, key);
        return row && JSON.parse(row.results);
      },
      set(key, items) {
        upsert.run(namespace, key, JSON.stringify(items));
      },
      close() {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
