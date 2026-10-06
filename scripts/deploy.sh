#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# INVOICE SERVICE DEPLOYMENT
# ============================================================
# Modes:
#   staging    Validate a new image in an isolated environment.
#   production Blue/green deployment with Nginx traffic switch.
#
# Usage:
#   ./deploy.sh staging <image>
#   ./deploy.sh production <image>
#
# Example:
#   ./deploy.sh staging itvmicroservicesteam/invoice-service:abc123
#   ./deploy.sh production itvmicroservicesteam/invoice-service:abc123
# ============================================================

# ============================================================
# ARGUMENTS
# ============================================================
MODE="${1:-}"
IMAGE="${2:-}"

# ============================================================
# PATHS / PROJECTS
# ============================================================
DEPLOY_DIR="/var/www/html/microservices/invoice-service"
GATEWAY_DIR="/var/www/html/microservices/gateway"
GATEWAY_NGINX_DIR="$GATEWAY_DIR/nginx"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
NETWORK_NAME="itv-network"
NGINX_CONTAINER="microservices-gateway"
NGINX_UPSTREAM_FILE="$GATEWAY_NGINX_DIR/invoice-service-upstream.conf"
STAGING_PROJECT="invoice-staging"
PRODUCTION_PROJECT="invoice-service-prod"
LOCK_FILE="/tmp/invoice-service-deploy.lock"

# ============================================================
# STAGING
# ============================================================
STAGING_APP_CONTAINER="invoice-service-staging"
STAGING_DB_CONTAINER="invoice-db-staging"
STAGING_VOLUME="invoice-mysql-staging-data"
STAGING_HOST_PORT="15006"

# ============================================================
# HEALTH / RETRIES
# ============================================================
HEALTH_PATH="/api/v1/health"
HEALTH_PORT="5006"
HEALTH_RETRIES=30
HEALTH_INTERVAL=2
DB_RETRIES=120
DB_INTERVAL=2
GATEWAY_RETRIES=10
GATEWAY_INTERVAL=2

# ============================================================
# PRODUCTION BLUE / GREEN
# ============================================================
BLUE_CONTAINER="invoice-service-blue"
GREEN_CONTAINER="invoice-service-green"
LEGACY_CONTAINER="invoice-service"

# ============================================================
# GRACEFUL SHUTDOWN
# ============================================================
DRAIN_SECONDS=20
OLD_CONTAINER_STOP_TIMEOUT=30

# ============================================================
# PRODUCTION SMOKE TEST
# ============================================================
PRODUCTION_SMOKE_TEST_URL="${PRODUCTION_SMOKE_TEST_URL:-}"

# ============================================================
# DEPLOYMENT STATE
# ============================================================
CURRENT_CONTAINER=""
NEW_CONTAINER=""
PREVIOUS_PRODUCTION_IMAGE=""
PRODUCTION_SWITCHED=0
DEPLOYMENT_SUCCESS=0
FAILURE_CLEANUP_RUNNING=0

# ============================================================
# MODE VALIDATION
# ============================================================
case "$MODE" in
    staging)
        ENV_FILE="$DEPLOY_DIR/.env.staging"
        APP_CONTAINER="$STAGING_APP_CONTAINER"
        DB_CONTAINER="$STAGING_DB_CONTAINER"
        APP_PORT="$STAGING_HOST_PORT"
        ;;
    production)
        ENV_FILE="$DEPLOY_DIR/.env.prod"
        DB_CONTAINER="invoice-db"
        APP_PORT="$HEALTH_PORT"
        ;;
    *)
        echo "❌ Invalid deployment mode."
        echo
        echo "Usage:"
        echo "  $0 staging <image>"
        echo "  $0 production <image>"
        exit 1
        ;;
esac

if [[ -z "$IMAGE" ]]; then
    echo "❌ Docker image is required."
    echo
    echo "Usage:"
    echo "  $0 $MODE <image>"
    exit 1
fi

# ============================================================
# IMAGE VALIDATION
# ============================================================
IMAGE_REPOSITORY="${IMAGE%:*}"

if [[ "$IMAGE_REPOSITORY" == "$IMAGE" ]]; then
    echo "❌ Docker image must contain an explicit tag:"
    echo "   $IMAGE"
    exit 1
