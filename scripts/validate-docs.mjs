import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md",
  "AGENTS.md",
  "docs/PRODUCT-CHARTER.md",
  "docs/SPEC.md",
  "docs/REQUIREMENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/USE-CASES.md",
  "docs/OPERATIONS.md",
  "docs/MAGIC-KEEPER-WORK-PLAN.md",
];
const markdown = [...required, "tests/performance/R130-RELEASE.md"];
const retired =
  /(?:DEVELOPMENT-HARNESS|HARNESS-(?:BASELINE|OBSERVABILITY|PILOT|WORKFLOWS|HOSTED-EXECUTION))\.md/i;
const problems = [];

for (const relative of required) {
  try {
    await access(path.join(root, relative));
  } catch {
    problems.push(`missing required document: ${relative}`);
  }
}

for (const relative of markdown) {
  let text;
  try {
    text = await readFile(path.join(root, relative), "utf8");
  } catch {
    continue;
  }
  if (relative !== "docs/MAGIC-KEEPER-WORK-PLAN.md" && retired.test(text)) {
    problems.push(
      `${relative}: links or refers to a retired orchestration document`,
    );
  }
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (
      target === "" ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue;
    }
    const file = decodeURIComponent(target.split("#", 1)[0]);
    try {
      await access(path.resolve(path.dirname(path.join(root, relative)), file));
    } catch {
      problems.push(`${relative}: broken local link ${target}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`documentation valid: ${markdown.length} files checked`);
}
