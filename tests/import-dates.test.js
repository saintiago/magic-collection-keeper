import { test } from "node:test";
import assert from "node:assert/strict";
import { groupDraftDates } from "../public/import-dates.js";
import { cardTimestamps, utcTimestamp } from "../domain/card-timestamps.js";

test("UC-IMPORT-DATES local calendar grouping keeps same-day batches separate and handles unknown creation", () => {
  const now = new Date(2026, 8, 10, 0, 15);
  const drafts = [
    { id: "old", created_at: new Date(2026, 8, 9, 23, 59).toISOString() },
    { id: "new", created_at: new Date(2026, 8, 10, 0, 1).toISOString() },
    { id: "same", created_at: new Date(2026, 8, 10, 0, 2).toISOString() },
    { id: "legacy", created_at: null },
  ];
  const groups = groupDraftDates(drafts, { now, locale: "en" });
  assert.deepEqual(
    groups.map((group) => group.label),
    ["Today", "Yesterday", "Creation date unknown"],
  );
  assert.deepEqual(
    groups[0].drafts.map((draft) => draft.id),
    ["same", "new"],
  );
  assert.equal(utcTimestamp("2026-09-09 10:00:00"), "2026-09-09T10:00:00.000Z");
  assert.deepEqual(cardTimestamps([{ updated_at: "2026-09-09T10:00:00Z" }]), {
    created_at: null,
    updated_at: "2026-09-09T10:00:00.000Z",
  });
});
