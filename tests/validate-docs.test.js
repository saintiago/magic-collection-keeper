import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function validDocuments() {
  // Keep the fixture contract explicit, independent of the validator's code
  // and of the repository's evolving product documentation.
  const specification = [
    ["card", 17],
    ["drag", 5],
    ["view", 4],
    ["recent", 4],
    ["import", 10],
    ["scan", 14],
    ["scale", 5],
    ["data", 7],
    ["deploy", 6],
    ["perf", 1],
    ["quality", 1],
  ]
    .flatMap(([prefix, count]) =>
      Array.from(
        { length: count },
        (_, index) =>
          `<a id="${prefix}-${String(index + 1).padStart(2, "0")}"></a>`,
      ),
    )
    .join("\n");
  return {
    "README.md":
      "[Specification](docs/SPEC.md#card-01)\n" +
      "[Operations](docs/OPERATIONS.md#local-checks)\n",
    "AGENTS.md": "# Contributor guidance\n",
    "docs/PRODUCT-CHARTER.md": "# Product charter\n",
    "docs/SPEC.md": specification,
    "docs/REQUIREMENTS.md": "# Requirements\n",
    "docs/ARCHITECTURE.md": "# Architecture\n",
    "docs/USE-CASES.md": Array.from(
      { length: 37 },
      (_, index) => `| UC-${String(index + 1).padStart(2, "0")} | Scenario |`,
    ).join("\n"),
    "docs/OPERATIONS.md": "# Operations\n\n## Local checks\n",
    "docs/MAGIC-KEEPER-WORK-PLAN.md": "# Work plan\n",
    "tests/performance/R130-RELEASE.md":
      "[Requirements](../../docs/REQUIREMENTS.md)\n",
  };
}

async function runValidator(t, documents) {
  // Keep disposable files within this checkout, including on Windows.
  const scratch = path.join(root, "data");
  await mkdir(scratch, { recursive: true });
  const fixture = await mkdtemp(path.join(scratch, "validate-docs-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "scripts"));
  await copyFile(
    path.join(root, "scripts/validate-docs.mjs"),
    path.join(fixture, "scripts/validate-docs.mjs"),
  );
  for (const [relative, content] of Object.entries(documents)) {
    const destination = path.join(fixture, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
  const result = spawnSync(
    process.execPath,
    [path.join(fixture, "scripts/validate-docs.mjs")],
    { cwd: fixture, encoding: "utf8", timeout: 10_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("B-12 documentation validator accepts a valid fixture", async (t) => {
  const result = await runValidator(t, validDocuments());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), "documentation valid: 10 files checked");
});

const invalidCases = [
  {
    name: "missing required document",
    change(documents) {
      delete documents["AGENTS.md"];
    },
    diagnostic: "missing required document: AGENTS.md",
  },
  {
    name: "broken local file link",
    change(documents) {
      documents["README.md"] += "[Missing file](docs/missing.md)\n";
    },
    diagnostic: "README.md: broken local link docs/missing.md",
  },
  {
    name: "missing cross-file anchor",
    change(documents) {
      documents["README.md"] +=
        "[Missing section](docs/OPERATIONS.md#missing-section)\n";
    },
    diagnostic:
      "README.md: missing local anchor docs/OPERATIONS.md#missing-section",
  },
  {
    name: "missing UC identifier",
    change(documents) {
      documents["docs/USE-CASES.md"] = documents["docs/USE-CASES.md"].replace(
        "| UC-37 | Scenario |",
        "",
      );
    },
    diagnostic: "docs/USE-CASES.md: missing stable use case UC-37",
  },
  {
    name: "missing required SPEC anchor",
    change(documents) {
      documents["docs/SPEC.md"] = documents["docs/SPEC.md"].replace(
        '<a id="quality-01"></a>',
        "",
      );
    },
    diagnostic: "docs/SPEC.md: missing stable requirement detail quality-01",
  },
  {
    name: "retired document reference",
    change(documents) {
      documents["README.md"] += "Retired reference: DEVELOPMENT-HARNESS.md\n";
    },
    diagnostic:
      "README.md: links or refers to a retired orchestration document",
  },
];

for (const { name, change, diagnostic } of invalidCases) {
  test(`B-12 documentation validator rejects ${name}`, async (t) => {
    const documents = validDocuments();
    change(documents);
    const result = await runValidator(t, documents);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), diagnostic);
  });
}
