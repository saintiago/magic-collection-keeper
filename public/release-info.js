import { release } from "./release.js";
export function setupReleaseInfo() {
  const button = document.getElementById("app-version");
  button.textContent =
    release.channel === "development"
      ? "Local development"
      : "App " + release.version;
  button.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "release-dialog";
    const heading = document.createElement("h2");
    heading.textContent = "About this app";
    dialog.append(heading);
    for (const [label, value] of Object.entries({
      Version: release.version,
      Commit: release.commit || "Local working copy",
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
    const close = document.createElement("button");
    close.className = "secondary";
    close.textContent = "Close about";
    close.onclick = () => dialog.close();
    dialog.append(close);
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  };
}
