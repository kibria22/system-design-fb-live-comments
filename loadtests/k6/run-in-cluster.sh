#!/usr/bin/env bash
# Run write-comments.js as an in-cluster Job against the Gateway Service.
#
# Usage:
#   ./loadtests/k6/run-in-cluster.sh -e POST_ID=<uuid> [-e RPS=100] [-e DURATION=60s] \
#     [-e WORKERS=1] [-e PRE_VUS=...] [-e MAX_VUS=...] [-e BASE_URL=...]
#
# Total target arrival rate ≈ RPS × WORKERS (each worker pod runs the same RPS).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/loadtests/k6/write-comments.js"
NS="${NAMESPACE:-fb-live-comments}"

POST_ID="${POST_ID:-}"
RPS="${RPS:-100}"
DURATION="${DURATION:-60s}"
WORKERS="${WORKERS:-1}"
BASE_URL="${BASE_URL:-http://api-gateway.envoy-gateway-system.svc.cluster.local}"
PRE_VUS="${PRE_VUS:-}"
MAX_VUS="${MAX_VUS:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -e)
      shift
      [[ $# -gt 0 ]] || { echo "missing value after -e" >&2; exit 1; }
      key="${1%%=*}"
      val="${1#*=}"
      if [[ "$key" == "$1" ]]; then
        echo "expected KEY=VALUE after -e, got: $1" >&2
        exit 1
      fi
      case "$key" in
        POST_ID) POST_ID="$val" ;;
        RPS) RPS="$val" ;;
        DURATION) DURATION="$val" ;;
        WORKERS) WORKERS="$val" ;;
        BASE_URL) BASE_URL="$val" ;;
        PRE_VUS) PRE_VUS="$val" ;;
        MAX_VUS) MAX_VUS="$val" ;;
        NAMESPACE) NS="$val" ;;
        *) echo "unknown env: $key" >&2; exit 1 ;;
      esac
      shift
      ;;
    -h|--help)
      cat <<'HELP'
Run write-comments.js as an in-cluster Job against the Gateway Service.

Usage:
  ./loadtests/k6/run-in-cluster.sh -e POST_ID=<uuid> [-e RPS=100] [-e DURATION=60s] \
    [-e WORKERS=1] [-e PRE_VUS=...] [-e MAX_VUS=...] [-e BASE_URL=...]

Total target arrival rate ≈ RPS × WORKERS (each worker pod runs the same RPS).
HELP
      exit 0
      ;;
    *)
      echo "unknown arg: $1 (use -e KEY=VALUE)" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$POST_ID" || "$POST_ID" == "REPLACE_ME" ]]; then
  echo "POST_ID is required. Example:" >&2
  echo "  $0 -e POST_ID=11111111-1111-1111-1111-111111111111 -e RPS=100 -e DURATION=60s" >&2
  exit 1
fi

if ! [[ "$WORKERS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WORKERS must be a positive integer (got: $WORKERS)" >&2
  exit 1
fi

if [[ -z "$PRE_VUS" ]]; then
  PRE_VUS="$RPS"
  if [[ "$PRE_VUS" -lt 10 ]]; then PRE_VUS=10; fi
fi
if [[ -z "$MAX_VUS" ]]; then
  MAX_VUS=$((RPS * 4))
  if [[ "$MAX_VUS" -lt "$PRE_VUS" ]]; then MAX_VUS=$PRE_VUS; fi
fi

# Escape values for YAML double-quoted strings
yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

POST_ID_Q="$(yaml_escape "$POST_ID")"
BASE_URL_Q="$(yaml_escape "$BASE_URL")"
DURATION_Q="$(yaml_escape "$DURATION")"

TOTAL_RPS=$((RPS * WORKERS))
echo "Syncing ConfigMap k6-write-comments from $SCRIPT"
kubectl -n "$NS" create configmap k6-write-comments \
  --from-file="write-comments.js=$SCRIPT" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Deleting previous Job (if any)"
kubectl -n "$NS" delete job k6-write-comments --ignore-not-found --wait=true

echo "Starting Job: ${WORKERS} worker(s) × ${RPS} RPS ≈ ${TOTAL_RPS} RPS total, duration=${DURATION}"
echo "  BASE_URL=$BASE_URL"
echo "  POST_ID=$POST_ID"
echo "  PRE_VUS=$PRE_VUS  MAX_VUS=$MAX_VUS (per worker)"

kubectl apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: k6-write-comments
  namespace: ${NS}
  labels:
    app: k6-write-comments
spec:
  parallelism: ${WORKERS}
  completions: ${WORKERS}
  backoffLimit: 0
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app: k6-write-comments
    spec:
      restartPolicy: Never
      containers:
        - name: k6
          image: grafana/k6:0.54.0
          imagePullPolicy: IfNotPresent
          args: ["run", "/scripts/write-comments.js"]
          env:
            - name: BASE_URL
              value: "${BASE_URL_Q}"
            - name: POST_ID
              value: "${POST_ID_Q}"
            - name: RPS
              value: "${RPS}"
            - name: DURATION
              value: "${DURATION_Q}"
            - name: PRE_VUS
              value: "${PRE_VUS}"
            - name: MAX_VUS
              value: "${MAX_VUS}"
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
          volumeMounts:
            - name: scripts
              mountPath: /scripts
              readOnly: true
      volumes:
        - name: scripts
          configMap:
            name: k6-write-comments
EOF

echo
echo "Follow logs:"
echo "  kubectl -n $NS logs -l app=k6-write-comments -f --prefix"
echo
echo "Status:"
echo "  kubectl -n $NS get job,pods -l app=k6-write-comments"
