"""JWT-to-SigV4 transport; no ML imports or inventory permissions."""

import base64
import json
import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

runtime = boto3.client(
    "sagemaker-runtime",
    config=Config(
        connect_timeout=2, read_timeout=25, retries={"total_max_attempts": 1}
    ),
)


def response(code, value):
    return {
        "statusCode": code,
        "headers": {"content-type": "application/json", "cache-control": "no-store"},
        "body": json.dumps(value),
    }


def handler(event, context):
    owner = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
        .get("sub")
    )
    if not isinstance(owner, str) or not owner:
        return response(401, {"error": "Sign in to scan"})
    body = event.get("body")
    if event.get("isBase64Encoded") or not isinstance(body, str) or len(body) > 710000:
        return response(413, {"error": "Image request too large"})
    try:
        payload = json.loads(body)
        if not isinstance(payload, dict) or set(payload) != {"image", "attempt"}:
            raise ValueError()
        if type(payload["attempt"]) is not int or not 1 <= payload["attempt"] <= 100000:
            raise ValueError()
        if not isinstance(payload["image"], str):
            raise ValueError()
        if not 0 < len(base64.b64decode(payload["image"], validate=True)) <= 524288:
            return response(413, {"error": "Image request too large"})
    except (ValueError, TypeError):
        return response(400, {"error": "Invalid image request"})
    try:
        result = runtime.invoke_endpoint(
            EndpointName=os.environ["ENDPOINT_NAME"],
            ContentType="application/json",
            Body=body.encode(),
            CustomAttributes=context.aws_request_id,
        )
        with result["Body"] as stream:
            value = json.loads(stream.read(65537))
        if (
            value.get("contractVersion") != 1
            or value.get("attempt") != payload["attempt"]
            or value.get("status") not in ("unknown", "possible")
        ):
            raise ValueError()
        return response(200, value)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        if code in ("ModelNotReadyException", "ServiceUnavailable"):
            return response(
                503,
                {"error": "Recognition is preparing. Retry shortly", "preparing": True},
            )
        if code in ("ThrottlingException", "TooManyRequestsException"):
            return response(429, {"error": "Scanner busy. Retry this card"})
        return response(503, {"error": "Recognition unavailable. Retry this card"})
    except (BotoCoreError, ValueError, KeyError):
        return response(503, {"error": "Recognition unavailable. Retry this card"})
