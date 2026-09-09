// Provider-specific search syntax stays out of the text parser.
export function listQuery(row) {
  const quoted = row.name.replace(/["\\]/g, "");
  return `!"${quoted}"${row.set ? ` set:${row.set} cn:${row.number}` : ""} lang:en`;
}
