#!/usr/bin/env bash
# Tear down all FB Live Comments resources, including DB volume data.
#
# Postgres/Mongo use emptyDir today — deleting their pods/namespace wipes data.
# This script also deletes any PersistentVolumeClaims in the app namespace
# (and optionally releases matching PVs) so future PVC-backed DBs are cleared too.
#
# Usage:
#   ./scripts/teardown-all.sh
#   ./scripts/teardown-all.sh --yes                 # skip confirmation
#   ./scripts/teardown-all.sh --keep-envoy          # leave Envoy Gateway helm release
#   ./scripts/teardown-all.sh --keep-monitoring     # leave monitoring namespace
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NS="fb-live-comments"
ASSUME_YES=0
KEEP_ENVOY=0
KEEP_MONITORING=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1; shift ;;
    --keep-envoy) KEEP_ENVOY=1; shift ;;
    --keep-monitoring) KEEP_MONITORING=1; shift ;;
    -h|--help)
      cat <<'HELP'
Tear down all FB Live Comments resources, including DB volume data.

Usage:
  ./scripts/teardown-all.sh
  ./scripts/teardown-all.sh --yes
  ./scripts/teardown-all.sh --keep-envoy
  ./scripts/teardown-all.sh --keep-monitoring
HELP
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
delete_f() {
  # Best-effort delete of manifest paths (ignore missing resources).
  kubectl delete -f "$@" --ignore-not-found --wait=true 2>/dev/null || \
    kubectl delete -f "$@" --ignore-not-found 2>/dev/null || true
}

if [[ "$ASSUME_YES" -ne 1 ]]; then
  cat <<EOF
This will DELETE:
  - namespace ${NS} (all app pods, emptyDir DB data for postgres/mongodb, redis)
  - any PVCs in ${NS} (and attempt to remove released PVs)
  - Gateway / HTTPRoutes / traffic policies
$([ "$KEEP_MONITORING" -eq 1 ] || echo "  - monitoring stack (helm release + namespace)")
$([ "$KEEP_ENVOY" -eq 1 ] || echo "  - Envoy Gateway (helm release + namespace)")
EOF
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
need kubectl
need helm

log "Delete gateway / app / data-plane manifests (best effort)"
delete_f \
  k8s/gateway/httproute-frontend.yaml \
  k8s/gateway/clienttrafficpolicy-sse.yaml \
  k8s/gateway/backendtrafficpolicy-broadcast.yaml \
  k8s/gateway/httproute-broadcast.yaml \
  k8s/gateway/httproute-comments.yaml \
  k8s/gateway/httproute-posts.yaml \
  k8s/gateway/gateway.yaml \
  k8s/gateway/envoyproxy.yaml \
  k8s/gateway/gatewayclass.yaml

delete_f \
  k8s/frontend/service.yaml \
  k8s/frontend/deployment.yaml \
  k8s/broadcast-service/hpa.yaml \
  k8s/broadcast-service/service.yaml \
  k8s/broadcast-service/deployment.yaml \
  k8s/comments-service/hpa.yaml \
  k8s/comments-service/service.yaml \
  k8s/comments-service/deployment.yaml \
  k8s/post-service/service.yaml \
  k8s/post-service/deployment.yaml

log "Wipe DB / cache volumes (scale down + delete PVC-backed storage if any)"
# emptyDir data dies with the pods; delete DB deployments explicitly first.
delete_f \
  k8s/redis/service.yaml \
  k8s/redis/deployment.yaml \
  k8s/mongodb/service.yaml \
  k8s/mongodb/deployment.yaml \
  k8s/postgres/service.yaml \
  k8s/postgres/deployment.yaml

if kubectl get ns "$NS" >/dev/null 2>&1; then
  # Future-proof: remove PVCs so PersistentVolume data is not left behind.
  PVC_LIST="$(kubectl get pvc -n "$NS" -o name 2>/dev/null || true)"
  if [[ -n "${PVC_LIST}" ]]; then
    log "Deleting PVCs in ${NS}"
    # shellcheck disable=SC2086
    kubectl delete $PVC_LIST -n "$NS" --wait=true --timeout=120s || true

    log "Deleting Released/Available PVs that belonged to ${NS}"
    kubectl get pv -o json 2>/dev/null | python3 -c '
import json, sys, subprocess
data = json.load(sys.stdin)
ns = "'"$NS"'"
for pv in data.get("items", []):
    claim = (pv.get("spec") or {}).get("claimRef") or {}
    if claim.get("namespace") != ns:
        continue
    name = pv["metadata"]["name"]
    phase = (pv.get("status") or {}).get("phase", "")
    print(f"deleting pv/{name} (phase={phase})")
    subprocess.run(["kubectl", "delete", "pv", name, "--ignore-not-found", "--wait=false"])
' || true
  else
    echo "No PVCs in ${NS} (emptyDir DB data already removed with pods)."
  fi
fi

log "Delete namespace ${NS} (final wipe of remaining emptyDir / objects)"
kubectl delete namespace "$NS" --ignore-not-found --wait=true --timeout=180s || \
  kubectl delete namespace "$NS" --ignore-not-found --force --grace-period=0 || true

if [[ "$KEEP_MONITORING" -eq 0 ]]; then
  log "Remove monitoring stack"
  delete_f \
    k8s/monitoring/grafana-dashboard-fblive.yaml \
    k8s/monitoring/servicemonitor-envoy-gateway.yaml \
    k8s/monitoring/podmonitor-envoy.yaml \
    k8s/monitoring/prometheusrule-minikube-pod-usage.yaml
  if helm status monitoring -n monitoring >/dev/null 2>&1; then
    helm uninstall monitoring -n monitoring || true
  fi
  kubectl delete namespace monitoring --ignore-not-found --wait=true --timeout=180s || true
else
  log "Keeping monitoring (--keep-monitoring)"
fi

if [[ "$KEEP_ENVOY" -eq 0 ]]; then
  log "Remove Envoy Gateway"
  if helm status eg -n envoy-gateway-system >/dev/null 2>&1; then
    helm uninstall eg -n envoy-gateway-system || true
  fi
  kubectl delete namespace envoy-gateway-system --ignore-not-found --wait=true --timeout=180s || true
else
  log "Keeping Envoy Gateway (--keep-envoy)"
fi

log "Done — cluster leftovers (if any):"
kubectl get ns 2>/dev/null | rg -i 'fb-live|envoy-gateway|monitoring' || echo "(none of the app/gateway/monitoring namespaces remain)"
