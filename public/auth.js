import { clearSnapshotCaches } from "./collection-cache.js";
export const config = await fetch(
  new URL("./config.json", import.meta.url),
).then((r) => r.json());
let tokens;
try {
  tokens = JSON.parse(sessionStorage.getItem("keeper-session") || "null");
} catch {
  sessionStorage.removeItem("keeper-session");
}
async function cognito(target, body) {
  const response = await fetch(
    `https://cognito-idp.${config.region}.amazonaws.com/`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Sign-in failed.");
  return data;
}
function store(result) {
  tokens = { ...result, expires: Date.now() + result.ExpiresIn * 1000 };
  sessionStorage.setItem("keeper-session", JSON.stringify(tokens));
}
export async function authorization() {
  if (config.local) return {};
  if (tokens && Date.now() > tokens.expires - 60000) {
    try {
      const data = await cognito("InitiateAuth", {
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: config.clientId,
        AuthParameters: { REFRESH_TOKEN: tokens.RefreshToken },
      });
      store({
        ...data.AuthenticationResult,
        RefreshToken: tokens.RefreshToken,
        account: tokens.account,
      });
    } catch {
      await signOut();
      throw new Error("Session expired. Please sign in again.");
    }
  }
  return { Authorization: `Bearer ${tokens?.IdToken}` };
}
export async function signIn() {
  if (config.local) return;
  document.querySelector(".local-badge").textContent =
    "◉ Private cloud collection";
  document.querySelector(".sidebar-bottom").innerHTML =
    '<button class="text-button" id="sign-out">Sign out</button>';
  document.getElementById("sign-out").onclick = () => signOut();
  if (tokens) return;
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.innerHTML =
    '<div class="eyebrow">WELCOME TO KEEPER</div><h2>Your collection, just for you.</h2><p class="hint">Sign in with the username and temporary password from your invitation.</p><form id="login-form"><label>Username<input name="username" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><p id="login-error" role="alert"></p><button class="primary full">Sign in</button></form>';
  document.body.append(dialog);
  dialog.oncancel = (e) => e.preventDefault();
  dialog.showModal();
  await new Promise((resolve) => {
    let challenge;
    dialog.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target,
        button = form.querySelector("button");
      button.disabled = true;
      try {
        const data = challenge
          ? await cognito("RespondToAuthChallenge", {
              ClientId: config.clientId,
              ChallengeName: "NEW_PASSWORD_REQUIRED",
              Session: challenge.Session,
              ChallengeResponses: {
                USERNAME:
                  challenge.ChallengeParameters.USER_ID_FOR_SRP ||
                  form.username.value,
                NEW_PASSWORD: form.password.value,
              },
            })
          : await cognito("InitiateAuth", {
              AuthFlow: "USER_PASSWORD_AUTH",
              ClientId: config.clientId,
              AuthParameters: {
                USERNAME: form.username.value,
                PASSWORD: form.password.value,
              },
            });
        if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
          challenge = data;
          form.username.readOnly = true;
          form.password.value = "";
          form.password.autocomplete = "new-password";
          form.password.minLength = 12;
          dialog.querySelector(".hint").textContent =
            "Choose a new password: at least 12 characters with uppercase, lowercase, a number, and a symbol.";
          button.textContent = "Set password & continue";
          form.password.focus();
        } else if (data.AuthenticationResult) {
          await clearSnapshotCaches();
          store(data.AuthenticationResult);
          dialog.close();
          dialog.remove();
          resolve();
        } else
          throw new Error(
            "This sign-in challenge is not supported. Contact the app owner.",
          );
        document.getElementById("login-error")?.replaceChildren();
      } catch (error) {
        document.getElementById("login-error").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
  });
}

let accountGeneration = 0;
export async function signOut(broadcast = true) {
  accountGeneration++;
  tokens = null;
  sessionStorage.removeItem("keeper-session");
  window.dispatchEvent(new Event("keeper-sign-out"));
  if (broadcast) {
    try {
      localStorage.setItem("keeper-sign-out", crypto.randomUUID());
    } catch {}
  }
  await clearSnapshotCaches();
  location.reload();
}
window.addEventListener("storage", (event) => {
  if (event.key === "keeper-sign-out") signOut(false);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
export async function collectionIdentity() {
  const environment = JSON.stringify([
    location.origin,
    config.apiUrl || "local",
    config.clientId || "local",
  ]);
  if (config.local) return { environment, owner: "local" };
  const generation = accountGeneration;
  const headers = await authorization();
  if (tokens?.account?.environment === environment) return tokens.account;
  const response = await fetch((config.apiUrl || "") + "/api/session", {
    headers,
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok)
    throw new Error(
      "Could not verify your account. Retry to load your collection.",
    );
  const identity = await response.json();
  if (generation !== accountGeneration || !tokens)
    throw new Error("Session changed. Please sign in again.");
  if (typeof identity.owner !== "string" || !identity.owner)
    throw new Error("Account identity unavailable.");
  // Only the JWT-protected server supplies the owner; never decode an unverified JWT for cache selection.
  tokens.account = { environment, owner: identity.owner };
  sessionStorage.setItem("keeper-session", JSON.stringify(tokens));
  return tokens.account;
}