fi

# ============================================================
# LOGGING
# ============================================================
log() { echo; echo "▶ $1"; }
success() { echo "✅ $1"; }
warning() { echo "⚠️ $1"; }
error() { echo "❌ $1"; }

# ============================================================
# PRE-FLIGHT VALIDATION
# ============================================================
validate_environment() {
    if [[ ! -f "$ENV_FILE" ]]; then
        error "Environment file not found:"
        echo "   $ENV_FILE"
        return 1
    fi

    if [[ ! -f "$COMPOSE_FILE" ]]; then
        error "Compose file not found:"
        echo "   $COMPOSE_FILE"
        return 1
    fi

    if ! command -v docker >/dev/null 2>&1; then
        error "Docker is not installed or unavailable."
        return 1
    fi

    if ! command -v flock >/dev/null 2>&1; then
        error "flock is required."
        return 1
    fi

    if [[ "$MODE" == "staging" ]]; then
        if ! command -v curl >/dev/null 2>&1; then
            error "curl is required for staging."
            return 1
        fi
        return 0
    fi

    if [[ ! -d "$GATEWAY_NGINX_DIR" ]]; then
        error "Gateway Nginx directory not found:"
        echo "   $GATEWAY_NGINX_DIR"
        return 1
    fi

    if ! docker container inspect "$NGINX_CONTAINER" >/dev/null 2>&1; then
        error "Gateway container not found:"
        echo "   $NGINX_CONTAINER"
        return 1
    fi

    if [[ -z "$PRODUCTION_SMOKE_TEST_URL" ]]; then
        error "PRODUCTION_SMOKE_TEST_URL is required."
        echo "   It must point to a safe read-only endpoint through the gateway."
        return 1
    fi

    if ! docker exec "$NGINX_CONTAINER" sh -c 'command -v curl >/dev/null 2>&1'; then
        error "curl is required inside $NGINX_CONTAINER."
        return 1
    fi

    return 0
}

# ============================================================
# DEPLOYMENT LOCK
# ============================================================
acquire_deployment_lock() {
    exec 9>"$LOCK_FILE"

    if ! flock -n 9; then
        error "Another Invoice Service deployment is already running."
        return 1
    fi

    echo "🔒 Deployment lock acquired."
}

# ============================================================
# CONTAINER HELPERS
# ============================================================
container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

container_running() {
    [[ "$(docker inspect --format='{{.State.Status}}' "$1" 2>/dev/null || true)" == "running" ]]
}

container_health() {
    docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo "missing"
}

get_container_image() {
    docker inspect --format='{{.Config.Image}}' "$1" 2>/dev/null || true
}

remove_container() {
    local container="$1"

    if ! container_exists "$container"; then
        return 0
    fi

    echo "🗑️ Removing container: $container"
    docker rm -f "$container" >/dev/null 2>&1 || true
}

stop_container_gracefully() {
    local container="$1"

    if ! container_exists "$container"; then
        return 0
    fi

    if ! container_running "$container"; then
        docker rm "$container" >/dev/null 2>&1 || true
        return 0
    fi

    echo "⏳ Gracefully stopping $container (${OLD_CONTAINER_STOP_TIMEOUT}s)..."

    if docker stop --time "$OLD_CONTAINER_STOP_TIMEOUT" "$container" >/dev/null 2>&1; then
        docker rm "$container" >/dev/null 2>&1 || true
        success "$container stopped gracefully."
        return 0
    fi

    warning "Graceful stop timed out."
    warning "Forcing removal of $container."
    docker rm -f "$container" >/dev/null 2>&1 || true
}

# ============================================================
# IMAGE HELPERS
# ============================================================
image_referenced_by_container() {
    local image="$1"
    docker ps -a --format '{{.Image}}' | grep -Fxq "$image"
}

remove_deployment_image_if_unused() {
    local image="$1"
    [[ -z "$image" ]] && return 0

    if image_referenced_by_container "$image"; then
        echo "ℹ️ Keeping image because a container still references it:"
        echo "   $image"
        return 0
    fi

    echo "🧹 Removing unused deployment image:"
    echo "   $image"
    docker image rm "$image" >/dev/null 2>&1 || true
}

