# GitHub Actions CI/CD design

## Status and triggers

This is the workflow design for the [CDK deployment units](deployment.md). GitHub Actions and
automatic deployment are currently disabled; implementing and activating this design is subsequent
work. The current environment is the test deployment target.

| Event                         | Validation                                                                 | Deployment                                                                            |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Pull request targeting `main` | Full repository checks and CDK synthesis/template checks.                  | None.                                                                                 |
| Push to `main` after a merge  | Repeat the same checks on the resulting committed revision.                | Changed stacks/components to the current test environment.                            |
| Manual production promotion   | Require the selected immutable release's passing test-deployment evidence. | Promote the selected changed components to production using production configuration. |

Use the repository's default branch, `main`, for merge-triggered deployment. Keep the existing
Nexus Lens merge requirement alongside CI.

## Workflow composition

Use `.github/workflows/ci-cd.yml` as the entry point for PR and `main` push events. It always runs
and calls one reusable `validate.yml` workflow. The validation workflow owns command invocation;
do not copy the same lint/test commands into each deployment workflow.

Run the repository's `npm run validate` contract: formatting, ESLint, Dependency Cruiser, TypeScript,
unit/component/integration tests, Python and browser-recognition regressions, browser journeys and
builds, with locked Linux preparation. Extend the existing infrastructure validation command to
synthesize CDK and validate its templates. Testing scope and assertions remain owned by
[testing architecture](testing.md), not by workflow YAML.

Publish one stable required `CI` result after validation. Do not apply event-level path filters
to this required workflow; test-only and documentation-only PRs still receive a result.

After successful validation on `main`, the entry workflow plans deployment and calls these separate
reusable `workflow_call` workflows when selected:

| Stack                 | Workflow                       |
| --------------------- | ------------------------------ |
| FoundationStack       | `deploy-foundation.yml`        |
| GatewayStack          | `deploy-gateway.yml`           |
| WebStack              | `deploy-web.yml`               |
| CatalogServingStack   | `deploy-catalog-serving.yml`   |
| UserCardsStack        | `deploy-usercards.yml`         |
| RecognitionStack      | `deploy-recognition.yml`       |
| CatalogIngestionStack | `deploy-catalog-ingestion.yml` |

Each workflow packages/publishes its selected artifact if applicable, prepares and inspects its
stack change set, executes the expected update, verifies the changed live boundary and records the
outcome. Common mechanics may use a shared action/script; component-specific migration, packaging
and verification stay in the component workflow. No deployment workflow runs for a PR.

A separate manually triggered `promote-production.yml` calls the same deployment workflows with
a test-verified release and production environment inputs. Reuse tested code/image/model bytes;
supply environment-specific public settings and infrastructure configuration without rebuilding code.

## Path and input mapping

Implement one version-controlled `scripts/ci/stack-inputs.json` mapping consumed by the planner.
Do not duplicate path lists across seven workflow triggers. Paths select candidate builds and stacks;
a resolved input dependency or actual artifact/template/configuration difference determines deployment.

