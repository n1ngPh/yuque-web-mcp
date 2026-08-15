#!/bin/sh
set -eu

app_dir=/opt/yuque-web-mcp
secret_dir=/etc/yuque-web-mcp
secret_file=$secret_dir/service.env

command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker is not installed' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'ERROR: docker compose is unavailable' >&2; exit 1; }

if command -v ss >/dev/null 2>&1 && ss -ltn | awk '{print $4}' | grep -Eq '(^|:)18080$'; then
  echo 'ERROR: TCP port 18080 is already listening' >&2
  exit 1
fi

for target in "$app_dir" "$secret_dir"; do
  if [ -e "$target" ]; then
    case "$target" in
      /opt/yuque-web-mcp|/etc/yuque-web-mcp) ;;
      *) echo "ERROR: unexpected target $target" >&2; exit 1 ;;
    esac
  fi
done

if [ ! -f "$secret_file" ]; then
  echo "ERROR: $secret_file does not exist" >&2
  exit 1
fi

mode=$(stat -c '%a' "$secret_file" 2>/dev/null || stat -f '%Lp' "$secret_file")
if [ "$mode" != 600 ]; then
  echo "ERROR: $secret_file must have mode 0600" >&2
  exit 1
fi

owner=$(stat -c '%U:%G' "$secret_file" 2>/dev/null || stat -f '%Su:%Sg' "$secret_file")
if [ "$owner" != root:root ]; then
  echo "ERROR: $secret_file must be owned by root:root" >&2
  exit 1
fi

required='YUQUE_HOST YUQUE_ORGANIZATION HOST PORT PUBLIC_BASE_URL MCP_ALLOWED_HOSTS MCP_OWNER_ID MCP_BEARER_TOKEN SESSION_ENCRYPTION_KEY'
for key in $required; do
  grep -q "^${key}=." "$secret_file" || { echo "ERROR: missing $key in service.env" >&2; exit 1; }
done

grep -q '^ALLOW_UNVERIFIED_CONTRACTS=false$' "$secret_file" || {
  echo 'ERROR: ALLOW_UNVERIFIED_CONTRACTS must remain false for deployment' >&2
  exit 1
}

echo 'Preflight passed. No server state was changed.'
