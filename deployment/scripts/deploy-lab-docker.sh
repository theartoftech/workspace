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

usage() {
    cat <<'USAGE'
Usage: deployment/scripts/deploy-lab-docker.sh <command> [options]

Commands:
  plan        Validate the single-host Compose model with example settings; no containers start.
  preflight   Validate real settings, secret files, Docker, and Compose without starting containers.
  deploy      Pull and start the lab monitoring stack. Requires exact confirmation.
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
    local release_quoted
    release_quoted="$(printf '%q' "$release_dir")"

    if [[ "$COMMAND" == "plan" || "$COMMAND" == "preflight" || "$COMMAND" == "deploy" ]]; then
        local archive
        archive="$(mktemp "${TMPDIR:-/tmp}/workspace-monitor-lab-docker.XXXXXX")"
        trap "rm -f -- $(printf '%q' "$archive")" EXIT
        # Runtime .env, secrets, and data are never synchronized from the workstation.
        COPYFILE_DISABLE=1 tar \
            --exclude='._*' \
            --exclude='deploy/compose/lab-observability/data' \
            -czf "$archive" \
            deployment/scripts/deploy-lab-docker.sh \
            deploy/compose/lab-observability \
            probes/internal/config.yaml
        echo "Synchronizing credential-free lab monitoring sources to ${remote_target}:${release_dir}..."
        ssh "$remote_target" \
            "rm -rf -- ${release_quoted} && mkdir -p -- ${release_quoted} && tar -xzf - -C ${release_quoted}" \
            < "$archive"
    fi

    local remote_arguments=("$COMMAND" --runtime-dir "$runtime_dir" --tail "$LOG_TAIL")
    if [[ -n "$CONFIRM_DEPLOY" ]]; then
        remote_arguments+=(--confirm-deploy "$CONFIRM_DEPLOY")
    fi
    local remote_command
    remote_command="cd ${release_quoted} && chmod +x deployment/scripts/deploy-lab-docker.sh && MONITORING_REMOTE_EXEC=1 deployment/scripts/deploy-lab-docker.sh $(shell_join "${remote_arguments[@]}")"
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

prepare_runtime_data() {
    local data_directory
    data_directory="$(resolve_env_path "$(env_value MONITORING_DATA_DIR)")"
    mkdir -p "$data_directory/gatus-internal" "$data_directory/gatus-public-path"
    [[ -w "$data_directory/gatus-internal" && -w "$data_directory/gatus-public-path" ]] || \
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

verify_stack() {
    require_command curl
    local services=(prometheus grafana blackbox-exporter node-exporter cadvisor gatus-internal gatus-public-path)
    local service
    local container_id
    local running
    for service in "${services[@]}"; do
        container_id="$(compose ps -q "$service")"
        [[ -n "$container_id" ]] || fail "Container is missing for service: $service"
        running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
        [[ "$running" == "true" ]] || fail "Container is not running for service: $service"
    done
    verify_http Prometheus http://127.0.0.1:9090/-/ready
    verify_http Grafana http://127.0.0.1:3000/api/health
    verify_http Blackbox http://127.0.0.1:9115/-/healthy
    verify_http "Gatus internal" http://127.0.0.1:8085/metrics
    verify_http "Gatus public-path" http://127.0.0.1:8186/metrics
    echo "Single-host lab monitoring stack is running and ready."
}

case "$COMMAND" in
    plan)
        validate_compose
        ;;
    preflight)
        validate_runtime_environment
        validate_compose
        docker info >/dev/null
        echo "Single-host lab preflight passed."
        ;;
    deploy)
        validate_runtime_environment
        validate_compose
        docker info >/dev/null
        prepare_runtime_data
        echo "Pulling pinned images for the single-host lab profile..."
        compose pull
        echo "Deploying single-host lab monitoring stack..."
        compose up -d --remove-orphans
        verify_stack
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
