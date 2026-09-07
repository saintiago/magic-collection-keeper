import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateEntry } from "./domain/inventory.js";

export function openDatabase(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS card_identities (
      oracle_id TEXT PRIMARY KEY, name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS printings (
      id TEXT PRIMARY KEY, oracle_id TEXT REFERENCES card_identities(oracle_id),
      set_code TEXT NOT NULL, collector_number TEXT NOT NULL, language TEXT NOT NULL,
      data TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS printing_lookup ON printings(set_code, collector_number, language);
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY, printing_id TEXT NOT NULL REFERENCES printings(id),
      language TEXT NOT NULL, condition TEXT NOT NULL CHECK(condition IN ('NM','LP','MP','HP','DMG')),
      finish TEXT NOT NULL CHECK(finish IN ('nonfoil','foil','etched')),
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(printing_id, language, condition, finish)
    );
    CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL, timestamp INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, input TEXT NOT NULL);
    `);
  if (db.prepare("PRAGMA user_version").get().user_version < 1)
    db.exec("PRAGMA user_version=1;");
  return db;
}

export function savePrinting(db, card) {
  if (card.oracle_id)
    db.prepare(
      "INSERT INTO card_identities VALUES (?,?) ON CONFLICT(oracle_id) DO UPDATE SET name=excluded.name",
    ).run(card.oracle_id, card.name);
  db.prepare(
    `INSERT INTO printings VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, fetched_at=excluded.fetched_at`,
  ).run(
    card.id,
    card.oracle_id ?? null,
    card.set,
    card.collector_number,
    card.lang,
    JSON.stringify(card),
    new Date().toISOString(),
  );
}

export function collection(db) {
  return db
    .prepare(
      "SELECT i.*, p.data FROM inventory i JOIN printings p ON p.id=i.printing_id ORDER BY i.updated_at DESC, i.id DESC",
    )
    .all()
    .map(({ data, ...row }) => ({ ...row, card: JSON.parse(data) }));
}

export function addInventory(db, input) {
  const printing = db
    .prepare("SELECT data FROM printings WHERE id=?")
    .get(input.printing_id);
  if (!printing) throw new Error("Search for and select a printing first.");
  const card = JSON.parse(printing.data);
  validateEntry(input, card);
  const existing = db
    .prepare(
      "SELECT quantity FROM inventory WHERE printing_id=? AND language=? AND condition=? AND finish=?",
    )
    .get(card.id, card.lang, input.condition, input.finish);
  if ((existing?.quantity ?? 0) + input.quantity > 100000)
    throw new Error("Total quantity cannot exceed 100,000.");
  db.prepare(
    `INSERT INTO inventory(printing_id,language,condition,finish,quantity) VALUES (?,?,?,?,?) ON CONFLICT(printing_id,language,condition,finish) DO UPDATE SET quantity=quantity+excluded.quantity,updated_at=CURRENT_TIMESTAMP`,
  ).run(card.id, card.lang, input.condition, input.finish, input.quantity);
}
