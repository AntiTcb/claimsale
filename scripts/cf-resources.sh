#!/usr/bin/env bash
# Idempotent Cloudflare resource helpers built on the Cloudflare CLI (`cf`, beta).
# Used by CI and by scripts/setup.sh. Needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID in the environment (or a `cf auth login` session).
#
#   scripts/cf-resources.sh ensure-d1 <name> [location]   # prints the database ID
#   scripts/cf-resources.sh delete-d1 <name>
#   scripts/cf-resources.sh ensure-queue <name>
#   scripts/cf-resources.sh delete-queue <name>
#   scripts/cf-resources.sh delete-worker <name>
set -euo pipefail

cf() { pnpm exec cf "$@"; }

# cf prints JSON; accept either a bare array or an API envelope with "result".
rows='if type == "array" then .[] else (.result // [])[] end'

d1_id() {
	cf d1 list --name "$1" | jq -r --arg n "$1" "$rows | select(.name == \$n) | .uuid" | head -n1
}

queue_id() {
	cf queues list | jq -r --arg n "$1" "$rows | select(.queue_name == \$n) | .queue_id" | head -n1
}

worker_id() {
	cf workers list | jq -r --arg n "$1" "$rows | select(.name == \$n) | .id" | head -n1
}

cmd="${1:-}"
name="${2:-}"
[ -n "$cmd" ] && [ -n "$name" ] || { sed -n '5,9p' "$0" >&2; exit 2; }

case "$cmd" in
	ensure-d1)
		id="$(d1_id "$name")"
		if [ -z "$id" ]; then
			cf d1 create --name "$name" --primary-location-hint "${3:-enam}" > /dev/null
			id="$(d1_id "$name")"
		fi
		[ -n "$id" ] || { echo "Could not create or find D1 database $name" >&2; exit 1; }
		echo "$id"
		;;
	delete-d1)
		id="$(d1_id "$name")"
		if [ -n "$id" ]; then cf d1 delete "$id" > /dev/null; fi
		;;
	ensure-queue)
		if [ -z "$(queue_id "$name")" ]; then cf queues create --queue-name "$name" > /dev/null; fi
		;;
	delete-queue)
		id="$(queue_id "$name")"
		if [ -n "$id" ]; then cf queues delete "$id" > /dev/null; fi
		;;
	delete-worker)
		id="$(worker_id "$name")"
		if [ -n "$id" ]; then cf workers delete "$id" > /dev/null; fi
		;;
	*)
		echo "Unknown command: $cmd" >&2
		exit 2
		;;
esac
