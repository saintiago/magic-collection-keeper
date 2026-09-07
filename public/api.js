import { config, authorization } from "./auth.js";
export async function api(path, options) {
  let response;
  try {
    response = await fetch((config.apiUrl || "") + path, {
      ...options,
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
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || data.message || "Request failed. Please try again.",
    );
  return data;
}
