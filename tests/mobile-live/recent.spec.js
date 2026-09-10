import { test } from "@playwright/test";
import { exerciseRecentPrintings } from "../helpers/recent-live.js";

test("LIVE-20 touch Recent printings preserve pending ownership, atomic addition receipts and reload order", ({
  page,
}) => exerciseRecentPrintings({ page }, test, true));
