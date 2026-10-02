# Local design storybook

## Purpose and interface

Provide a local workspace for inspecting and iterating the application's appearance and interaction
states. The workflow is design language, then the mocked app, then explicit frontend deployment.
Performance measurement is outside this workspace's scope.

Reuse [UserInterface](architecture.md)'s actual presentation code and styles. The local composition
supplies mock implementations through the existing provider-owned public contracts described in
[the system architecture](../architecture.md#composition-and-replacement). It does not maintain a
second implementation of the screens or add mock behavior to production components.

## Two parts

- **Mocked app:** the current interface, screens and navigation with a fixed local identity and no
  authorization or sign-in flow. All API calls and database-backed capabilities use local fixtures
  and mocks. Changes affect only local mock state, so the existing workflows can be inspected.
- **Design language:** one page showing the common presentation elements used by those screens,
  including typography, colors, spacing, controls, card views, dialogs and notices. Show their
  applicable loading, disabled, empty, validation, success and error presentations using the same
  presentation code as the app.

## Manual state progression

An action that starts asynchronous work immediately presents the real UI's loading or pending state.
The mock holds that state indefinitely until the operator presses Space. Each Space press advances
one next visible stage of that action; any subsequent loading or transient stage waits for another
press. An action with only loading and completion needs one press. Staged content can expose basic
content before images or optional fragments finish, allowing each intermediate presentation to be
examined. Initial page loading follows the same rule.

Progression is deliberate and repeatable, without simulated latency, automatic completion or timed
expiry of an inspectable transient state. The local controller gates mock completions and the local
presentation timing needed to hold those states; it does not impose a new workflow state machine on
the deployed app. Ordinary animation, such as a spinner, may continue while its state is held.

Space advances the pending stage rather than scrolling or retriggering the focused action. Preserve
normal Space input when editing text; a held key must not skip several stages. With no pending stage,
Space does not advance anything. Keep this keyboard behavior within the local workspace.

## Isolation and iteration

Run from a separate local entry point on localhost in WSL. No real account, credentials, database,
API service or external runtime assets are needed. Supply local images and other fixtures rather
than reaching external services. Keep mocks, fixtures, the stepping controller and workspace tooling
outside deployable artifacts; production startup and authorization remain unchanged.

Editing shared UI code or styles updates the local workspace promptly and reaches the frontend only
through its normal build and explicit deployment. Adding the workspace itself does not redesign the
current interface or change application behavior. [Operations](../operations.md#local-design-workspace)
owns startup and packaging, and [Testing](../testing.md#local-design-storybook) owns verification.
