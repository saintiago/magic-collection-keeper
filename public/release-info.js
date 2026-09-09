import { release } from "./release.js";
import { downloadSourcePackage } from "./source-package.js";
export function setupReleaseInfo({ api }) {
  const button = document.getElementById("app-version");
  button.textContent =
    release.channel === "development"
      ? "Local development"
      : "App " + release.version;
  const info = document.getElementById("recognition-info");
  info.onclick = () => button.click();
  button.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "release-dialog";
    const heading = document.createElement("h2");
    heading.textContent = "About this app";
    dialog.append(heading);
    for (const [label, value] of Object.entries({
      Version: release.version,
      Commit: release.commit || "Local working copy",
      ...(release.api
        ? {
            "API version": release.api.version,
            "API commit": release.api.commit,
          }
        : {}),
      ...(release.mode ? { "Release path": release.mode } : {}),
      "Deployment started (UTC)": release.startedAt || "Not deployed",
    })) {
      const line = document.createElement("p");
      line.textContent = label + ": " + value;
      dialog.append(line);
    }
    if (release.workflowUrl) {
      const link = document.createElement("a");
      link.textContent = "View deployment checks";
      link.href = release.workflowUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      dialog.append(link);
    }
    const privacy = document.createElement("p");
    privacy.textContent =
      "Recognition uses this device and parallel cloud checks, including an independent image model. Card crops are sent securely for temporary processing and are not saved. Suggested identities and printings need your review.";
    const source = document.createElement("button");
    source.className = "secondary";
    source.textContent = "Download Recognition source (AGPL-3.0)";
    const controller = new AbortController();
    source.onclick = async () => {
      source.disabled = true;
      try {
        const { blob, filename } = await downloadSourcePackage({
          api,
          release,
          signal: controller.signal,
        });
        if (!dialog.open || controller.signal.aborted) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        if (dialog.open && !controller.signal.aborted)
          privacy.textContent =
            error.message || "Source download unavailable. Sign in and retry.";
      } finally {
        source.disabled = false;
      }
    };
    dialog.append(privacy, source);
    const close = document.createElement("button");
    close.className = "secondary";
    close.textContent = "Close about";
    close.onclick = () => dialog.close();
    dialog.append(close);
    const signOut = () => dialog.close();
    window.addEventListener("keeper-sign-out", signOut);
    dialog.onclose = () => {
      controller.abort();
      window.removeEventListener("keeper-sign-out", signOut);
      dialog.remove();
    };
    document.body.append(dialog);
    dialog.showModal();
  };
}
