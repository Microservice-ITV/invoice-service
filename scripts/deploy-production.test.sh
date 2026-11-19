#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/deploy.sh" production test-image:test

events=()
old_running=0

container_exists() { [[ "$1" == "invoice-service-blue" ]]; }
container_running() { return 1; }
docker() { events+=("docker:$*"); }
stop_container_gracefully invoice-service-blue true
[[ "${#events[@]}" -eq 0 ]]
echo "PASS: an already-stopped previous container is retained for rollback."

stop_container_gracefully() {
    events+=("stop:$1:$2")
}

docker() {
    case "$1" in
        run)
            if [[ " $* " != *" -e RABBITMQ_CONSUMERS_START_PAUSED=true "* ]]; then
                echo "New production container was not started with consumers paused." >&2
                return 1
            fi
            events+=("run-paused")
            ;;
        kill) events+=("signal:$3:$2") ;;
        start)
            events+=("start:$2")
            old_running=1
            ;;
        *) echo "Unexpected docker command in test: $*" >&2; return 1 ;;
    esac
}

wait_for_consumer_activation() {
    events+=("activate:$1")
}

CURRENT_CONTAINER="invoice-service-blue"
NEW_CONTAINER="invoice-service-green"
IMAGE="test-image"
start_production_application
[[ "${events[0]}" == "run-paused" ]]
events=()
PREVIOUS_CONTAINER_STOPPED=0
perform_production_consumer_handoff

[[ "${events[0]}" == "stop:invoice-service-blue:true" ]]
[[ "${events[1]}" == "signal:invoice-service-green:--signal=USR2" ]]
[[ "${events[2]}" == "activate:invoice-service-green" ]]
[[ "$PREVIOUS_CONTAINER_STOPPED" -eq 1 ]]
echo "PASS: previous consumer stops before new consumer activation."

events=()
container_running() { [[ "$1" == "$CURRENT_CONTAINER" && "$old_running" -eq 1 ]]; }
wait_for_container_health() {
    events+=("healthy:$1")
    old_running=1
}
remove_container() { events+=("remove:$1"); }
switch_nginx() { events+=("switch:$1"); }
verify_nginx_upstream() { events+=("verify:$1"); }
cleanup_staging() { events+=("cleanup-staging"); }
remove_deployment_image_if_unused() { events+=("cleanup-image:$1"); }

PRODUCTION_SWITCHED=1
PREVIOUS_CONTAINER_STOPPED=1
old_running=0
production_failure_cleanup 1

remove_new_index=-1
start_old_index=-1
switch_old_index=-1
for index in "${!events[@]}"; do
    [[ "${events[$index]}" == "remove:$NEW_CONTAINER" ]] && remove_new_index="$index"
    [[ "${events[$index]}" == "start:$CURRENT_CONTAINER" ]] && start_old_index="$index"
    [[ "${events[$index]}" == "switch:$CURRENT_CONTAINER" ]] && switch_old_index="$index"
done

[[ "$remove_new_index" -ge 0 ]]
[[ "$start_old_index" -gt "$remove_new_index" ]]
[[ "$switch_old_index" -gt "$start_old_index" ]]
echo "PASS: rollback removes the new app before restarting and routing to the previous app."
