# Build and release operations

## Rebuild delivery policy

GitHub Actions CI and automatic deployment remain disabled during the rebuild. Pushes, pull requests
and merges do not deploy the service. Nexus runs the repository's committed preparation and
validation commands (README.md). A passing task check is not deployed verification.

Nexus Lens review is required for merges to main during Nexus execution. The required check is
`Nexus Lens review`, published by the configured Nexus Lens GitHub App. This review gate is enabled
independently of GitHub Actions CI and automatic deployment.

Builds and deployment preparation remain part of development. Execute deployments explicitly against
the intended environment; production cutover and collection migration require the owner's concrete
authorization. Existing production resources and collection data remain intact. Introducing CI/CD
later requires a separate decision.

## Infrastructure

Define the AWS stack in CloudFormation using validated environment parameters. New resources are
isolated from the existing application; retain the existing Cognito user pool and create a separate
app client. Use least-privilege roles, private database networking and secret references.

Document create/update, rollback and data-retention procedures together with operating-cost
assumptions. Catalog synchronization runs as finite tasks. Infrastructure preparation does not
authorize resource creation, deletion or provisioned/periodic warm compute.

Validate templates and inspect an applicable change plan before execution. Check the configured
identity and network boundaries; a valid template alone does not prove deployed authorization.

## Packaging and deployment

Build reproducible browser, backend and catalog-job artifacts from the committed dependencies.
Identify the source revision and artifact versions so the deployed combination can be inspected
and restored. Keep public browser settings separate from secrets and redact sensitive diagnostics.

Provide explicit deployment and rollback commands with documented environment inputs. Preserve
authenticated account context through database operations and expose finite catalog synchronization
as a separate job. Verify packages locally, then validate changed live boundaries in an isolated
environment. Do not add health/readiness endpoints without a concrete requirement.

## Recognition packaging

Package the retained Python engine for container Lambda and browser inference as compatible
workers/runtime/model assets. Verify the pinned manifests and hashes. Supply authenticated service
access and the required model-provider settings without changing matching behavior or thresholds.

Ship notices and the corresponding-source download for the exact deployed version. Document model
preparation and rollback, measure cold/warm execution and resource use, and run packaged engine
regressions. Live Lambda/model-provider checks and physical-camera acceptance are separate evidence.

## Release acceptance

Keep a repository release checklist tied to documented requirements and verification evidence.
Rehearse deployment, rollback, collection migration and restoration in a separate test environment.
Verify reproducibility from a fresh checkout and preserve existing account identity and production
storage during the rehearsal.

Record unresolved provider, physical-device and collection-reconciliation checks explicitly. Present
the concrete production actions and recovery procedure before cutover; preparation does not imply
authorization to mutate owner data or delete the previous environment. Record source completion,
deployment and production acceptance separately.
