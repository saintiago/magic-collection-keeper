const encoder = new TextEncoder();
const hex = (bytes) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const sha256 = async (bytes) =>
  hex(await crypto.subtle.digest("SHA-256", bytes));

// A bounded POSIX ustar wrapper keeps the authenticated backend archive private
// until download. Headers are independently decoded in tests with Python tarfile.
function sourceTar(files) {
  const parts = [];
  for (const [name, bytes] of files) {
    if (!/^[a-zA-Z0-9.-]{1,80}$/.test(name) || bytes.length > 8_000_000)
      throw Error("Invalid source package entry");
    const header = new Uint8Array(512);
    const text = (value, offset) => header.set(encoder.encode(value), offset);
    const number = (value, offset, width) =>
      text(value.toString(8).padStart(width - 1, "0") + "\0", offset);
    text(name, 0);
    number(0o644, 100, 8);
    number(0, 108, 8);
    number(0, 116, 8);
    number(bytes.length, 124, 12);
    number(0, 136, 12);
    text("        ", 148);
    text("0", 156);
    text("ustar\0", 257);
    text("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(
      header,
      bytes,
      new Uint8Array((512 - (bytes.length % 512)) % 512),
    );
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: "application/x-tar" });
}

export async function downloadSourcePackage({
  api,
  release,
  signal,
  fetch: fetchSource = fetch,
}) {
  signal?.throwIfAborted();
  const backend = await api("/api/recognition/source", {
    responseType: "blob",
    signal,
  });
  signal?.throwIfAborted();
  if (!release.sourceOverlay)
    return { blob: backend, filename: "keeper-recognition-source.zip" };
  const { sourceOverlay, recognition } = release;
  if (
    !/^r[1-9]\d*-a[1-9]\d*$/.test(release.id || "") ||
    sourceOverlay.file !== "frontend-source.zip" ||
    !/^[a-f0-9]{64}$/.test(sourceOverlay.sha256 || "") ||
    !/^[a-f0-9]{64}$/.test(recognition?.sourceSha256 || "") ||
    !Number.isSafeInteger(sourceOverlay.bytes) ||
    sourceOverlay.bytes <= 0 ||
    sourceOverlay.bytes > 4_000_000 ||
    backend.size <= 0 ||
    backend.size > 4_000_000
  )
    throw Error("Source identities are unavailable");
  const response = await fetchSource(
    new URL("./frontend-source.zip", import.meta.url),
    { signal, redirect: "error" },
  );
  if (!response.ok) throw Error("Frontend source is unavailable");
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      signal?.throwIfAborted();
      length += value.length;
      if (length > sourceOverlay.bytes)
        throw Error("Frontend source exceeds its declared size");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const frontBytes = new Uint8Array(length);
  let offset = 0;
  for (const part of chunks) {
    frontBytes.set(part, offset);
    offset += part.length;
  }
  const backBytes = new Uint8Array(await backend.arrayBuffer());
  if (
    frontBytes.length !== sourceOverlay.bytes ||
    (await sha256(frontBytes)) !== sourceOverlay.sha256 ||
    (await sha256(backBytes)) !== recognition.sourceSha256
  ) {
    throw Error(
      "Source changed or failed integrity verification; reload and retry",
    );
  }
  signal?.throwIfAborted();
  const manifest = encoder.encode(
    JSON.stringify(
      {
        schema: 1,
        frontend: {
          commit: release.commit,
          version: release.version,
          ...sourceOverlay,
        },
        api: release.api,
        recognition,
      },
      null,
      2,
    ),
  );
  const instructions = encoder.encode(
    "Complete source for this deployed Keeper combination\n\n" +
      "1. Extract backend-source.zip into a new empty directory. It contains the recognition service, application backend, dependencies, licenses and build instructions.\n" +
      "2. In that extracted copy only, replace the keeper/public directory with keeper/public from frontend-source.zip. This complete frontend tree supersedes the older public tree in the backend archive, including removed files.\n" +
      "3. Follow keeper/README.md and keeper/docs/OPERATIONS.md for the unchanged build dependencies and pinned model fetches. deployment.json identifies the frontend, API and recognition source used together.\n\n" +
      "The backend archive was downloaded through your authenticated session. This wrapper does not make it publicly accessible. Card/model licenses remain with their source files.\n",
  );
  return {
    blob: sourceTar([
      ["README.txt", instructions],
      ["deployment.json", manifest],
      ["backend-source.zip", backBytes],
      ["frontend-source.zip", frontBytes],
    ]),
    filename: "keeper-source-" + release.id + ".tar",
  };
}
