# Release checklist

The repository release checklist of [release acceptance](operations.md#release-acceptance). One
release is one committed revision and the artifacts built from it. This checklist records what has
been established for that release and what has not, with source completion, deployment and
production acceptance kept separate. Preparation never authorizes a deployment, a collection
migration, access to owner data or deletion of the previous environment.

The records use per-stack artifact identities and an environment record of the deployed combination
([CI/CD](ci-cd.md#selecting-and-executing-deployment)). Unchanged components retain their previous
artifact and source revision; one repository revision does not force a coordinated redeployment.

## Release records

| Record                                | Written by                                                                  | Contents                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts/manifest.json`             | `npm run package`                                                           | Source revision, version label and the byte size and SHA-256 of every artifact ([packaging and deployment](operations.md#packaging-and-deployment)).        |
| `artifacts/recognition/manifest.json` | `npm run package:recognition`                                               | Engine, model, browser and corresponding-source identities of the recognition image context ([recognition packaging](operations.md#recognition-packaging)). |
| `artifacts/release.json`              | Deployment environment-record capture ([Create](../infra/README.md#create)) | Environment plus Catalog-serving/UserCards object keys and versions and Recognition/Catalog-ingestion image digests.                                        |
| `artifacts/release-evidence.json`     | `npm run release:evidence -- --out artifacts`                               | The acceptance record: the stages below, every verified release byte and the unresolved checks.                                                             |

Keep the complete release directory — manifest, release record, evidence record, packaged
`browser/` directory and recognition context — before packaging a replacement: it is what the
rollback below restores, together with the artifact bucket's object version and the immutable image
tags ([packaging and publication](../infra/README.md#packaging-and-publication)).

## Source completion

Run from a fresh Linux/WSL checkout of the release revision
([workspace preparation](../README.md#workspace-preparation)), on test data only:

| Check                      | Requirement                                                                              | Evidence                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Locked preparation         | [Reproducible workspace](tech-stack.md#reproducible-workspace)                           | `npm ci` and `npm run install:browsers`                                                                                 |
| Aggregate checks           | [Checks](../README.md#checks), [integrated acceptance](testing.md#integrated-acceptance) | `npm run validate` over the release revision                                                                            |
| Reproducible artifacts     | [Packaging and deployment](operations.md#packaging-and-deployment)                       | `npm run package`; `tests/integration/packaging.test.ts` rebuilds the same bytes and verifies every digest              |
| Recognition packaging      | [Recognition packaging](operations.md#recognition-packaging)                             | `npm run package:recognition` verifies the pinned manifests, hashes and corresponding-source download                   |
| Infrastructure definitions | [Infrastructure](operations.md#infrastructure)                                           | `npm run lint:infrastructure`; legacy-template and `tests/integration/cdk-stacks.test.ts` checks                        |
| Acceptance evidence        | This checklist                                                                           | `npm run release:evidence -- --out artifacts` re-verifies every recorded byte and writes the stages beside the manifest |

The release revision is the packaging manifest's `revision`, and the packaging and recognition
manifests' `workingTree` must both be `clean`: artifacts built from uncommitted changes cannot be
restored. Record the command output with the release. `release-evidence.json` records source
completion only when every byte the packaging and recognition manifests name still matches, the
recognition image context (when it is packaged) belongs to the same release, and its browser assets
are the ones the packaged browser manifest carries. The deployment record, when one exists, has to
name this release as well.

Package the browser after `npm run prepare:recognition`, because the browser bundle carries the
prepared recognition assets; the evidence command rejects a recognition context whose browser
assets the packaged `browser/` directory does not carry.

## Deployment in an isolated environment

A deployment happens only with the owner's explicit authorization
([rebuild delivery policy](operations.md#rebuild-delivery-policy)) and, during the rebuild, only in
an isolated test environment with test data. The concrete procedure is
[Create](../infra/README.md#create):

1. Inspect each selected CloudFormation change set before executing it, following provider-before-
   consumer order and deploying no unchanged stack.
2. Publish the artifacts of the release revision: Catalog-serving and UserCards zips under their
   separate `releases/<version>/` keys with object versions, and Recognition/Catalog-ingestion
   images by digest
   ([packaging and publication](../infra/README.md#packaging-and-publication)).
3. Build the browser bundle from captured Gateway/Web outputs, publish it and invalidate the
   distribution, so only public settings reach the browser.
4. Capture the resulting multi-stack combination into `artifacts/release.json`. Starting finite
   Catalog ingestion is a separate explicit operation; when authorized, verify its test snapshot,
   public queries and authoritative private reads.
5. Verify the changed live boundaries and keep the results separate from the local checks: change
   plan, deployed artifacts, identity and routing, network, IAM, data path, delivery and alarms
   ([Verification](../infra/README.md#verification)).
6. Confirm continuity: the retained Cognito user pool and its accounts stay in place and only the
   rebuild's app client is added ([infrastructure](operations.md#infrastructure)); the environment
   reads synthetic test data, never the owner's collection, and creates or removes only resources
   isolated from the existing production application
   ([contracts and cooperation](testing.md#contracts-and-cooperation)).
7. Rehearse rollback before calling the rehearsal complete: restore each changed component's prior
   artifact/configuration, restore the previous browser bundle where applicable, and verify that the
   test account's identity and data are unchanged without rerunning Catalog ingestion
   ([rollback and recovery](#rollback-and-recovery)). Keep the candidate's captured
   `artifacts/release.json`: capturing the stack's parameters again while the previous release runs
   would replace the candidate's record with the previous release's.
8. Record the candidate's deployment stage from its preserved release record by re-running the
   evidence command, and keep the rollback outcome — previous parameters and browser bundle back in
   place, no data job replayed, identity and data unchanged — with the rehearsal evidence. The
   rehearsal is deployment evidence for the `test` environment, not production acceptance.

## Production acceptance

Recorded only after the owner authorizes production cutover, and only once source completion and the
test-environment rehearsal above are recorded:

1. The owner authorizes the cutover ([release acceptance](operations.md#release-acceptance)). The
   collection migration is authorized and planned separately
   ([collection migration](requirements.md#collection-migration)).
2. The production deployment follows the same steps with `Environment=production`, the production
   app client of the retained pool and the artifacts pinned by version and digest
   ([Create](../infra/README.md#create)).
3. The collection migration runs as its own authorized procedure with the verification its plan
   defines; the rebuild does not design, implement or rehearse it.
4. Production acceptance is recorded separately from source completion and deployment: the live
   boundary checks of [Verification](../infra/README.md#verification) plus the owner's acceptance
   after cutover.
5. The unresolved checks below are dispositioned explicitly; any that remain unresolved are carried
   forward in the release evidence instead of being implied complete.
6. The previous environment and its storage stay intact until the owner explicitly authorizes
   deletion ([release acceptance](operations.md#release-acceptance),
   [deletion and rollback](../infra/README.md#deletion-and-rollback)).

## Rollback and recovery

The artifacts of a release are immutable, so a rollback restores identities instead of rebuilding:

- **Components.** Update only changed stacks to the prior `CatalogServingCodeKey`/object version,
  `UserCardsCodeKey`/object version, `RecognitionImageUri` or `CatalogJobImageUri` recorded for the
  previous combination ([Update](../infra/README.md#update)).
- **Browser.** Re-upload the retained packaged `browser/` directory, or the bucket's previous object
  versions, and invalidate the distribution again ([Update](../infra/README.md#update)).
- **Background jobs.** Catalog synchronization uses the pinned image digest on its next explicit run;
  ordinary private changes require no background job
  ([background jobs](../infra/README.md#background-jobs)).
- **Failed create or update.** CloudFormation rolls back automatically;
  `aws cloudformation continue-update-rollback` continues an interrupted rollback. A failed create
  removes newly created buckets carrying `RetainExceptOnCreate`; image repositories and owner
  secrets carry `Retain`, and cluster deletion protection blocks an accidental drop. Retention on
  later deletion is separate: buckets, repositories and secrets stay in place, and the cluster has a final
  snapshot ([deletion and rollback](../infra/README.md#deletion-and-rollback)).
- **Data.** Recovery starts from the final cluster snapshot: the restored cluster keeps the
  database roles, the retained reader and writer secrets keep working, a new master credential is
  established, and schema bootstrap runs again before component stacks point at it
  ([data retention](../infra/README.md#data-retention)).
- **Boundaries.** A rollback never mutates owner data, deletes the previous environment or performs
  a migration; deletion and migration are separate authorized actions
  ([deletion and rollback](../infra/README.md#deletion-and-rollback)).

## Unresolved checks

`release-evidence.json` carries these entries in `unresolvedChecks` until they are performed and
recorded; none of them is established by local checks and test data alone:

| Id                           | Check                                                           | Owning section                                                                                                                              | Why it is unresolved                                                               |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `provider-model-calls`       | Live Lambda invocations and Amazon Bedrock model calls          | [Recognition packaging](operations.md#recognition-packaging)                                                                                | Needs a deployed function and an authorized model-provider call.                   |
| `physical-device-acceptance` | Real mobile-camera acceptance on physical hardware              | [Recognition packaging](operations.md#recognition-packaging), [live boundaries and performance](testing.md#live-boundaries-and-performance) | Needs a real device; recorded browser and emulated evidence does not establish it. |
| `collection-reconciliation`  | Owner collection reconciliation and migration (MIG-001–MIG-004) | [Collection migration](requirements.md#collection-migration)                                                                                | Deferred until after the rebuild and gated on the owner's authorization.           |

## Recording and authorization

The release stages are recorded separately because each one is established by different evidence:
source completion by the repository checks and the packaged bytes, deployment by the captured stack
parameters and the live boundary checks, and production acceptance by the owner after an authorized
cutover. A stage that has not happened is recorded as not recorded, with its reason, rather than
left out.

Preparation does not imply authorization: deployment execution, production cutover, collection
migration, owner-data access and deletion of the previous environment stay with the owner
([release acceptance](operations.md#release-acceptance),
[collection migration](requirements.md#collection-migration)). The rebuild prepares release
evidence and the execution procedure above; it executes nothing outside an authorized isolated
environment.
