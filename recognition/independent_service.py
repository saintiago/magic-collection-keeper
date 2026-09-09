"""Independent identity proposals over geometry, reader and catalog ports."""
from time import perf_counter
from independent_policy import validate_identity


class IndependentRecognitionService:
    def __init__(self, reader, presence, catalog, aliases):
        self.reader, self.presence, self.catalog, self.aliases = reader, presence, catalog, aliases

    def recognize(self, image):
        began = perf_counter()
        base = {"contractVersion":1,"status":"unknown","candidates":[],"selected":None,"versions":{"independent":self.reader.version},"evidence":{"independentIdentity":True,"isProbability":False}}
        geometry = self.presence(image)
        base["evidence"]["visual"] = {"cardPresence":geometry}
        if geometry["state"] != "single":
            return {**base,"reason":"wait_for_single_card","timings":{"totalMs":(perf_counter()-began)*1000}}
        checked = perf_counter()
        try:
            proposal = self.reader.read(image)
            card = validate_identity(proposal,self.catalog,self.aliases)
            base["evidence"].update(model=proposal.get("metrics",{}),identityBasis=proposal.get("basis"),catalogValidated=bool(card))
            if card:
                base.update(status="possible",candidates=[card],reason="review_independent_identity")
        except Exception:
            base["evidence"]["independentUnavailable"] = True
        return {**base,"timings":{"geometryMs":(checked-began)*1000,"independentMs":(perf_counter()-checked)*1000,"totalMs":(perf_counter()-began)*1000}}
