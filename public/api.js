import { config, authorization } from "./auth.js";
let sessionGeneration = 0;
window.addEventListener("keeper-sign-out", () => sessionGeneration++);
export async function api(path, options) {
  const generation = sessionGeneration;
  let response;
  try {
    response = await fetch((config.apiUrl || "") + path, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(35000),
      headers: {
        "Content-Type": "application/json",
        ...(await authorization()),
        ...options?.headers,
      },
    });
  } catch {
    throw new Error(
      "Could not reach the collection service. Check your connection and try again.",
    );
  }
  if (generation !== sessionGeneration)
    throw new Error("Session changed. Please sign in again.");
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The collection service returned an unreadable response. Please retry.",
    );
  }
  if (generation !== sessionGeneration)
    throw new Error("Session changed. Please sign in again.");
  if (!response.ok)
    throw new Error(
      data.error || data.message || "Request failed. Please try again.",
    );
  return data;
}
