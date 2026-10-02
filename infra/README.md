# Rebuild infrastructure

This document describes the approved deployment target. Source implementation and currently deployed
resources can lag that target. Deployments, data migration and resource deletion are separately
explicit actions. CI and automatic deployment remain disabled; no scheduled indexing is required.

## Stacks and ownership

Deploy in `us-east-1` with CloudFormation. Retain the existing Cognito pool and account identities.
Use one app client for this deployment. Follow the [data architecture](../docs/data-architecture.md)
and [operations](../docs/operations.md).

| Stack             | Owns                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundation.json` | Isolated VPC/database subnets, Aurora PostgreSQL Serverless v2 with Data API, encrypted storage and backups, private browser/source/artifact buckets, immutable Catalog/Recognition ECR repositories, owner-specific database secrets, logs and alarms. |
| `service.json`    | Cognito app client, JWT-authorized HTTP API, interactive Node.js Lambda, Recognition container Lambda, finite Catalog Fargate task and private-browser CloudFront delivery.                                                                             |

Catalog and UserCards use separate schemas and owner read/write roles in one cluster. Each query
implementation accesses only its owner's records. Credentials are injected into provider factories;
transport, CardList and UI never receive unrestricted connections. No SQL join or transaction spans
owners. Moving UserCards to a dedicated cluster later changes composition/resource bindings only.

There is no Search schema, projection, indexing image/job, scheduler or publication-reader role in
the target stack. Private edits become queryable on commit. Ordinary database indexes belong to each
owner and require no asynchronous Search job.

## Environment inputs

Validate environment names, PostgreSQL identifiers and immutable artifact identities before template
execution. Foundation inputs cover database name/version, backup retention, Serverless capacity,
auto-pause, owner roles and notification destination. Service inputs cover retained user-pool ID,
foundation exports, API artifact key/object version, Recognition/Catalog image digests and permitted
Recognition model settings. Credentials are secret references, never template values or browser settings.

Capture actual stack outputs and parameters; do not guess generated physical names. Read/write roles
are separate for each owner. Runtime workloads never use the master credential.

## Packaging and publication

Build from a clean committed revision and locked dependencies. Preserve the complete release directory
for rollback, including manifests and immutable artifact identities.

| Artifact                                          | Destination                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Browser bundle and prepared recognition assets    | Versioned private browser bucket, delivered by CloudFront.                         |
| Interactive API zip                               | Versioned artifact bucket at `releases/<version>/api.zip`; pin its object version. |
| Finite Catalog job and Dockerfile                 | Catalog ECR repository; pin `@sha256:` digest.                                     |
| Recognition container context and source download | Recognition ECR repository; pin digest and retained manifest.                      |

```sh
npm ci
npm run validate
npm run package -- --out artifacts
npm run package:recognition -- --out artifacts
npm run release:evidence -- --out artifacts
```

Recognition preparation precedes browser packaging. Publish API bytes to the captured artifact bucket,
push images to the repositories named by foundation outputs, and record their digests. Obtain browser
`config.json` from captured service outputs, with only public settings:

```sh
npm run package -- --from-outputs infra/service-outputs.json --environment test
```

The browser receives API/authentication coordinates and supported public settings, never database
credentials. Retain source revision, artifact digests, API object version and deployed parameters in
the release record. Packaging and publication do not execute a stack update.

## Recognition packaging

Recognition is one retained engine prepared once and delivered twice: the container image the
recognition Lambda runs, and the browser assets the preserved ONNX modules resolve beside
themselves (docs/operations.md#recognition-packaging, docs/recognition.md#engines-and-assets).
`artifacts/recognition/manifest.json` records the engine identities both halves share — the pinned
upstream revision, the model, catalog, OCR and title-name digests, the browser runtime and asset
digests, the revision and the corresponding-source download — so a deployed combination can be
inspected and restored. No matching policy, threshold or preprocessing step changes here, and the
model-provider settings and credentials stay with the deployed function (`RecognitionFunction` of
`infra/service.json`), never with the image.

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

# 3. Build and push the image, then read the digest the service stack pins.
docker build -t <recognition-repository>:<version> artifacts/recognition
docker push <recognition-repository>:<version>
aws ecr describe-images --region us-east-1 --repository-name <recognition-repository-name> \
  --image-ids imageTag=<version> --query 'imageDetails[0].imageDigest' --output text
```

