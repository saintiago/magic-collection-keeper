"""Vendor-independent recognition decision policy. SPDX-License-Identifier: AGPL-3.0-only"""

import re


def normal(value):
    return "".join(x for x in value.casefold() if x.isalnum())


def printing_agrees(printing, footer):
    if not all(
        isinstance(printing.get(key), str) and printing[key]
        for key in ("collector_number", "set", "lang")
    ):
        return False
    text = " ".join(footer).casefold()
    number = printing.get("collector_number", "")
    return bool(
        number
        and re.search(r"(?<!\w)0*" + re.escape(number) + r"(?!\w)", text)
        and all(
            re.search(r"(?<!\w)" + re.escape(printing.get(key, "?")) + r"(?!\w)", text)
            for key in ("set", "lang")
        )
    )


def decide(visual, text, *, allow_confirmed=False):
    evidence = {"visual": visual.get("evidence", {}), "text": text.get("evidence", {})}
    base = {
        "contractVersion": 1,
        "candidates": [],
        "selected": None,
        "evidence": evidence,
    }
    candidates = visual.get("candidates", [])
    if not visual.get("identity_supported") or not candidates:
        return {**base, "status": "unknown", "reason": "identity_uncertain"}
    first = candidates[0]
    title_agrees = normal(first["name"]) == normal(" ".join(text.get("title", [])))
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
