"""Frozen public translated names, loaded offline and independently of visual weights."""
import gzip
import hashlib
import json


def load_title_names(root):
    manifest = json.loads((root / "name-catalog.json").read_text())
    data = (root / "title-names.json.gz").read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise ValueError("Title catalog digest mismatch")
    rows = json.loads(gzip.decompress(data))
    if len(rows) != manifest["identities"]:
        raise ValueError("Incomplete title catalog")
    return {oracle: [[name, "en"], *aliases] for oracle, name, printing, aliases in rows}


def load_identity_catalog(root):
    from policy import normal
    manifest = json.loads((root / "name-catalog.json").read_text())
    data = (root / "title-names.json.gz").read_bytes()
    if hashlib.sha256(data).hexdigest() != manifest["sha256"]:
        raise ValueError("Title catalog digest mismatch")
    rows = json.loads(gzip.decompress(data))
    if len(rows) != manifest["identities"]:
        raise ValueError("Incomplete title catalog")
    canonical, aliases = {}, {}
    for oracle, name, printing, names in rows:
        card = {"id":printing,"oracle_id":oracle,"name":name,"titles":{normal(v) for v,lang in [[name,"en"],*names]}}
        canonical.setdefault(normal(name),[]).append(card)
        for title in card["titles"]:
            aliases.setdefault(title,[]).append(card)
    return canonical, aliases