# ============================================================
# STAGING CLEANUP
# ============================================================
cleanup_staging() {
    echo
    echo "🧹 Cleaning temporary staging environment..."

    remove_container "$STAGING_APP_CONTAINER"

    docker compose -p "$STAGING_PROJECT" --env-file "$DEPLOY_DIR/.env.staging" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true

    docker volume rm "$STAGING_VOLUME" >/dev/null 2>&1 || true

    success "Temporary staging environment removed."
}

# ============================================================
# DATABASE HEALTH
# ============================================================
wait_for_db() {
    local container="$1"

    echo "⏳ Waiting for database..."

    for i in $(seq 1 "$DB_RETRIES"); do
        if ! container_exists "$container"; then
            echo "Database container not created yet... ($i/$DB_RETRIES)"
            sleep "$DB_INTERVAL"
            continue
        fi

        local status
        status="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "starting")"

        case "$status" in
            healthy)
                success "Database healthy."
                return 0
                ;;
            unhealthy)
                error "Database is unhealthy."
                docker logs --tail 150 "$container" || true
                return 1
                ;;
            *)
                echo "Database: $status ($i/$DB_RETRIES)"
                sleep "$DB_INTERVAL"
                ;;
        esac
    done

    error "Database failed health check."
    docker logs --tail 150 "$container" || true
    return 1
}

# ============================================================
# APPLICATION HEALTH
# ============================================================
wait_for_container_health() {
    local container="$1"
    local label="$2"

    echo "⏳ Waiting for $label..."

    for i in $(seq 1 "$HEALTH_RETRIES"); do
        if ! container_exists "$container"; then
            echo "Container not created yet... ($i/$HEALTH_RETRIES)"
            sleep "$HEALTH_INTERVAL"
            continue
        fi

        local status
        local health

        status="$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")"
        health="$(container_health "$container")"

        if [[ "$status" == "exited" || "$status" == "dead" ]]; then
            error "$label container exited."
            docker logs --tail 200 "$container" || true
            return 1
        fi

        if [[ "$status" != "running" ]]; then
            echo "$label: $status ($i/$HEALTH_RETRIES)"
            sleep "$HEALTH_INTERVAL"
            continue
        fi

        if [[ "$health" == "healthy" ]]; then
            success "$label healthy."
            return 0
        fi

        if [[ "$health" == "unhealthy" ]]; then
            error "$label Docker healthcheck failed."
            docker logs --tail 200 "$container" || true
            return 1
        fi

        echo "$label: health=$health ($i/$HEALTH_RETRIES)"
        sleep "$HEALTH_INTERVAL"
    done

    error "$label health check timed out."
    docker logs --tail 200 "$container" || true
    return 1
}

# ============================================================
# PRODUCTION ACTIVE CONTAINER
# ============================================================
get_active_container() {
    local active=""

    # First production deployment:
    # no upstream file means there is no active Invoice container yet.
    if [[ ! -f "$NGINX_UPSTREAM_FILE" ]]; then
        echo ""
        return 0
    fi

    active="$(sed -n "s/^[[:space:]]*server[[:space:]]\+\([^:;[:space:]]*\):${HEALTH_PORT};.*/\1/p" "$NGINX_UPSTREAM_FILE" | head -n 1)"

    # Empty upstream means first deployment / no active service.
    if [[ -z "$active" ]]; then
        echo ""
        return 0
    fi

    case "$active" in
        "$BLUE_CONTAINER"|"$GREEN_CONTAINER"|"$LEGACY_CONTAINER")
            ;;
        *)
            error "Nginx upstream points to an unexpected container:"
            echo "   $active"
            return 1
            ;;
    esac

    # If the configured container is no longer running,
    # treat this as an inactive/first deployment state.
    if ! container_running "$active"; then
        warning "Nginx upstream points to '$active', but it is not running." >&2
        warning "Treating Invoice Service as having no active container." >&2
        echo ""
        return 0
    fi

    echo "$active"
}

get_new_container() {
    local current="$1"

    case "$current" in
        "")
            echo "$BLUE_CONTAINER"
            ;;
        "$BLUE_CONTAINER")
            echo "$GREEN_CONTAINER"
            ;;
        "$GREEN_CONTAINER")
            echo "$BLUE_CONTAINER"
            ;;
        "$LEGACY_CONTAINER")
            echo "$BLUE_CONTAINER"
            ;;
        *)
            error "Cannot determine new production color."
            return 1
            ;;
    esac
}

