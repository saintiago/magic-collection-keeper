#!/usr/bin/env bash
set -euo pipefail

# Playwright downloads its pinned browsers itself. The hosted runner's unrelated
# Google Chrome apt index can be inconsistent while Google publishes an update.
# Move only that index configuration aside; keep Ubuntu dependency verification.
for source in /etc/apt/sources.list.d/*google-chrome*.list /etc/apt/sources.list.d/*google-chrome*.sources; do
  if [[ -f "$source" ]]; then
    sudo mv "$source" "/tmp/keeper-$(basename "$source").disabled"
  fi
done
npx playwright install --with-deps chromium webkit
