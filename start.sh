#!/usr/bin/env bash
set -euo pipefail

export DOMAIN_RECORDS='[{"zone_id":"abc123","record_name":"tardigram.com","fallback_type":"A","fallback_content":"151.115.80.213"},{"zone_id":"abc123","record_name":"elpapeo.com","fallback_type":"A","fallback_content":"151.115.80.213"}]'

docker compose up --build "$@"