# ============================================================
# NGINX CONFIGURATION
# ============================================================
write_upstream_file() {
    local container="$1"
    local target_file="$2"

    cat > "$target_file" <<EOF
upstream invoice_service_backend {
    server ${container}:${HEALTH_PORT};
}
EOF
}

switch_nginx() {
    local new_container="$1"
    local previous_file
    local temporary_file

    previous_file="$(mktemp)"
    temporary_file="$(mktemp)"

    cleanup_switch_files() {
        rm -f "$previous_file" "$temporary_file"
    }

    if [[ -f "$NGINX_UPSTREAM_FILE" ]]; then
        cp "$NGINX_UPSTREAM_FILE" "$previous_file"
    else
        : > "$previous_file"
    fi

    write_upstream_file "$new_container" "$temporary_file"
    cp "$temporary_file" "$NGINX_UPSTREAM_FILE"

    if ! docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
        error "Nginx configuration validation failed."

        if [[ -s "$previous_file" ]]; then
            cp "$previous_file" "$NGINX_UPSTREAM_FILE"
        else
            : > "$NGINX_UPSTREAM_FILE"
        fi

        cleanup_switch_files
        return 1
    fi

    if ! docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1; then
        error "Nginx reload failed."

        if [[ -s "$previous_file" ]]; then
            cp "$previous_file" "$NGINX_UPSTREAM_FILE"
        else
            : > "$NGINX_UPSTREAM_FILE"
        fi

        if docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
            docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
        fi

        cleanup_switch_files
        return 1
    fi

    cleanup_switch_files
    return 0
}

# ============================================================
# VERIFY NGINX UPSTREAM
# ============================================================
verify_nginx_upstream() {
    local expected_container="$1"
    local actual_container=""

    actual_container="$(sed -n "s/^[[:space:]]*server[[:space:]]\+\([^:;[:space:]]*\):${HEALTH_PORT};.*/\1/p" "$NGINX_UPSTREAM_FILE" | head -n 1)"

    if [[ "$actual_container" != "$expected_container" ]]; then
        error "Nginx upstream verification failed."
        echo "   Expected: $expected_container"
        echo "   Actual  : ${actual_container:-none}"
        return 1
    fi

    if ! docker exec "$NGINX_CONTAINER" nginx -T 2>/dev/null | grep -Fq "server ${expected_container}:${HEALTH_PORT};"; then
        error "Gateway does not contain expected upstream:"
        echo "   ${expected_container}:${HEALTH_PORT}"
        return 1
    fi

    success "Nginx upstream points to $expected_container."
    return 0
}

# ============================================================
# REAL GATEWAY SMOKE TEST
# ============================================================
verify_gateway_traffic() {
    local expected_container="$1"

    echo "⏳ Verifying Nginx traffic → $expected_container..."

    if ! verify_nginx_upstream "$expected_container"; then
        return 1
    fi

    for i in $(seq 1 "$GATEWAY_RETRIES"); do
        if docker exec "$NGINX_CONTAINER" curl -fsS --max-time 10 "$PRODUCTION_SMOKE_TEST_URL" >/dev/null 2>&1; then
            success "Real gateway smoke test passed."
            return 0
        fi

        echo "Gateway smoke test retry $i/$GATEWAY_RETRIES"
        sleep "$GATEWAY_INTERVAL"
    done

    error "Real gateway smoke test failed:"
    echo "   $PRODUCTION_SMOKE_TEST_URL"
    return 1
}

