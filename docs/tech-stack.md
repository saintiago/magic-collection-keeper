# Tech stack

## Platform

Backend workloads run on Linux. On Windows, dependency installation, builds, tests and backend
execution take place inside WSL. The browser application supports desktop and mobile browsers.

## Language and tooling

Use Node.js 24, TypeScript ES modules and npm for application code and tooling. Use esbuild to
bundle browser and Lambda code. Python remains the language for the recognition engine, with ONNX
Runtime for model execution and ONNX Runtime Web for browser recognition.

Use Zod for external input validation. Providers own their contract schemas; derive TypeScript
types from those schemas where runtime validation is needed.

Use ESLint for JavaScript and TypeScript linting, TypeScript for static checking and Prettier for
supported source and documentation formatting.

## Component boundaries

Use Dependency Cruiser to enforce TypeScript component import boundaries. Cross-component imports
use provider-owned public interfaces. Application assembles concrete implementations. Recognition's
Python implementation is accessed through its public contract.

## Validation

Use Turborepo for local validation caching and tool-native caches where appropriate. Cache only
deterministic results with their inputs declared. Live service checks are never replaced by cached
results.

Use Vitest for JavaScript and TypeScript unit, component, integration and system tests, including
contract tests. Use its assertions, spies, mocks, fake timers and setup/cleanup hooks. Use Node.js
standard filesystem and process APIs for temporary integration-test resources.

Use Playwright for browser journeys and Python unittest for recognition tests.

## Reproducible workspace

Keep dependency versions in committed lockfiles and document preparation from a fresh Linux/WSL
checkout. Provide focused component checks and an aggregate validation command covering formatting,
linting, type checking, boundaries, tests and builds as applicable. Empty suites do not establish
behavioral coverage. Verify that forbidden component imports fail the boundary check.

Configure Nexus preparation and checks to invoke these repository commands once the workspace is
implemented. The documentation-only baseline's empty command arrays are temporary bootstrap state.
Component separation does not require npm workspaces or a package per component; choose the
simplest layout that enforces the documented boundaries.

## Integrations

Use the AWS SDK for JavaScript in TypeScript services and Boto3 in Python recognition code. Keep
credentials in the execution environment and use workload roles in AWS.

Use maintained libraries or existing tools for established infrastructure. Keep integration glue
small; introduce a dependency when it reduces total implementation and maintenance complexity.

## AWS stack

Deploy in `us-east-1`.

| Area                       | Technology                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Browser delivery           | Private Amazon S3 bucket and Amazon CloudFront.                                       |
| HTTP API                   | Amazon API Gateway HTTP API with JWT authorization.                                   |
| Authentication             | Amazon Cognito; existing user pool with a separate app client for the rebuild.        |
| Application compute        | AWS Lambda with Node.js; container Lambda for Python recognition.                     |
| Catalog synchronization    | Amazon ECS standalone tasks on AWS Fargate.                                           |
| Relational storage         | Amazon Aurora PostgreSQL Serverless v2, accessed by the API through the RDS Data API. |
| Source snapshots           | Private Amazon S3 data bucket.                                                        |
| Container images           | Amazon ECR.                                                                           |
| Recognition models         | Amazon Bedrock where required by the selected recognition engine.                     |
| Access and secrets         | AWS IAM workload roles and AWS Secrets Manager.                                       |
| Database networking        | Private VPC subnets.                                                                  |
| Observability              | Amazon CloudWatch logs, metrics and alarms.                                           |
| Infrastructure definitions | AWS CloudFormation.                                                                   |
