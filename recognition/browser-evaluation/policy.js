// Exact whole-title corroboration, matching the existing server admission guard.
export function normalizeTitle(value) {
  return value
    .toLowerCase()
    .replaceAll("ß", "ss")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");
}
export function titleAgreement(name, lines, aliases = []) {
  const text = lines.join(" ").trim();
  const forms = new Set([
    normalizeTitle(text),
    normalizeTitle(text.replace(/\s+\d{1,3}$/, "")),
  ]);
  const languages = new Set(
    [[name, "en"], ...aliases]
      .filter(([value]) => value && forms.has(normalizeTitle(value)))
      .map(([, lang]) => lang),
  );
  return {
    agrees: languages.size > 0,
    language: languages.size === 1 ? [...languages][0] : null,
  };
}
export async function evaluateTitle(
  ocr,
  frame,
  corners,
  orientation,
  candidate,
  score,
  margin,
  aliases,
  footer,
) {
  const plausible =
    score >= 0.6 &&
    margin >= 0.12 &&
    normalizeTitle(candidate.name).length >= 8;
  const ordered =
    orientation === "rotated_180"
      ? [...corners.slice(2), ...corners.slice(0, 2)]
      : corners;
  const first = await ocr.read(frame, ordered, { footer });
  let agreement = titleAgreement(candidate.name, first.title, aliases),
    opposite = null;
  if (plausible && !agreement.agrees) {
    opposite = await ocr.read(
      frame,
      [...ordered.slice(2), ...ordered.slice(0, 2)],
      { footer: false },
    );
    const second = titleAgreement(candidate.name, opposite.title, aliases);
    if (second.agrees) agreement = second;
  }
  return {
    first,
    opposite,
    ...agreement,
    supported: plausible && agreement.agrees,
  };
}
