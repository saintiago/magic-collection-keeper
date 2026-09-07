// Provider-specific search syntax stays out of the text parser and OCR engine.
export function listQuery(row) {
  const quoted = row.name.replace(/["\\]/g, "");
  return `!"${quoted}"${row.set ? ` set:${row.set} cn:${row.number}` : ""} lang:en`;
}
export function recognitionQuery(reading) {
  if (!reading.exact) return reading.name;
  const { set, number, language = "en" } = reading.exact;
  return `set:${set} cn:${number.replace(/^0+(?=\d)/, "")} lang:${language.toLowerCase()}`;
}
