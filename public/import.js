// Pure text parser: never fetches or scrapes Moxfield URLs.
export function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ raw: raw.trim(), line: index + 1 }))
    .filter(
      (r) =>
        r.raw &&
        !/^(?:\/\/|#|Commander\s*$|Deck\s*$|Mainboard\s*$|Sideboard\s*$|Considering\s*$|Maybeboard\s*$)/i.test(
          r.raw,
        ),
    )
    .map((row) => {
      const match = row.raw.match(
        /^(\d+)\s*x?\s+(.+?)(?:\s+\(([a-z0-9]+)\)\s+([\w★-]+))?(?:\s+\*(F|E)\*)?$/i,
      );
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 100000)
        return {
          ...row,
          error:
            "Use “quantity card name”, optionally followed by (SET) number.",
        };
      return {
        ...row,
        quantity: Number(match[1]),
        name: match[2],
        set: match[3],
        number: match[4],
        finish:
          match[5]?.toUpperCase() === "F"
            ? "foil"
            : match[5]?.toUpperCase() === "E"
              ? "etched"
              : "nonfoil",
      };
    });
}
