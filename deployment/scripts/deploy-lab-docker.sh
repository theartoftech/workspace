#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMMAND=""
CONFIRM_DEPLOY=""
ENV_FILE=""
ENV_FILE_SET=false
RUNTIME_DIR=""
RUNTIME_DIR_SET=false
SSH_HOST=""
SSH_USER="${USER:-}"
REMOTE_DIR=""
LOG_TAIL=200
COMPOSE_COMMAND=()
PORTAL_BUILD_REVISION="${PORTAL_BUILD_REVISION:-}"

usage() {
    cat <<'USAGE'
Usage: deployment/scripts/deploy-lab-docker.sh <command> [options]

Commands:
  plan        Validate the single-host Compose model with example settings; no containers start.
  preflight   Validate real settings, secret files, Docker, and Compose without starting containers.
  deploy      Build the portal/API, pull pinned images, and start the lab stack. Requires exact confirmation.
  status      Show container state without changing the deployment.
  verify      Verify containers and local HTTP readiness endpoints.
  logs        Show recent stack logs without following them.
  help        Show this help.

Options:
  --env-file <path>        Environment file. Defaults to `.env.example` for plan and
                           `<runtime-dir>/.env` for all runtime commands.
  --runtime-dir <path>     Persistent secret/data root. Defaults to the Compose source locally.
  --confirm-deploy <name>  Required for deploy and must be: lab-docker
  --host <hostname>        Run on the CPQ lab server over SSH.
  --ssh-user <user>        SSH user. Default: current local user.
  --remote-dir <path>      Remote root. Default: /home/<user>/workspace-monitor
  --tail <lines>           Number of log lines. Default: 200
  -h, --help               Show this help.

Examples:
  deployment/scripts/deploy-lab-docker.sh plan --host 192.168.86.246 --ssh-user jhaynes
  deployment/scripts/deploy-lab-docker.sh preflight --host 192.168.86.246 --ssh-user jhaynes
  deployment/scripts/deploy-lab-docker.sh deploy --host 192.168.86.246 \
    --ssh-user jhaynes --confirm-deploy lab-docker

The lab profile binds operator ports to loopback for the Cloudflare tunnel.
It does not create or modify Cloudflare tunnels, credentials, DNS, or Access policy.
USAGE
}

fail() {
    echo "$*" >&2
    exit 1
}

require_value() {
    local option="$1"
    local value="${2:-}"
    if [[ -z "$value" || "$value" == --* ]]; then
        fail "$option requires a value."
    fi
}

set_command() {
    local requested="$1"
    if [[ -n "$COMMAND" ]]; then
        fail "Only one command may be supplied; got '$COMMAND' and '$requested'."
    fi
    COMMAND="$requested"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        plan|preflight|deploy|status|verify|logs)
            set_command "$1"
            ;;
        help|-h|--help)
            usage
            exit 0
            ;;
        --env-file)
            require_value "$1" "${2:-}"
            ENV_FILE="$2"
            ENV_FILE_SET=true
            shift
            ;;
        --runtime-dir)
            require_value "$1" "${2:-}"
            RUNTIME_DIR="$2"
            RUNTIME_DIR_SET=true
            shift
            ;;
        --confirm-deploy)
            require_value "$1" "${2:-}"
            CONFIRM_DEPLOY="$2"
            shift
            ;;
        --host)
            require_value "$1" "${2:-}"
            SSH_HOST="$2"
            shift
            ;;
        --ssh-user)
            require_value "$1" "${2:-}"
            SSH_USER="$2"
            shift
            ;;
        --remote-dir)
            require_value "$1" "${2:-}"
            REMOTE_DIR="$2"
            shift
            ;;
        --tail)
            require_value "$1" "${2:-}"
            LOG_TAIL="$2"
            shift
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

[[ -n "$COMMAND" ]] || fail "A command is required. Run with help for usage."
[[ "$LOG_TAIL" =~ ^[1-9][0-9]{0,4}$ ]] || fail "--tail must be an integer from 1 to 99999."
if [[ "$COMMAND" == "deploy" && "$CONFIRM_DEPLOY" != "lab-docker" ]]; then
    fail "Refusing deployment. Rerun with --confirm-deploy lab-docker after reviewing plan and preflight output."
