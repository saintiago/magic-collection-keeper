import { test } from "node:test";
import assert from "node:assert/strict";
import { createHomeHistory, activityEntries } from "../public/home-history.js";
import { homeContent } from "../public/home-view.js";
import { routeMode } from "../public/screen.js";
test("UC-32 home activity bounds real card/tag interactions, persists under verified keys and clears only one account", () => {
  const data = new Map();
  let denied = false;
  const storage = {
    read: (k) => data.get(k),
    write: (k, v) => {
      if (denied) throw Error();
      data.set(k, v);
    },
    remove: (k) => {
      if (denied) throw Error();
      data.delete(k);
    },
  };
  const history = createHomeHistory({ storage });
  history.remember({ kind: "tag", id: "before-identity" });
  assert.equal(data.size, 0);
  assert.throws(() => history.start(""), /Verified/);
  history.start("one");
  for (let i = 0; i < 20; i++) {
    history.remember({
      kind: "card",
      name: `Card ${i}`,
      printing_id: `p${i}`,
      oracle_id: `o${i}`,
      quantity: 100,
    });
    history.remember({ kind: "tag", id: `t${i}`, label: "Never a key" });
  }
  assert.equal(history.state.entries.length, 24);
  history.remember({
    name: "Card 15",
    printing_id: "other-printing",
    oracle_id: "o15",
  });
  assert.equal(history.state.entries[0].oracle_id, "o15");
  assert.equal(history.state.entries.length, 24);
  assert.equal(history.state.entries[0].quantity, undefined);
  history.stop();
  assert.equal(history.state.entries.length, 0);
  history.start("two");
  assert.equal(history.state.entries.length, 0);
  history.remember({ kind: "tag", id: "second" });
  history.clear();
  const restored = createHomeHistory({ storage });
  restored.start("one");
  assert.equal(restored.state.entries.length, 24);
  denied = true;
  restored.remember({ kind: "tag", id: "memory" });
  assert.match(restored.state.error, /visit only/);
  restored.clear();
  assert.match(restored.state.error, /Could not clear/);
  assert.equal(restored.state.entries.length, 24);
  assert.equal(
    activityEntries([
      { name: "unsafe", printing_id: "p", image_url: "javascript:alert(1)" },
    ])[0].image_url,
    undefined,
  );
});
test("UC-32 home uses stable current tag metadata, separates decks by kind, and never invents recent activity or ownership", () => {
  const base = {
    activity: { status: "ready", entries: [], error: "" },
    searches: [],
    collection: { rows: [], status: "ready" },
    tags: [
      { id: "d", label: "<Deck>", type: "location", kind: "deck" },
      { id: "r", label: "Deck role", type: "role", kind: "role" },
    ],
    tagsReady: true,
  };
  let view = homeContent(base);
  assert.match(view.html, /Your decks/);
  assert.doesNotMatch(view.html, /Recent decks|<Deck>/);
  assert.match(view.html, /&lt;Deck&gt;/);
  view = homeContent({
    ...base,
    activity: {
      ...base.activity,
      entries: [
        { kind: "tag", id: "deleted" },
        { kind: "tag", id: "r" },
      ],
    },
  });
  assert.match(view.html, /Recent tags/);
  assert.match(view.html, /Your decks/);
  view = homeContent({
    ...base,
    activity: { ...base.activity, status: "locked" },
    searches: [{ kind: "card", name: "private", printing_id: "p" }],
  });
  assert.doesNotMatch(view.html, /private/);
  view = homeContent({ ...base, tags: [], tagsError: "Unavailable" });
  assert.match(view.html, /Tags unavailable/);
  assert.doesNotMatch(view.html, /No tags yet/);
  assert.equal(routeMode(""), "home");
  assert.equal(routeMode("#collection"), "collection");
  assert.equal(routeMode("#tag=x"), "collection");
  assert.equal(routeMode("#import"), "import");
});
