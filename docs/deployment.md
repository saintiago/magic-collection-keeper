# CDK deployment design

## Status and environment

This design is implemented by the CDK app under `infra/cdk/`. The checked-in two-template
CloudFormation definitions remain migration sources for the legacy-adoption synthesis mode; no live
stack has been adopted or split merely because the repository implementation exists.

Treat the current environment as test. Merges to the repository's default branch, `main`, will
deploy changed stacks there through [CI/CD](ci-cd.md). Production uses manual promotion of
test-verified artifacts. Classification as test does not authorize deleting existing data or
resources, or creating a replacement environment.

## Deployment composition

Use one TypeScript AWS CDK v2 app per repository, instantiated for each environment. Model
component infrastructure with focused constructs; use top-level stacks as independent deployment
units. Do not place these units inside a common nested-stack deployment.

| Stack                 | Owned resources and deployment contents                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FoundationStack       | VPC, database and task networking, shared Aurora cluster, owner-specific database secrets, shared artifact bucket, shared notification destination and database alarms. |
| GatewayStack          | Cognito app client for the retained pool, HTTP API, default stage, JWT authorizer and CORS configuration.                                                               |
| WebStack              | Private browser bucket, CloudFront delivery and bucket policy, browser release and public configuration.                                                                |
| CatalogServingStack   | Catalog query/resolution Lambda, role, logs, alarms, API routes, integrations and invocation permissions, including retained recognition lookup adapters.               |
| UserCardsStack        | UserCards Lambda, role, logs, alarms, API routes, integrations and invocation permissions.                                                                              |
| RecognitionStack      | Recognition container Lambda, ECR repository, role, logs, alarms, model-provider settings, inference/source-download routes, integrations and invocation permissions.   |
| CatalogIngestionStack | Catalog ECR repository, source-snapshot bucket, finite Fargate task and cluster, task/execution roles and logs.                                                         |

CatalogServingStack and CatalogIngestionStack are two deployments of the same Catalog component.
Deploying ingestion updates its executable definition; it never starts synchronization.

Application remains the composition layer, with separate browser, Catalog-serving, UserCards,
Recognition and ingestion entry points. It is not another deployed service. The web release
contains UserInterface, CardList, Capture, browser provider facades and browser Recognition.
Version large browser recognition assets immutably and reuse unchanged bytes between releases.

Catalog and UserCards retain separate private schemas/read-write roles within one Aurora cluster.
Owner schema upgrades are explicit steps in the owning component's deployment workflow, not
database-infrastructure updates or application-request side effects.

## Resource references and runtime contracts

Foundation exports stable resource references to consumers. Gateway exports the API ID,
authorizer ID, authentication coordinates and base URL. Component stacks own their integrations,
routes and invocation permissions; Gateway does not reference component functions. Web consumes
public gateway coordinates. Ingestion consumes foundation networking and its Catalog credentials.
Consumers receive only the resource capabilities they need.

Keep cross-stack dependencies one-way. Define grants and resource policies so that a provider
stack does not acquire a reverse dependency on its consumers. Runtime API calls do not create CDK
dependencies on another component's function version or artifact.

UserCards consumes Catalog reference resolution through a service adapter implementing Catalog's
public contract, using authenticated service access. It does not embed Catalog's PostgreSQL
implementation or receive Catalog storage credentials. This boundary adds a network failure mode
to operations requiring resolution; the adapter preserves the existing error and deadline contract.
Ordinary private reads remain independent of Catalog resolution.

Recognition/browser adapters use the stable Catalog routes for candidate resolution. Preserve
the existing authentication policy and provider-owned behavior when dividing the current routes.
Each workload retains only its own data and secret permissions.

Compatible provider implementation changes require consumer validation, not consumer deployment.
Schema upgrades retain compatibility with the previous deployed version for rollback. Breaking
contracts need a staged provider/consumer transition, including already-open browser sessions.

## Source layout and artifacts

Keep infrastructure under `infra/cdk/`: one composition entry point, an environment configuration
module, a `stacks/` directory and focused `constructs/` modules. Use these stack file stems:

- `foundation.ts`, `gateway.ts`, `web.ts`
- `catalog-serving.ts`, `usercards.ts`, `recognition.ts`, `catalog-ingestion.ts`

Separate production Application entry-point wiring under `src/application/entrypoints/` using
`web.ts`, `catalog-serving.ts`, `usercards.ts` and `catalog-ingestion.ts`. Recognition retains its
Python entry point. Shared transport/composition helpers may remain shared; they do not own domain
policy. These files are the production layout. The legacy entry points remain for migration
compatibility and are not packaging inputs.

Build application artifacts before synthesis. CDK receives immutable artifact references from a
release manifest and preserves the deployed references for unchanged components. Synthesis does
not implicitly build every application or download recognition models. Configuration is explicit;
browser settings are public, and credentials remain secret references or workload identity.

A source revision in release metadata must not by itself change every deployed template or bundle.
Stack selection and publication follow [CI/CD's input mapping](ci-cd.md#path-and-input-mapping).

## Migration and recovery

First establish CDK management of the deployed templates while preserving stack/resource identities
and settings. Then split resources into the target stacks as separately reviewed refactoring steps.
Do not combine resource moves with application behavior changes. Existing exported values remain
available while deployed consumers and rollback versions depend on them.

Inspect the actual deployed templates and change plans; repository templates alone do not establish
the live state. Use resource-preserving migration/refactoring where supported. Retain authoritative
storage, existing account identities, recovery artifacts and source archives. A stack move must not
replace the database, rerun collection migration or implicitly populate the Catalog.

Rollback restores the affected component's previous artifact/configuration and verifies its live
boundary. It does not replay catalog ingestion, imports or owner-data migration. Persistent resources
retain their existing backup, retention and deletion-protection obligations.

## References

- [AWS CDK: model with constructs, deploy with stacks](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)
- [Migrate existing CloudFormation to CDK](https://docs.aws.amazon.com/cdk/v2/guide/migrate.html)
- [CloudFormation stack refactoring](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/stack-refactoring.html)
