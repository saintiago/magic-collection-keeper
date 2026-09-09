import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
export function deploymentRelease(baseVersion, env, now = new Date()) {
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion))
    throw new Error("Use a numeric base version in package.json.");
  for (const name of [
    "GITHUB_RUN_NUMBER",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
  ]) {
    if (
      !/^[1-9]\d*$/.test(env[name] || "") ||
      !Number.isSafeInteger(Number(env[name]))
    )
      throw new Error("Invalid " + name);
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || ""))
    throw new Error("Full commit SHA required.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || ""))
    throw new Error("Repository required.");
  const runNumber = Number(env.GITHUB_RUN_NUMBER),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    channel: "deployment",
    id: `r${runNumber}-a${attempt}`,
    version: `${baseVersion}+deploy.${runNumber}.${attempt}`,
    runNumber,
    attempt,
    commit: env.GITHUB_SHA,
    startedAt: now.toISOString(),
    workflowUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${attempt}`,
  };
}
export function assertNewerRelease(release, previousIndex) {
  const match = previousIndex.match(/name="keeper-release" content="([^"]+)"/);
  if (!match) return; // First versioned release upgrades the legacy HTML.
  const previous = /^r(\d+)-a(\d+)$/.exec(match[1]);
  if (!previous) throw new Error("Published release marker is invalid.");
  if (
    release.runNumber < Number(previous[1]) ||
    (release.runNumber === Number(previous[1]) &&
      release.attempt <= Number(previous[2]))
  ) {
    throw new Error(
      "This deployment would reuse or regress the published version. Revert on main or start a new workflow run.",
    );
  }
}
export async function packageWebsite({ source, destination, release }) {
  const prefix = `/releases/${release.id}/`;
  const directory = join(destination, "releases", release.id);
  await mkdir(directory, { recursive: true });
  await cp(source, directory, {
    recursive: true,
    filter: (path) => {
      const name = relative(source, path).replaceAll("\\", "/");
      // Old generated assets may remain in local builds; omit retired engines.
      return (
        !path.endsWith("index.html") &&
        !/^(?:vendor\/(?:core|lang)(?:\/|$)|vendor\/(?:ocr\.js|worker\.min\.js)$|vendor\/ort\/.*(?:webgpu|asyncify))/.test(
          name,
        )
      );
    },
  });
  await writeFile(
    join(directory, "release.js"),
    `export const release = ${JSON.stringify(release)};\n`,
  );
  await writeFile(join(directory, "version.json"), JSON.stringify(release));
  const html = (await readFile(join(source, "index.html"), "utf8"))
    .replace(
      "<head>",
      `<head>\n    <meta name="keeper-release" content="${release.id}">`,
    )
    .replace(
      /(href|src)="\/(?!\/)([^"?#]+\.(?:css|js|woff2))"/g,
      `$1="${prefix}$2"`,
    );
  await writeFile(join(destination, "index.html"), html);
}
