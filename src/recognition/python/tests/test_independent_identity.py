import unittest
from independent_policy import validate_identity
from independent_service import IndependentRecognitionService
from adapters.bedrock_identity import BedrockIdentity, PROMPT
from PIL import Image
import json


class Tests(unittest.TestCase):
    def test_exact_identity_visible_alias_and_ambiguity(self):
        card={"id":"printing","oracle_id":"oracle","name":"Lightning Bolt","titles":{"lightningbolt","relampago"}}
        catalog={"lightningbolt":[card]}
        good={"uncertain":False,"identity":"Lightning Bolt","basis":"visible_title","visible_title":"Relámpago"}
        self.assertEqual(validate_identity(good,catalog)["oracle_id"],"oracle")
        for patch in [{"uncertain":True},{"identity":"invented"},{"visible_title":"Shock"},{"visible_title":""}]:
            self.assertIsNone(validate_identity({**good,**patch},catalog))
        self.assertIsNone(validate_identity(good,{"lightningbolt":[card,card]}))
        self.assertIsNotNone(validate_identity({**good,"basis":"artwork","visible_title":""},catalog))

    def test_geometry_rejects_before_provider_and_errors_expose_no_text(self):
        class Reader:
            version = {"model":"test"}
            calls = 0
            def read(self, image):
                self.calls += 1
                raise RuntimeError("private image text")
        reader = Reader()
        for state in ("none", "multiple", "ambiguous"):
            service = IndependentRecognitionService(reader, lambda image: {"state":state}, {}, {})
            self.assertEqual(service.recognize(None)["status"], "unknown")
        self.assertEqual(reader.calls, 0)
        result = IndependentRecognitionService(reader, lambda image: {"state":"single"}, {}, {}).recognize(None)
        self.assertEqual(reader.calls, 1)
        self.assertEqual(result["status"], "unknown")
        self.assertNotIn("private image text", str(result))

    def test_model_contract_strict_count_uncertainty_and_no_candidate_priming(self):
        good = {"card_count":1,"is_game_card":True,"identity":"Lightning Bolt","visible_title":"Lightning Bolt","language":"en","basis":"visible_title","visible_evidence":"Complete title","uncertain":False}
        class Client:
            value = good
            def converse(self, **request):
                self.request = request
                return {"output":{"message":{"content":[{"text":json.dumps(self.value)}]}}}
        client = Client()
        reader = BedrockIdentity(client, "test-model")
        image = Image.new("RGB", (1800, 2400))
        self.assertEqual(reader.read(image)["identity"], "Lightning Bolt")
        self.assertEqual(client.request["system"], [{"text":PROMPT}])
        self.assertNotIn("Lightning Bolt", str(client.request))
        self.assertEqual(client.request["inferenceConfig"]["maxTokens"], 300)
        for patch in ({"card_count":True},{"card_count":2},{"uncertain":"false"},{"is_game_card":False},{"basis":"confidence"},{"identity":"x"*201},{"visible_evidence":""}):
            client.value = {**good, **patch}
            self.assertTrue(reader.read(image)["uncertain"])
