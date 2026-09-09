import { release } from "./release.js";
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
    source.onclick = async () => {
      source.disabled = true;
      try {
        const blob = await api("/api/recognition/source", {
          responseType: "blob",
        });
        if (!dialog.open) return;
        const url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = "keeper-recognition-source.zip";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        privacy.textContent = "Source download unavailable. Sign in and retry.";
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
    dialog.onclose = () => dialog.remove();
    document.body.append(dialog);
    dialog.showModal();
  };
}
