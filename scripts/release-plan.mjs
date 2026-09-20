// Presentation changes may reuse a verified backend. API callers, build inputs,
// dependencies, models, infrastructure and unknown files deliberately use full.
const presentation = new Set([
  "public/index.html",
  "public/style.css",
  "public/card-actions.css",
  "public/fonts.css",
  "public/fonts/cinzel-latin.woff2",
  "public/fonts/cinzel-latin-ext.woff2",
  "public/fonts/inter-latin.woff2",
  "public/fonts/inter-latin-ext.woff2",
  "public/fonts/cinzel-OFL.txt",
  "public/fonts/inter-OFL.txt",
  "public/fonts/sources.json",
  "public/artwork-inspector.js",
  "public/artwork-viewer.js",
  "public/card-action-layout.js",
  "public/card-gestures.js",
  "public/card-tilt.js",
  "public/card-tile-view.js",
  "public/card-wheel-view.js",
  "public/collection-view.js",
  "public/home-view.js",
  "public/tag-view.js",
]);

const documentationOrTest = (path) =>
  ["AGENTS.md", "README.md"].includes(path) || /^(?:docs|tests)\//.test(path);
const documentation = (path) =>
  ["AGENTS.md", "README.md"].includes(path) || /^docs\//.test(path);
const sha = (value) => /^[a-f0-9]{40}$/.test(value || "");
const digest = (value) => /^[a-f0-9]{64}$/.test(value || "");

function changesOf(changedPaths) {
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.includes("\\") ||
        path.startsWith("/") ||
        path.split("/").includes(".."),
    )
  ) {
    throw Error("A repository-relative changed-path list is required");
  }
  return [...new Set(changedPaths)].sort();
}

export function reusableRelease(base) {
  return Boolean(
    base?.schema === 1 &&
    sha(base.commit) &&
    /^r[1-9]\d*-a[1-9]\d*$/.test(base.id || "") &&
    sha(base.api?.commit) &&
    typeof base.api?.version === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(base.api?.codeSha256 || "") &&
    /^r[1-9]\d*-a[1-9]\d*$/.test(base.assets?.id || "") &&
    digest(base.assets?.manifestSha256) &&
    digest(base.configSha256) &&
    digest(base.recognition?.sourceSha256) &&
    /^[1-9]\d*$/.test(base.recognition?.version || ""),
  );
}

export function planRelease({ changedPaths, base, redeployFrontend = false }) {
  const changes = changesOf(changedPaths);
  const runtime = changes.filter((path) => !documentationOrTest(path));
  if (!runtime.length && !redeployFrontend)
    return {
      mode: changes.every(documentation) ? "docs" : "checks",
      reason: changes.every(documentation)
        ? "Only documentation changed"
        : "Only documentation or tests changed",
      changes,
    };
  const unknown = runtime.filter((path) => !presentation.has(path));
  if (unknown.length)
    return {
      mode: "full",
      reason: "Changes include full-release inputs",
      changes,
      fullInputs: unknown,
    };
  if (!reusableRelease(base))
    return {
      mode: "full",
      reason: "Published release has no complete verified reuse metadata",
      changes,
    };
  return {
    mode: "frontend",
    reason: "Only explicit presentation files changed",
    changes,
    baseCommit: base.commit,
    baseRelease: base.id,
  };
}

export function planDelivery({
  currentChangedPaths,
  releaseChangedPaths,
  base,
  redeployFrontend = false,
}) {
  const currentChanges = changesOf(currentChangedPaths);
  const release = planRelease({
    changedPaths: releaseChangedPaths,
    base,
    redeployFrontend,
  });

  // Any unpublished runtime or presentation input still needs its guarded
  // release path, even when the newest commit changes only documentation.
  if (release.mode === "full" || release.mode === "frontend") {
    return { ...release, currentChanges };
  }

  // Accumulated documentation and tests are not application release inputs.
  // Validate only the current PR/push so a prior test-only main commit cannot
  // make every later documentation correction run the browser/model suite.
  const unexpectedRuntime = currentChanges.filter(
    (path) => !documentationOrTest(path),
  );
  if (unexpectedRuntime.length > 0) {
    return {
      mode: "full",
      reason: "Current runtime changes are missing from release classification",
      changes: currentChanges,
      currentChanges,
      releaseChanges: release.changes,
      fullInputs: unexpectedRuntime,
    };
  }
  const mode = currentChanges.every(documentation) ? "docs" : "checks";
  return {
    mode,
    reason:
      mode === "docs"
        ? "Only current documentation changed; accumulated changes contain no runtime inputs"
        : "Current documentation or tests changed; accumulated changes contain no runtime inputs",
    changes: currentChanges,
    currentChanges,
    releaseChanges: release.changes,
  };
}