The foundation stack creates the two image repositories, so a push or a digest read names them
through their outputs (`infra/outputs.json`): `CatalogRepositoryName` and `RecognitionRepositoryName`. CloudFormation generates the physical names, so none of these is
`keeper-<environment>-<job>`.

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
Validate templates, create the foundation change set, inspect resource actions and execute it first.
Capture its outputs. Bootstrap the owners' schemas/roles through their supplied bootstrap contracts,
using the temporary master credential only for this operation; verify owner isolation. Publish pinned
artifacts, create/inspect/execute the service change set importing that foundation, and capture its
outputs and deployed parameters. Publish the browser with public settings and invalidate CloudFront.

Use the AWS CLI's `cloudformation create-change-set`, `describe-change-set`, `execute-change-set` and
stack waiters with the intended stack name, template and explicit parameter file. Inspection must
precede execution. Never interpolate secrets into command arguments or print their values.

A new isolated test environment uses synthetic data. A deployment to an existing environment preserves
its authoritative data and identity. Importing the Catalog or owner collection is separate work.

## Update

Inspect the current stack/resource identities and release record before preparing replacements. Build
and publish only changed artifacts; preserve unchanged artifact identities. Inspect compatible schema
upgrades and grants through owner bootstrap before switching reads. Data-preserving upgrades must be
repeat-safe and retain receipts, provenance and exact migration archives.

For this architecture correction, plan removal of obsolete derived Search resources independently
from authoritative schemas. Do not replace the cluster, retained Cognito pool, source archives or
collection records. Source removal alone authorizes no live deletion. The inspected deployment plan
must distinguish removable derived resources, retained rollback artifacts and authoritative state.
Keep existing scheduling disabled throughout transition; do not re-enable the obsolete worker.

Inspect foundation/service change sets before execution. Preserve previous artifact identities and
compatible rollback behavior, capture deployed parameters after success, publish changed browser
assets and invalidate CloudFront. Verify the actual deployed combination, not merely stack completion.

Cluster replacement, database renaming and incompatible storage changes require an explicit migration
and recovery procedure. They are outside this correction. Do not rerun completed owner migration or
Catalog import to populate query metadata.

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

Release rollback restores pinned API/image identities and retained browser bytes; it does not replay
imports or rewrite owner data. CloudFormation performs failed-update rollback; investigate interrupted
rollback before using `continue-update-rollback`.

Environment deletion is separately authorized: remove the service stack before its imported foundation.
Verify backup/restore sources first, explicitly remove database deletion protection only when authorized,
and retain the final cluster snapshot, source/artifact/browser buckets, image repositories and owner
secrets. Delete retained resources only after their recovery obligation ends. Never infer deletion
permission from an obsolete source definition.

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
  Catalog cannot mutate UserCards; owner read roles cannot write or access the other owner's relations.
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

Application binds each owner client to its read/write capability. Runtime inputs contain environment,
authentication/API coordinates, owner database/secret references, source snapshot location and optional
Recognition provider settings. Owner connections can target different clusters without consumer changes.
No indexing accounts/rebuild controls, Search credentials or indexing-progress endpoints remain.

The interactive request timeout stays below the Lambda timeout, which stays below the gateway limit.
Unknown write outcomes retain recoverable operation identity. Recognition cold-start timeout is a
retryable failure, never a successful reading. Model assets/settings never leak secret values.

## Deliberate exclusions

No automatic deployment, periodic Search job, warm ECS service, provisioned concurrency, custom domain,
NAT gateway, interface endpoints, new health/readiness endpoint or cross-region replication. Additional
infrastructure requires an actual need and an explicit operational/cost decision.
