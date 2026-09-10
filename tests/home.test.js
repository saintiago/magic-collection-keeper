import { test } from "node:test";
import assert from "node:assert/strict";
import { createHomeHistory, activityEntries } from "../public/home-history.js";
import { homeContent } from "../public/home-view.js";
import { routeMode } from "../public/screen.js";

test("RECENT-02 distinct printings survive persistence, reopening moves only that printing and Home never substitutes another owned printing", () => {
  const saved = new Map();
  const storage = {
    read: (key) => saved.get(key),
    write: (key, value) => saved.set(key, value),
    remove: (key) => saved.delete(key),
  };
  const first = {
    kind: "card",
    name: "Same card",
    oracle_id: "same-oracle",
    printing_id: "first",
    image_url: "https://cards.scryfall.io/first.jpg",
  };
  const second = {
    ...first,
    printing_id: "second",
    image_url: "https://cards.scryfall.io/second.jpg",
  };
  const history = createHomeHistory({ storage });
  history.start("one");
  history.remember(first);
  history.remember(second);
  assert.deepEqual(
    history.state.entries.map((item) => item.printing_id),
    ["second", "first"],
  );
  history.remember(first);
  assert.deepEqual(
    history.state.entries.map((item) => item.printing_id),
    ["first", "second"],
  );
  history.stop();
  history.start("two");
  assert.deepEqual(history.state.entries, []);
  history.stop();
  history.start("one");
  assert.deepEqual(
    history.state.entries.map((item) => item.printing_id),
    ["first", "second"],
  );
  const view = homeContent({
    activity: history.state,
    searches: [],
    tags: [],
    tagsReady: true,
    collection: {
      status: "ready",
      rows: [
        {
          id: "owned-first",
          printing_id: "first",
          quantity: 1,
          card: {
            id: "first",
            name: first.name,
            oracle_id: first.oracle_id,
            image_uris: { normal: first.image_url },
          },
        },
      ],
    },
  });
  assert.deepEqual(
    view.cards.map((item) => item.printing_id),
    ["first", "second"],
  );
  assert.match(view.html, /src="https:\/\/cards.scryfall.io\/second.jpg"/);
  assert.match(view.html, /data-card-key="second"/);
  assert.match(
    view.html,
    /data-home-card="1" aria-label="Open Same card artwork · Not owned"/,
  );
});
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

test("RECENT-04 resolved artwork enriches an existing choice without creating activity or moving it ahead of a later choice", () => {
  const values = new Map();
  const history = createHomeHistory({
    storage: {
      read: (key) => values.get(key),
      write: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  history.start("one");
  const first = { kind: "card", name: "First", printing_id: "first" };
  const second = { kind: "card", name: "Second", printing_id: "second" };
  history.remember(first);
  history.remember(second);
  history.enrich({
    ...first,
    image_url: "https://cards.scryfall.io/first.jpg",
  });
  assert.deepEqual(
    history.state.entries.map((item) => item.printing_id),
    ["second", "first"],
  );
  assert.equal(
    history.state.entries[1].image_url,
    "https://cards.scryfall.io/first.jpg",
  );
  history.enrich({ name: "Unchosen", printing_id: "unchosen" });
  assert.equal(history.state.entries.length, 2);
  history.clear();
  history.enrich(first);
  assert.deepEqual(history.state.entries, []);
  history.stop();
  history.start("two");
  history.enrich(first);
  assert.deepEqual(history.state.entries, []);
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
