"""Vendor-independent recognition decision policy. SPDX-License-Identifier: AGPL-3.0-only"""

import re
import unicodedata


def normal(value):
    return "".join(x for x in unicodedata.normalize("NFKD", value.casefold()) if x.isalnum())


def title_languages(name, title, aliases):
    # OCR sometimes includes numeric mana to the right of the complete title.
    # Only a separated terminal number may be removed; never fuzzy words.
    text = " ".join(title).strip()
    forms = {normal(text), normal(re.sub(r"\s+\d{1,3}$", "", text))}
    return {lang for value, lang in [[name, "en"], *aliases] if normal(value) and normal(value) in forms}


def needs_title_check(visual):
    evidence = visual.get("evidence", {})
    return bool(
        visual.get("candidates")
        and visual.get("corners") is not None
        and evidence.get("topScore", 0) >= 0.60
        and evidence.get("differentIdentityMargin", 0) >= 0.12
    )


def needs_vlm_check(visual):
    evidence = visual.get("evidence", {})
    return bool(visual.get("candidates") and visual.get("corners") is not None and evidence.get("topScore", 0) >= .55 and evidence.get("differentIdentityMargin", 0) >= .08)


def printing_agrees(printing, footer, language=None):
    if not all(
        isinstance(printing.get(key), str) and printing[key]
        for key in ("collector_number", "set", "lang")
    ):
        return False
    text = " ".join(footer).casefold()
    number = printing.get("collector_number", "")
    lang = language or printing["lang"]
    printed_lang = {"es": "sp", "ja": "jp"}.get(lang, lang)
    set_lang = r"(?<!\w)" + re.escape(printing["set"]) + r"[\W_]*" + re.escape(printed_lang) + r"(?!\w)"
    return bool(
        number
        and re.search(r"(?<!\w)[curm]?0*" + re.escape(number) + r"(?!\w)", text)
        and (re.search(set_lang, text) or all(re.search(r"(?<!\w)" + re.escape(token) + r"(?!\w)", text) for token in [printing["set"], printed_lang]))
    )


def decide(visual, text, *, aliases=(), vision_language=False, allow_confirmed=False):
    evidence = {"visual": visual.get("evidence", {}), "text": text.get("evidence", {})}
    base = {
        "contractVersion": 1,
        "candidates": [],
        "selected": None,
        "evidence": evidence,
    }
    candidates = visual.get("candidates", [])
    if not candidates:
        return {**base, "status": "unknown", "reason": "identity_uncertain"}
    first = candidates[0]
    name = normal(first["name"])
    languages = title_languages(first["name"], text.get("title", []), aliases)
    title_agrees = bool(languages)
    if len(languages) == 1:
        evidence["titleLanguage"] = next(iter(languages))
    plausible = needs_vlm_check(visual) if vision_language else needs_title_check(visual)
    title_corroborated = plausible and len(name) >= 8 and title_agrees
    if vision_language:
        evidence["titleEvidenceProvider"] = "vision_language"
    evidence["identityTitleCorroborated"] = title_corroborated
    if not visual.get("identity_supported") and not title_corroborated:
        return {**base, "status": "unknown", "reason": "identity_uncertain"}
    exact_ids = [c["id"] for c in candidates if c.get("oracle_id") == first.get("oracle_id") and title_agrees and printing_agrees(c, text.get("footer", []))]
    if len(exact_ids) == 1:
        evidence["exactPrintingId"] = exact_ids[0]
    if title_agrees and len(languages) == 1:
        references = [c["id"] for c in candidates if c.get("oracle_id") == first.get("oracle_id") and printing_agrees(c, text.get("footer", []), next(iter(languages)))]
        if len(references) == 1:
            evidence["printingReferenceId"] = references[0]
    exact = title_agrees and printing_agrees(first, text.get("footer", []))
    evidence.update(titleAgrees=title_agrees, exactPrintingCorroborated=exact)
    # Both switches and adapter-specific calibration approval are required.
    if (
        allow_confirmed
        and visual.get("confirmation_calibrated")
        and text.get("confirmation_calibrated")
        and exact
    ):
        return {
            **base,
            "status": "confirmed",
            "candidates": candidates,
            "selected": first,
            "reason": "printing_corroborated",
        }
    return {
        **base,
        "status": "possible",
        "candidates": candidates,
        "reason": "review_printing" if title_agrees else "review_identity",
    }
