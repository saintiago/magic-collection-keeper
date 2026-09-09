import { test } from "@playwright/test";
import { exerciseBackendScanner } from "../helpers/backend-live.js";
test("LIVE-14 touch server candidate review, source access, wheel and persistence", async ({
  page,
}) => exerciseBackendScanner({ page }, test));
