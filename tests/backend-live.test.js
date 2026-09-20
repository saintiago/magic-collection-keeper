import assert from "node:assert/strict";
import test from "node:test";
import { clearCaptureTestData } from "./helpers/backend-live.js";

function reservedProfilePage() {
  const drafts = new Map([
    ["existing-draft", { id: "existing-draft", version: 3 }],
    ["scenario-draft", { id: "scenario-draft", version: 5 }],
  ]);
  const collection = new Map([
    ["existing-row", { id: "existing-row" }],
    ["scenario-row", { id: "scenario-row" }],
  ]);
  const page = {
    evaluate: async (_callback, { path, options = {} }) => {
      if (path === "/api/import-draft")
        return {
          pending_drafts: [...drafts.values()].map((draft) => ({
            id: draft.id,
            kind: "capture",
          })),
        };
      if (path.startsWith("/api/import-draft?id=")) {
        const id = new URL("https://keeper.invalid" + path).searchParams.get(
          "id",
        );
        return {
          draft: drafts.get(id) || null,
          ...(id === "scenario-draft"
            ? { scan_session: { previous: "existing-draft" } }
            : {}),
        };
      }
      if (path === "/api/import-draft/clear") {
        drafts.delete(JSON.parse(options.body).id);
        return { draft: null };
      }
      if (path === "/api/collection") return [...collection.values()];
      if (path.startsWith("/api/collection/") && options.method === "DELETE") {
        collection.delete(path.split("/").pop());
        return [...collection.values()];
      }
      throw Error(
        `Unexpected test API call: ${options.method || "GET"} ${path}`,
      );
    },
  };
  return { page, drafts, collection };
}

test("QUALITY-01 reserved cleanup removes only scenario data and preserves its linked baseline", async () => {
  const previousUser = process.env.KEEPER_TEST_USER;
  process.env.KEEPER_TEST_USER = "keeper-e2e";
  const { page, drafts, collection } = reservedProfilePage();
  try {
    await clearCaptureTestData(
      page,
      new Set(["existing-draft"]),
      new Set(["existing-row"]),
    );
    assert.deepEqual([...drafts.keys()], ["existing-draft"]);
    assert.deepEqual([...collection.keys()], ["existing-row"]);
  } finally {
    if (previousUser === undefined) delete process.env.KEEPER_TEST_USER;
    else process.env.KEEPER_TEST_USER = previousUser;
  }
});

test("QUALITY-01 reserved cleanup rejects a foreign profile before API access", async () => {
  const previousUser = process.env.KEEPER_TEST_USER;
  process.env.KEEPER_TEST_USER = "owner";
  let calls = 0;
  try {
    await assert.rejects(
      clearCaptureTestData(
        {
          evaluate: async () => {
            calls++;
          },
        },
        new Set(),
      ),
    );
    assert.equal(calls, 0);
  } finally {
    if (previousUser === undefined) delete process.env.KEEPER_TEST_USER;
    else process.env.KEEPER_TEST_USER = previousUser;
  }
});
