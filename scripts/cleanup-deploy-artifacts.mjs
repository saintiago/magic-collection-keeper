const repository = "saintiago/magic-collection-keeper";
const disposable = new Set([
  "keeper-release-plan",
  "keeper-build",
  "keeper-frontend-build",
]);

export function verifiedDeployment(run, jobs, attempt) {
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/deploy.yml" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.run_attempt !== attempt
  )
    return false;
  return jobs.some(
    (job) =>
      job.conclusion === "success" &&
      job.status === "completed" &&
      ((job.name === "deploy" &&
        job.steps?.some(
          (step) =>
            step.name === "Verify protected deployed app" &&
            step.conclusion === "success",
        )) ||
        (job.name === "frontend / frontend-publish" &&
          job.steps?.some(
            (step) =>
              step.name ===
                "Verify the deployed frontend with reserved profiles" &&
              step.conclusion === "success",
          ))),
  );
}

// Only same-run intermediates; never read artifacts or execute originating-run code.
export async function cleanupDeployArtifacts({ github, runId, attempt, log }) {
  if (
    !Number.isSafeInteger(runId) ||
    runId <= 0 ||
    !Number.isSafeInteger(attempt) ||
    attempt <= 0
  ) {
    throw new Error("An exact run and attempt are required");
  }
  const scope = {
    owner: "saintiago",
    repo: "magic-collection-keeper",
    run_id: runId,
  };
  const readRun = async () =>
    (await github.rest.actions.getWorkflowRun(scope)).data;
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRunAttempt,
    {
      ...scope,
      attempt_number: attempt,
      per_page: 100,
    },
  );
  if (!verifiedDeployment(await readRun(), jobs, attempt)) {
    log(
      "Preserved artifacts: no completed, verified main deployment for this attempt.",
    );
    return [];
  }
  const artifacts = await github.paginate(
    github.rest.actions.listWorkflowRunArtifacts,
    {
      ...scope,
      per_page: 100,
    },
  );
  const removed = [];
  for (const artifact of artifacts) {
    if (
      !disposable.has(artifact.name) ||
      artifact.expired ||
      artifact.workflow_run?.id !== runId
    )
      continue;
    // A queued/in-progress rerun invalidates the completed-attempt evidence.
    if (!verifiedDeployment(await readRun(), jobs, attempt)) break;
    await github.rest.actions.deleteArtifact({
      owner: scope.owner,
      repo: scope.repo,
      artifact_id: artifact.id,
    });
    removed.push(artifact.id);
    log(
      `Deleted disposable ${artifact.name} (${artifact.id}) from verified run ${runId}, attempt ${attempt}.`,
    );
  }
  return removed;
}
