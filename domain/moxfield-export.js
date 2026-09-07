import { ApplicationError } from "./inventory.js";
export const normalizeCardName = (name) =>
  String(name)
    .normalize("NFKC")
    .replace(/\s*\/+\s*/g, " // ")
    .toLowerCase()
    .trim();

export function parseMoxfieldExport(source) {
  const commanders = new Set(
    (source.groups ?? [])
      .filter((g) => g.section.startsWith("Commander"))
      .flatMap((g) => g.names)
      .map(normalizeCardName),
  );
  const companions = new Set(
    (source.groups ?? [])
      .filter((g) => g.section.startsWith("Companion"))
      .flatMap((g) => g.names)
      .map(normalizeCardName),
  );
  if (!commanders.size)
    throw new ApplicationError(
      `Commander identity is missing for ${source.name}.`,
    );
  const entries = [],
    excluded = new Map();
  let section = "mainboard";
  for (const raw of source.exportText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(SIDEBOARD|MAYBEBOARD|CONSIDERING|TOKENS):?$/i.test(line)) {
      section = line.replace(":", "").toLowerCase();
      continue;
    }
    const match = line.match(
      /^(\d+)\s+(.+)\s+\(([^)]+)\)\s+(\S+?)(?:\s+\*([FE])\*)?$/,
    );
    if (!match)
      throw new ApplicationError(
        `Unsupported exported line in ${source.name}: ${line}`,
      );
    const [, qty, name, set, number, finish] = match;
    if (section !== "mainboard") {
      excluded.set(section, (excluded.get(section) || 0) + Number(qty));
      continue;
    }
    entries.push({
      quantity: Number(qty),
      name,
      set: set.toLowerCase(),
      collector_number: number,
      finish: finish === "F" ? "foil" : finish === "E" ? "etched" : "nonfoil",
      section: commanders.has(normalizeCardName(name))
        ? "commanders"
        : companions.has(normalizeCardName(name))
          ? "companions"
          : "mainboard",
    });
  }
  const main = Number(source.visibleTotals?.match(/^(\d+) main deck/)?.[1]);
  const total = entries.reduce((n, e) => n + e.quantity, 0);
  if (!Number.isInteger(main) || total !== main)
    throw new ApplicationError(
      `Export total ${total} does not match displayed main deck total ${main} for ${source.name}.`,
    );
  for (const name of commanders)
    if (
      !entries.some(
        (e) => e.section === "commanders" && normalizeCardName(e.name) === name,
      )
    )
      throw new ApplicationError(
        `Exported commander missing for ${source.name}.`,
      );
  return {
    ...source,
    entries,
    excluded: [...excluded].map(([section, quantity]) => ({
      section,
      quantity,
    })),
  };
}
