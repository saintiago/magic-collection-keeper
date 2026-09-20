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
  const changes = [...new Set(changedPaths)].sort();
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
