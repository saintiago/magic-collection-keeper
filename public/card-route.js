const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const validCardId = (value) => uuid.test(value || "");
export function cardHref(ref) {
  const params = new URLSearchParams({
    card: ref.printing_id || "",
    oracle: ref.oracle_id || "",
  });
  if (ref.entry) params.set("entry", ref.entry);
  if (ref.lang && ref.lang !== "en") params.set("lang", ref.lang);
  return "#" + params;
}
export function cardFromHash(hash) {
  if (!hash.startsWith("#card=")) return null;
  const params = new URLSearchParams(hash.slice(1));
  const ref = {
    printing_id: params.get("card"),
    oracle_id: params.get("oracle"),
    entry: params.get("entry") || "",
    lang: params.get("lang") || "en",
  };
  return validCardId(ref.printing_id) &&
    validCardId(ref.oracle_id) &&
    /^[a-z]{2,5}$/.test(ref.lang) &&
    ref.entry.length <= 256
    ? ref
    : { invalid: true };
}
