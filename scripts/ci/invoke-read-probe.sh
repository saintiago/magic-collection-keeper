#!/usr/bin/env bash
# Invoke a read-only Lambda boundary, allowing Aurora Serverless time to resume from auto-pause.
set -euo pipefail

function_name="$1"
request="$2"
response="$3"
invocation="$4"
attempts="${READ_PROBE_ATTEMPTS:-6}"
retry_seconds="${READ_PROBE_RETRY_SECONDS:-10}"

[[ "$attempts" =~ ^[1-9][0-9]*$ ]]
[[ "$retry_seconds" =~ ^[0-9]+$ ]]

for ((attempt = 1; attempt <= attempts; attempt++)); do
  aws lambda invoke \
    --function-name "$function_name" \
    --payload "fileb://$request" \
    "$response" > "$invocation"
  test "$(jq -r '.FunctionError // empty' "$invocation")" = ""
  status="$(jq -er '.statusCode | select(type == "number" and floor == .)' "$response")"
  if ((status < 400)); then
    exit 0
  fi
  code="$(jq -r 'try (.body | fromjson | .error.code // "") catch ""' "$response")"
  if [[ "$status" = 503 && "$code" = unavailable && "$attempt" -lt "$attempts" ]]; then
    sleep "$retry_seconds"
    continue
  fi
  printf 'Read probe failed with status %s and code %s after %s attempt(s).\n' \
    "$status" "${code:-unknown}" "$attempt" >&2
  exit 1
done
