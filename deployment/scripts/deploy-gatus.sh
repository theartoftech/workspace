#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMMAND=""
VANTAGE=""
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
Usage: deployment/scripts/deploy-gatus.sh <command> --vantage <internal|external> [options]

Commands:
  plan        Validate the selected Compose file with an environment file; no containers start.
  preflight   Validate required runtime values and the deployable Compose configuration.
  deploy      Pull and start the selected Gatus node. Requires exact confirmation.
  status      Show the selected Compose project without changing it.
  verify      Verify the container is running and its Prometheus metrics endpoint responds.
  logs        Show recent Gatus logs without following them.
  help        Show this help.

Options:
  --vantage <name>         Required: internal or external.
  --env-file <path>        Environment file. Defaults to `.env` for runtime commands
                           and `.env.example` for plan.
  --runtime-dir <path>     Persistent runtime directory. Defaults to probes/<vantage>.
  --confirm-deploy <name>  Required for deploy; must exactly equal --vantage.
  --host <hostname>        Run the command on a remote Gatus host over SSH.
  --ssh-user <user>        SSH user. Default: current local user.
  --remote-dir <path>      Remote root. Default: /home/<user>/workspace-monitor
  --tail <lines>           Number of log lines. Default: 200
  -h, --help               Show this help.

Examples:
  deployment/scripts/deploy-gatus.sh plan --vantage internal
  deployment/scripts/deploy-gatus.sh preflight --vantage external --host status.example.net --ssh-user monitor
  deployment/scripts/deploy-gatus.sh deploy --vantage internal --confirm-deploy internal

Remote deployment never transfers `.env` or the SQLite data directory. Provision
the remote runtime `.env` separately through the target's secret workflow.
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
        --vantage)
            require_value "$1" "${2:-}"
            VANTAGE="$2"
            shift
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
[[ "$VANTAGE" == "internal" || "$VANTAGE" == "external" ]] || fail "--vantage must be internal or external."
[[ "$LOG_TAIL" =~ ^[1-9][0-9]{0,4}$ ]] || fail "--tail must be an integer from 1 to 99999."

if [[ "$COMMAND" == "deploy" && "$CONFIRM_DEPLOY" != "$VANTAGE" ]]; then
    fail "Refusing deployment. Rerun with --confirm-deploy $VANTAGE after reviewing plan and preflight output."
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
    [[ "$ENV_FILE_SET" == false ]] || fail "--env-file with --host is ambiguous and is refused. Provision the remote runtime .env separately."
    [[ "$RUNTIME_DIR_SET" == false ]] || fail "--runtime-dir with --host is ambiguous; use --remote-dir to select the remote root."
    if [[ -z "$REMOTE_DIR" ]]; then
        REMOTE_DIR="/home/${SSH_USER}/workspace-monitor"
    fi
    validate_remote_dir "$REMOTE_DIR"

    local remote_target="${SSH_USER}@${SSH_HOST}"
    local release_dir="${REMOTE_DIR}/release"
    local runtime_dir="${REMOTE_DIR}/runtime/gatus/${VANTAGE}"
    local release_quoted
    release_quoted="$(printf '%q' "$release_dir")"

    if [[ "$COMMAND" == "plan" || "$COMMAND" == "preflight" || "$COMMAND" == "deploy" ]]; then
        local archive
        archive="$(mktemp "${TMPDIR:-/tmp}/workspace-monitor-gatus.XXXXXX")"
        trap 'rm -f "$archive"' EXIT
        # Only compose.yaml and config.yaml are synchronized into the runtime directory.
        # Runtime .env files and SQLite data are never placed in the release archive.
        tar -czf "$archive" \
            deployment/scripts/deploy-gatus.sh \
            "probes/${VANTAGE}/compose.yaml" \
            "probes/${VANTAGE}/config.yaml" \
            "probes/${VANTAGE}/.env.example"
        echo "Synchronizing credential-free Gatus sources to ${remote_target}:${release_dir}..."
        ssh "$remote_target" \
            "rm -rf -- ${release_quoted} && mkdir -p -- ${release_quoted} && tar -xzf - -C ${release_quoted}" \
            < "$archive"
    fi

    local remote_arguments=("$COMMAND" --vantage "$VANTAGE" --runtime-dir "$runtime_dir" --tail "$LOG_TAIL")
    if [[ -n "$CONFIRM_DEPLOY" ]]; then
        remote_arguments+=(--confirm-deploy "$CONFIRM_DEPLOY")
    fi
    local remote_command
    remote_command="cd ${release_quoted} && chmod +x deployment/scripts/deploy-gatus.sh && MONITORING_REMOTE_EXEC=1 deployment/scripts/deploy-gatus.sh $(shell_join "${remote_arguments[@]}")"
    echo "Running '$COMMAND' on $remote_target..."
    ssh -tt "$remote_target" "bash -lc $(printf '%q' "$remote_command")"
}

