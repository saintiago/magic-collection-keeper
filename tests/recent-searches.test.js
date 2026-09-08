import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRecentSearches,
  recentEntries,
} from "../public/recent-searches.js";
const card = {
  name: "Lightning Bolt",
  oracle_id: "bolt",
  printing_id: "en",
  quantity: 99,
  tag_ids: ["private"],
};
test("UC-30 bounded recency deduplicates committed cards/queries and stores no ownership metadata", () => {
  const data = new Map();
  const storage = {
    read: (key) => data.get(key),
    write: (key, value) => data.set(key, value),
    remove: (key) => data.delete(key),
  };
  const recent = createRecentSearches({ storage });
  recent.remember(card);
  assert.equal(data.size, 0);
  recent.start("verified-one");
  recent.remember(card);
  recent.remember({ ...card, printing_id: "es" });
  assert.equal(recent.state.entries.length, 1);
  assert.equal(recent.state.entries[0].printing_id, "es");
  assert.equal(recent.state.entries[0].quantity, undefined);
  for (let i = 0; i < 12; i++)
    recent.remember({ kind: "query", name: `Query ${i}` });
  assert.equal(recent.state.entries.length, 10);
  assert.equal(recent.state.entries[0].name, "Query 11");
  recent.remember({ kind: "query", name: " query 4 " });
  assert.equal(recent.state.entries.length, 10);
  assert.equal(recent.state.entries[0].name, "query 4");
  assert.equal(
    recentEntries([
      { kind: "query", name: "x".repeat(901) },
      null,
      { name: "invalid" },
    ]).length,
    0,
  );
  assert.equal(
    recentEntries([{ kind: "query", name: "x".repeat(900) }]).length,
    1,
  );
});
test("UC-30 history persists only under verified account keys, clears one account, and survives blocked storage safely", () => {
  const data = new Map();
  let denied = false;
  const storage = {
    read: (key) => data.get(key),
    write: (key, value) => {
      if (denied) throw Error();
      data.set(key, value);
    },
    remove: (key) => {
      if (denied) throw Error();
      data.delete(key);
    },
  };
  const recent = createRecentSearches({ storage });
  recent.start("one");
  recent.remember(card);
  recent.stop();
  assert.equal(recent.state.entries.length, 0);
  recent.remember({ kind: "query", name: "while signed out" });
  recent.start("two");
  assert.equal(recent.state.entries.length, 0);
  recent.remember({ kind: "query", name: "Second user" });
  recent.clear();
  assert.equal(recent.state.entries.length, 0);
  const reloaded = createRecentSearches({ storage });
  reloaded.start("one");
  assert.equal(reloaded.state.entries[0].name, "Lightning Bolt");
  denied = true;
  reloaded.remember({ kind: "query", name: "Memory only" });
  assert.match(reloaded.state.error, /this visit only/);
  reloaded.clear();
  assert.match(reloaded.state.error, /Could not clear/);
  assert.equal(reloaded.state.entries.length, 2);
  denied = false;
  reloaded.clear();
  assert.equal(reloaded.state.entries.length, 0);
  assert.throws(() => recent.start(""), /Verified account/);
  const corrupted = createRecentSearches({
    storage: { ...storage, read: () => "{" },
  });
  corrupted.start("one");
  assert.equal(corrupted.state.entries.length, 0);
  corrupted.unavailable();
  assert.equal(corrupted.state.status, "unavailable");
});