# ============================================================
# PRODUCTION IMAGE CLEANUP
# ============================================================
cleanup_old_invoice_images() {
    local previous_image="${1:-}"
    local active_image=""
    local current_image="$IMAGE"
    local image=""
    local images=""

    echo "🧹 Cleaning old Invoice Service images..."

    if [[ -n "$NEW_CONTAINER" ]] && container_running "$NEW_CONTAINER"; then
        active_image="$(get_container_image "$NEW_CONTAINER")"
    fi

    echo
    echo "Protected images:"
    [[ -n "$active_image" ]] && echo "  Current  : $active_image"
    [[ -n "$previous_image" ]] && echo "  Previous : $previous_image"
    echo "  Deploying: $current_image"

    images="$(docker images "$IMAGE_REPOSITORY" --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' || true)"

    while IFS= read -r image; do
        [[ -z "$image" ]] && continue
        [[ "$image" == "$current_image" ]] && continue

        if [[ -n "$active_image" && "$image" == "$active_image" ]]; then
            continue
        fi

        if [[ -n "$previous_image" && "$image" == "$previous_image" ]]; then
            continue
        fi

        if image_referenced_by_container "$image"; then
            echo "Keeping referenced image: $image"
            continue
        fi

        echo "Removing old unused image: $image"
        docker image rm "$image" >/dev/null 2>&1 || true
    done <<< "$images"

    docker image prune -f >/dev/null 2>&1 || true
    success "Old unused Invoice Service images cleaned."
}

# ============================================================
# PRODUCTION FAILURE CLEANUP
# ============================================================
production_failure_cleanup() {
    local exit_code="${1:-1}"

    if [[ "$FAILURE_CLEANUP_RUNNING" -eq 1 ]]; then
        return 0
    fi

    FAILURE_CLEANUP_RUNNING=1

    echo
    echo "========================================="
    echo "⚠️ PRODUCTION DEPLOYMENT FAILED"
    echo "========================================="

    if [[ "$PRODUCTION_SWITCHED" -eq 1 ]]; then
        if [[ -n "$CURRENT_CONTAINER" ]]; then
            if container_running "$CURRENT_CONTAINER"; then
                echo "🔄 Restoring traffic to:"
                echo "   $CURRENT_CONTAINER"

                if switch_nginx "$CURRENT_CONTAINER"; then
                    if verify_nginx_upstream "$CURRENT_CONTAINER"; then
                        PRODUCTION_SWITCHED=0
                        success "Production traffic restored."
                    else
                        error "CRITICAL: Nginx rollback verification failed."
                    fi
                else
                    error "CRITICAL: Nginx rollback failed."
                    error "Manual intervention may be required."
                fi
            else
                error "Previous production container is unavailable."
                error "Automatic traffic rollback is not possible."
            fi
        else
            echo "ℹ️ No previous production container; there is nothing to roll back to."
        fi
    fi

    if [[ -n "$NEW_CONTAINER" ]] && [[ "$NEW_CONTAINER" != "$CURRENT_CONTAINER" ]]; then
        remove_container "$NEW_CONTAINER"
    fi

    cleanup_staging
    remove_deployment_image_if_unused "$IMAGE"

    echo
    echo "Failure cleanup completed."
    echo "========================================="

    return 0
}

# ============================================================
# UNEXPECTED ERROR HANDLER
# ============================================================
on_unexpected_error() {
    local exit_code="$1"

    if [[ "$MODE" == "production" ]] && [[ "$DEPLOYMENT_SUCCESS" -eq 0 ]]; then
        production_failure_cleanup "$exit_code"
    fi

    exit "$exit_code"
}

trap 'on_unexpected_error "$?"' ERR

# ============================================================
# DOCKER AUTHENTICATION
# ============================================================
docker_authenticate() {
    log "Docker authentication"

    if [[ -n "${DOCKER_USERNAME:-}" ]] && [[ -n "${DOCKER_TOKEN:-}" ]]; then
        printf '%s' "$DOCKER_TOKEN" | docker login --username "$DOCKER_USERNAME" --password-stdin
        success "Docker authentication completed."
    else
        echo "ℹ️ Docker credentials were not provided."
        echo "   Assuming the image is publicly accessible or already authenticated."
    fi
}

# ============================================================
# PULL IMAGE
# ============================================================
pull_image() {
    log "Pulling Docker image"

    if ! docker pull "$IMAGE"; then
        error "Failed to pull image."
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    export IMAGE_TAG="${IMAGE##*:}"

    echo
    echo "Image:"
    echo "  $IMAGE"
    success "Docker image pulled successfully."
}

