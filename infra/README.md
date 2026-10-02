# Rebuild infrastructure

The [CDK deployment design](../docs/deployment.md) is implemented under `infra/cdk/`. GitHub Actions
orchestration remains separate work ([CI/CD](../docs/ci-cd.md)); local synthesis never deploys. The
current environment is test and has not been moved merely because these templates exist. Live
resource moves, data migration, Catalog synchronization and deletion remain explicit operations.

## Stacks and ownership

Deploy in `us-east-1` with CloudFormation. Retain the existing Cognito pool and account identities.
Use one app client for this deployment. Follow the [data architecture](../docs/data-architecture.md)
and [operations](../docs/operations.md).

| Stack                   | Owns                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `FoundationStack`       | VPC/database networking, Aurora, owner secrets, shared artifact bucket, alarm topic and database alarms. |
| `GatewayStack`          | Retained-pool app client, HTTP API/default stage, JWT authorizer, CORS and API alarms.                   |
| `WebStack`              | Private versioned browser bucket, CloudFront distribution and bucket policy.                             |
| `CatalogServingStack`   | Catalog Lambda artifact, role, log, alarm, public JWT routes and IAM-authenticated service routes.       |
| `UserCardsStack`        | UserCards Lambda artifact, owner credentials, Catalog service permission, routes, log and alarm.         |
| `RecognitionStack`      | Recognition repository/image Lambda, provider permissions, routes, logs and alarm.                       |
| `CatalogIngestionStack` | Catalog repository, versioned source bucket and finite Fargate task, cluster, roles and logs.            |

`foundation.json` and `service.json` remain source definitions for the first, no-op legacy
adoption. The CDK app synthesizes that two-stack shape with `layout=legacy`, or the seven independent
units with `layout=target`. They are migration modes, not alternatives to operate indefinitely.

Catalog and UserCards use separate schemas and owner read/write roles in one cluster. Each query
implementation accesses only its owner's records. Credentials are injected into provider factories;
transport, CardList and UI never receive unrestricted connections. No SQL join or transaction spans
owners. Moving UserCards to a dedicated cluster later changes composition/resource bindings only.

There is no Search schema, projection, indexing image/job, scheduler or publication-reader role in
the target stack. Private edits become queryable on commit. Ordinary database indexes belong to each
owner and require no asynchronous Search job.

## Environment inputs

Instantiate the CDK app once per environment. `Environment` is fixed by CDK context; PostgreSQL and
capacity settings remain explicit Foundation parameters. Gateway receives the retained user-pool ID
and browser origin. Catalog-serving and UserCards each receive their own artifact key/object version;
Recognition and Catalog ingestion receive digest-pinned image URIs. Credentials are secret
references, never template values or browser settings.

Validation may omit a release and leaves artifact parameters required. Deployment synthesis reads
the captured immutable combination and uses its values as parameter defaults:

```sh
npm run synth -- --context environment=test --context layout=target \
  --context release=artifacts/release.json --output .turbo/cdk-release.out
```

The release record must belong to the selected environment and pin both images by digest. Synthesis
does not publish or rebuild any artifact.

`release.json` is a schema-1 environment record. Every component owns its provenance and immutable
identity, so an unchanged component can keep an older revision:

```json
{
  "schema": 1,
  "environment": "test",
  "components": {
    "catalogServing": {
      "revision": "<40-character revision>",
      "version": "<artifact version>",
      "manifest": "manifest.json",
      "codeKey": "releases/<artifact version>/catalog-serving.zip",
      "codeVersion": "<S3 object version>"
    },
    "userCards": {
      "revision": "<40-character revision>",
      "version": "<artifact version>",
      "manifest": "provenance/usercards-manifest.json",
      "codeKey": "releases/<artifact version>/usercards.zip",
      "codeVersion": "<S3 object version>"
    },
    "recognition": {
      "revision": "<40-character revision>",
      "version": "<artifact version>",
      "manifest": "recognition/manifest.json",
      "imageUri": "<repository>@sha256:<digest>"
    },
    "catalogIngestion": {
      "revision": "<40-character revision>",
      "version": "<artifact version>",
      "manifest": "manifest.json",
      "imageUri": "<repository>@sha256:<digest>"
    }
  }
}
```

