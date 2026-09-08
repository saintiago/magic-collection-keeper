import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestionPanel } from "../public/suggestion-view.js";

test("UC-31 suggestion markup places accessible ownership beside escaped names and recent cards omit historical aliases", () => {
  const item = {
    name: "<Lightning & Bolt>",
    matched_name: "Relámpago <img>",
    matched_language: "es",
    quantity: 5,
  };
  const normal = suggestionPanel([item], 0);
  assert.match(
    normal,
    /&lt;Lightning &amp; Bolt&gt;<\/b><span class="suggestion-ownership" role="img">/,
  );
  assert.match(normal, /Relámpago &lt;img&gt; · ES/);
  assert.doesNotMatch(normal, /5 owned|<img>/);
  const recent = suggestionPanel(
    [item, { kind: "query", name: "Piracy" }],
    -1,
    { recent: true },
  );
  assert.doesNotMatch(recent, /Relámpago|suggestion-alias/);
  assert.match(recent, /Run this search again/);
  assert.equal((recent.match(/suggestion-ownership/g) || []).length, 1);
});
