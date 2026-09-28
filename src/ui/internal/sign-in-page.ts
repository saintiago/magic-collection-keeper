/**
 * The deployment's sign-in interaction (docs/application.md#configuration-and-lifecycle,
 * docs/user-interface.md#pages-and-navigation).
 *
 * The visitor signs in against this environment's user pool through a page of this build, not a
 * modal window: the form takes the place of the shell's current page content with its own heading
 * and the fields the step needs, and the region returns to the page it presented when the step
 * settles. A refused sign-in leaves the visitor on the view they came from, where the shell's
 * status reports what happened and the sign-in action is offered again, and a completed one
 * presents the view the URL names. Nothing the visitor typed is retained anywhere else.
 */

import type { BrowserCredentialPrompt } from '../../application/index.js';

/** Renders the credential prompt of this document; the page is created per sign-in step. */
export function createCredentialPrompt(root: Element): BrowserCredentialPrompt {
  const document = root.ownerDocument;
  return {
    request(mode, account) {
      const page = document.createElement('section');
      const heading = document.createElement('h1');
      heading.tabIndex = -1;
      heading.textContent = mode === 'sign-in' ? 'Sign in' : 'Choose a password';
      const hint = document.createElement('p');
      hint.textContent =
        mode === 'sign-in'
          ? 'Sign in with the username and password of your account.'
          : 'This account signs in for the first time; choose its password.';

      const form = document.createElement('form');
      const username = document.createElement('input');
      username.name = 'username';
      username.autocomplete = 'username';
      username.required = true;
      username.value = account ?? '';
      const usernameLabel = document.createElement('label');
      usernameLabel.textContent = 'Username';
      usernameLabel.append(username);
      if (mode === 'new-password') {
        username.readOnly = true;
      }

      const password = document.createElement('input');
      password.name = 'password';
      password.type = 'password';
      password.autocomplete = mode === 'sign-in' ? 'current-password' : 'new-password';
      password.required = true;
      const passwordLabel = document.createElement('label');
      passwordLabel.textContent = mode === 'sign-in' ? 'Password' : 'New password';
      passwordLabel.append(password);

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = mode === 'sign-in' ? 'Sign in' : 'Set password and continue';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      form.append(heading, hint, usernameLabel, passwordLabel, submit, cancel);
      page.append(form);

      // The prompt is one page of the shell's page region; the region keeps what it presented
      // before, so settling the step restores the view the visitor came from.
      const region = readPageRegion(root);
      const previous = [...region.childNodes];
      region.replaceChildren(page);

      return new Promise<{ readonly username: string; readonly password: string }>(
        (resolve, reject) => {
          let settled = false;
          const close = (outcome: 'resolve' | 'reject'): void => {
            if (settled) {
              return;
            }
            settled = true;
            const values = { username: username.value, password: password.value };
            if (page.parentNode === region) {
              region.replaceChildren(...previous);
            }
            if (outcome === 'resolve') {
              resolve(values);
            } else {
              reject(new Error('Sign-in was cancelled.'));
            }
          };
          cancel.addEventListener('click', () => {
            close('reject');
          });
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!form.reportValidity()) {
              return;
            }
            close('resolve');
          });
          heading.focus();
        },
      );
    },
  };
}

/** The page region of this shell; a root without one presents the prompt as its content. */
function readPageRegion(root: Element): Element {
  return root.querySelector('main') ?? root;
}