# ============================================================
# STAGING APPLICATION
# ============================================================
start_staging_application() {
    log "Starting staging application"

    docker run -d \
        --name "$APP_CONTAINER" \
        --restart=no \
        --init \
        --env-file "$ENV_FILE" \
        --network "$NETWORK_NAME" \
        -p "127.0.0.1:${APP_PORT}:${HEALTH_PORT}" \
        --tmpfs "/tmp:rw,nosuid,nodev,size=256m" \
        --tmpfs "/dev/shm:rw,nosuid,nodev,size=256m" \
        --security-opt no-new-privileges:true \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        --health-cmd="node -e \"require('http').get('http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"" \
        --health-interval=30s \
        --health-timeout=10s \
        --health-retries=3 \
        --health-start-period=40s \
        "$IMAGE"
}

# ============================================================
# STAGING DEPLOYMENT
# ============================================================
deploy_staging() {
    echo
    echo "========================================="
    echo "🧪 TEMPORARY STAGING DEPLOYMENT"
    echo "========================================="

    cleanup_staging

    log "Starting staging database"

    docker compose -p "$STAGING_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d invoice-db

    if ! wait_for_db "$DB_CONTAINER"; then
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    if ! start_staging_application; then
        error "Failed to start staging application."
        docker logs --tail 200 "$APP_CONTAINER" || true
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    if ! wait_for_container_health "$APP_CONTAINER" "Staging application"; then
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    log "Running staging HTTP smoke test"

    local http_status

    http_status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" || true)"

    if [[ "$http_status" != "200" ]]; then
        error "Staging smoke test failed."
        echo "   HTTP status: $http_status"
        docker logs --tail 200 "$APP_CONTAINER" || true
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    echo
    echo "========================================="
    echo "✅ STAGING VALIDATION PASSED"
    echo "========================================="
    echo
    echo "ℹ️ Staging remains alive for production deployment."
    echo

    return 0
}

# ============================================================
# PRODUCTION DATABASE
# ============================================================
ensure_production_database() {
    log "Ensuring production database is healthy"

    docker compose -p "$PRODUCTION_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d invoice-db
    wait_for_db "$DB_CONTAINER"
}

# ============================================================
# START PRODUCTION APPLICATION
# ============================================================
start_production_application() {
    log "Starting new production container"

    docker run -d \
        --name "$NEW_CONTAINER" \
        --restart=unless-stopped \
        --init \
        --env-file "$ENV_FILE" \
        --network "$NETWORK_NAME" \
        --tmpfs "/tmp:rw,nosuid,nodev,size=256m" \
        --tmpfs "/dev/shm:rw,nosuid,nodev,size=256m" \
        --security-opt no-new-privileges:true \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        --health-cmd="node -e \"require('http').get('http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"" \
        --health-interval=30s \
        --health-timeout=10s \
        --health-retries=3 \
        --health-start-period=40s \
        "$IMAGE"
}

# ============================================================
# VERIFY GATEWAY NETWORK CONNECTIVITY
# ============================================================
verify_gateway_network_connectivity() {
    log "Validating new container from gateway network"

    if ! docker exec "$NGINX_CONTAINER" curl -fsS --max-time 10 "http://${NEW_CONTAINER}:${HEALTH_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
        error "Gateway network cannot reach new production container."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    success "Gateway network can reach $NEW_CONTAINER."
}

