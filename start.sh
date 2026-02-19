#!/usr/bin/env bash
set -euo pipefail

export DOMAIN_RECORDS='[
  {
    "zone_id": "faec4689c05f781fb7f3c78ee7210b95",
    "record_name": "tardigram.com",
    "fallback_type": "A",
    "fallback_content": "151.115.80.213"
  },
  {
    "zone_id": "d389c9eb9447d54287732dae99c19df2",
    "record_name": "elpapeo.com",
    "fallback_type": "A",
    "fallback_content": "151.115.80.213"
  }
]'

docker compose up --build "$@"
