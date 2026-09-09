import { test } from "@playwright/test";
import { exerciseBackendScanner } from "../helpers/backend-live.js";
test("LIVE-14 real server candidates, source access and confirmed ownership persistence", async ({
  page,
}) => exerciseBackendScanner({ page }, test));
