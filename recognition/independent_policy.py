"""Exact catalog validation is necessary, not proof of model correctness."""
from policy import normal


def validate_identity(proposal, catalog, aliases=None):
    if proposal.get("uncertain") is not False:
        return None
    name = normal(proposal.get("identity", ""))
    matches = catalog.get(name, [])
    title = normal(proposal.get("visible_title", ""))
    # A complete native-language title can resolve globally when the proposed
    # English translation is absent from the catalog. Never fuzzy-match either.
    if not matches and title and aliases is not None:
        matches = aliases.get(title, [])
    if len(matches) != 1:
        return None
    card = matches[0]
    if proposal.get("basis") == "visible_title" and not title:
        return None
    if title and title not in card["titles"]:
        return None
    return {key:card[key] for key in ("id","oracle_id","name")}