if [[ -n "$SSH_HOST" && "${MONITORING_REMOTE_EXEC:-0}" != "1" ]]; then
    sync_and_run_remote
    exit 0
fi

SOURCE_DIR="$ROOT_DIR/probes/$VANTAGE"
[[ -f "$SOURCE_DIR/compose.yaml" && -f "$SOURCE_DIR/config.yaml" ]] || fail "Gatus source configuration is missing for $VANTAGE."

if [[ -z "$RUNTIME_DIR" ]]; then
    RUNTIME_DIR="$SOURCE_DIR"
fi
if [[ "$RUNTIME_DIR" != /* ]]; then
    RUNTIME_DIR="$ROOT_DIR/$RUNTIME_DIR"
fi

if [[ -z "$ENV_FILE" ]]; then
    if [[ "$COMMAND" == "plan" ]]; then
        ENV_FILE="$SOURCE_DIR/.env.example"
    else
        ENV_FILE="$RUNTIME_DIR/.env"
    fi
fi
if [[ "$ENV_FILE" != /* ]]; then
    ENV_FILE="$ROOT_DIR/$ENV_FILE"
fi

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

validate_runtime_environment() {
    require_env_file
    local required=(
        GATUS_LISTEN_ADDRESS
        GATUS_UID
        GATUS_GID
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
    value="$(env_value GATUS_UID)"
    [[ "$value" =~ ^[0-9]+$ && "$value" != "0" ]] || fail "GATUS_UID must be a non-zero numeric host user ID."
    value="$(env_value GATUS_GID)"
    [[ "$value" =~ ^[0-9]+$ && "$value" != "0" ]] || fail "GATUS_GID must be a non-zero numeric host group ID."
}

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

compose() {
    local project_directory="$1"
    shift
    if [[ ${#COMPOSE_COMMAND[@]} -eq 0 ]]; then
        detect_compose
    fi
    GATUS_ENV_FILE="$ENV_FILE" "${COMPOSE_COMMAND[@]}" \
        --env-file "$ENV_FILE" \
        --project-directory "$project_directory" \
        -f "$project_directory/compose.yaml" \
        "$@"
}

validate_compose() {
    local project_directory="$1"
    detect_compose
    require_env_file
    compose "$project_directory" config --quiet
    echo "Compose configuration is valid for $VANTAGE."
}

prepare_runtime() {
    mkdir -p "$RUNTIME_DIR/data"
    if [[ "$RUNTIME_DIR" != "$SOURCE_DIR" ]]; then
        cp "$SOURCE_DIR/compose.yaml" "$RUNTIME_DIR/compose.yaml"
        cp "$SOURCE_DIR/config.yaml" "$RUNTIME_DIR/config.yaml"
    fi
    [[ -w "$RUNTIME_DIR/data" ]] || fail "Runtime data directory is not writable: $RUNTIME_DIR/data"
}

verify_runtime() {
    require_command curl
    local container_id
    container_id="$(compose "$RUNTIME_DIR" ps -q gatus)"
    [[ -n "$container_id" ]] || fail "Gatus container is not present for $VANTAGE."
    local running
    running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
    [[ "$running" == "true" ]] || fail "Gatus container is not running for $VANTAGE."
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8080/metrics >/dev/null
    echo "Gatus $VANTAGE container is running and /metrics responds."
}

case "$COMMAND" in
    plan)
        validate_compose "$SOURCE_DIR"
        ;;
    preflight)
        validate_runtime_environment
        validate_compose "$SOURCE_DIR"
        echo "Gatus $VANTAGE preflight passed."
        ;;
    deploy)
        validate_runtime_environment
        validate_compose "$SOURCE_DIR"
        prepare_runtime
        validate_compose "$RUNTIME_DIR"
        echo "Pulling and deploying Gatus $VANTAGE..."
        compose "$RUNTIME_DIR" pull
        compose "$RUNTIME_DIR" up -d --remove-orphans
        verify_runtime
        ;;
    status)
        require_command docker
        require_env_file
        compose "$RUNTIME_DIR" ps
        ;;
    verify)
        require_command docker
        require_env_file
        verify_runtime
        ;;
    logs)
        require_command docker
        require_env_file
        compose "$RUNTIME_DIR" logs --tail "$LOG_TAIL" gatus
        ;;
esac
