#!/usr/bin/env bash
# Create all FB Live Comments resources on Minikube (apps, DBs, gateway).
#
# Usage (from repo root or anywhere):
#   ./scripts/deploy-all.sh
#   ./scripts/deploy-all.sh --skip-build          # manifests only (images must exist)
#   ./scripts/deploy-all.sh --with-monitoring     # also install Prometheus/Grafana
#   ./scripts/deploy-all.sh --load-images         # docker build on host + minikube image load
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_BUILD=0
WITH_MONITORING=0
LOAD_IMAGES=0
EG_VERSION="${EG_VERSION:-v1.5.4}"
NS="fb-live-comments"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --with-monitoring) WITH_MONITORING=1; shift ;;
    --load-images) LOAD_IMAGES=1; shift ;;
    -h|--help)
      cat <<'HELP'
Create all FB Live Comments resources on Minikube.

Usage:
  ./scripts/deploy-all.sh
  ./scripts/deploy-all.sh --skip-build
  ./scripts/deploy-all.sh --with-monitoring
  ./scripts/deploy-all.sh --load-images
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
image_tag() {
  # Extract container image from a Deployment manifest (first "image:" under containers).
  local file="$1"
  awk '/^[[:space:]]*image:/{ gsub(/"/,"",$2); print $2; exit }' "$file"
}

POST_IMAGE="$(image_tag k8s/post-service/deployment.yaml)"
COMMENTS_IMAGE="$(image_tag k8s/comments-service/deployment.yaml)"
BROADCAST_IMAGE="$(image_tag k8s/broadcast-service/deployment.yaml)"
FRONTEND_IMAGE="$(image_tag k8s/frontend/deployment.yaml)"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need kubectl
need minikube
need helm
need docker

if ! minikube status >/dev/null 2>&1; then
  log "Starting Minikube"
  minikube start
fi

log "Cluster nodes"
kubectl get nodes

# Prefer building inside Minikube's Docker unless --load-images is set.
if [[ "$SKIP_BUILD" -eq 0 && "$LOAD_IMAGES" -eq 0 ]]; then
  log "Using Minikube Docker env for builds"
  # shellcheck disable=SC2091
  eval "$(minikube docker-env)"
fi

log "Install Envoy Gateway ${EG_VERSION}"
if helm status eg -n envoy-gateway-system >/dev/null 2>&1; then
  echo "Helm release eg already present — skipping install"
else
  helm install eg oci://docker.io/envoyproxy/gateway-helm \
    --version "$EG_VERSION" \
    -n envoy-gateway-system \
    --create-namespace
fi
kubectl wait --timeout=5m \
  -n envoy-gateway-system deployment/envoy-gateway \
  --for=condition=Available

log "Namespace + databases"
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/postgres/deployment.yaml -f k8s/postgres/service.yaml
kubectl apply -f k8s/mongodb/deployment.yaml -f k8s/mongodb/service.yaml
kubectl apply -f k8s/redis/deployment.yaml -f k8s/redis/service.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n "$NS" --timeout=180s
kubectl wait --for=condition=ready pod -l app=mongodb -n "$NS" --timeout=180s
kubectl wait --for=condition=ready pod -l app=redis -n "$NS" --timeout=180s

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  log "Build app images (${POST_IMAGE}, ${COMMENTS_IMAGE}, ${BROADCAST_IMAGE}, ${FRONTEND_IMAGE})"
  docker build -t "$POST_IMAGE" ./services/post-service
  docker build -t "$COMMENTS_IMAGE" ./services/comments-service
  docker build -t "$BROADCAST_IMAGE" ./services/broadcast-service
  docker build -t "$FRONTEND_IMAGE" ./services/frontend

  if [[ "$LOAD_IMAGES" -eq 1 ]]; then
    log "Loading images into Minikube"
    minikube image load "$POST_IMAGE"
    minikube image load "$COMMENTS_IMAGE"
    minikube image load "$BROADCAST_IMAGE"
    minikube image load "$FRONTEND_IMAGE"
  fi
else
  log "Skipping image builds (--skip-build)"
fi

log "App Deployments / Services / HPAs"
kubectl apply -f k8s/post-service/deployment.yaml -f k8s/post-service/service.yaml
kubectl apply -f k8s/comments-service/deployment.yaml -f k8s/comments-service/service.yaml -f k8s/comments-service/hpa.yaml
kubectl apply -f k8s/broadcast-service/deployment.yaml -f k8s/broadcast-service/service.yaml -f k8s/broadcast-service/hpa.yaml
kubectl apply -f k8s/frontend/deployment.yaml -f k8s/frontend/service.yaml

log "Gateway API routes + SSE timeout policies"
kubectl apply -f k8s/gateway/gatewayclass.yaml
kubectl apply -f k8s/gateway/envoyproxy.yaml
kubectl apply -f k8s/gateway/gateway.yaml
kubectl apply -f k8s/gateway/httproute-posts.yaml
kubectl apply -f k8s/gateway/httproute-comments.yaml
kubectl apply -f k8s/gateway/httproute-broadcast.yaml
kubectl apply -f k8s/gateway/backendtrafficpolicy-broadcast.yaml
kubectl apply -f k8s/gateway/clienttrafficpolicy-sse.yaml
kubectl apply -f k8s/gateway/httproute-frontend.yaml

kubectl wait --timeout=3m \
  -n "$NS" gateway/api-gateway \
  --for=condition=Programmed

log "Wait for app rollouts"
kubectl rollout status deployment/post-service -n "$NS" --timeout=180s
kubectl rollout status deployment/comments-service -n "$NS" --timeout=180s
kubectl rollout status deployment/broadcast-service -n "$NS" --timeout=180s
kubectl rollout status deployment/frontend -n "$NS" --timeout=180s

if [[ "$WITH_MONITORING" -eq 1 ]]; then
  log "Install kube-prometheus-stack + scrapes/dashboard"
  helm upgrade --install monitoring \
    oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack \
    --version 69.8.2 \
    -n monitoring \
    --create-namespace \
    -f k8s/monitoring/values.yaml
  kubectl wait --timeout=10m \
    -n monitoring \
    --for=condition=available deployment \
    -l app.kubernetes.io/part-of=kube-prometheus-stack || true
  kubectl apply -f k8s/monitoring/podmonitor-envoy.yaml
  kubectl apply -f k8s/monitoring/servicemonitor-envoy-gateway.yaml
  kubectl apply -f k8s/monitoring/grafana-dashboard-fblive.yaml
  kubectl apply -f k8s/monitoring/prometheusrule-minikube-pod-usage.yaml
  if [[ -f k8s/monitoring/patch-minikube-dashboards.py ]]; then
    python3 k8s/monitoring/patch-minikube-dashboards.py || true
  fi
fi

log "Done"
kubectl get pods -n "$NS" -o wide
echo
echo "Gateway (NodePort may hang on Docker Desktop Mac — prefer port-forward):"
echo "  http://$(minikube ip):30080"
echo "  kubectl -n envoy-gateway-system port-forward svc/api-gateway 8080:80"
echo "  → http://127.0.0.1:8080"
