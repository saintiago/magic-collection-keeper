#!/usr/bin/env bash
# Reuse a published immutable candidate before preparation or rebuilding on a fresh runner.
set -euo pipefail
repository="$1"
version="$2"
output="$3"
lookup_error="$(mktemp)"
trap 'rm -f "$lookup_error"' EXIT
if digest="$(aws ecr describe-images --repository-name "${repository#*/}" --image-ids imageTag="$version" --query 'imageDetails[0].imageDigest' --output text 2> "$lookup_error")"; then
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  aws ecr get-login-password | docker login --username AWS --password-stdin "${repository%%/*}"
  image_uri="$repository@$digest"
  docker pull "$image_uri"
  manifest_sha="$(docker inspect --format '{{ index .Config.Labels "keeper.manifest-sha256" }}' "$image_uri")"
  [[ "$manifest_sha" =~ ^[0-9a-f]{64}$ ]]
  jq -n --arg imageUri "$image_uri" --arg digest "$digest" --arg version "$version" --arg manifestSha256 "$manifest_sha" '{kind:"image",values:{imageUri:$imageUri,digest:$digest,version:$version,manifestSha256:$manifestSha256}}' > "$output"
  echo 'found=true' >> "$GITHUB_OUTPUT"
elif grep -Fq 'ImageNotFoundException' "$lookup_error"; then
  echo 'found=false' >> "$GITHUB_OUTPUT"
else
  cat "$lookup_error" >&2
  exit 1
fi
