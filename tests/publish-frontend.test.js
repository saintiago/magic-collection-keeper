import { test } from "node:test";
import assert from "node:assert/strict";
import { publishFrontend } from "../scripts/publish-frontend.mjs";

function fixture() {
  const base = { id: "r90-a1", api: { codeSha256: "verified" } };
  const release = { id: "r91-a1", mode: "frontend", api: base.api };
  const state = {
    id: base.id,
    code: "verified",
    settled: true,
    metadata: base,
    calls: [],
    published: false,
  };
  const html = (id) => `<meta name="keeper-release" content="${id}">`;
  const options = {
    base,
    release,
    bucket: "keeper-fixture",
    distribution: "ETEST",
    previousIndex: html(base.id),
    published: async () => {
      state.published = true;
    },
    aws: (...args) => {
      state.calls.push(args);
      if (args[0] === "lambda")
        return JSON.stringify({
          CodeSha256: state.code,
          LastUpdateStatus: state.settled ? "Successful" : "InProgress",
        });
      if (args[0] === "s3" && args[3] === "-")
        return args[2].endsWith("version.json")
          ? JSON.stringify(state.metadata)
          : html(state.id);
      if (args[1] === "sync") state.afterUpload?.();
      if (args[1] === "cp")
        state.id = args[2].includes("previous") ? base.id : release.id;
      if (args[1] === "create-invalidation" && state.failInvalidation)
        throw Error("Controlled invalidation failure");
      return "I123";
    },
  };
  return { state, options };
}

test("DEPLOY-03 only the new prefix and root HTML are written, with API recheck after upload", async () => {
  const { state, options } = fixture();
  await publishFrontend(options);
  assert.equal(state.id, options.release.id);
  assert.equal(state.published, true);
  assert.equal(state.calls.filter((c) => c[0] === "lambda").length, 2);
  const writes = state.calls.filter((c) => c[0] === "s3" && c[3] !== "-");
  assert.deepEqual(
    writes.map((c) => c.slice(0, 4)),
    [
      [
        "s3",
        "sync",
        "build/site/releases/r91-a1/",
        "s3://keeper-fixture/releases/r91-a1/",
      ],
      ["s3", "cp", "build/site/index.html", "s3://keeper-fixture/index.html"],
    ],
  );
});

test("DEPLOY-03 stale frontend, backend and immutable metadata refuse publication", async () => {
  for (const alter of [
    (s) => {
      s.id = "r92-a1";
    },
    (s) => {
      s.code = "changed";
    },
    (s) => {
      s.settled = false;
    },
    (s) => {
      s.metadata = {};
    },
  ]) {
    const { state, options } = fixture();
    alter(state);
    await assert.rejects(publishFrontend(options));
    assert.equal(state.published, false);
    assert.equal(
      state.calls.some((c) => c[1] === "sync"),
      false,
    );
  }
  const { state, options } = fixture();
  state.afterUpload = () => {
    state.code = "changed";
  };
  await assert.rejects(publishFrontend(options), /backend changed/);
  assert.equal(state.id, options.base.id);
  assert.equal(state.published, false);
});

test("DEPLOY-03 failed invalidation remains rollback eligible, without overwriting newer releases", async () => {
  const { state, options } = fixture();
  state.failInvalidation = true;
  await assert.rejects(publishFrontend(options), /invalidation failure/);
  assert.equal(state.published, true);
  state.failInvalidation = false;
  await publishFrontend({ ...options, rollback: true });
  assert.equal(state.id, options.base.id);
  state.id = "r92-a1";
  await assert.rejects(
    publishFrontend({ ...options, rollback: true }),
    /another release/,
  );
  assert.equal(state.id, "r92-a1");
  state.id = options.release.id;
  await assert.rejects(
    publishFrontend({ ...options, rollback: true, previousIndex: "wrong" }),
    /Rollback page/,
  );
});
