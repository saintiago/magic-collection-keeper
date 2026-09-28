/**
 * The deployment's sign-in interaction (docs/application.md#configuration-and-lifecycle,
 * docs/user-interface.md#interface).
 *
 * The visitor signs in against this environment's user pool through a modal form the deployment
 * renders; the account and the tokens stay with the authentication boundary, so the shell only
 * receives the verified account it presents. A closed or cancelled form rejects the sign-in the
 * shell is running, and nothing the visitor typed is retained anywhere else.
 */

import type { BrowserCredentialPrompt } from './cognito.js';

/** Renders the credential prompt of this document; the form is created per sign-in. */
export function createCredentialPrompt(document: Document): BrowserCredentialPrompt {
  return {
    request(mode, account) {
      const dialog = document.createElement('dialog');
      const form = document.createElement('form');
      form.method = 'dialog';
      const heading = document.createElement('h2');
      heading.textContent = mode === 'sign-in' ? 'Sign in' : 'Choose a password';
      const hint = document.createElement('p');
      hint.textContent =
        mode === 'sign-in'
          ? 'Sign in with the username and password of your account.'
          : 'This account signs in for the first time; choose its password.';

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

      const error = document.createElement('p');
      error.setAttribute('role', 'alert');
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = mode === 'sign-in' ? 'Sign in' : 'Set password and continue';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      form.append(heading, hint, usernameLabel, passwordLabel, error, submit, cancel);
      dialog.append(form);
      document.body.append(dialog);

      return new Promise<{ readonly username: string; readonly password: string }>(
        (resolve, reject) => {
          let settled = false;
          const close = (outcome: 'resolve' | 'reject'): void => {
            if (settled) {
              return;
            }
            settled = true;
            const values = { username: username.value, password: password.value };
            dialog.close();
            dialog.remove();
            if (outcome === 'resolve') {
              resolve(values);
            } else {
              reject(new Error('Sign-in was cancelled.'));
            }
          };
          cancel.addEventListener('click', () => {
            close('reject');
          });
          dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            close('reject');
          });
          form.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!form.reportValidity()) {
              return;
            }
            close('resolve');
          });
          dialog.showModal();
          username.focus();
        },
      );
    },
  };
}
