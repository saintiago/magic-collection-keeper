import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCardTagState,
  relevantCardTags,
} from "../public/card-tag-state.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const location = {
  id: "deck-a",
  label: "Current deck label",
  type: "location",
};
const role = { id: "role-b", label: "Commander", type: "classification" };

test("DRAG-04 a frozen explicit Remove already satisfied by fresh state sends no inverse write", async () => {
  const calls = [],
    item = { row: { quantity: 9, tags: [] } };
  const state = create(item, async (...args) => calls.push(args));
  await tick();
  state.set(location.id, false);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(state.view.desired.size, 0);
  assert.equal(item.row.quantity, 9);
});
function create(item, toggle, load = async () => [location, role]) {
  return createCardTagState(item, {
    available: () => [location, role],
    recent: () => [],
    load,
    toggle,
  });
}

test("CARD-12 current registry labels replace cached metadata and system tags are never controls", () => {
  const tags = relevantCardTags(
    {
      row: {
        tags: [
          { ...location, label: "Old label" },
          { id: "pending", label: "Pending", type: "system" },
        ],
      },
    },
    [location, role],
  );
  assert.equal(tags.find((t) => t.id === location.id).label, location.label);
  assert.equal(
    tags.some((t) => t.id === "pending"),
    false,
  );
});

test("CARD-13 rapid remove/add preserves the location quantity and serializes explicit intent", async () => {
  const item = {
    row: { quantity: 9, locations: [{ tag_id: location.id, quantity: 5 }] },
  };
  const calls = [],
    finishes = [];
  const state = create(item, async (_, tag, selected, quantity) => {
    calls.push({ id: tag.id, selected, quantity });
    await new Promise((resolve) => finishes.push(resolve));
    item.row = {
      ...item.row,
      locations: selected ? [{ tag_id: tag.id, quantity }] : [],
    };
  });
  await tick();
  state.select(location.id);
  state.select(location.id);
  assert.equal(calls.length, 1);
  finishes.shift()();
  await tick();
  assert.deepEqual(calls, [
    { id: location.id, selected: false, quantity: 5 },
    { id: location.id, selected: true, quantity: 5 },
  ]);
  finishes.shift()();
  await tick();
  assert.equal(item.row.quantity, 9);
  assert.equal(state.view.confirmed.has(location.id), true);
  assert.equal(state.view.desired.size, 0);
});

test("CARD-13 a replay returning newer server state never reissues the settled intent with a new operation", async () => {
  const item = { row: { locations: [] } };
  let calls = 0;
  const state = create(item, async () => {
    calls++;
    // The old receipt is confirmed, but a later server action already removed
    // this tag. The current authoritative row intentionally remains unassigned.
    if (calls > 1) throw Error("Repeated a settled intent");
  });
  await tick();
  state.select(location.id);
  await tick();
  assert.equal(calls, 1);
  assert.equal(state.view.confirmed.has(location.id), false);
  assert.equal(state.view.desired.size, 0);
});

test("CARD-13 a rejected tag rolls back visibly while another queued tag is still applied", async () => {
  const item = { row: { tag_ids: [] } };
  let reject;
  const calls = [];
  const state = create(item, async (_, tag) => {
    calls.push(tag.id);
    if (tag.id === location.id)
      await new Promise((_, fail) => {
        reject = fail;
      });
    else item.row = { ...item.row, tag_ids: [role.id] };
  });
  await tick();
  state.select(location.id);
  state.select(role.id);
  reject(Error("The deck assignment was rejected"));
  await tick();
  assert.deepEqual(calls, [location.id, role.id]);
  assert.equal(state.view.confirmed.has(location.id), false);
  assert.equal(state.view.confirmed.has(role.id), true);
  assert.match(state.view.errors.get(location.id), /rejected/);
});

test("CARD-13 a late tag load cannot overwrite a newer retry", async () => {
  const finishes = [];
  const state = create(
    { row: {} },
    async () => {},
    () => new Promise((resolve) => finishes.push(resolve)),
  );
  state.retry();
  finishes[1]([role]);
  await tick();
  finishes[0]([location]);
  await tick();
  assert.deepEqual(
    state.view.tags.map((t) => t.id),
    [role.id],
  );
});
