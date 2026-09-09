> Historical comparison review. The stack was deleted after the authorized final hybrid speed checks. See SAGEMAKER-CLEANUP.md. Template/runtime reproduction is available at commit 0d5df87.

# Isolated SageMaker Serverless comparison review

Prepared September 9, 2026. Deployment attempts and corrections are recorded below. The generated
`sagemaker-review-template.json` passed CloudFormation ValidateTemplate and requires
CAPABILITY_IAM. The owner's explicit instruction on September 9 authorizes this
concrete stack and replaces separate administrator review or confirmation. The
exact immutable image has been verified below. Generate the template from the checked-in proxy
using `python recognition/scripts/sagemaker_template.py`; it never deploys.

Proposed stack: **magic-keeper-sagemaker**, account **698643713254**, **us-east-1**.

| Resource | Concrete scope |
| --- | --- |
| Model + endpoint configuration | Frozen CollectorVision/Paddle ONNX weights and full catalog, same image contents and policy as Lambda; a different HTTP entrypoint |
| Endpoint | `magic-keeper-sagemaker`, 3072 MB, maximum concurrency 2, ProvisionedConcurrency omitted |
| Model execution role | ECR authorization token (`*` required by that action); pull only `magic-keeper-recognition`; write only its endpoint logs |
| Proxy execution role | Invoke only this endpoint; write only its own Lambda logs |
| Proxy Lambda | `magic-keeper-sagemaker-proxy`, Python 3.12 ZIP, 256 MB, 28-second timeout; no ML imports |
| Logs | `/aws/sagemaker/Endpoints/magic-keeper-sagemaker` and `/aws/lambda/magic-keeper-sagemaker-proxy`, retention 7 days |
| API integration + route + permission | Only `POST /api/recognize/sagemaker` on existing HTTP API `exex6mzt02`, existing verified Cognito JWT authorizer `giiovd`, 29-second gateway wait |

No inventory/table access, model S3 bucket, VPC, secrets, GPU, schedules, periodic
keepalive or provisioned warm capacity. Existing app CI role and pantry resources
are untouched. The model image is published to the already isolated recognition
ECR repository using the reviewed ECR-only publisher; exact digest verification
precedes deployment. Models are in the image. SageMaker retains an encrypted image
copy while endpoints use it. Its Serverless mode does not support network isolation;
the code uses frozen local artifacts and ORT_DISABLE_TELEMETRY=1. This is not a claim
that AWS enforces network isolation.

The proxy verifies the trusted JWT subject and the bounded image contract before
forwarding image/attempt only with SigV4. Body-provided owner or extra fields are
rejected. The private container independently decodes and validates the image.
Images, raw OCR and credentials are never logged or retained. Data capture is off.
The authenticated AGPL source offer must match the deployed image before use.

AWS Price List API checked September 9: SKU PUE6HBQ8KFHBUN5T,
USE1-ServerlessInf:Mem-3GB, effective September 1: **$0.00006 per processing second**.
For example, 1,000 calls averaging one billed processing second cost **$0.06 in
SageMaker compute**; ten seconds average costs **$0.60**. Data processing, proxy
Lambda/API requests, ECR storage and logs are additional. No free tier is assumed.
No fixed idle compute is requested; actual billed duration and overhead must be
checked against measured results. This is an example, not a spending cap.

The model must become healthy within 3 minutes and complete container inference
within 60 seconds. The existing HTTP API path waits 29 seconds, so a slow on-demand
start can still return a preparation/timeout failure. Benchmarks must preserve that
failure and distinguish explicit session preparation/retry from first-call success.
No automatic per-card retries or session preheat are enabled until measured.

Review sources: [Serverless behavior and exclusions](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints.html),
[invocation limits](https://docs.aws.amazon.com/sagemaker/latest/dg/serverless-endpoints-invoke.html),
[AWS pricing](https://aws.amazon.com/sagemaker/ai/pricing/),
[CloudFormation configuration](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-sagemaker-endpointconfig-serverlessconfig.html).

Before destructive cleanup after comparison, enumerate this stack's endpoint,
configuration, model, proxy, roles, route/integration/permission and logs; retain
benchmark evidence and exact source/image artifacts, then request administrator
review of those concrete deletions. Do not delete shared ECR images still referenced
by any Lambda version or retained endpoint. No such deletion is authorized here.

## Verified deployment artifact

Runtime verification **34288656263** and full PR checks **34288659802** passed.
The actual container HTTP smoke became healthy in 3.021 s and returned the correct
public-card candidates in 1.220 s, offline Linux; this is not AWS latency evidence.
All 17 Python contract/log/privacy/proxy tests passed.

Publisher **34289201862** loaded and rechecked that exact image. ECR manifest config
was compared with the retained Docker image ID:

- Image: `698643713254.dkr.ecr.us-east-1.amazonaws.com/magic-keeper-recognition@sha256:cc85daaba677ebef3aa6e4decea6d21e38636bfeab956a41d7b340742726784b`
- Docker ID: `sha256:6d6a1ceef49e603b606a5294cd98ace04b82f40dce20b8ca0fae41538bf7bd71`
- Source ZIP SHA-256: `c1ef1946075f6ccf291c9bd4df939a3f2f3d01f1a6a7600060cd0702b1b86e5a`
- Source: 2,937,157 bytes, 351 entries; audit found no forbidden private paths or credential patterns.
- Code: `3ba1d8f` (container support plus corrected explicit Docker allowlist).

The concrete reviewed template and this image are authorized for deployment.
Deployment is proceeding under the owner's explicit instruction. The initial comparison uses the
same original orientation policy as Lambda; browser comparison evidence has since
identified an orientation fix to evaluate before final provider selection.

The first creation failed because SageMaker CloudFormation `Ref` returns ARNs;
the endpoint configuration and proxy now use the documented name attributes.
The second failed because this account limits serverless endpoint memory to
3072 MB. The comparison uses that smaller available size rather than waiting for
a quota increase. Failed creations rolled back their newly empty resources;
their CloudFormation events are retained with the local benchmark evidence.
