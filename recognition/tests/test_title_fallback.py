import unittest
from service import RecognitionService
from policy import decide

CARD = {"id":"00000000-0000-4000-8000-000000000001", "oracle_id":"00000000-0000-4000-8000-000000000002", "name":"Example Long Title", "set":"tst", "collector_number":"12", "lang":"en"}

class Visual:
    version = {}
    def inspect(self, image):
        return {"identity_supported":False, "candidates":[CARD], "corners":[[0,0],[1,0],[1,1],[0,1]], "evidence":{"topScore":.58,"differentIdentityMargin":.09}}

class Text:
    version = {}
    def read(self, *args):return {"title":[],"footer":[]}

class Fallback:
    version = {"adapter":"test-vision-language"}
    def __init__(self,title="Example Long Title",fail=False):self.title,self.fail,self.calls=title,fail,0
    def read(self,*args):
        self.calls+=1
        if self.fail:raise RuntimeError("private provider message")
        return {"title":[self.title],"footer":[]}

class Tests(unittest.TestCase):
    def test_one_fallback_requires_whole_title_agreement_and_never_confirms(self):
        fallback=Fallback();result=RecognitionService(Visual(),Text(),fallback=fallback).recognize(None)
        self.assertEqual(fallback.calls,1)
        self.assertEqual(result["status"],"possible")
        self.assertIsNone(result["selected"])
        self.assertEqual(result["evidence"]["titleEvidenceProvider"],"vision_language")
        for wrong in ["Example Long", "Example Long Titles", "Different Known Card", ""]:
            result=RecognitionService(Visual(),Text(),fallback=Fallback(wrong)).recognize(None)
            self.assertEqual(result["status"],"unknown")
    def test_provider_failure_is_unknown_without_leaking_message(self):
        fallback=Fallback(fail=True);result=RecognitionService(Visual(),Text(),fallback=fallback).recognize(None)
        self.assertEqual(fallback.calls,1)
        self.assertEqual(result["status"],"unknown")
        self.assertNotIn("private",str(result))
    def test_no_fallback_for_missing_geometry_weak_or_already_supported_visual(self):
        for change in [{"corners":None},{"candidates":[]},{"evidence":{"topScore":.54,"differentIdentityMargin":.3}},{"evidence":{"topScore":.8,"differentIdentityMargin":.07}},{"identity_supported":True}]:
            class Changed(Visual):
                def inspect(self,image):return {**super().inspect(image),**change}
            fallback=Fallback();RecognitionService(Changed(),Text(),fallback=fallback).recognize(None)
            self.assertEqual(fallback.calls,0)

class AdapterTests(unittest.TestCase):
    def test_crop_and_request_bounds_and_uncertain_schema(self):
        import json
        from PIL import Image
        from adapters.bedrock_title import BedrockTitle
        class Client:
            def __init__(self): self.calls=[]; self.count=1
            def converse(self, **kwargs):
                self.calls.append(kwargs)
                return {"output":{"message":{"content":[{"text":json.dumps({"card_count":self.count,"title":"Example Long Title","language":"en","set_code":"TST","collector_number":"12","uncertain":False})}]}}}
        client=Client(); adapter=BedrockTitle(client,"amazon.nova-lite-v1:0")
        frame=Image.new("RGB",(1000,1400),"white")
        self.assertEqual(adapter.read(frame,None)["title"],[])
        self.assertEqual(len(client.calls),0)
        self.assertEqual(adapter.read(frame,[[0,0],[1,0],[1,1],[0,1]])["title"],["Example Long Title"])
        request=client.calls[0]
        self.assertEqual(request["inferenceConfig"],{"maxTokens":160,"temperature":0})
        self.assertLessEqual(len(request["messages"][0]["content"][0]["image"]["source"]["bytes"]),524288)
        client.count=True
        self.assertEqual(adapter.read(frame,[[0,0],[1,0],[1,1],[0,1]])["title"],[])

if __name__=="__main__":unittest.main()