# ============================================================
# VERIFY PUBLIC HEALTH ROUTE
# ============================================================
verify_public_health_route() {
    local nginx_config
    local route_block

    if ! nginx_config="$(docker exec "$NGINX_CONTAINER" nginx -T 2>/dev/null)"; then
        error "Unable to read the active Nginx configuration."
        return 1
    fi

    route_block="$(printf '%s\n' "$nginx_config" | awk '
        /^[[:space:]]*location[[:space:]]*=[[:space:]]*\/invoices\/health[[:space:]]*\{/ {
            in_route = 1
            depth = 1
            print
            next
        }
        in_route {
            opens = gsub(/\{/, "{")
            closes = gsub(/\}/, "}")
            depth += opens - closes
            print
            if (depth == 0) {
                exit
            }
        }
    ')"

    if [[ -z "$route_block" ]] ||
        ! grep -Eq 'proxy_pass[[:space:]]+http://invoice_service_backend/api/v1/health([;[:space:]]|$)' <<< "$route_block"; then
        error "Nginx must define 'location = /invoices/health' and proxy it to the invoice blue/green upstream at /api/v1/health."
        return 1
    fi

    success "Nginx public health route proxies to the invoice blue/green upstream."
}

# ============================================================
# PRODUCTION DEPLOYMENT
# ============================================================
deploy_production() {
    echo
    echo "========================================="
    echo "🚀 ZERO-DOWNTIME PRODUCTION DEPLOYMENT"
    echo "========================================="

    log "Validating production Docker network"

    if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
        error "Docker network does not exist:"
        echo "   $NETWORK_NAME"
        return 1
    fi

    ensure_production_database

    log "Determining active production container"

    CURRENT_CONTAINER="$(get_active_container)"

    echo
    echo "Current container:"
    echo "  $CURRENT_CONTAINER"

    NEW_CONTAINER="$(get_new_container "$CURRENT_CONTAINER")"

    echo "New container:"
    echo "  $NEW_CONTAINER"

    if [[ "$CURRENT_CONTAINER" == "$NEW_CONTAINER" ]]; then
        error "New container is already active."
        return 1
    fi

    if [[ -n "$CURRENT_CONTAINER" ]]; then
        PREVIOUS_PRODUCTION_IMAGE="$(get_container_image "$CURRENT_CONTAINER")"
    else
        PREVIOUS_PRODUCTION_IMAGE=""
    fi

    echo
    echo "Previous production image:"
    echo "  ${PREVIOUS_PRODUCTION_IMAGE:-none}"

    log "Cleaning inactive production color"
    remove_container "$NEW_CONTAINER"

    if ! start_production_application; then
        error "Failed to start new production container."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    if ! wait_for_container_health "$NEW_CONTAINER" "New production application"; then
        error "New production deployment failed."
        return 1
    fi

    if ! docker inspect --format='{{range .Config.Env}}{{println .}}{{end}}' "$NEW_CONTAINER" |
        grep -q '^SERVICE_API_KEY=.'; then
        error "SERVICE_API_KEY is not available in $NEW_CONTAINER."
        return 1
    fi
    success "SERVICE_API_KEY is available in the new production container."

    verify_gateway_network_connectivity

    verify_public_health_route

    log "Switching Nginx traffic"

    if ! switch_nginx "$NEW_CONTAINER"; then
        error "Failed to switch Nginx traffic."
        return 1
    fi

    PRODUCTION_SWITCHED=1

    echo
    success "Nginx traffic switched to:"
    echo "   $NEW_CONTAINER"

    log "Running real gateway smoke test"

    if ! verify_gateway_traffic "$NEW_CONTAINER"; then
        error "Production gateway verification failed."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    success "Production gateway verification passed."

    if [[ -n "$CURRENT_CONTAINER" ]]; then
        log "Draining previous production container"
        echo "⏳ Waiting ${DRAIN_SECONDS}s for active connections..."
        sleep "$DRAIN_SECONDS"

        log "Gracefully removing previous production container"
        stop_container_gracefully "$CURRENT_CONTAINER"
    else
        echo "ℹ️ No previous production container."
    fi

    DEPLOYMENT_SUCCESS=1

    log "Removing temporary staging environment"
    cleanup_staging

    log "Cleaning old Invoice Service images"
    cleanup_old_invoice_images "$PREVIOUS_PRODUCTION_IMAGE"

    echo
    echo "📊 Invoice containers:"

    docker ps --filter "name=invoice-service-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true

    echo
    echo "========================================="
    echo "✅ ZERO-DOWNTIME DEPLOYMENT SUCCESSFUL"
    echo "========================================="

    echo "Active container : $NEW_CONTAINER"
    echo "Image            : $IMAGE"
    echo "Previous image   : ${PREVIOUS_PRODUCTION_IMAGE:-none}"
    echo "Staging          : removed"

    echo "========================================="
}

# ============================================================
# MAIN
# ============================================================
main() {
    validate_environment
    cd "$DEPLOY_DIR"
    acquire_deployment_lock
    docker_authenticate
    pull_image

    case "$MODE" in
        staging)
            deploy_staging
            ;;
        production)
            deploy_production
            ;;
    esac
}

main "$@"
