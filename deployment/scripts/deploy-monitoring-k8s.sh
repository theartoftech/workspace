#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMMAND=""
NAMESPACE="monitoring"
RELEASE_NAME="lab-observability"
KUBE_CONTEXT=""
CONFIRM_DEPLOY=""
SSH_HOST=""
SSH_USER="${USER:-}"
REMOTE_DIR=""

usage() {
    cat <<'USAGE'
Usage: deployment/scripts/deploy-monitoring-k8s.sh <command> [options]

Commands:
  plan        Build dependencies, lint, and render manifests locally. No cluster access.
  preflight   Run plan and verify cluster access, namespace, and Grafana Secret.
  deploy      Install or upgrade the Helm release, then verify it. Requires confirmation.
  status      Show Helm and Kubernetes status without changing the target.
  verify      Wait for monitoring workloads and verify the CPQ ServiceMonitor exists.
  help        Show this help.

Options:
  --namespace <name>       Kubernetes namespace. Default: monitoring
  --release <name>         Helm release name. Default: lab-observability
  --context <name>         Optional kubectl/Helm context.
  --confirm-deploy <name>  Required for deploy; must exactly equal --namespace.
  --host <hostname>        Run the command on a remote Kubernetes host over SSH.
  --ssh-user <user>        SSH user. Default: current local user.
  --remote-dir <path>      Remote source root. Default: /home/<user>/workspace-monitor
  -h, --help               Show this help.

Examples:
  deployment/scripts/deploy-monitoring-k8s.sh plan
  deployment/scripts/deploy-monitoring-k8s.sh preflight --host 192.168.86.246 --ssh-user jhaynes
  deployment/scripts/deploy-monitoring-k8s.sh deploy --host 192.168.86.246 \
    --ssh-user jhaynes --confirm-deploy monitoring

No command in this script creates credentials. Provision the required Grafana
Secret separately before preflight or deploy.
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
        plan|preflight|deploy|status|verify)
            set_command "$1"
            ;;
        help|-h|--help)
            usage
            exit 0
            ;;
        --namespace)
            require_value "$1" "${2:-}"
            NAMESPACE="$2"
            shift
            ;;
        --release)
            require_value "$1" "${2:-}"
            RELEASE_NAME="$2"
            shift
            ;;
        --context)
            require_value "$1" "${2:-}"
            KUBE_CONTEXT="$2"
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
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

