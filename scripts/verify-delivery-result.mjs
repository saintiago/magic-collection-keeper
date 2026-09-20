import { fileURLToPath } from "node:url";

const outcomes = new Set(["success", "failure", "cancelled", "skipped"]);

function requireOutcome(name, actual, expected) {
  if (!outcomes.has(actual)) {
    throw new Error(
      `${name} has a missing or unknown result: ${actual || "<empty>"}`,
    );
  }
  if (actual !== expected) {
    throw new Error(`${name} must be ${expected}, received ${actual}`);
  }
}

export function verifyDeliveryResult(result) {
  requireOutcome("plan", result.plan, "success");
  const main =
    result.ref === "refs/heads/main" && result.event !== "pull_request";

  switch (result.mode) {
    case "docs":
      requireOutcome("docs", result.docs, "success");
      requireOutcome("frontend", result.frontend, "skipped");
      requireOutcome("test", result.test, "skipped");
      requireOutcome("deploy", result.deploy, "skipped");
      break;
    case "checks":
      requireOutcome("docs", result.docs, "skipped");
      requireOutcome("frontend", result.frontend, "skipped");
      requireOutcome("test", result.test, "success");
      requireOutcome("deploy", result.deploy, "skipped");
      break;
    case "frontend":
      requireOutcome("docs", result.docs, "skipped");
      requireOutcome("frontend", result.frontend, "success");
      requireOutcome("test", result.test, "skipped");
      requireOutcome("deploy", result.deploy, "skipped");
      break;
    case "full":
      requireOutcome("docs", result.docs, "skipped");
      requireOutcome("frontend", result.frontend, "skipped");
      requireOutcome("test", result.test, "success");
      requireOutcome("deploy", result.deploy, main ? "success" : "skipped");
      break;
    default:
      throw new Error(
        `release mode is missing or unknown: ${result.mode || "<empty>"}`,
      );
  }

  if (!/^[a-f0-9]{40}$/.test(result.commit)) {
    throw new Error(
      "commit must be the exact 40-character Git SHA evaluated by this run",
    );
  }
  return `Validated ${result.mode} path for exact commit ${result.commit}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      verifyDeliveryResult({
        mode: process.env.MODE ?? "",
        plan: process.env.PLAN ?? "",
        docs: process.env.DOCS ?? "",
        frontend: process.env.FRONTEND ?? "",
        test: process.env.TEST ?? "",
        deploy: process.env.DEPLOY ?? "",
        event: process.env.EVENT ?? "",
        ref: process.env.REF ?? "",
        commit: process.env.COMMIT ?? "",
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
