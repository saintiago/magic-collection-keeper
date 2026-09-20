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

function headingAnchor(line) {
  return line
    .replace(/^#+\s+/, "")
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function hasAnchor(text, anchor) {
  if (!anchor) return true;
  if (
    [...text.matchAll(/\bid=["']([^"']+)["']/g)].some(
      (match) => match[1] === anchor,
    )
  ) {
    return true;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => /^#+\s+/.test(line))
    .some((line) => headingAnchor(line) === anchor);
}

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
    const [encodedFile, encodedAnchor = ""] = target.split("#", 2);
    const file = decodeURIComponent(encodedFile);
    const anchor = decodeURIComponent(encodedAnchor);
    const resolved = path.resolve(
      path.dirname(path.join(root, relative)),
      file,
    );
    try {
      await access(resolved);
      if (anchor && /\.md$/i.test(resolved)) {
        const targetText = await readFile(resolved, "utf8");
        if (!hasAnchor(targetText, anchor)) {
          problems.push(`${relative}: missing local anchor ${target}`);
        }
      }
    } catch {
      problems.push(`${relative}: broken local link ${target}`);
    }
  }
}

const useCases = await readFile(path.join(root, "docs/USE-CASES.md"), "utf8");
for (let number = 1; number <= 37; number += 1) {
  const id = `UC-${String(number).padStart(2, "0")}`;
  if (!new RegExp(`\\| ${id} \\|`).test(useCases)) {
    problems.push(`docs/USE-CASES.md: missing stable use case ${id}`);
  }
}

const specification = await readFile(path.join(root, "docs/SPEC.md"), "utf8");
for (const [prefix, count] of [
  ["card", 17],
  ["drag", 5],
  ["view", 4],
  ["recent", 4],
  ["import", 10],
  ["scan", 14],
  ["scale", 5],
  ["data", 7],
  ["deploy", 6],
]) {
  for (let number = 1; number <= count; number += 1) {
    const anchor = `${prefix}-${String(number).padStart(2, "0")}`;
    if (!hasAnchor(specification, anchor)) {
      problems.push(
        `docs/SPEC.md: missing stable requirement detail ${anchor}`,
      );
    }
  }
}
for (const anchor of ["perf-01", "quality-01"]) {
  if (!hasAnchor(specification, anchor)) {
    problems.push(`docs/SPEC.md: missing stable requirement detail ${anchor}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`documentation valid: ${markdown.length} files checked`);
}
