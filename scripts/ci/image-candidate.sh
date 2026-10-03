#!/usr/bin/env bash
# Reuse an immutable candidate by component build inputs, including on a fresh runner.
set -euo pipefail
repository="$1"
inputs_sha="$2"
[[ "$inputs_sha" =~ ^[0-9a-f]{64}$ ]]
version="inputs-$inputs_sha"
output="$3"
lookup_error="$(mktemp)"
trap 'rm -f "$lookup_error"' EXIT
if digest="$(aws ecr describe-images --repository-name "${repository#*/}" --image-ids imageTag="$version" --query 'imageDetails[0].imageDigest' --output text 2> "$lookup_error")"; then
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  image_uri="$repository@$digest"
  jq -n --arg imageUri "$image_uri" --arg digest "$digest" --arg version "$version" --arg inputsSha256 "$inputs_sha" '{kind:"image",values:{imageUri:$imageUri,digest:$digest,version:$version,inputsSha256:$inputsSha256}}' > "$output"
  echo 'found=true' >> "$GITHUB_OUTPUT"
elif grep -Fq 'ImageNotFoundException' "$lookup_error"; then
  echo 'found=false' >> "$GITHUB_OUTPUT"
else
  cat "$lookup_error" >&2
  exit 1
fi
