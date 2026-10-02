# Build and release operations

## Rebuild delivery policy

GitHub Actions validation and selective deployment are implemented as described by
[GitHub Actions CI/CD](ci-cd.md). The required workflow validates pull requests and merges to `main`;
automatic test deployment remains inactive until `DEPLOYMENT_ENABLED=true` is set after the current
environment's CDK baseline and deployment record are verified. Until that activation, pushes, pull
requests and merges do not deploy the service. Nexus runs the repository's committed preparation and
validation commands (README.md). A passing task check is not deployed verification.

Nexus Lens review is required for merges to main during Nexus execution. The required check is
`Nexus Lens review`, published by the configured Nexus Lens GitHub App. This review gate is enabled
independently of GitHub Actions CI and automatic deployment.

Builds and deployment preparation remain part of development. Execute deployments explicitly against
the intended environment; production cutover and collection migration require the owner's concrete
authorization. Existing production resources and collection data remain intact. The CI/CD target is agreed; its activation follows the documented environment and promotion boundaries.

## Infrastructure

Define the target AWS stacks in TypeScript CDK v2, synthesizing CloudFormation with validated
environment configuration ([deployment design](deployment.md)). The existing templates remain the
transitional implementation. New resources are
isolated from the existing application; retain the existing Cognito user pool and create a separate
app client. Use least-privilege roles, private database networking and secret references.

Document create/update, rollback and data-retention procedures together with operating-cost
assumptions. Catalog synchronization runs as a finite task; ordinary queries read their owning storage directly.
Infrastructure preparation does not authorize resource creation, deletion or provisioned/periodic
warm compute.

Validate templates and inspect an applicable change plan before execution. Check the configured
identity and network boundaries; a valid template alone does not prove deployed authorization.

## Packaging and deployment

Build reproducible browser, backend and background-job artifacts from the committed dependencies.
Identify the source revision and artifact versions so the deployed combination can be inspected
and restored. Keep public browser settings separate from secrets and redact sensitive diagnostics.

Provide explicit deployment and rollback commands with documented environment inputs. Preserve
authenticated account context through database operations and expose finite catalog synchronization
as a separate job. Verify packages locally, then validate changed live boundaries
in an isolated environment. Do not add health/readiness endpoints without a concrete requirement.

## Browser and API connectivity

The deployed browser must reach the API from its own origin. CORS preflight requests return a
successful response without authentication; actual operations retain their documented authentication.
Verify this boundary through a browser workflow that loads and changes synthetic collection data,
including the resulting current list and private fragments. Direct API calls alone do not establish browser connectivity.

## Recognition packaging

Package the retained Python engine for container Lambda and browser inference as compatible
workers/runtime/model assets. Verify the pinned manifests and hashes. Supply authenticated service
access and the required model-provider settings without changing matching behavior or thresholds.

Ship notices and the corresponding-source download for the exact deployed version. Document model
preparation and rollback, measure cold/warm execution and resource use, and run packaged engine
regressions. Live Lambda/model-provider checks and physical-camera acceptance are separate evidence.

## Release acceptance

Keep a repository release checklist tied to documented requirements and verification evidence:
[the release checklist](release-checklist.md), whose `npm run release:evidence` writes the prepared
release's acceptance record beside `artifacts/manifest.json`. During the rebuild, prepare release
evidence and deployment/rollback procedures using test data.
Offline [migration preparation](migration.md) follows the rebuild. Actual owner-data rehearsal and
cutover remain separately authorized; they do not block rebuild verification.
Rehearse deployment and rollback in a separate test environment only when execution is authorized.
Verify reproducibility from a fresh checkout and preserve existing account identity and production
storage during the rehearsal.

Record unresolved provider, physical-device and collection-reconciliation checks explicitly. Present
the concrete production actions and recovery procedure before cutover; preparation does not imply
authorization to mutate owner data or delete the previous environment. Record source completion,
deployment and production acceptance separately.

## Local design workspace

Provide `npm run storybook` to start the [design storybook](ui/storybook.md) from the WSL checkout,
bound to localhost and accessible in the owner's browser. Support rapid updates when shared UI code
or styles change. Startup requires no deployed configuration, authentication, database or API.

Use a separate entry point and output from production packaging. Do not include workspace pages,
mocks, fixtures, stepping controls or development dependencies in deployable browser/backend/job
artifacts. Starting or updating this local workspace does not deploy anything.