[[ -n "$COMMAND" ]] || fail "A command is required. Run with help for usage."
[[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "Invalid Kubernetes namespace: $NAMESPACE"
[[ "$RELEASE_NAME" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || fail "Invalid Helm release name: $RELEASE_NAME"
[[ -z "$KUBE_CONTEXT" || "$KUBE_CONTEXT" =~ ^[A-Za-z0-9._@:/-]+$ ]] || fail "Invalid Kubernetes context: $KUBE_CONTEXT"

if [[ "$COMMAND" == "deploy" && "$CONFIRM_DEPLOY" != "$NAMESPACE" ]]; then
    fail "Refusing deployment. Rerun with --confirm-deploy $NAMESPACE after reviewing plan and preflight output."
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
    if [[ -z "$REMOTE_DIR" ]]; then
        REMOTE_DIR="/home/${SSH_USER}/workspace-monitor"
    fi
    validate_remote_dir "$REMOTE_DIR"

    local remote_target="${SSH_USER}@${SSH_HOST}"
    local release_dir="${REMOTE_DIR}/release"
    local release_quoted
    release_quoted="$(printf '%q' "$release_dir")"
    if [[ "$COMMAND" == "plan" || "$COMMAND" == "preflight" || "$COMMAND" == "deploy" ]]; then
        local archive
        archive="$(mktemp "${TMPDIR:-/tmp}/workspace-monitor-k8s.XXXXXX")"
        trap 'rm -f "$archive"' EXIT
        tar \
            --exclude='deploy/helm/lab-observability/charts' \
            -czf "$archive" \
            deployment/scripts/deploy-monitoring-k8s.sh \
            deploy/helm/lab-observability
        echo "Synchronizing a credential-free monitoring release to ${remote_target}:${release_dir}..."
        ssh "$remote_target" \
            "rm -rf -- ${release_quoted} && mkdir -p -- ${release_quoted} && tar -xzf - -C ${release_quoted}" \
            < "$archive"
    fi

    local remote_arguments=("$COMMAND" --namespace "$NAMESPACE" --release "$RELEASE_NAME")
    if [[ -n "$KUBE_CONTEXT" ]]; then
        remote_arguments+=(--context "$KUBE_CONTEXT")
    fi
    if [[ -n "$CONFIRM_DEPLOY" ]]; then
        remote_arguments+=(--confirm-deploy "$CONFIRM_DEPLOY")
    fi
    local remote_command
    remote_command="cd ${release_quoted} && chmod +x deployment/scripts/deploy-monitoring-k8s.sh && MONITORING_REMOTE_EXEC=1 deployment/scripts/deploy-monitoring-k8s.sh $(shell_join "${remote_arguments[@]}")"
    echo "Running '$COMMAND' on $remote_target..."
    ssh -tt "$remote_target" "bash -lc $(printf '%q' "$remote_command")"
}

if [[ -n "$SSH_HOST" && "${MONITORING_REMOTE_EXEC:-0}" != "1" ]]; then
    sync_and_run_remote
    exit 0
fi

CHART_DIR="$ROOT_DIR/deploy/helm/lab-observability"
[[ -f "$CHART_DIR/Chart.yaml" ]] || fail "Helm chart not found: $CHART_DIR"

KUBECTL=(kubectl)
HELM_CONTEXT=()
if [[ -n "$KUBE_CONTEXT" ]]; then
    KUBECTL+=(--context "$KUBE_CONTEXT")
    HELM_CONTEXT+=(--kube-context "$KUBE_CONTEXT")
fi
KUBECTL+=(--namespace "$NAMESPACE")

render_and_lint() {
    require_command helm
    local helm_state
    helm_state="$(mktemp -d "${TMPDIR:-/tmp}/workspace-monitor-helm.XXXXXX")"
    if ! (
        export HELM_CACHE_HOME="$helm_state/cache"
        export HELM_CONFIG_HOME="$helm_state/config"
        export HELM_DATA_HOME="$helm_state/data"
        export HELM_REPOSITORY_CACHE="$helm_state/repository-cache"
        export HELM_REPOSITORY_CONFIG="$helm_state/repositories.yaml"
        mkdir -p "$HELM_CACHE_HOME" "$HELM_CONFIG_HOME" "$HELM_DATA_HOME" "$HELM_REPOSITORY_CACHE"
        helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
        echo "Resolving locked Helm dependencies..."
        helm dependency build "$CHART_DIR"
        echo "Linting monitoring chart..."
        helm lint "$CHART_DIR" --namespace "$NAMESPACE"
        helm template "$RELEASE_NAME" "$CHART_DIR" --namespace "$NAMESPACE" > "$helm_state/rendered.yaml"
    ); then
        rm -rf "$helm_state"
        fail "Helm dependency, lint, or template validation failed."
    fi
    echo "Helm plan rendered successfully; temporary output was removed."
    rm -rf "$helm_state"
}

require_secret_key() {
    local secret_name="$1"
    local key="$2"
    local value
    value="$("${KUBECTL[@]}" get secret "$secret_name" -o "jsonpath={.data.${key}}" 2>/dev/null || true)"
    [[ -n "$value" ]] || fail "Secret '$secret_name' is missing non-empty key '$key' in namespace '$NAMESPACE'."
}

cluster_preflight() {
    require_command kubectl
    "${KUBECTL[@]}" cluster-info >/dev/null
    "${KUBECTL[@]}" get namespace "$NAMESPACE" >/dev/null 2>&1 || \
        fail "Namespace '$NAMESPACE' does not exist. Create it and provision its Grafana Secret before deployment."
    require_secret_key lab-observability-grafana-admin admin-user
    require_secret_key lab-observability-grafana-admin admin-password
    echo "Cluster preflight passed for namespace '$NAMESPACE'."
}

show_status() {
    require_command helm
    require_command kubectl
    helm status "$RELEASE_NAME" --namespace "$NAMESPACE" "${HELM_CONTEXT[@]}"
    echo
    "${KUBECTL[@]}" get deployment,statefulset,pod,service,pvc -o wide
    echo
    "${KUBECTL[@]}" get prometheus,alertmanager,servicemonitor
}

verify_release() {
    require_command helm
    require_command kubectl
    helm status "$RELEASE_NAME" --namespace "$NAMESPACE" "${HELM_CONTEXT[@]}" >/dev/null
    "${KUBECTL[@]}" rollout status deployment/lab-monitoring-operator --timeout=300s
    "${KUBECTL[@]}" rollout status deployment/lab-monitoring-grafana --timeout=300s
    "${KUBECTL[@]}" rollout status deployment/lab-blackbox-exporter --timeout=300s
    "${KUBECTL[@]}" rollout status statefulset/prometheus-lab-monitoring-prometheus --timeout=300s
    "${KUBECTL[@]}" rollout status statefulset/alertmanager-lab-monitoring-alertmanager --timeout=300s
    "${KUBECTL[@]}" get servicemonitor cpq-demo >/dev/null
    echo "Monitoring release '$RELEASE_NAME' is ready and CPQ ServiceMonitor 'cpq-demo' exists."
}

case "$COMMAND" in
    plan)
        render_and_lint
        ;;
    preflight)
        render_and_lint
        cluster_preflight
        ;;
    deploy)
        render_and_lint
        cluster_preflight
        echo "Deploying Helm release '$RELEASE_NAME' to namespace '$NAMESPACE'..."
        helm upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
            --namespace "$NAMESPACE" \
            "${HELM_CONTEXT[@]}" \
            --atomic \
            --timeout 10m \
            --history-max 10
        verify_release
        ;;
    status)
        show_status
        ;;
    verify)
        verify_release
        ;;
esac
