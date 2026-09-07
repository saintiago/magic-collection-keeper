import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoxfieldExport } from "../domain/moxfield-export.js";
test("source export preserves commander, exact markers, finishes and excludes sideboard", () => {
  const source = {
    name: "Test",
    groups: [{ section: "Commander(1)", names: ["Front // Back"] }],
    visibleTotals: "3 main deck/1 sideboard",
    exportText:
      "1 Front / Back (ABC) 3 *F*\n2 Island (ABC) 4\nSIDEBOARD:\n1 Other (XYZ) 2 *E*",
  };
  const parsed = parseMoxfieldExport(source);
  assert.equal(parsed.entries[0].section, "commanders");
  assert.equal(parsed.entries[0].finish, "foil");
  assert.deepEqual(parsed.excluded, [{ section: "sideboard", quantity: 1 }]);
  assert.throws(() =>
    parseMoxfieldExport({
      ...source,
      visibleTotals: "4 main deck/1 sideboard",
    }),
  );
  assert.throws(() => parseMoxfieldExport({ ...source, groups: [] }));
});
