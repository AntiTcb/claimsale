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
#   scripts/cf-resources.sh delete-preview-pair <pr-number>   # web, queue, engine, D1
set -euo pipefail

# CF_BIN overrides the CLI (tests use a fake); by default the repo's pinned cf.
cf() {
	if [ -n "${CF_BIN:-}" ]; then "$CF_BIN" "$@"; else pnpm exec cf "$@"; fi
}

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
[ -n "$cmd" ] && [ -n "$name" ] || { sed -n '5,10p' "$0" >&2; exit 2; }

# --force everywhere: cf asks for confirmation otherwise, and aborts when nobody can answer (CI).
delete_d1() {
	local id; id="$(d1_id "$1")"
	if [ -n "$id" ]; then cf d1 delete "$id" --force > /dev/null; fi
}
delete_queue() {
	local id; id="$(queue_id "$1")"
	if [ -n "$id" ]; then cf queues delete "$id" --force > /dev/null; fi
}
delete_worker() {
	local id; id="$(worker_id "$1")"
	if [ -n "$id" ]; then cf workers delete "$id" --force > /dev/null; fi
}

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
	delete-d1) delete_d1 "$name" ;;
	ensure-queue)
		if [ -z "$(queue_id "$name")" ]; then cf queues create --queue-name "$name" > /dev/null; fi
		;;
	delete-queue) delete_queue "$name" ;;
	delete-worker) delete_worker "$name" ;;
	delete-preview-pair)
		# Order matters: web binds to the engine, and the API refuses to delete a Worker
		# that still consumes a queue (10064), so the queue goes before the engine.
		pr="$name"
		[[ "$pr" =~ ^[0-9]+$ ]] || { echo "delete-preview-pair needs a PR number" >&2; exit 2; }
		delete_worker "claimsale-web-pr-$pr"
		delete_queue "claimsale-notifications-pr-$pr"
		delete_worker "claimsale-engine-pr-$pr"
		delete_d1 "claimsale-pr-$pr"
		;;
	*)
		echo "Unknown command: $cmd" >&2
		exit 2
		;;
esac
