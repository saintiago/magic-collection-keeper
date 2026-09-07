export const config = await fetch("/config.json").then((r) => r.json());
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
      });
    } catch {
      sessionStorage.removeItem("keeper-session");
      location.reload();
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
    '<span class="status-dot"></span> Saved securely in AWS<p>A little order.<br>A lot of Magic.</p><button class="secondary" id="sign-out">Sign out</button>';
  document.getElementById("sign-out").onclick = () => {
    sessionStorage.removeItem("keeper-session");
    location.reload();
  };
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
