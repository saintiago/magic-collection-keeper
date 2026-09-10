import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupDeployArtifacts,
  verifiedDeployment,
} from "../scripts/cleanup-deploy-artifacts.mjs";

const repo = { full_name: "saintiago/magic-collection-keeper" };
const run = {
  repository: repo,
  head_repository: repo,
  head_branch: "main",
  path: ".github/workflows/deploy.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
};
const jobs = [
  {
    name: "deploy",
    status: "completed",
    conclusion: "success",
    steps: [{ name: "Verify protected deployed app", conclusion: "success" }],
  },
];

test("cleanup requires successful main publication and live verification", () => {
  assert.equal(verifiedDeployment(run, jobs, 1), true);
  for (const patch of [
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_branch: "feature" },
    { event: "pull_request" },
    { head_repository: { full_name: "fork/repo" } },
    { repository: { full_name: "other/repo" } },
    { path: ".github/workflows/recognition-publish.yml" },
    { run_attempt: 2 },
  ]) {
    assert.equal(verifiedDeployment({ ...run, ...patch }, jobs, 1), false);
  }
  assert.equal(verifiedDeployment(run, [], 1), false);
  assert.equal(verifiedDeployment(run, [{ ...jobs[0], steps: [] }], 1), false);
  assert.equal(
    verifiedDeployment(
      run,
      [{ ...jobs[0], steps: [{ ...jobs[0].steps[0], conclusion: "failure" }] }],
      1,
    ),
    false,
  );
  assert.equal(
    verifiedDeployment(
      run,
      [
        {
          ...jobs[0],
          name: "frontend / frontend-publish",
          steps: [
            {
              name: "Verify the deployed frontend with reserved profiles",
              conclusion: "success",
            },
          ],
        },
      ],
      1,
    ),
    true,
  );
});

function fixture(states = [run]) {
  const deleted = [];
  const artifacts = [
    { id: 1, name: "keeper-build", workflow_run: { id: 10 } },
    { id: 2, name: "recognition-verification", workflow_run: { id: 10 } },
    { id: 3, name: "keeper-build", workflow_run: { id: 11 } },
    { id: 4, name: "reviewed-recognition-image", workflow_run: { id: 10 } },
    { id: 5, name: "keeper-release-plan", workflow_run: { id: 10 } },
    { id: 6, name: "unknown", workflow_run: { id: 10 } },
    {
      id: 7,
      name: "keeper-frontend-build",
      expired: true,
      workflow_run: { id: 10 },
    },
    { id: 8, name: "keeper-build" },
  ];
  const actions = {
    getWorkflowRun: async () => ({
      data: states.length > 1 ? states.shift() : states[0],
    }),
    listJobsForWorkflowRunAttempt: "jobs",
    listWorkflowRunArtifacts: "artifacts",
    deleteArtifact: async (args) => {
      assert.equal(args.owner, "saintiago");
      assert.equal(args.repo, "magic-collection-keeper");
      deleted.push(args.artifact_id);
    },
  };
  const github = {
    rest: { actions },
    paginate: async (method, args) => {
      assert.equal(args.run_id, 10);
      return method === "jobs" ? jobs : artifacts;
    },
  };
  return { deleted, options: { github, runId: 10, attempt: 1, log: () => {} } };
}

test("cleanup deletes only known same-run intermediates, preserving source and concurrent runs", async () => {
  const f = fixture();
  assert.deepEqual(await cleanupDeployArtifacts(f.options), [1, 5]);
  assert.deepEqual(f.deleted, [1, 5]);
});

test("failed or queued runs never lose artifacts", async () => {
  for (const patch of [{ conclusion: "failure" }, { status: "queued" }]) {
    const f = fixture([{ ...run, ...patch }]);
    assert.deepEqual(await cleanupDeployArtifacts(f.options), []);
    assert.deepEqual(f.deleted, []);
  }
});

test("a rerun queued during cleanup stops deletion", async () => {
  const f = fixture([run, run, { ...run, status: "queued", run_attempt: 2 }]);
  assert.deepEqual(await cleanupDeployArtifacts(f.options), [1]);
  assert.deepEqual(f.deleted, [1]);
});

test("missing exact run identifiers fail closed", async () => {
  const f = fixture();
  await assert.rejects(
    cleanupDeployArtifacts({ ...f.options, runId: 0 }),
    /exact run/,
  );
  assert.deepEqual(f.deleted, []);
});
