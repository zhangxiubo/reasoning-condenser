#!/usr/bin/env bash
set -euo pipefail

credential_file="${OPENCODE_GO_CREDENTIAL_FILE:-.env}"

set -a
source "$credential_file"
set +a

: "${OPENCODE_GO_API_KEY:?OPENCODE_GO_API_KEY is missing from $credential_file}"

export PRIMARY_BASE_URL="https://opencode.ai/zen/go/v1"
export PRIMARY_MODEL="deepseek-v4-flash"
export PRIMARY_API_KEY="$OPENCODE_GO_API_KEY"
export CONDENSER_BASE_URL="$PRIMARY_BASE_URL"
export CONDENSER_MODEL="$PRIMARY_MODEL"
export CONDENSER_API_KEY="$OPENCODE_GO_API_KEY"
export UPSTREAM_REASONING_REPLAY_MODE="assistant_content"

exec npm start
