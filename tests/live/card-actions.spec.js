import { test } from "@playwright/test";
import { exerciseCardActions } from "../helpers/card-actions-live.js";
test("LIVE-17 cloud card actions retry atomically, isolate accounts and require catalogue Add", ({
  page,
  browser,
}) => exerciseCardActions({ page, browser }, test));