Manifest paths are relative to the release directory. Copy the manifest from a retained older
release into `provenance/` when that component remains deployed. `npm run release:evidence` verifies
each referenced manifest is clean, matches that component's revision/version and records the
serving artifact digest; it separately requires object versions and digest-pinned image URIs.

Capture actual stack outputs and parameters; do not guess generated physical names. Read/write roles
are separate for each owner. Runtime workloads never use the master credential.

## Packaging and publication

Build from a clean committed revision and locked dependencies. Preserve the complete release directory
for rollback, including manifests and immutable artifact identities.

| Artifact                                          | Destination                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Browser bundle and prepared recognition assets    | Versioned private browser bucket, delivered by CloudFront.                           |
| Catalog-serving zip                               | Artifact bucket at `releases/<version>/catalog-serving.zip`; pin its object version. |
| UserCards zip                                     | Artifact bucket at `releases/<version>/usercards.zip`; pin its object version.       |
| Finite Catalog ingestion job and Dockerfile       | Catalog ECR repository; pin `@sha256:` digest.                                       |
| Recognition container context and source download | Recognition ECR repository; pin digest and retained manifest.                        |

```sh
npm ci
npm run validate
npm run package -- --out artifacts
npm run package:recognition -- --out artifacts
npm run release:evidence -- --out artifacts
```

Recognition preparation precedes browser packaging. Publish serving zips to the captured Foundation
artifact bucket, push images to the repositories named by their owning stack outputs, and record
their digests. Obtain browser `config.json` from captured Gateway/Web outputs, with only public settings:

```sh
npm run package -- --from-outputs infra/service-outputs.json --environment test
```

The browser receives Gateway authentication coordinates and supported public settings, never database
credentials. Retain each component's source revision, artifact digest/object version and deployed
parameters in the environment record. Packaging and publication do not execute a stack update.

## Recognition packaging

