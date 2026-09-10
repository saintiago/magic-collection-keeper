import { test } from "@playwright/test";
import { exerciseRecentPrintings } from "../helpers/recent-live.js";

test("LIVE-19 exact Recent printings preserve pending ownership, atomic addition receipts and reload order", ({
  page,
}) => exerciseRecentPrintings({ page }, test));
