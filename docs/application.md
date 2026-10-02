# Application

## Responsibility

Assemble the application, validate configuration and establish trusted request context. Own
entry points and runtime lifecycle. Business decisions stay with their owning component.

## Interface

- Construct Catalog, UserCards, Recognition, CardList and Capture through their public contracts; supply
  UserInterface with the capabilities and public configuration it needs.
- Accept authenticated requests, validate their transport input and dispatch to the owning
  component. Derive user identity from verified authentication context, never a supplied owner ID.
- Supply UserCards with trusted user context for private queries and operations.
- Expose catalog synchronization as a separate job entry point. Recognition has its own compute
  entry point; both use the same configuration and authentication principles.
- Dispatch public queries to Catalog and private queries/fragments to UserCards. Query routes
  preserve provider errors and pagination; transport does not evaluate or combine membership.
- Translate component results and failures into consistent transport responses without exposing
  storage details, credentials or provider exceptions.

Browser composition supplies CardList with read/fragment capabilities and Capture with recognition
and staging capabilities. UserCards supplies the client operation facade, including recovery and
change invalidation; transport code does not implement these semantics. UserInterface receives ready
capabilities rather than constructing clients. Concrete wiring remains separate from the supplied
component interfaces, including the browser-only components.

The supplied UserCards account lookup accepts only the current authenticated account. This check
also applies when a retained Capture factory constructs staging, before acquiring device or inference
resources. Account departure releases existing scopes; signing in again permits a fresh scope.

Supply CardList with Catalog public query/resolution and UserCards private query/fragment clients.
Forward UserCards local invalidations within the account lifetime. There is no Search constructor,
indexing job/configuration, publication-reader credential or browser indexing-status capability.
UI receives list loading and operation outcomes through its existing provider interfaces.

### Construction and request boundary

Receive explicit implementations of the required component contracts, resource settings and
identity verification. Construction validates compatibility before serving requests. Production
wiring selects concrete implementations; component tests supply alternatives.

Each backend invocation carries verified account context when required, request identity and a
cancellation/deadline signal. Operations that promise replay accept a separate operation ID so retries
can refer to the same action. Invalid authentication never reaches private operations.

Map validation, unauthorized access, missing records, revision conflict, stale continuation, busy
and unavailable outcomes without collapsing them into an empty success. Do not infer a failed write
from a lost response. The owning component's operation receipt determines its committed outcome.

## Internal design

| Unit                   | Owns                                                                            | Excludes                                                         |
| ---------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Deployment composition | Concrete construction and resource binding for one runtime.                     | Request handling and business decisions.                         |
| Runtime boundary       | Validated settings, serving/disposed state, request deadlines and job dispatch. | Database selection and component internals.                      |
| Authentication         | Credential verification and trusted request context.                            | Ownership and membership rules.                                  |
| Transport mapping      | Routes, envelopes, serialization and failure translation.                       | Printing selection, query evaluation and import decisions.       |
| Browser composition    | Authenticated access, supplied browser factories and account-scoped lifetimes.  | Presentation, list loading, capture and domain operation policy. |

Deployment wiring supplies separate storage roles for each owner and purpose. Query credentials read
only their owner's data; mutation credentials write only their owner's data. Public lookup and
private query clients use provider-owned capabilities rather than cross-owner SQL access. A TypeScript query
method alone does not enforce database permissions.

The runtime receives ready component implementations. Its settings do not require database or bucket
coordinates. The default deployment constructor validates those resource settings before composing the
runtime. Construction checks callable capabilities; behavioral compatibility is established by contract
tests. Supplied resources remain owned by the caller and are not closed by runtime disposal.

Compatibility endpoints translate retained request and response formats only. They dispatch selection
to the provider's published lookup policy. They must not scan or filter provider records with their own
matching rules. Browser composition permits replacement browser capabilities without changing
transport or page code.

## Configuration and lifecycle

Use explicit construction functions. Configuration identifies environment, resources, credentials
and enabled capabilities. Validate it before accepting work and expose only public settings to the
browser. Keep development, test and production identities and storage separate.

Interactive backend components can share a deployment without sharing internal modules or mutable
request state. Per-request identity, cancellation and diagnostics remain isolated. Release temporary
resources when work completes; retain reusable clients only when safe between requests.

Diagnostics identify the operation and failure without logging credentials, images or private
collection contents. Background job failures also report the failing stage and sanitized provider
error classification/correlation identity when available; a generic unavailable outcome alone is
insufficient for diagnosis. Do not log raw exception messages, response bodies, SQL or bound values.
A transport timeout does not establish whether a write committed; return or
recover the operation's recorded outcome before retrying it.
