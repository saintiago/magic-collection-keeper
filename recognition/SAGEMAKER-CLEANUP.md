# Completed comparison: scoped SageMaker cleanup

The browser/Lambda hybrid no longer uses the SageMaker route. Actual
SageMaker baseline, corrected-image, parallel cold-start and subsequent-call
measurements are retained in the recognition evaluation benchmark directory.
Matching source ZIPs and image identity audits are retained separately. No
inventory was written by these comparisons.

The completed action was deletion of only CloudFormation stack
`magic-keeper-sagemaker`, account `698643713254`, region `us-east-1`, stack UUID
`157a3a50-abdd-11f1-b9c5-0affe3d85951`. This removes:

| Resource | Exact target |
| --- | --- |
| Endpoint | `magic-keeper-sagemaker` |
| Endpoint configuration | `EndpointConfig-3bycFHnGEGVY` |
| Model | `Model-7fKP8SlO26jD` |
| Proxy Lambda | `magic-keeper-sagemaker-proxy` |
| Model role | `magic-keeper-sagemaker-ModelRole-4JVfdK6VtjU2` |
| Proxy role | `magic-keeper-sagemaker-ProxyRole-hjlyMZrpsK9l` |
| JWT API route | `3to28wd`, only `POST /api/recognize/sagemaker` on API `exex6mzt02` |
| API integration | `m3wi4e7` |
| Proxy invocation permission | `magic-keeper-sagemaker-Permission-nkjIn73BvnwU` |
| Endpoint log group | `/aws/sagemaker/Endpoints/magic-keeper-sagemaker` |
| Proxy log group | `/aws/lambda/magic-keeper-sagemaker-proxy` |

Shared ECR images, the selected Lambda recognizer, its source offer, the collection
application/API/authorizer, all inventory/test profiles, existing CI permissions
and pantry resources are outside this action. The SageMaker comparison URL will
stop working. Recreating the reviewed template and retained image restores it;
deleted CloudWatch groups themselves are not recoverable from AWS, so timing
evidence has been exported before deletion.

The owner explicitly authorized removing unused solutions after final speed validation and stated that an explicit request replaces separate administrator review. Final 48/72-reading hybrid runs met the documented speed targets with zero failures/unsafe selections/inventory changes. The exact resource set and stack ARN were rechecked immediately before deletion. CloudFormation reports DELETE_COMPLETE on September 9, 2026. Shared resources were outside this action. Historical reproduction uses the template and dual-entrypoint code at commit 0d5df87; they are removed from the active runtime.
