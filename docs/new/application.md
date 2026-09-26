# Application

## Responsibility

Assemble the application, validate configuration and establish trusted request context. Own
entry points and runtime lifecycle. Business decisions stay with their owning component.

## Interface

- Construct Catalog, UserCards, Search and Recognition through their public contracts; supply
  UserInterface with the capabilities and public configuration it needs.
- Accept authenticated requests, validate their transport input and dispatch to the owning
  component. Derive user identity from verified authentication context, never a supplied owner ID.
- Supply Search and UserCards with trusted user context. Their contracts enforce private access.
- Expose catalog synchronization as a separate job entry point. Recognition has its own compute
  entry point; both use the same configuration and authentication principles.
- Translate component results and failures into consistent transport responses without exposing
  storage details, credentials or provider exceptions.

## Configuration and lifecycle

Use explicit construction functions. Configuration identifies environment, resources, credentials
and enabled capabilities. Validate it before accepting work and expose only public settings to the
browser. Keep development, test and production identities and storage separate.

Interactive backend components can share a deployment without sharing internal modules or mutable
request state. Per-request identity, cancellation and diagnostics remain isolated. Release temporary
resources when work completes; retain reusable clients only when safe between requests.

Diagnostics identify the operation and failure without logging credentials, images or private
collection contents. A transport timeout does not establish whether a write committed; return or
recover the operation's recorded outcome before retrying it.
