import { test } from "@playwright/test";
import { exerciseCardActions } from "../helpers/card-actions-live.js";
test("LIVE-18 native mobile artwork and tag controls preserve cloud review and explicit ownership", ({
  page,
  browser,
}) => exerciseCardActions({ page, browser }, test, true));
