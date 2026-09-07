import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, savePrinting, addInventory, collection } from "../db.js";
import { parseList } from "../public/import.js";
import { listQuery } from "../public/catalog-query.js";
import { parseRecognition } from "../public/recognition.js";
import { frameDifference } from "../public/camera.js";
const card = {
  id: "printing-1",
  oracle_id: "oracle-1",
  name: "Test Card",
  set: "tst",
  collector_number: "1",
  lang: "en",
  finishes: ["nonfoil", "foil"],
};
test("inventory persists and merges only matching printing attributes", () => {
  const dir = mkdtempSync(join(tmpdir(), "keeper-")),
    path = join(dir, "test.sqlite");
  let db = openDatabase(path);
  try {
    savePrinting(db, card);
    savePrinting(db, { ...card, id: "printing-2", set: "two" });
    const item = {
      printing_id: card.id,
      quantity: 2,
      condition: "NM",
      finish: "nonfoil",
    };
    addInventory(db, item);
    addInventory(db, item);
    addInventory(db, { ...item, finish: "foil" });
    addInventory(db, { ...item, condition: "LP" });
    addInventory(db, { ...item, printing_id: "printing-2" });
    assert.equal(collection(db).length, 4);
    assert.equal(
      collection(db).find(
        (r) =>
          r.condition === "NM" &&
          r.finish === "nonfoil" &&
          r.printing_id === card.id,
      ).quantity,
      4,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM card_identities").get().n,
      1,
    );
    db.close();
    db = openDatabase(path);
    assert.equal(
      collection(db).reduce((n, r) => n + r.quantity, 0),
      10,
    );
    assert.throws(() => addInventory(db, { ...item, quantity: 1.5 }));
    assert.throws(() => addInventory(db, { ...item, finish: "etched" }));
    assert.throws(() => addInventory(db, { ...item, quantity: 100000 }));
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});
test("text import retains quantities and exact printing markers; bad lines remain reviewable", () => {
  const rows = parseList(
    "Commander\n1 Sol Ring (CMM) 410 *F*\n2x Lightning Bolt\n\nSIDEBOARD\nnot a card line",
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0].quantity, 1);
  assert.equal(rows[0].set, "CMM");
  assert.equal(rows[0].number, "410");
  assert.equal(rows[0].finish, "foil");
  assert.equal(rows[1].name, "Lightning Bolt");
  assert.ok(rows[2].error);
  assert.equal(listQuery(rows[0]), '!"Sol Ring" set:CMM cn:410 lang:en');
});
test("OCR reads modern footer and falls back to name", () => {
  const reading = parseRecognition(
    "Lightning Bolt\nInstant\n149/249 C\nM11 • EN\n2010 Wizards",
  );
  assert.equal(reading.name, "Lightning Bolt");
  const exact = parseRecognition("Sol Ring\n0410\nCMM • EN\nWizards");
  assert.equal(exact.exact.set, "CMM");
  assert.equal(exact.exact.number, "0410");
  assert.equal(parseRecognition("").name, "");
});
test("stable-frame difference distinguishes repeated and changed frames", () => {
  const a = new Uint8ClampedArray([20, 40, 60, 255]);
  assert.equal(frameDifference(a, a), 0);
  assert.ok(
    frameDifference(a, new Uint8ClampedArray([220, 240, 60, 255])) > 18,
  );
});
