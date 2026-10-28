#!/usr/bin/env bash
# The move to the fitfine backend: copies the 11 tables with their constraints, indexes and
# triggers, every row, the auth users and the member photos from the old project into
# TARGET_SCHEMA of the target project, deploys the backend (supabase/migrations, supabase/functions)
# and validates each step. --final does all of it on a brand-new project. Usage: ./run.sh --help
set -euo pipefail
umask 077
MIG_DIR=$(cd "$(dirname "$0")" && pwd)
. "$MIG_DIR/lib/common.sh"
. "$MIG_DIR/lib/defs.sh"
. "$MIG_DIR/lib/preflight.sh"
. "$MIG_DIR/lib/load.sh"
. "$MIG_DIR/lib/validate.sh"
. "$MIG_DIR/lib/photos.sh"
. "$MIG_DIR/lib/backend.sh"
. "$MIG_DIR/lib/deploy.sh"

usage() {
  cat <<'EOF'
Usage: run.sh [--preflight | --load | --validate | --photos | --validate-photos | --validate-backend
              | --deploy-backend | --deploy-functions | --final [--yes]]

The final run, on a brand-new project (README "Final run"):
  --final       everything below, in order, stopping at the first failure: the checks, the data
                (load + 4a/4b), the photos, the backend, the functions, then the manual checklist.
                Asks you to type the target ref first; --yes skips that (unattended runs).

With no option, the data run only, unattended:
  Task 0 preflight -> load (Tasks 1-3) -> validate 4a + 4b
The app must be down for the whole run: nothing may sign in or write on either project.

  --preflight   Task 0 only: read-only checks, changes nothing
  --load        Task 0, then one load (Tasks 1-3); no validation
  --validate    Task 0, then 4a + 4b against the current target; read-only

Member photos, after the data is loaded:
  --photos           copy every source photo into the target bucket, same names; creates the
                     bucket with the source's settings if missing; re-run copies only what is missing
  --validate-photos  read-only: same names, same bytes, every fitfine.members photo path found

The backend, after the data is loaded (each safe to re-run):
  --deploy-backend    marks the baseline migration applied, pushes supabase/migrations (constraints,
                      grants, access rule, triggers, policies, views, API functions, storage),
                      then --validate-backend (checks D.1, B.1-B.12)
  --deploy-functions  deploys supabase/functions (server-side bundling, no Docker), checks they are
                      all ACTIVE with JWT verification on, and smoke-tests each (checks D.2, D.3)
  --validate-backend  read-only, target only: grants, policies, constraints, functions, triggers,
                      views, storage and default privileges against the design (checks B.1-B.12)

Exit codes: 0 ok, 1 a step or check failed, 2 refused before changing anything.
Connection details come from .env.local next to this script (MIG_ENV_FILE overrides the path);
a variable already set in the shell wins over the file.
EOF
}

mode=all
MIG_YES=0
if [ "${2-}" = --yes ]; then
  [ "${1-}" = --final ] || { usage >&2; refuse "--yes goes only with --final"; }
  MIG_YES=1
  set -- "$1"
fi
case ${1-} in
  '')          ;;
  --preflight) mode=preflight ;;
  --load)      mode=load ;;
  --validate)  mode=validate ;;
  --photos)    mode=photos ;;
  --validate-photos) mode=validate-photos ;;
  --validate-backend) mode=validate-backend ;;
  --deploy-backend) mode=deploy-backend ;;
  --deploy-functions) mode=deploy-functions ;;
  --final)     mode=final ;;
  --yes)       usage >&2; refuse "--yes goes only with --final" ;;
  -h|--help)   usage; exit "$EXIT_OK" ;;
  *)           usage >&2; refuse "unknown argument: $1" ;;
esac
[ $# -le 1 ] || { usage >&2; refuse "one option at most"; }

load_env "${MIG_ENV_FILE:-$MIG_DIR/.env.local}"
TARGET_SCHEMA=${TARGET_SCHEMA:-fitfine}

# Every file the run writes (source export, 4a exports, psql buffers) goes here: mode 700, outside
# the repo, removed on any exit. It holds member records and password hashes while the run lasts.
done_ok() { MIG_DONE=1; exit "$EXIT_OK"; }

MIG_TMP=$(mktemp -d "${TMPDIR:-/tmp}/migrate-to-fitfine.XXXXXX")
chmod 700 "$MIG_TMP"
# Bash 3.2 exits 0 when set -u aborts a script that has an EXIT trap, and $? in the trap is 0 too,
# so a crash would look like success. Every intended success sets MIG_DONE first (done_ok); any
# other exit 0 is turned into 1.
trap 'rc=$?; rm -rf "$MIG_TMP"; [ "$rc" != 0 ] || [ "${MIG_DONE-}" = 1 ] || rc=$EXIT_FAIL; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export TMPDIR=$MIG_TMP

case $mode in
  validate-backend)
    preflight_backend
    step_validate_backend || exit "$EXIT_FAIL"
    done_ok ;;
  deploy-backend)
    preflight_deploy_static backend
    preflight_backend
    step_deploy_backend || exit "$EXIT_FAIL"
    done_ok ;;
  deploy-functions)
    preflight_deploy_static functions
    step_deploy_functions || exit "$EXIT_FAIL"
    done_ok ;;
  final)
    preflight_deploy_static final
    preflight_photo_vars
    preflight
    preflight_photos
    preflight_fresh_target
    confirm_target
    step_load
    step_validate || { log "stopping: the load failed 4a/4b"; exit "$EXIT_FAIL"; }
    step_photos || { log "stopping: the photo copy failed"; exit "$EXIT_FAIL"; }
    step_validate_photos || { log "stopping: the photo validation failed"; exit "$EXIT_FAIL"; }
    step_deploy_backend || { log "stopping: the backend deploy or its validation failed"; exit "$EXIT_FAIL"; }
    step_deploy_functions || { log "stopping: the function deploy or its checks failed"; exit "$EXIT_FAIL"; }
    final_checklist
    done_ok ;;
  photos|validate-photos)
    preflight_photo_vars
    preflight_connections
    preflight_photos
    if [ "$mode" = photos ]; then step_photos || exit "$EXIT_FAIL"; else step_validate_photos || exit "$EXIT_FAIL"; fi
    done_ok ;;
esac

preflight

case $mode in
  preflight)
    done_ok ;;
  load)
    step_load
    done_ok ;;
  validate)
    step_validate || exit "$EXIT_FAIL"
    done_ok ;;
esac

step_load
step_validate || { log "the load failed 4a/4b; the target is left as it is for inspection"; exit "$EXIT_FAIL"; }
log "done: the target holds the source data in $TARGET_SCHEMA, validated (4a + 4b)"
done_ok
