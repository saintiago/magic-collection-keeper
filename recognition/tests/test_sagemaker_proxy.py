import base64
import importlib.util
import io
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class Tests(unittest.TestCase):
    def setUp(self):
        self.runtime = Mock()
        modules = {
            "boto3": types.SimpleNamespace(client=Mock(return_value=self.runtime)),
            "botocore.config": types.SimpleNamespace(Config=Mock()),
            "botocore.exceptions": types.SimpleNamespace(BotoCoreError=OSError, ClientError=ClientError),
        }
        spec = importlib.util.spec_from_file_location("tested_proxy", Path(__file__).parents[1] / "sagemaker_proxy.py")
        self.proxy = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(self.proxy)
        self.context = types.SimpleNamespace(aws_request_id="c804eaff-f7c2-40ab-a459-ba461b33c3bd")
        self.body = {"image": base64.b64encode(b"test image bytes").decode(), "attempt": 1}
        self.event = {"requestContext": {"authorizer": {"jwt": {"claims": {"sub": "reserved-test-owner"}}}}, "body": json.dumps(self.body)}

    def test_denies_unauthenticated_owner_override_and_oversized_before_cloud(self):
        for event, expected in (({"body": self.event["body"]}, 401), ({**self.event, "body": json.dumps({**self.body, "owner": "forged"})}, 400), ({**self.event, "body": "x"*710001}, 413)):
            self.assertEqual(self.proxy.handler(event, self.context)["statusCode"], expected)
        self.runtime.invoke_endpoint.assert_not_called()

    def test_forwards_image_only_to_configured_endpoint_and_rejects_confirmation(self):
        result = {"contractVersion": 1, "attempt": 1, "status": "possible", "selected": None}
        self.runtime.invoke_endpoint.return_value = {"Body": io.BytesIO(json.dumps(result).encode())}
        with patch.dict("os.environ", {"ENDPOINT_NAME": "magic-keeper-sagemaker"}):
            self.assertEqual(self.proxy.handler(self.event, self.context)["statusCode"], 200)
        args = self.runtime.invoke_endpoint.call_args.kwargs
        self.assertEqual(args["EndpointName"], "magic-keeper-sagemaker")
        self.assertEqual(json.loads(args["Body"]), self.body)
        self.assertNotIn("reserved-test-owner", str(args))
        result["status"] = "confirmed"
        self.runtime.invoke_endpoint.return_value = {"Body": io.BytesIO(json.dumps(result).encode())}
        with patch.dict("os.environ", {"ENDPOINT_NAME": "magic-keeper-sagemaker"}):
            self.assertEqual(self.proxy.handler(self.event, self.context)["statusCode"], 503)

    def test_preparation_busy_and_errors_do_not_disclose_provider_details(self):
        with patch.dict("os.environ", {"ENDPOINT_NAME": "magic-keeper-sagemaker"}):
            for code, expected in (("ModelNotReadyException", 503), ("ThrottlingException", 429), ("PRIVATE_DETAIL", 503)):
                self.runtime.invoke_endpoint.side_effect = ClientError(code)
                result = self.proxy.handler(self.event, self.context)
                self.assertEqual(result["statusCode"], expected)
                self.assertNotIn(code, result["body"])