The following is the mapping contract; `infra/cdk/` and the separate Application entry points are
the target layout defined in [deployment composition](deployment.md#source-layout-and-artifacts).

| Changed path                                                                 | Candidate deployment                                                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `infra/cdk/stacks/foundation.ts`                                             | FoundationStack.                                                                                                           |
| `infra/cdk/stacks/gateway.ts`                                                | GatewayStack.                                                                                                              |
| `infra/cdk/stacks/web.ts`                                                    | WebStack.                                                                                                                  |
| `infra/cdk/stacks/catalog-serving.ts`                                        | CatalogServingStack.                                                                                                       |
| `infra/cdk/stacks/usercards.ts`                                              | UserCardsStack.                                                                                                            |
| `infra/cdk/stacks/recognition.ts`                                            | RecognitionStack.                                                                                                          |
| `infra/cdk/stacks/catalog-ingestion.ts`                                      | CatalogIngestionStack.                                                                                                     |
| `infra/cdk/constructs/**`                                                    | Stacks importing the changed construct.                                                                                    |
| CDK entry point, shared CDK configuration or dependencies                    | Synthesize all stacks and compare; select only changed templates/configuration.                                            |
| `src/ui/**`, `src/card-list/**`, `src/capture/**`                            | WebStack.                                                                                                                  |
| `src/application/entrypoints/<unit>.ts`                                      | That entry point's stack.                                                                                                  |
| `src/catalog/**`                                                             | CatalogServingStack and CatalogIngestionStack; WebStack or other consumers only when their build imports the changed file. |
| `src/usercards/**`                                                           | UserCardsStack; WebStack only when its build imports the changed file.                                                     |
| `src/recognition/browser/**`, browser runtime/asset manifest                 | WebStack.                                                                                                                  |
| `src/recognition/python/**`                                                  | RecognitionStack; WebStack also when changed preparation inputs affect its engine/runtime/model assets.                    |
| Recognition baseline, shared engine/asset preparation or packaging manifests | RecognitionStack and WebStack as affected by their declared package inputs.                                                |
| Shared Application code and other `src/**`                                   | Builds whose source dependency graph includes the changed file.                                                            |
| `scripts/package-artifacts.ts`, `scripts/packaging-support.ts`               | Web, Catalog-serving, UserCards and Catalog-ingestion artifacts; Recognition when it imports the helper.                   |
| Other packaging scripts, Dockerfiles, Python requirements or model inputs    | The artifacts consuming them.                                                                                              |
| `package.json`, `package-lock.json`, build configuration                     | Reassess all affected build/synthesis inputs; compare outputs before deployment.                                           |
| `.github/workflows/**`, planner/mapping or deployment scripts                | Validate orchestration and re-plan affected stacks; a workflow edit alone does not force resource updates.                 |
| `tests/**`, `storybook/**`, documentation and validation-only configuration  | Run CI; no deployment unless the file is an actual production build/synthesis input.                                       |

For the current combined Application entry points and packaging command, use their actual broad
dependency graph until the split is implemented. Do not claim independent Catalog/UserCards
deployment while they still share one Lambda artifact.

Use source imports and explicit non-code package inputs together. Account for removed/renamed files
and previous input graphs, so removing a production dependency still selects the affected artifact.
If the planner cannot classify a changed input, fail planning rather than silently skip it.
Documentation/tests for the new design do not alter deployed resources.

## Selecting and executing deployment

For PR reporting, compare against the PR base. For deployment, compare each stack's desired inputs
with its last successful verified deployment in the target environment, not merely the previous
Git commit. This preserves changes from failed or skipped deployments.

Build candidate artifacts reproducibly and compare their content identities, resolved configuration
and synthesized templates with the deployed combination. Keep source provenance outside content
comparison so changing only a revision label does not deploy identical code. Preserve unchanged
artifact references in the synthesized deployment.

Deploy selected Foundation/Gateway updates before their consumers. Deploy independent component
stacks separately; when a provider contract/schema transition requires ordering, follow its staged
compatibility plan. A foundation update does not automatically deploy every consumer. Re-plan
consumer configuration when exported resource coordinates change.

Serialize deployment runs per environment without cancelling an in-progress resource update. Once
a run acquires the environment lock, refresh the deployed state and reject a stale revision that
would unintentionally downgrade a newer deployment. Inspect changes before execution, preserve
unchanged resources and verify affected boundaries using synthetic data. Existing
[operational retention and rollback rules](operations.md) still apply.

GitHub deployment jobs use OIDC with AWS roles scoped to the environment and required stack
operations. PR validation has no deployment credentials. Production promotion is manually triggered
and uses the production GitHub Environment.

A component deployment succeeds only after its live verification passes. Record each stack's source
revision, template/configuration identity, immutable artifact references, verification outcome and
previous restorable version. A deployment failure must not overwrite its last verified version;
record the actual attempted state for recovery. The environment record describes the resulting
combination, including components still running older revisions.

CloudFormation updates use the intended stack only, with explicit dependencies handled by the
planner. Avoid a blanket `cdk deploy --all`. A selected stack update may be a no-op; publishing a
candidate artifact does not imply that it must replace the deployed version.

Catalog synchronization, owner-data migration and destructive cleanup are separately invoked
operations. Neither automatic test deployment nor production promotion starts them implicitly.

## Design verification

Verify the planner against changes isolated to each deployment unit, shared imports, lockfiles,
browser recognition preparation, removals/renames, docs/tests-only changes and accumulated changes
after a failed deployment. Verify that a skipped component receives no resource update and retains
its immutable artifact reference. Check mixed-version contract compatibility and component rollback.
Keep these assertions in focused planner/infrastructure tests, rather than mirroring workflow YAML.

## References

- [GitHub Actions workflow syntax and path-filter limitations](https://docs.github.com/en/enterprise-cloud%40latest/actions/reference/workflows-and-actions/workflow-syntax)
- [AWS CDK deployment model](https://docs.aws.amazon.com/cdk/v2/guide/deploy.html)
- [GitHub Actions OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)
- [GitHub Actions deployment concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
