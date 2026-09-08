// Provider-specific search syntax stays out of the text parser and OCR engine.
export function listQuery(row) {
  const quoted = row.name.replace(/["\\]/g, "");
  return `!"${quoted}"${row.set ? ` set:${row.set} cn:${row.number}` : ""} lang:en`;
}
export function recognitionQuery(reading) {
  if (!reading.exact) return recognitionNameQuery(reading.name);
  const { set, number, language = "en" } = reading.exact;
  if (
    !/^[a-z0-9]{2,8}$/i.test(set) ||
    !/^[0-9]+[a-z★†]?$/i.test(number) ||
    !/^[a-z]{2,5}$/i.test(language)
  )
    return recognitionNameQuery(reading.name);
  return `set:${set} cn:${number.replace(/^0+(?=\d)/, "")} lang:${language.toLowerCase()}`;
}

export function recognitionNameQuery(name = "") {
  const literal = name
    .replace(/["\\\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return /\p{L}{3}/u.test(literal) ? `!"${literal}"` : "";
}