Recognition is one retained engine prepared once and delivered twice: the container image the
recognition Lambda runs, and the browser assets the preserved ONNX modules resolve beside
themselves (docs/operations.md#recognition-packaging, docs/recognition.md#engines-and-assets).
`artifacts/recognition/manifest.json` records the engine identities both halves share — the pinned
upstream revision, the model, catalog, OCR and title-name digests, the browser runtime and asset
digests, the revision and the corresponding-source download — so a deployed combination can be
inspected and restored. No matching policy, threshold or preprocessing step changes here, and the
model-provider settings and credentials stay with `RecognitionStack`, never with the image.

Preparation is an explicit build step. It fetches only public, frozen bytes through the retained
preparation scripts; it is never part of publishing a revision and never runs inside the packaged
image:

```sh
# 1. Prepare the retained engine: pinned public models, catalog, OCR and title names, the converted
#    ONNX text weights, the browser catalog/model assets, the browser ONNX runtime of the locked
#    dependency and the corresponding-source download. Needs Python 3.12 with the pinned build
#    requirements and access to the public model/catalog sources
#    (docs/operations.md#recognition-packaging). The retained bundler reads the committed sources,
#    so commit the revision before preparing; packaging then verifies the download against it.
python3 -m venv .recognition-build/runtime
.recognition-build/runtime/bin/pip install -r src/recognition/python/requirements-visual.txt
python3 -m venv .recognition-build/converter
.recognition-build/converter/bin/pip install -r src/recognition/python/requirements-converter.txt
npm run prepare:recognition -- --python .recognition-build/runtime/bin/python \
  --converter-python .recognition-build/converter/bin/python

# 2. Package the deployable artifacts and the verified recognition image context.
npm run package -- --out artifacts
npm run package:recognition -- --out artifacts

# 3. Build and push the image, then read the digest RecognitionStack pins.
docker build -t <recognition-repository>:<version> artifacts/recognition
docker push <recognition-repository>:<version>
aws ecr describe-images --region us-east-1 --repository-name <recognition-repository-name> \
  --image-ids imageTag=<version> --query 'imageDetails[0].imageDigest' --output text
```

CatalogIngestionStack and RecognitionStack create their respective image repositories, so a push or
digest read names them through captured `CatalogRepositoryName` or `RecognitionRepositoryName`.
CloudFormation generates the physical names; never guess them.

`npm run package:recognition` verifies every pinned manifest and hash before it writes anything: the
retained baseline digests of the engine sources it ships, the model, catalog, OCR and title-name
digests, the pinned upstream CollectorVision revision with the content of every file it ships
(generated build output is excluded rather than packaged), the cached catalog feed offline loading
reads, the browser runtime and asset digests with the engine identity the browser manifest reports,
and the membership and bytes of the corresponding-source download of this checkout. The Dockerfile
builds from the digest-pinned AWS Lambda Python runtime of the retained engine, so the context plus
the tag name the whole image. The browser half carries the prepared `browser/vendor/` assets in
`artifacts/browser/`; the recognition manifest records their digests, so the container and browser
halves of one release can be matched. Packaging the context costs no model download and is safe to
repeat after `npm run package`, which replaces only the artifacts it builds itself.

Packaged regressions and resource measurement run the built image locally, not in AWS:

```sh
# The packaged engine regression and its measurement: no network, read-only root, bounded /tmp.
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m \
  --entrypoint python <recognition-repository>@sha256:<digest> /var/task/smoke.py
npm run test:python        # retained Python engine regressions
npm run test:recognition   # retained browser recognition regressions
```

The smoke run reports the import and model initialization, per-frame inference timings and peak RSS
of the packaged image, and prints `physicalDeviceVerified: false`; record cold (first run) and warm
(repeated run) figures with the image digest, host and dataset, and keep them separate from
accuracy (docs/testing.md#live-boundaries-and-performance). The corresponding-source download of
exactly this revision ships in the image and is served by `GET /api/recognition/source`, which
reports the digest and function version it served; its digest is also in the recognition manifest
beside the notices and `LICENSE`.

Live Lambda invocations, real Bedrock model calls and physical-camera acceptance are separate
evidence: a valid local package and a passing smoke run do not establish deployed authorization,
latency or camera accuracy.

Rollback restores the previous release: images are immutable tags with the newest ten kept, so the
previous `RecognitionImageUri` digest — and the previous `artifacts/browser/` directory when the
browser bundle changed — remain the restore source. Rebuild the image from the recorded context
only if its tag was pruned; the context and the corresponding source of that revision are the
restorable inputs.

## Create

Creation requires explicit authorization for the concrete environment and inspected change sets.
Image repositories are established first, before either consuming runtime exists:

1. Synthesize the repository-only stage:

   ```sh
   npm run synth -- --context environment=test --context layout=target \
     --context stage=image-repositories --output .turbo/cdk-repositories.out
   ```

2. Create and inspect change sets only for `keeper-test-recognition` and
   `keeper-test-catalog-ingestion` from that assembly. Execute them and capture
   `RecognitionRepositoryName` and `CatalogRepositoryName`. These templates contain only the
   owning ECR repository and its outputs; do not deploy the other synthesized stacks from this
   stage.
3. Build and push Recognition and Catalog-ingestion images to those captured repositories, resolve
   both digests, and create `artifacts/release.json` with the component provenance above.
4. Synthesize the complete target:

   ```sh
   npm run synth -- --context environment=test --context layout=target \
     --context stage=complete --context release=artifacts/release.json \
     --output .turbo/cdk-release.out
   ```

   Create Foundation, Web, Gateway, Catalog serving and UserCards in dependency order, capturing
   provider outputs before planning consumers. Update the two repository stacks from the complete
   assembly to add their consuming runtimes. Inspect that `RecognitionRepository` and
   `CatalogRepository` keep the same logical and physical IDs and have no replacement action; the
   repository definitions are identical in both stages.

Bootstrap owner schemas/roles through their supplied contracts, using the temporary master
credential only for bootstrap, and verify isolation. Publish serving artifacts before supplying
their object versions. Publish the browser from captured Gateway and Web outputs and invalidate
CloudFront.

Use the AWS CLI's `cloudformation create-change-set`, `describe-change-set`, `execute-change-set` and
stack waiters with the intended stack name, template and explicit parameter file. Inspection must
precede execution. Never interpolate secrets into command arguments or print their values.

A new isolated test environment uses synthetic data. A deployment to an existing environment
preserves authoritative data and identity. Importing Catalog or an owner collection is separate.

## Update

Inspect the current stack/resource identities and environment record before preparing replacements.
Build and publish only changed artifacts; keep unchanged object versions/digests in parameters.
Deploy one intended stack, never `cdk deploy --all`. A compatible schema upgrade precedes the owner
runtime that uses it and remains compatible with the previous runtime for rollback.

### Existing test-environment migration

This ticket prepares but does not execute the live move. Use the actual deployed templates and
parameters captured with `get-template` and `describe-stacks`; repository templates alone are not
evidence of live state.

1. **Capture and protect.** Record both stack templates, parameters, outputs, logical/physical IDs,
   termination/deletion protection, current artifact identities and a restorable database snapshot.
   Confirm no stack update or Catalog task is running.
2. **Adopt without splitting.** Synthesize `layout=legacy` for the same environment and compare its
   parameters, resources, policies and outputs to the captured templates. Resolve every difference
   explicitly. Import/adopt it only when the inspected change set is a no-op; do not accept a
   replacement, deletion or physical-name change as an adoption shortcut.
3. **Prepare target artifacts.** Package and publish the two Lambda zips independently, push both
   images by digest, preserve the current browser bytes, and synthesize `layout=target`. Validate all
   seven templates. This step starts no task and changes no stack.
4. **Refactor retained resources.** Use CloudFormation stack refactoring/resource moves in small,
   separately reviewed operations: browser bucket to Web; source bucket and Catalog repository to
   Catalog ingestion; Recognition repository to Recognition; then the service resources to Gateway,
   Web, Recognition and Catalog ingestion. Move only resources supported by the refactor plan and
   preserve each logical/physical identity, policy and export required by still-deployed consumers.
5. **Introduce serving stacks additively.** Deploy Catalog serving with its own artifact and Catalog
   reader only. Verify JWT public reads and its IAM service route. Deploy UserCards with UserCards
   read/write credentials and the signed Catalog adapter; verify it has no Catalog secret. Keep the
   combined legacy Lambda/routes available until both boundaries pass synthetic live checks.
6. **Switch routes, then remove legacy compute.** Move browser-facing route ownership to the new
   component integrations without changing paths or authentication. Verify already-open browser
   sessions and mixed versions. Only then remove the legacy integration/function/role/log/alarm.
7. **Finalize Foundation.** Move no authoritative database, owner secret, alarm destination or
   shared artifact bucket. Remove old exports only after no deployed or rollback template imports
   them. Capture the resulting seven-stack environment record and retain the pre-split templates and
   parameters through the rollback window.

Stop if a refactor plan proposes replacement of Aurora, Cognito identity, a retained bucket,
repository or secret; if an export remains imported; or if route/auth/IAM verification differs from
the plan. Retention policy is recovery protection, not permission to remove an imported resource.
Collection migration and Catalog synchronization never run as part of this procedure.

## Background jobs

Catalog synchronization is one finite Fargate task per explicit run. Its own public synchronization
contract validates a complete candidate before atomic publication. It reads only its authorized source
snapshot and writes only Catalog storage. Readers retain the previous coherent revision on failure.
It is not an ECS service and keeps no warm task between runs. No per-write or periodic indexing runs.

Start an authorized Catalog task using the task definition, cluster, public-subnet IDs and outbound-only
security group from captured outputs. Use `ecs run-task` with Fargate/`awsvpc`, inspect the returned
failures/task ID, then require exit zero and the recorded complete Catalog publication outcome.
A process exit alone does not establish successful synchronization. Preserve evidence before retry.

## Deletion and rollback

Component rollback restores only that stack's previous template, configuration and immutable
artifact: Catalog-serving/UserCards object key and version, Recognition/Catalog-ingestion image
digest, or retained Web bytes. Verify the component boundary and its contract consumers after the
rollback. Do not start Catalog ingestion, replay imports or rewrite owner data. CloudFormation handles
failed-update rollback; investigate an interruption before using `continue-update-rollback`.

During the split migration, rollback reverses only the completed stage: restore the prior route
integration before removing a new serving stack; reverse a supported stack refactor with the
captured pre/post templates and identifiers; or restore the adopted two-stack templates while their
exports and artifacts remain. Never attempt rollback by creating replacement storage. If a reverse
resource move is unsupported or the old stack can no longer import an export, stop and recover from
the captured CloudFormation state rather than improvising.

Environment deletion is separately authorized. Remove consumer/component stacks before Gateway and
Foundation, verify backup/restore sources first, and remove database deletion protection only with
explicit authorization. Retain the final cluster snapshot, source/artifact/browser buckets, image
repositories and owner secrets until their recovery obligations end. An obsolete source definition
does not authorize deletion.

## Data retention

Aurora uses encrypted storage, automated backups/point-in-time recovery, deletion protection and a final
snapshot on stack deletion. Buckets and image repositories remain retained for recovery; object-version
and image lifecycle policies must preserve the releases selected for rollback. Logs have bounded
retention and contain no private card records or credentials.

Restoring a cluster preserves its roles; RDS creates a new master credential. Reapply compatible owner
bootstrap/grants and verify account isolation before binding the service to that cluster. Retained owner
secrets must correspond to those roles. Collection migration archives and native backups are preserved
independently of source cleanup or Search removal.

## Operating-cost assumptions

Verify current regional prices before a deployment; these are drivers, not a quoted monthly bill.

| Driver               | Assumption                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aurora               | Serverless auto-pause/zero idle capacity where configured; awake ACU time, storage, I/O and excess backup storage are billed. Cold requests can wait for resume. |
| Networking           | Isolated database subnets; outbound-only public subnet for the finite task. No NAT gateway or interface endpoints.                                               |
| Compute              | Lambda invocations without provisioned concurrency; finite Catalog task time, no idle task or Search indexing.                                                   |
| Recognition          | Container invocation time; optional Bedrock model calls only when configured.                                                                                    |
| Delivery             | S3 storage/requests, CloudFront traffic, ECR image storage.                                                                                                      |
| Access/observability | Master and owner secrets, retained logs, metrics and configured alarms.                                                                                          |

## Verification

Local template/package checks prove definitions and reproducible bytes, not live authorization:

```sh
npm run lint:infrastructure
npm run test:integration -- infrastructure-templates
npm run test:integration -- cdk-stacks
npm run test:integration -- packaging
npm run test:integration -- recognition-packaging
```

Before declaring an authorized deployment complete, verify:

- Change sets contain only expected actions and preserve authoritative storage/identity.
- Deployed API object version and image digests match the retained release record; browser settings
  are public only, assets serve over HTTPS and the source bucket remains private.
- JWT/CORS routing rejects invalid/wrong-audience/expired identity and supports actual browser reads
  and writes. Recognition endpoints retain their documented authentication and source download.
- Database subnets remain isolated, Data API is enabled and deletion protection remains on.
- IAM grants each workload only its required secrets/storage. Recognition cannot use the Data API;
  Catalog-serving has only its reader secret; UserCards has only its reader/writer secrets and signed
  Catalog service access; owner roles cannot access the other owner's relations.
- Synthetic-account queries enforce isolation and complete grouping before pagination. A committed
  edit is visible through new authoritative reads and refreshed browser fragments with no worker.
- Pending records remain restricted to import reads, current collection/tag counts remain exact and
  refresh failure never becomes an empty result or failed-save claim.
- Obsolete Search scheduling remains disabled through transition and its target definition is absent
  after the authorized cleanup. No implicit migration or Catalog replay occurred.
- Logs redact sensitive values; configured alarms and recovery procedures work.

Existing owner verification is separate authorized work through provider-owned contracts; never
embed private collection records or credentials in repository tests or release evidence.

## Runtime environment

Application packages separate Catalog-serving, UserCards, Web and Catalog-ingestion entry points.
Catalog-serving binds only Catalog's reader. UserCards binds its reader/writer and reaches Catalog's
public contract through a SigV4-authenticated service adapter; it receives no Catalog credential.
Catalog ingestion alone binds the writer and snapshot source. Recognition retains its Python entry.

The interactive request timeout stays below the Lambda timeout, which stays below the gateway limit.
Unknown write outcomes retain recoverable operation identity. Recognition cold-start timeout is a
retryable failure, never a successful reading. Model assets/settings never leak secret values.

## Deliberate exclusions

No automatic deployment, periodic Search job, warm ECS service, provisioned concurrency, custom domain,
NAT gateway, interface endpoints, new health/readiness endpoint or cross-region replication. Additional
infrastructure requires an actual need and an explicit operational/cost decision.
