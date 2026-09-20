import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function runtimeSourceInput(name) {
  return (
    Boolean(name) &&
    !["README.md", "AGENTS.md"].includes(name) &&
    !name.startsWith("public/") &&
    !name.startsWith("docs/") &&
    !name.startsWith("tests/") &&
    !name.startsWith("recognition/tests/")
  );
}

export function digestSourceEntries(entries) {
  const digest = createHash("sha256");
  for (const [name, contents] of [...entries].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const pathBytes = Buffer.from(name);
    digest.update(Buffer.from(`${pathBytes.length}\0`));
    digest.update(pathBytes);
    digest.update(Buffer.from(`\0${contents.length}\0`));
    digest.update(contents);
  }
  return digest.digest("hex");
}

export function currentSourceTreeDigest(ref = "HEAD") {
  const paths = execFileSync("git", ["ls-tree", "-rz", "--name-only", ref], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(runtimeSourceInput);
  return digestSourceEntries(
    paths.map((name) => [
      name,
      execFileSync("git", ["show", `${ref}:${name}`], { encoding: "buffer" }),
    ]),
  );
}

export function verifySourceReadiness(expected, actual) {
  if (!/^[a-f0-9]{64}$/.test(expected || "")) {
    throw Error("Published corresponding-source tree digest is required");
  }
  if (actual !== expected) {
    throw Error(
      "Backend/build source differs from the separately verified published source",
    );
  }
  return actual;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const actual = currentSourceTreeDigest();
  console.log(
    `Verified corresponding-source publication readiness: ${verifySourceReadiness(
      process.env.RECOGNITION_SOURCE_TREE_SHA256,
      actual,
    )}`,
  );
}
