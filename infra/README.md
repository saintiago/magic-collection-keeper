# Rebuild infrastructure

The two CloudFormation templates in this directory define the isolated AWS stack of the rebuild
(docs/operations.md#infrastructure, docs/tech-stack.md#aws-stack). They create nothing by
themselves: deployment execution, existing-resource deletion and collection migration stay with the
owner's explicit authorization.

| Template          | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `foundation.json` | Isolated VPC with two public subnets (outbound-only task networking) and two isolated database subnets, Aurora PostgreSQL Serverless v2 cluster with its writer instance on the RDS Data API, database subnet group and security groups, private browser, source-snapshot and deployment-artifact buckets, immutable catalog and recognition image repositories, the reader secret and one writer secret per mutating component, alarm topic, capacity alarm and cluster log group. |
| `service.json`    | App client on the retained Cognito user pool, JWT-authorized HTTP API with the interactive and recognition entry points, interactive Node.js Lambda, recognition container Lambda, finite Fargate catalog task definition, CloudFront delivery of the private browser bucket, log groups and alarms.                                                                                                                                                                                |

Both stacks take the same `Environment` value, and the service stack imports the foundation's export
values, so it has to be deleted before the foundation stack. The split exists because repositories
and buckets must exist before the packaged artifacts can be pushed to them, and because a deployment
then inspects one change plan at a time. Deploy in `us-east-1` (docs/tech-stack.md#aws-stack); the
retained recognition engine also calls Amazon Bedrock in that region.

The definition reuses exactly one existing resource: the owner's Cognito user pool, through
`ExistingUserPoolId`. Everything else - network, storage, repositories, roles, secrets and
credentials - is created by these stacks.

## Parameters

`foundation.json`:

| Parameter                     | Default                   | Validation                           | Meaning                                                                                |
| ----------------------------- | ------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `Environment`                 | required                  | `development`, `test`, `production`  | Names the stack's exports and pairs it with the service stack of the same environment. |
| `VpcCidr`                     | `10.42.0.0/16`            | IPv4 CIDR `/16`-`/22`                | Range the four `/24` subnets are carved from; a smaller range cannot hold them.        |
| `DatabaseName`                | `keeper`                  | PostgreSQL identifier                | Database holding the published Catalog and UserCards schemas.                          |
| `DatabaseEngineVersion`       | `17.10`                   | `x` or `x.y[.z]`                     | Aurora PostgreSQL version; scaling to zero ACUs needs 16.3/15.7/14.12/13.15 or later.  |
| `DatabaseMaximumCapacity`     | `2`                       | `1`, `2`, `4`, `8`, `16`, `32`, `64` | Upper scaling bound in ACUs.                                                           |
| `DatabaseAutoPauseSeconds`    | `600`                     | `300`-`86400`                        | Idle time before the writer pauses at zero ACUs.                                       |
| `DatabaseBackupRetentionDays` | `7`                       | `1`-`35`                             | Automated backup window.                                                               |
| `ReaderRoleName`              | `keeper_reader`           | lowercase PostgreSQL identifier      | Published-view reader role the schema bootstrap creates.                               |
| `UserCardsWriterRoleName`     | `keeper_usercards_writer` | lowercase PostgreSQL identifier      | UserCards private-mutation role; only the interactive API's credential.                |
| `CatalogWriterRoleName`       | `keeper_catalog_writer`   | lowercase PostgreSQL identifier      | Catalog private-mutation role; only the finite catalog task's credential.              |
| `SnapshotPrefix`              | `snapshots/`              | key prefix                           | Prefix of the private bucket the catalog job streams its provider snapshot from.       |

`service.json`:

| Parameter             | Default                 | Validation                          | Meaning                                                                                      |
| --------------------- | ----------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `Environment`         | required                | `development`, `test`, `production` | Must match the foundation stack whose exports are imported.                                  |
| `ExistingUserPoolId`  | required                | Cognito pool identifier             | Retained pool the rebuild authenticates against; the stack only adds an app client.          |
| `ApiCodeKey`          | required                | 1-1024 characters                   | Key of the packaged interactive-API bundle in the artifact bucket.                           |
| `ApiCodeVersion`      | required                | 1-1024 characters                   | Object version of that bundle, so the deployed function names the exact artifact it runs.    |
| `RecognitionImageUri` | required                | ECR URI pinned with `@sha256:`      | Immutable recognition container image.                                                       |
| `CatalogJobImageUri`  | required                | ECR URI pinned with `@sha256:`      | Immutable catalog job image.                                                                 |
| `TitleModelId`        | `amazon.nova-lite-v1:0` | that value or empty                 | Bedrock title fallback; empty runs the retained engines without it.                          |
| `IdentityModelId`     | `amazon.nova-pro-v1:0`  | that value or empty                 | Bedrock independent-identity engine; empty leaves `/api/recognize-independent` unconfigured. |

Keep environment-specific values, including the user pool and any locally captured outputs, in the
ignored `.local-secrets/` directory or in `infra/outputs.json` (ignored by Git). Never commit
account identifiers or credentials; the stack creates the credentials it needs.

The deploying identity owns the whole change set: CloudFormation with `CAPABILITY_IAM`, the network,
database, storage, registry, identity, compute and delivery services it touches, and the CloudWatch
Logs delivery permissions (`logs:CreateLogDelivery`, `logs:PutResourcePolicy` and their siblings)
that the HTTP API stage needs for its access log.

## Packaging and publication

`npm run package` builds the three artifacts one deployment publishes
(docs/operations.md#packaging-and-deployment) from the committed lockfile:

| Artifact             | Contents                                                                                                           | Published to                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `artifacts/backend/` | `api.zip` with `index.mjs`, the interactive entry point and every dependency it reaches.                           | The exported artifact bucket, then the service stack. |
| `artifacts/browser/` | `index.html`, `app.js`, the preserved browser recognition modules and the runtime assets a prepared build carries. | The exported browser bucket, then CloudFront.         |
| `artifacts/catalog/` | `job.mjs`, the finite job, and the Dockerfile that packages it.                                                    | The exported catalog repository, pinned by digest.    |

`artifacts/manifest.json` records the source revision, whether that revision was the whole working
tree, the version label (`<package version>+<short revision>`) and the byte size and SHA-256 of
every artifact, so a released combination can be inspected and the exact artifact of one revision
restored. Packaging is deterministic: the same revision and lockfile produce the same bytes, and
`tests/integration/packaging.test.ts` rebuilds the artifacts and compares them. The backend package
carries its dependencies, so the Lambda runtime supplies only Node.js; the catalog image starts from
the Node.js base image the deployment pins by digest, because image tags are not reproducible.

The browser artifact carries no environment-specific file. Its `config.json` is written when the
deployment publishes it, from the service stack's public outputs only: `--from-outputs` projects a
captured stack, `--public-settings` publishes a prepared file, and either form is validated against
the public settings schema, which accepts no resource, credential or private setting.

The preserved browser recognition engines stay loadable modules: the workers they start and the
ONNX runtime and catalog they resolve next to themselves are reached by URL, so the delivery build
copies the preserved modules beside `app.js` and copies the prepared `vendor/` assets when they
exist. Preparing those model and runtime bytes is the recognition packaging step
(docs/operations.md#recognition-packaging); a build without them still delivers the rest of the
UserInterface, and the capture views report recognition as unavailable.

```sh
# 1. Build the artifacts of this revision; record artifacts/manifest.json beside the release.
npm run package -- --out artifacts

# 2. Publish the interactive package; keep the object version the function will name.
aws s3api put-object --region us-east-1 \
  --bucket <artifact-bucket> --key releases/<version>/api.zip \
  --body artifacts/backend/api.zip --query VersionId --output text

# 3. Build and push the finite job image, then read the digest the stack pins.
docker pull node:24-slim
docker inspect --format '{{index .RepoDigests 0}}' node:24-slim     # the base digest to pass in
docker build --build-arg NODE_BASE_IMAGE=node@sha256:<digest> \
  -f artifacts/catalog/Dockerfile -t <catalog-repository>:<version> artifacts/catalog
docker push <catalog-repository>:<version>
aws ecr describe-images --region us-east-1 --repository-name keeper-<environment>-catalog \
  --image-ids imageTag=<version> --query 'imageDetails[0].imageDigest' --output text

# 4. Publish the browser artifact with this environment's public settings, then invalidate it.
npm run package -- --out artifacts --from-outputs infra/outputs.json --environment <environment>
aws s3 sync artifacts/browser/ s3://<browser-bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths '/*'

# 5. Upload the provider snapshot the finite job streams, naming its provider version.
aws s3api put-object --region us-east-1 \
  --bucket <snapshot-bucket> --key snapshots/default_cards.jsonl \
  --body <default_cards.jsonl> --metadata source-version=<scryfall-updated-at>
```

The finite job reads `${SnapshotPrefix}${dataset}.jsonl` from the snapshot bucket and requires the
`source-version` metadata, which is the provider version Catalog compares before it republishes;
the default dataset is Scryfall's `default_cards` list. The job runs as an explicit task, never as a
service or a schedule (see Catalog synchronization below).

Keep the previous `api.zip` version, image digest and packaged `browser/` directory with their
manifest before replacing them, because that is what a rollback restores. Each artifact is
immutable: the repositories accept no tag overwrite, the artifact bucket keeps every object
version, and the browser bucket keeps replaced versions for 30 days.

## Create

Validate the definitions and inspect the change plan before executing anything:

```sh
npm run lint:infrastructure   # pinned cfn-lint over every template in infra/ (skips infra/outputs.json)
npm run test:integration -- infrastructure-templates   # documented template shape
```

Install the foundation stack, then capture its outputs into the ignored file:

```sh
aws cloudformation create-change-set --region us-east-1 \
  --stack-name keeper-test-foundation --change-set-name foundation-create \
  --change-set-type CREATE --template-body file://infra/foundation.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=Environment,ParameterValue=test \
  --tags Key=Environment,Value=test
aws cloudformation describe-change-set --region us-east-1 \
  --stack-name keeper-test-foundation --change-set-name foundation-create \
  --query 'Changes[].ResourceChange.{Action:Action,Type:ResourceType,Logical:LogicalResourceId}'
aws cloudformation execute-change-set --region us-east-1 \
  --stack-name keeper-test-foundation --change-set-name foundation-create
aws cloudformation wait stack-create-complete --region us-east-1 \
  --stack-name keeper-test-foundation
aws cloudformation describe-stacks --region us-east-1 \
  --stack-name keeper-test-foundation --query 'Stacks[0].Outputs' > infra/outputs.json
```

Package and publish the artifacts first (see Packaging and publication above): the interactive
package goes to the exported artifact bucket, the recognition and catalog images to the exported
repositories by digest. Then create the service stack with the recorded artifact identities, where
`RecognitionImageUri` and `CatalogJobImageUri` must name those repositories:

```sh
aws cloudformation create-change-set --region us-east-1 \
  --stack-name keeper-test-service --change-set-name service-create \
  --change-set-type CREATE --template-body file://infra/service.json \
  --capabilities CAPABILITY_IAM \
  --parameters ParameterKey=Environment,ParameterValue=test \
    ParameterKey=ExistingUserPoolId,ParameterValue=<pool-id> \
    ParameterKey=ApiCodeKey,ParameterValue=<bundle-key> \
    ParameterKey=ApiCodeVersion,ParameterValue=<object-version> \
    ParameterKey=RecognitionImageUri,ParameterValue=<repository>@sha256:<digest> \
    ParameterKey=CatalogJobImageUri,ParameterValue=<repository>@sha256:<digest> \
  --tags Key=Environment,Value=test
aws cloudformation describe-change-set --region us-east-1 \
  --stack-name keeper-test-service --change-set-name service-create \
  --query 'Changes[].ResourceChange.{Action:Action,Type:ResourceType,Logical:LogicalResourceId}'
aws cloudformation execute-change-set --region us-east-1 \
  --stack-name keeper-test-service --change-set-name service-create
aws cloudformation wait stack-create-complete --region us-east-1 \
  --stack-name keeper-test-service
```

Finish the environment with the steps that are not part of the stack (the browser sync repeats the
publication above so an environment that was created without a browser artifact is completed):

```sh
# Upload the packaged browser artifact with the environment's public settings, then publish it.
aws s3 sync artifacts/browser/ "s3://<browser-bucket>/" --delete
aws cloudfront create-invalidation --distribution-id <distribution-id> --paths '/*'

# Notify an operator when an alarm fires.
aws sns subscribe --topic-arn <alarm-topic-arn> --protocol email --notification-endpoint <address>
```

The schema bootstrap step of the deployment then connects as the RDS-managed master user
(`DatabaseMasterSecretArn`): it creates the reader role and the two writer roles with the passwords
stored in the three database secrets, applies `catalogSchemaSql`/`usercardsSchemaSql` and the
components' `catalogReaderGrants`/`usercardsReaderGrants`, and grants each writer role the private
privileges of its own component only - the interactive API's role reaches `usercards_private` and
the finite job's role reaches `catalog_private`. No runtime component uses the master credential,
and neither writer credential can mutate the other component's schema.

The service stack's outputs carry the public settings the browser bundle is built with
(`ApiBaseUrl`, `RecognitionBaseUrl`, `UserPoolClientId`, and the environment's region for the
`authentication` block); `BrowserUrl` is the address users open, and `DistributionId` is the
distribution to invalidate after a bundle replacement.

## Catalog synchronization

Synchronization is one finite task per run: there is no service, schedule or warm capacity to start
or pause. Start a run from the captured outputs and follow it to completion:

```sh
aws ecs run-task --region us-east-1 \
  --cluster <EcsClusterName> \
  --task-definition <CatalogTaskDefinitionArn> \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<PublicSubnetIds>],securityGroups=[<CatalogTaskSecurityGroupId>],assignPublicIp=ENABLED}'
aws ecs describe-tasks --region us-east-1 \
  --cluster <EcsClusterName> --tasks <task-arn> --query 'tasks[0].{lastStatus:lastStatus,stopCode:stopCode,reason:stoppedReason}'
```

The container streams the provider snapshot named by the configured bucket and prefix and reports
its outcome in the catalog log group. The task definition names one image digest, so a run is
repeatable and a release can be re-run after a rollback.

## Update

Upload new artifacts first, then replace the service stack's references through an inspected change
set (`--change-set-type UPDATE` for both stacks with the same commands as above). Image tags in the
repositories are immutable, so a new release pushes a new tag and updates the stack to its digest.
A browser bundle replacement needs a CloudFront invalidation, because `/index.html` and hashed
assets stay cached until they expire.

Artifact-pinned updates roll back by updating the service stack to the previous release's
`ApiCodeKey`, `ApiCodeVersion` and `CatalogJobImageUri`, which that release's `manifest.json`
records; the previous package stays in the artifact bucket under its object version and the previous
image stays in the repository, so no artifact has to be rebuilt. The browser artifact is restored by
re-uploading the retained packaged directory (or the bucket's previous object versions) and
invalidating the distribution again. The catalog job starts explicitly, so a rollback takes effect
on its next run.

CloudFormation refuses to change or remove an export while another stack imports it, so every
foundation parameter that an exported value carries is blocked until the importing service stack is
handled: `SnapshotPrefix` changes the exported snapshot prefix, and `DatabaseName` and `VpcCidr`
additionally force the cluster or network to be replaced and change the imported database name and
cluster ARN or the VPC, subnet and security-group identifiers. The protected cluster blocks that
replacement's delete as well, so these are migrations rather than routine updates and a
foundation-only change set cannot execute them. Run them as the collection-migration procedure:
rehearse in a separate environment, remove or rebuild the service stack whose imports are in use,
disable the cluster's deletion protection deliberately, migrate the data, and re-create the service
stack against the new cluster before turning protection back on. `DatabaseEngineVersion` changes
upgrade the cluster in place during its maintenance window, change no export, and keep the automated
backups and the final-snapshot behaviour.

## Deletion and rollback

An update that fails rolls back automatically; `aws cloudformation continue-update-rollback`
continues an interrupted rollback. A create that fails deletes only what that create made: the
buckets, repositories and secrets use `RetainExceptOnCreate`/`Retain` policies, and the cluster's
deletion protection blocks an accidental drop.

Deleting an environment is a deliberate, ordered action, not part of a deployment:

1. Delete the service stack first: the foundation stack's exports stay in use until then.
2. Read the retained data - final cluster snapshot, buckets, repositories, secret values - before
   removing the foundation stack.
3. Disable the cluster's deletion protection explicitly
   (`aws rds modify-db-cluster --no-deletion-protection`); deleting the foundation stack then takes
   a final cluster snapshot (`DeletionPolicy: Snapshot`) and leaves the buckets, repositories and
   reader/writer secrets in place. The cluster's RDS-managed master secret goes with the cluster.
4. Delete those retained resources by hand only when they are no longer the restore source.

## Data retention

| Resource                  | Retention                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aurora cluster            | Automated backups for `DatabaseBackupRetentionDays` plus point-in-time recovery, `DeletionProtection`, final snapshot on stack deletion, encrypted storage with the AWS-managed key.                                                                                                                                                                                         |
| Reader and writer secrets | `ReaderSecret`, `UserCardsWriterSecret` and `CatalogWriterSecret` are retained across stack deletion. The RDS-managed master secret is not retained: Aurora deletes it with its cluster, so a restore establishes a new master credential. Rotating one of the retained credentials updates its secret value and that role's password together, without a rotation function. |
| Browser bucket            | Versioned; replaced versions expire after 30 days; incomplete uploads abort after 7 days; objects retained on deletion.                                                                                                                                                                                                                                                      |
| Source-snapshot bucket    | Versioned; replaced versions expire after 90 days; incomplete uploads abort after 7 days; objects retained on deletion.                                                                                                                                                                                                                                                      |
| Artifact bucket           | Versioned; replaced deployment artifacts expire after 30 days; incomplete uploads abort after 7 days; objects retained on deletion.                                                                                                                                                                                                                                          |
| Image repositories        | Immutable tags, newest ten images kept, retained on deletion for rollback.                                                                                                                                                                                                                                                                                                   |
| Log groups                | 30 days retention. Log groups are deleted with the stack; they hold no private record contents.                                                                                                                                                                                                                                                                              |

Collection data itself stays with the migration task: this definition never rewrites or moves it.

Restoration starts from the final cluster snapshot: the restored cluster carries the database roles,
so the retained reader and writer secrets keep working, and RDS establishes a new master credential
in the restored cluster's `MasterUserSecret`. Re-run the schema bootstrap with that credential to
re-apply the schemas and grants before the service stack points at the restored cluster.

## Operating-cost assumptions

Assumptions for a single-user deployment in `us-east-1`, on-demand, excluding free tiers and with
list prices to verify against the current price list before cutover. The monthly accounting period,
not billed amounts, is what these estimates describe.

| Driver                     | Assumption                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aurora Serverless v2       | Scales to zero ACUs when idle, so there is no idle capacity charge; awake capacity is billed per ACU-hour with a 0.5 ACU floor, and the first request after a pause waits for the resume. |
| Aurora storage and backups | Storage per GB-month plus backup storage beyond the retention window.                                                                                                                     |
| Task networking            | No NAT gateway and no VPC interface endpoints: the catalog task uses a public subnet with an outbound-only security group, which removes an always-on network charge.                     |
| Catalog job                | Fargate 1 vCPU / 2 GiB for the minutes the finite task runs (about $0.05 per hour), not for idle time.                                                                                    |
| Interactive Lambda         | 1024 MB per invocation while handling a request; no provisioned concurrency.                                                                                                              |
| Recognition Lambda         | 3008 MB per recognition invocation, including container start-up; the retained ONNX/OCR engines run without provider calls.                                                               |
| Amazon Bedrock             | Billed per token only when `TitleModelId`/`IdentityModelId` are configured; leave them empty to run without provider calls.                                                               |
| S3 and CloudFront          | Standard storage plus transferred bytes and requests; `PriceClass_100` limits edge locations to Europe and North America.                                                                 |
| Secrets Manager            | One small monthly charge per stored secret (master, reader, UserCards writer, Catalog writer).                                                                                            |
| CloudWatch                 | Log ingestion and storage for five 30-day log groups plus four alarms.                                                                                                                    |
| Container image storage    | ECR storage for the pushed images, bounded by the ten-image lifecycle policy.                                                                                                             |

## Verification

Local checks prove template validity and the documented shape, nothing more:

```sh
npm run package                                        # every artifact of this revision
npm run test:integration -- packaging                  # artifact contents, digests and settings
npm run lint:infrastructure                             # cfn-lint over every template
npm run test:integration -- infrastructure-templates    # documented boundary cases
```

Packaging is verified locally: the same revision is rebuilt and compared byte for byte, the
interactive package is loaded the way the Lambda loads it, the finite job is executed the way the
task runs it, and only public settings are accepted beside the browser bundle. That is artifact
evidence, not deployed evidence.

A valid template does not prove deployed authorization. Before cutover, check the changed
boundaries in an isolated environment and record the results separately from these local checks:

- Change plan: `describe-change-set` shows only the expected resource actions.
- Artifacts: the deployed function's code object version and the task definition's image digest
  match the release's `manifest.json`, and the published `config.json` carries exactly the public
  settings the deployment projected from the stack's outputs.
- Identity and routing: the API rejects a request without a token (401) and with a token of another
  pool, another app client or an expired session; a fresh token from this environment's app client
  reaches the documented route; and `POST /api/recognize`, `POST /api/recognize-independent` and
  `GET /api/recognition/source` all reach the recognition function with that token
  (`aws apigatewayv2 get-routes` shows one route per preserved endpoint).
- Network: `aws ec2 describe-route-tables` shows no route off the VPC for the database subnets; the
  cluster's security group has no inbound rule; `aws rds describe-db-clusters` shows the Data API
  enabled, `PubliclyAccessible` false and deletion protection on.
- IAM: `aws iam simulate-principal-policy` shows the interactive role cannot read snapshots or
  invoke Bedrock, the recognition role cannot use the Data API, and the catalog role cannot invoke
  Bedrock; only the catalog execution role holds the repository authorization wildcard, the
  interactive role resolves only the reader and UserCards writer secrets, and the catalog role
  resolves only the Catalog writer secret.
- Data path: a schema-bootstrap connection through the Data API succeeds with the master secret,
  the reader role can select the published views and nothing else, and each writer role can write
  only its component's private schema - a statement against the other component's schema through
  that credential fails.
- Delivery: the CloudFront URL serves the browser bundle over HTTPS while the bucket stays private
  (a direct object URL without a signed request fails).
- Alarms: a deliberately failing request moves `Errors`/`5xx` and the subscribed topic receives the
  notification.

## Runtime environment

The stacks supply the coordinates the packaging step binds; the variable names are the deployment's
interface to the components.

| Consumer           | Variables                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interactive API    | `KEEPER_ENVIRONMENT`, `KEEPER_USER_POOL_ID`, `KEEPER_USER_POOL_CLIENT_ID`, `KEEPER_DATABASE_CLUSTER_ARN`, `KEEPER_DATABASE_NAME`, `KEEPER_DATABASE_READER_SECRET_ARN`, `KEEPER_DATABASE_USERCARDS_WRITER_SECRET_ARN`, `KEEPER_SNAPSHOT_BUCKET`, `KEEPER_SNAPSHOT_PREFIX`, `KEEPER_RECOGNITION_BASE_URL`, `KEEPER_CLOUD_RECOGNITION`, `KEEPER_SOURCE_IMPORTS`, `KEEPER_REQUEST_TIMEOUT_MS`. |
| Recognition Lambda | `KEEPER_ENVIRONMENT`, `KEEPER_TITLE_MODEL`, `KEEPER_IDENTITY_MODEL` (the container image supplies `RECOGNITION_ARTIFACTS` and the engine settings).                                                                                                                                                                                                                                        |
| Catalog job        | `AWS_REGION`, `KEEPER_ENVIRONMENT`, `KEEPER_DATABASE_CLUSTER_ARN`, `KEEPER_DATABASE_NAME`, `KEEPER_DATABASE_CATALOG_WRITER_SECRET_ARN`, `KEEPER_SNAPSHOT_BUCKET`, `KEEPER_SNAPSHOT_PREFIX`; the image supplies its own entry point and command.                                                                                                                                            |

Each workload receives only the credential of the mutation it owns: the interactive API gets the
reader secret and the UserCards writer secret, and the catalog job gets the Catalog writer secret.
Neither role can resolve the other component's writer secret.

`KEEPER_REQUEST_TIMEOUT_MS` (20 s) stays below the function timeout (25 s), which stays below the
HTTP API's fixed 30-second integration limit: a slow operation therefore returns Application's own
timeout outcome, which names the receipt to recover, instead of an unexplained gateway failure.
Recognition runs under the same limit, so a cold container start that exceeds it is reported as a
retryable failure rather than as a successful reading.

The app client allows the password and refresh flows the retained browser sign-in uses
(`InitiateAuth` with `USER_PASSWORD_AUTH`); a different flow needs a deliberate app-client change
before the identities of this environment can sign in.

## Deliberate exclusions

- No custom domain, certificate or hosted zone: the stacks expose the default `execute-api` and
  CloudFront endpoints, and the browser bundle is served over HTTPS by CloudFront.
- No NAT gateway, VPC interface endpoints or Lambda VPC attachment: the interactive and recognition
  runtimes reach AWS endpoints without VPC networking, the database subnets have no route off the
  VPC, and database access is only through the IAM-authorized Data API.
- No provisioned concurrency, ECS service, scheduled task or auto scaling: the catalog
  synchronization is started explicitly per run, and nothing keeps capacity warm.
- No health or readiness endpoints, no customer-managed KMS key, no CloudFront access logging and no
  cross-region replication; each would need its own requirement and cost decision.