fi

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

shell_join() {
    local quoted=()
    local argument
    for argument in "$@"; do
        quoted+=("$(printf '%q' "$argument")")
    done
    printf '%s' "${quoted[*]}"
}

validate_remote_dir() {
    local directory="$1"
    [[ "$directory" == /* ]] || fail "--remote-dir must be an absolute path."
    [[ "$directory" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "--remote-dir contains unsupported characters: $directory"
    [[ "$directory" != "/" && "$directory" != "/home" && "$directory" != "/Users" ]] || fail "--remote-dir is too broad: $directory"
    [[ "$directory" != *".."* ]] || fail "--remote-dir must not contain '..'."
}

sha256_file() {
    local file="$1"
    local digest
    if command -v sha256sum >/dev/null 2>&1; then
        digest="$(sha256sum "$file" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
        digest="$(shasum -a 256 "$file" | awk '{print $1}')"
    else
        fail "SHA-256 tooling is required as either 'sha256sum' or 'shasum'."
    fi
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "Unable to derive a valid SHA-256 digest for the candidate archive."
    printf '%s' "$digest"
}

validate_direct_local_portal_source() {
    [[ "$COMMAND" == "deploy" ]] || return 0
    [[ "${MONITORING_REMOTE_EXEC:-0}" != "1" ]] || return 0
    require_command git
    git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || \
        fail "Direct local portal deployment must run from a Git worktree."
    local changes
    changes="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal)"
    [[ -z "$changes" ]] || \
        fail "Direct local deploy requires a clean Git worktree. Use --host to package an uncommitted candidate with content-derived provenance."
}

sync_and_run_remote() {
    require_command ssh
    require_command tar
    [[ -n "$SSH_USER" ]] || fail "--ssh-user is required when the current user cannot be detected."
    [[ "$ENV_FILE_SET" == false ]] || fail "--env-file with --host is refused. Provision the remote runtime .env separately."
    [[ "$RUNTIME_DIR_SET" == false ]] || fail "--runtime-dir with --host is ambiguous; use --remote-dir to select the remote root."
    if [[ -z "$REMOTE_DIR" ]]; then
        REMOTE_DIR="/home/${SSH_USER}/workspace-monitor"
    fi
    validate_remote_dir "$REMOTE_DIR"

    local remote_target="${SSH_USER}@${SSH_HOST}"
    local release_dir="${REMOTE_DIR}/release"
    local runtime_dir="${REMOTE_DIR}/runtime/lab-docker"
    local portal_revision=""
    local release_quoted
    release_quoted="$(printf '%q' "$release_dir")"

    if [[ "$COMMAND" == "plan" || "$COMMAND" == "preflight" || "$COMMAND" == "deploy" ]]; then
        local archive
        archive="$(mktemp "${TMPDIR:-/tmp}/workspace-monitor-lab-docker.XXXXXX")"
        trap "rm -f -- $(printf '%q' "$archive")" EXIT
        # Runtime .env, secrets, and data are never synchronized from the workstation.
        COPYFILE_DISABLE=1 tar \
            --exclude='._*' \
            --exclude='.git' \
            --exclude='.env' \
            --exclude='node_modules' \
            --exclude='dist' \
            --exclude='coverage' \
            --exclude='runtime' \
            --exclude='*/secrets' \
            --exclude='*/secrets/*' \
            --exclude='deploy/compose/lab-observability/data' \
            -cf "$archive" \
            .dockerignore \
            package.json \
            package-lock.json \
            index.html \
            vite.config.ts \
            tsconfig.json \
            tsconfig.app.json \
            tsconfig.node.json \
            tsconfig.server.json \
            web \
            shared \
            server \
            catalog \
            deploy/portal \
            deploy/inventory-api \
            deploy/kubernetes \
            deployment/scripts/deploy-lab-docker.sh \
            deployment/PORTAL_ROLLBACK.md \
            deploy/compose/lab-observability \
            probes/internal/config.yaml
        local archive_digest
        archive_digest="$(sha256_file "$archive")"
        portal_revision="candidate-${archive_digest}"
        local remote_archive="${REMOTE_DIR}/.candidate-${archive_digest}.tar"
        local remote_archive_quoted
        remote_archive_quoted="$(printf '%q' "$remote_archive")"
        local remote_root_quoted
        remote_root_quoted="$(printf '%q' "$REMOTE_DIR")"
        echo "Candidate revision: ${portal_revision}"
        echo "Synchronizing credential-free lab monitoring sources to ${remote_target}:${release_dir}..."
        ssh "$remote_target" \
            "mkdir -p -- ${remote_root_quoted} && cat > ${remote_archive_quoted} && echo '${archive_digest}  ${remote_archive}' | sha256sum --check --status && rm -rf -- ${release_quoted} && mkdir -p -- ${release_quoted} && tar -xf ${remote_archive_quoted} -C ${release_quoted} && rm -f -- ${remote_archive_quoted}" \
            < "$archive"
    fi

    local remote_arguments=("$COMMAND" --runtime-dir "$runtime_dir" --tail "$LOG_TAIL")
    if [[ -n "$CONFIRM_DEPLOY" ]]; then
        remote_arguments+=(--confirm-deploy "$CONFIRM_DEPLOY")
    fi
    local remote_command
    local revision_environment=""
    if [[ -n "$portal_revision" ]]; then
        revision_environment="PORTAL_BUILD_REVISION=$(printf '%q' "$portal_revision") "
    fi
    remote_command="cd ${release_quoted} && chmod +x deployment/scripts/deploy-lab-docker.sh && ${revision_environment}MONITORING_REMOTE_EXEC=1 deployment/scripts/deploy-lab-docker.sh $(shell_join "${remote_arguments[@]}")"
    echo "Running '$COMMAND' on $remote_target..."
    ssh -tt "$remote_target" "bash -lc $(printf '%q' "$remote_command")"
}

if [[ -n "$SSH_HOST" && "${MONITORING_REMOTE_EXEC:-0}" != "1" ]]; then
    sync_and_run_remote
    exit 0
fi

STACK_DIR="$ROOT_DIR/deploy/compose/lab-observability"
[[ -f "$STACK_DIR/compose.yaml" ]] || fail "Compose stack not found: $STACK_DIR"
if [[ -z "$RUNTIME_DIR" ]]; then
    RUNTIME_DIR="$STACK_DIR"
fi
if [[ "$RUNTIME_DIR" != /* ]]; then
    RUNTIME_DIR="$ROOT_DIR/$RUNTIME_DIR"
fi
if [[ -z "$ENV_FILE" ]]; then
    if [[ "$COMMAND" == "plan" ]]; then
        ENV_FILE="$STACK_DIR/.env.example"
    else
        ENV_FILE="$RUNTIME_DIR/.env"
    fi
fi
if [[ "$ENV_FILE" != /* ]]; then
    ENV_FILE="$ROOT_DIR/$ENV_FILE"
fi

initialize_portal_revision() {
    local revision_file="$RUNTIME_DIR/portal-revision"
    if [[ -z "$PORTAL_BUILD_REVISION" && -f "$revision_file" ]]; then
        PORTAL_BUILD_REVISION="$(tr -d '[:space:]' < "$revision_file")"
    fi
    if [[ -z "$PORTAL_BUILD_REVISION" ]]; then
        PORTAL_BUILD_REVISION="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || true)"
    fi
    if [[ -z "$PORTAL_BUILD_REVISION" && "$COMMAND" == "plan" ]]; then
        PORTAL_BUILD_REVISION="development"
    fi
    [[ "$PORTAL_BUILD_REVISION" == "development" || "$PORTAL_BUILD_REVISION" =~ ^[0-9a-f]{7,40}$ || "$PORTAL_BUILD_REVISION" =~ ^candidate-[0-9a-f]{64}$ ]] || \
        fail "PORTAL_BUILD_REVISION must be 'development', a 7-40 character lowercase Git revision, or a candidate- prefixed SHA-256 digest."
    if [[ "$COMMAND" == "deploy" && "$PORTAL_BUILD_REVISION" == "development" ]]; then
        fail "Deploy requires a Git or content-derived PORTAL_BUILD_REVISION; the development tag is refused."
    fi
    export PORTAL_BUILD_REVISION
}

initialize_portal_revision
validate_direct_local_portal_source

detect_compose() {
    require_command docker
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_COMMAND=(docker compose)
        return
    fi
    if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
        COMPOSE_COMMAND=(docker-compose)
        return
    fi
    fail "Docker Compose is required as either 'docker compose' or 'docker-compose'."
}

require_env_file() {
    [[ -f "$ENV_FILE" ]] || fail "Required environment file is missing: $ENV_FILE"
}

env_value() {
    local key="$1"
    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    [[ -n "$line" ]] || return 1
    printf '%s' "${line#*=}"
}

resolve_env_path() {
    local value="$1"
    if [[ "$value" == /* ]]; then
        printf '%s' "$value"
    else
        printf '%s/%s' "$STACK_DIR" "${value#./}"
    fi
}

validate_runtime_environment() {
    require_env_file
    local required=(
        MONITORING_BIND_ADDRESS
        MONITORING_PUBLIC_HOST
        MONITORING_PUBLIC_URL
        MONITORING_UID
        MONITORING_GID
        MONITORING_DATA_DIR
        GRAFANA_ADMIN_PASSWORD_FILE
    )
    local key
    local value
    local normalized_value
    for key in "${required[@]}"; do
        value="$(env_value "$key" || true)"
        [[ -n "$value" ]] || fail "Environment file is missing non-empty key '$key'."
        normalized_value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
        case "$normalized_value" in
            *example.invalid*|replace-me|changeme)
                fail "Environment key '$key' still contains a placeholder value."
                ;;
        esac
    done
    [[ "$(env_value MONITORING_BIND_ADDRESS)" == "127.0.0.1" ]] || fail "MONITORING_BIND_ADDRESS must remain 127.0.0.1 for the Cloudflare tunnel profile."
    [[ "$(env_value MONITORING_PUBLIC_HOST)" == "monitor.jefferyhaynes.net" ]] || fail "MONITORING_PUBLIC_HOST must be monitor.jefferyhaynes.net for this lab profile."
    [[ "$(env_value MONITORING_PUBLIC_URL)" == "https://monitor.jefferyhaynes.net" ]] || fail "MONITORING_PUBLIC_URL must be https://monitor.jefferyhaynes.net."
    value="$(env_value MONITORING_UID)"
    [[ "$value" =~ ^[0-9]+$ && "$value" != "0" ]] || fail "MONITORING_UID must be a non-zero numeric host user ID."
    value="$(env_value MONITORING_GID)"
    [[ "$value" =~ ^[0-9]+$ && "$value" != "0" ]] || fail "MONITORING_GID must be a non-zero numeric host group ID."
    local password_file
    password_file="$(resolve_env_path "$(env_value GRAFANA_ADMIN_PASSWORD_FILE)")"
    [[ -s "$password_file" ]] || fail "Grafana password file is missing or empty: $password_file"
    normalized_value="$(tr '[:upper:]' '[:lower:]' < "$password_file")"
    case "$normalized_value" in
        *replace-me*|*changeme*|*example*)
            fail "Grafana password file still contains a placeholder value."
            ;;
    esac
}

compose() {
    MONITORING_ENV_FILE="$ENV_FILE" "${COMPOSE_COMMAND[@]}" \
        --project-name lab-observability \
        --env-file "$ENV_FILE" \
        --project-directory "$STACK_DIR" \
        -f "$STACK_DIR/compose.yaml" \
        "$@"
}

validate_compose() {
    detect_compose
    require_env_file
    compose config --quiet
    echo "Single-host lab Compose configuration is valid."
}

validate_portal_sources() {
    local required_sources=(
        "$ROOT_DIR/.dockerignore"
        "$ROOT_DIR/package.json"
        "$ROOT_DIR/package-lock.json"
        "$ROOT_DIR/index.html"
        "$ROOT_DIR/vite.config.ts"
        "$ROOT_DIR/web/src/main.tsx"
        "$ROOT_DIR/shared/inventory.ts"
        "$ROOT_DIR/server/src/main.ts"
        "$ROOT_DIR/catalog/services.json"
        "$ROOT_DIR/deploy/portal/Dockerfile"
        "$ROOT_DIR/deploy/portal/default.conf"
        "$ROOT_DIR/deploy/inventory-api/Dockerfile"
        "$ROOT_DIR/deploy/kubernetes/inventory-reader-rbac.yaml"
    )
    local source
    for source in "${required_sources[@]}"; do
        [[ -f "$source" ]] || fail "Required portal build source is missing: $source"
    done
}

validate_portal_capacity() {
    local minimum_free_kb="${PORTAL_MIN_FREE_KB:-1572864}"
    [[ "$minimum_free_kb" =~ ^[1-9][0-9]*$ ]] || fail "PORTAL_MIN_FREE_KB must be a positive integer."
    local available_kb
    available_kb="$(df -Pk "$ROOT_DIR" | awk 'NR == 2 {print $4}')"
    [[ "$available_kb" =~ ^[0-9]+$ ]] || fail "Unable to determine free disk capacity for the portal build."
    (( available_kb >= minimum_free_kb )) || \
        fail "Portal build requires at least ${minimum_free_kb} KiB free; only ${available_kb} KiB is available."
}

validate_portal_port() {
    require_command ss
    if ss -H -ltn 'sport = :3100' | grep -q .; then
        local existing_portal
        existing_portal="$(compose ps -q portal 2>/dev/null || true)"
        [[ -n "$existing_portal" ]] || fail "Loopback port 3100 is already occupied by a process outside this Compose portal service."
        echo "Loopback port 3100 is held by the existing portal service and can be updated safely."
    fi
}

prepare_runtime_data() {
    local data_directory
    data_directory="$(resolve_env_path "$(env_value MONITORING_DATA_DIR)")"
    mkdir -p "$data_directory/gatus-internal" "$data_directory/gatus-public-path" "$data_directory/runtime-secrets"
    chmod 0755 "$data_directory/runtime-secrets"
    [[ -w "$data_directory/gatus-internal" && -w "$data_directory/gatus-public-path" && -r "$data_directory/runtime-secrets" ]] || \
        fail "Gatus data directories are not writable under: $data_directory"
}

verify_http() {
    local name="$1"
    local url="$2"
    local retry_delay="${MONITORING_VERIFY_RETRY_SECONDS:-2}"
    local attempt
    for attempt in {1..30}; do
        if curl --fail --silent --show-error --max-time 5 "$url" >/dev/null; then
            return
        fi
        if [[ "$attempt" -lt 30 ]]; then
            sleep "$retry_delay"
        fi
    done
    fail "$name readiness failed after 30 attempts: $url"
}

fetch_http() {
    local name="$1"
    local url="$2"
    local response
    response="$(curl --fail --silent --show-error --max-time 5 "$url")" || fail "$name request failed: $url"
    printf '%s' "$response"
}

verify_portal_routes() {
    local routes=("/" "/deployments" "/services/cpq-demo" "/infrastructure" "/performance" "/incidents" "/settings")
    local route
    local html
    for route in "${routes[@]}"; do
        html="$(fetch_http "Portal route $route" "http://127.0.0.1:3100${route}")"
        grep -Fq '<title>Workspace Monitor</title>' <<< "$html" || \
            fail "Portal route did not return the application shell: $route"
    done

    local asset_path
    asset_path="$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' <<< "$html" | head -n 1)"
    [[ -n "$asset_path" ]] || fail "Portal index did not reference its versioned JavaScript asset."
    local bundle
    bundle="$(fetch_http "Portal application asset" "http://127.0.0.1:3100${asset_path}")"
    grep -Fq 'Live inventory' <<< "$bundle" || \
        fail "Portal bundle does not contain the required live-inventory disclosure."

    local inventory
    inventory="$(fetch_http "Inventory API" "http://127.0.0.1:3100/api/v1/inventory?environment=all")"
    grep -Fq '"apiVersion":1' <<< "$inventory" || fail "Inventory API response has no supported API version."
    grep -Fq '"id":"cpq-demo"' <<< "$inventory" || fail "Inventory API response is missing CPQ Demo."
    local source_evidence
    source_evidence="$(fetch_http "Internal Gatus evidence proxy" "http://127.0.0.1:3100/tools/gatus-internal/api/v1/endpoints/statuses")"
    grep -Fq 'cpq-demo-ready-internal' <<< "$source_evidence" || fail "Internal Gatus evidence proxy is missing CPQ Demo."
}

verify_portal_container_health() {
    local container_id="$1"
    local retry_delay="${MONITORING_VERIFY_RETRY_SECONDS:-2}"
    local status
    local attempt
    for attempt in {1..30}; do
        status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")"
        if [[ "$status" == "healthy" ]]; then
            return
        fi
        if [[ "$status" == "unhealthy" ]]; then
            fail "Portal container health check reported unhealthy."
        fi
        if [[ "$attempt" -lt 30 ]]; then
            sleep "$retry_delay"
        fi
    done
    fail "Portal container did not become healthy after 30 attempts; last status: $status"
}

verify_stack() {
    require_command curl
    local services=(portal inventory-api prometheus grafana blackbox-exporter node-exporter cadvisor gatus-internal gatus-public-path)
    local service
    local container_id
    local running
    for service in "${services[@]}"; do
        container_id="$(compose ps -q "$service")"
        [[ -n "$container_id" ]] || fail "Container is missing for service: $service"
        running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
        [[ "$running" == "true" ]] || fail "Container is not running for service: $service"
    done
    verify_http "Portal health" http://127.0.0.1:3100/healthz
    container_id="$(compose ps -q portal)"
    verify_portal_container_health "$container_id"
    verify_portal_routes
    verify_http Prometheus http://127.0.0.1:9090/-/ready
    verify_http Grafana http://127.0.0.1:3000/api/health
    verify_http Blackbox http://127.0.0.1:9115/-/healthy
    verify_http "Gatus internal" http://127.0.0.1:8085/metrics
    verify_http "Gatus public-path" http://127.0.0.1:8186/metrics
    echo "Single-host lab monitoring stack and live inventory portal are running and ready."
}

case "$COMMAND" in
    plan)
        validate_portal_sources
        validate_compose
        ;;
    preflight)
        validate_runtime_environment
        validate_portal_sources
        validate_compose
        docker info >/dev/null
        validate_portal_capacity
        validate_portal_port
        echo "Single-host lab preflight passed."
        ;;
    deploy)
        validate_runtime_environment
        validate_portal_sources
        validate_compose
        docker info >/dev/null
        validate_portal_capacity
        validate_portal_port
        prepare_runtime_data
        echo "Pulling pinned images for the single-host lab profile..."
        compose pull prometheus grafana blackbox-exporter node-exporter cadvisor gatus-internal gatus-public-path
        echo "Building portal and inventory API images for revision ${PORTAL_BUILD_REVISION}..."
        compose build --pull inventory-api portal
        echo "Deploying single-host lab monitoring stack..."
        compose up -d --remove-orphans
        verify_stack
        printf '%s\n' "$PORTAL_BUILD_REVISION" > "$RUNTIME_DIR/portal-revision"
        ;;
    status)
        validate_compose
        compose ps
        ;;
    verify)
        validate_compose
        verify_stack
        ;;
    logs)
        validate_compose
        compose logs --tail "$LOG_TAIL"
        ;;
esac
