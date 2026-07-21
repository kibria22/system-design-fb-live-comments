# FB Live Comments

Microservice architecture for Facebook Live–style posts and comments, designed to run on **Minikube**.

## Architecture

```text
Browser
  └─ Gateway API (Envoy Gateway)              NodePort :30080
       ├─ /                                   → Frontend (Next.js)
       ├─ /v1/users, /v1/posts                → Post Service (FastAPI)
       │                                          └─ PostgreSQL
       ├─ /v1/posts/{id}/comments             → Comments Service (Express/TS)
       │                                          ├─ MongoDB
       │                                          └─ PUBLISH → Redis (post:{id}:comments)
       └─ /v1/posts/{id}/comments/stream      → Broadcast Service (SSE)
                                                    └─ SUBSCRIBE Redis (per connected post)
```


| Component              | Tech                                   | Responsibility                                                              |
| ---------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| **frontend**           | Next.js 16                             | UI: list/create posts, expand comments, SSE live feed, infinite scroll      |
| **api-gateway**        | Kubernetes Gateway API + Envoy Gateway | L7 routing to Frontend / Post / Comments / Broadcast                        |
| **post-service**       | FastAPI + SQLAlchemy + Pydantic        | Users + posts (PostgreSQL)                                                  |
| **comments-service**   | Express (TypeScript) + Mongoose + Zod  | Comments CRUD (MongoDB); publishes new comments to Redis                    |
| **broadcast-service**  | Express (TypeScript) + SSE + ioredis   | SSE streams; subscribes to Redis channels for connected posts               |
| **postgres**           | PostgreSQL 16                          | Posts DB                                                                    |
| **mongodb**            | MongoDB 7                             | Comments DB                                                                 |
| **redis**              | Redis 7                                | Pub/Sub (one channel per post)                                              |




### Data models

**Post Service (PostgreSQL)**

- `User`: `id`, `name`, `createdAt`
- `Post`: `id`, `userId`, `content`, `createdAt`, `updatedAt`

**Comments Service (MongoDB)**

- `Comment`: `id`, `postId`, `userId`, `content`, `createdAt`



### API surface (via gateway)


| Method | Path                                                        | Service    |
| ------ | ----------------------------------------------------------- | ---------- |
| `POST` | `/v1/users`                                                 | Post       |
| `POST` | `/v1/posts`                                                 | Post       |
| `GET`  | `/v1/posts?cursor={timestamp}&limit={10}`                   | Post       |
| `POST` | `/v1/posts/{postId}/comments`                               | Comments   |
| `GET`  | `/v1/posts/{postId}/comments?cursor={timestamp}&limit={20}` | Comments   |
| `GET`  | `/v1/posts/{postId}/comments/stream`                        | Broadcast (SSE) |




### Frontend behavior

1. Each browser tab gets a random `userId` + `name` (sessionStorage) and registers the user on load.
2. Main page lists posts; **Create Post** opens a modal.
3. **Comments** expands a section under a post.
4. While expanded, the UI opens an **SSE** stream (`EventSource` → `/comments/stream`) for live comments.
5. Scrolling the comments list loads older history with **cursor pagination** (limit 20).

---



## Folder structure

```text
.
├── README.md
├── k8s/
│   ├── namespace.yaml
│   ├── postgres/            # Deployment + Service
│   ├── mongodb/             # Deployment + Service
│   ├── redis/               # Deployment + Service (pub/sub)
│   ├── post-service/        # Deployment + Service
│   ├── comments-service/    # Deployment + Service + HPA
│   ├── broadcast-service/   # Deployment + Service + HPA (SSE)
│   ├── gateway/             # Gateway API: GatewayClass, Gateway, HTTPRoutes
│   ├── frontend/            # Deployment + ClusterIP Service
│   └── monitoring/          # Prometheus + Grafana values, scrapes, dashboard
├── loadtests/
│   └── k6/                  # write-comments.js + in-cluster Job helper
└── services/
    ├── post-service/        # FastAPI app + Dockerfile
    ├── comments-service/    # Express (TypeScript) app + Dockerfile
    ├── broadcast-service/   # Express (TypeScript) SSE + Redis subscriber
    └── frontend/            # Next.js 16 app + Dockerfile
```

---



## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Minikube](https://minikube.sigs.k8s.io/docs/start/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Helm](https://helm.sh/docs/intro/install/) (for Envoy Gateway)

---



## Run on Minikube (step by step)

Run these from the **repo root**.

### 1. Start Minikube

```bash
minikube start
kubectl get nodes
```



### 2. Point your shell at Minikube’s Docker daemon

So images you build are available inside the cluster (no image registry needed):

```bash
eval $(minikube docker-env)
docker images
```

> Keep using this same terminal for the image builds below. In a new terminal, run `eval $(minikube docker-env)` again.



### 3. Install Envoy Gateway (Gateway API controller)

```bash
# Use v1.5.4 on Kubernetes 1.30 (Minikube default here).
# Envoy Gateway v1.8.x needs Kubernetes 1.32+ (Gateway API CRDs use CEL isIP).
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.5.4 \
  -n envoy-gateway-system \
  --create-namespace

kubectl wait --timeout=5m \
  -n envoy-gateway-system deployment/envoy-gateway \
  --for=condition=Available

# Helm installs the controller; GatewayClass is applied with our gateway manifests
kubectl apply -f k8s/gateway/gatewayclass.yaml
kubectl get gatewayclass
```

You should see a `GatewayClass` named `eg` with `Accepted=True`.

If you upgrade the cluster to Kubernetes 1.32+, you can use `--version v1.8.2` instead.

### 4. Create the namespace

```bash
kubectl apply -f k8s/namespace.yaml
kubectl get ns fb-live-comments
```



### 5. Deploy databases

**PostgreSQL (Posts DB)**

```bash
kubectl apply -f k8s/postgres/deployment.yaml
kubectl apply -f k8s/postgres/service.yaml
kubectl get pods -n fb-live-comments -l app=postgres
kubectl get svc -n fb-live-comments postgres
```

**MongoDB (Comments DB)**

```bash
kubectl apply -f k8s/mongodb/deployment.yaml
kubectl apply -f k8s/mongodb/service.yaml
kubectl get pods -n fb-live-comments -l app=mongodb
kubectl get svc -n fb-live-comments mongodb
```

**Redis (comment pub/sub)**

```bash
kubectl apply -f k8s/redis/deployment.yaml
kubectl apply -f k8s/redis/service.yaml
kubectl get pods -n fb-live-comments -l app=redis
kubectl get svc -n fb-live-comments redis
```

Wait until DBs are Ready:

```bash
kubectl wait --for=condition=ready pod -l app=postgres -n fb-live-comments --timeout=120s
kubectl wait --for=condition=ready pod -l app=mongodb -n fb-live-comments --timeout=120s
kubectl wait --for=condition=ready pod -l app=redis -n fb-live-comments --timeout=120s
```



### 6. Build application images

**Option A (recommended):** build inside Minikube’s Docker (after step 2 `eval $(minikube docker-env)`):

```bash
docker build -t post-service:latest ./services/post-service
docker build -t comments-service:latest ./services/comments-service
docker build -t broadcast-service:latest ./services/broadcast-service
docker build -t frontend:latest ./services/frontend
```

**Option B:** build on your host Docker (e.g. Docker Desktop), then load images into the cluster:

```bash
docker build -t post-service:latest ./services/post-service
docker build -t comments-service:latest ./services/comments-service
docker build -t broadcast-service:latest ./services/broadcast-service
docker build -t frontend:latest ./services/frontend

# Required if you did NOT run eval $(minikube docker-env) before building
minikube image load post-service:latest
minikube image load comments-service:latest
minikube image load broadcast-service:latest
minikube image load frontend:latest
```

Verify the images are visible to Minikube:

```bash
minikube image ls | grep -E 'post-service|comments-service|broadcast-service|frontend'
```

If pods were already created and stuck on `ImagePullBackOff` / “image can't be pulled”, load the images (Option B), then restart:

```bash
kubectl rollout restart deployment/post-service -n fb-live-comments
kubectl rollout restart deployment/comments-service -n fb-live-comments
kubectl rollout restart deployment/broadcast-service -n fb-live-comments
kubectl rollout restart deployment/frontend -n fb-live-comments
```



### 7. Deploy Post Service

```bash
kubectl apply -f k8s/post-service/deployment.yaml
kubectl apply -f k8s/post-service/service.yaml
kubectl get pods -n fb-live-comments -l app=post-service
kubectl get svc -n fb-live-comments post-service
kubectl logs -n fb-live-comments -l app=post-service --tail=50
```



### 8. Deploy Comments Service

```bash
kubectl apply -f k8s/comments-service/deployment.yaml
kubectl apply -f k8s/comments-service/service.yaml
kubectl apply -f k8s/comments-service/hpa.yaml
kubectl get pods -n fb-live-comments -l app=comments-service
kubectl get svc -n fb-live-comments comments-service
kubectl get hpa -n fb-live-comments comments-service
kubectl logs -n fb-live-comments -l app=comments-service --tail=50
```

HPA scales `comments-service` between 1–5 replicas at ~70% CPU / ~80% memory of the container requests. Requires metrics-server (`minikube addons enable metrics-server` if `kubectl top pods` fails).



### 9. Deploy Broadcast Service (SSE)

```bash
kubectl apply -f k8s/broadcast-service/deployment.yaml
kubectl apply -f k8s/broadcast-service/service.yaml
kubectl apply -f k8s/broadcast-service/hpa.yaml
kubectl get pods -n fb-live-comments -l app=broadcast-service
kubectl get svc -n fb-live-comments broadcast-service
kubectl get hpa -n fb-live-comments broadcast-service
kubectl logs -n fb-live-comments -l app=broadcast-service --tail=50
```

HPA keeps `broadcast-service` between 2–10 replicas (CPU ~70%). Scale-down is slower (5m stabilization) because SSE connections are sticky to pods.



### 10. Deploy Frontend

```bash
kubectl apply -f k8s/frontend/deployment.yaml
kubectl apply -f k8s/frontend/service.yaml
kubectl get pods -n fb-live-comments -l app=frontend
kubectl get svc -n fb-live-comments frontend
```



### 11. Deploy Gateway API resources

```bash
kubectl apply -f k8s/gateway/gatewayclass.yaml
kubectl apply -f k8s/gateway/envoyproxy.yaml
kubectl apply -f k8s/gateway/gateway.yaml
kubectl apply -f k8s/gateway/httproute-posts.yaml
kubectl apply -f k8s/gateway/httproute-comments.yaml
kubectl apply -f k8s/gateway/httproute-broadcast.yaml
kubectl apply -f k8s/gateway/backendtrafficpolicy-broadcast.yaml
kubectl apply -f k8s/gateway/clienttrafficpolicy-sse.yaml
kubectl apply -f k8s/gateway/httproute-frontend.yaml

kubectl get gateway,httproute -n fb-live-comments
kubectl get svc -n envoy-gateway-system api-gateway
```

Wait until the Gateway is programmed:

```bash
kubectl wait --timeout=2m \
  -n fb-live-comments gateway/api-gateway \
  --for=condition=Programmed
```

Smoke test:

```bash
curl "http://$(minikube ip):30080/health"
curl -sI "http://$(minikube ip):30080/" | head -5
```



### 12. Open the app

Everything (UI + API) goes through the gateway NodePort:

```bash
echo "http://$(minikube ip):30080"
```


| Path                             | Backend            |
| -------------------------------- | ------------------ |
| `/`                              | frontend           |
| `/v1/users`, `/v1/posts`         | post-service       |
| `/v1/posts/{id}/comments`        | comments-service   |
| `/v1/posts/{id}/comments/stream` | broadcast-service  |



| Service             | NodePort |
| ------------------- | -------- |
| api-gateway (Envoy) | `30080`  |
| Grafana             | `30300`  |
| Prometheus          | `30090`  |



### 13. Install Prometheus + Grafana (optional, for graphs)

```bash
helm upgrade --install monitoring \
  oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack \
  --version 69.8.2 \
  -n monitoring \
  --create-namespace \
  -f k8s/monitoring/values.yaml

kubectl wait --timeout=10m \
  -n monitoring \
  --for=condition=available deployment \
  -l app.kubernetes.io/part-of=kube-prometheus-stack

# Scrape Envoy Gateway proxies + control plane; load the FB Live dashboard
kubectl apply -f k8s/monitoring/podmonitor-envoy.yaml
kubectl apply -f k8s/monitoring/servicemonitor-envoy-gateway.yaml
kubectl apply -f k8s/monitoring/grafana-dashboard-fblive.yaml
# Minikube cAdvisor often lacks per-container labels; this makes CPU/mem graphs work
kubectl apply -f k8s/monitoring/prometheusrule-minikube-pod-usage.yaml
# Stock "Kubernetes / Compute Resources /*" Memory panels still use raw cAdvisor
# filters (container!="", image!=""). Patch them to use the recording rules above:
python3 k8s/monitoring/patch-minikube-dashboards.py
```

Open Grafana (preferred on Docker Desktop Mac: port-forward):

```bash
kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80
# → http://127.0.0.1:3000
# login: admin / admin
```

Or NodePort (may hang from macOS like the gateway NodePort):

```bash
echo "http://$(minikube ip):30300"
```

In Grafana open dashboard **FB Live Comments** (or Dashboards → browse). Graphs include:

- Gateway / route **RPS** (from Envoy)
- Upstream RPS by HTTP status
- App + DB **pod CPU / memory**

Prometheus UI:

```bash
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
# → http://127.0.0.1:9090
```

Useful PromQL while running k6:

```promql
sum(rate(envoy_http_downstream_rq_total{envoy_http_conn_manager_prefix="http-10080"}[1m]))
sum by (envoy_cluster_name) (rate(envoy_cluster_upstream_rq_total{envoy_cluster_name=~"httproute/fb-live-comments/.*"}[1m]))
```

### k6 write load (in-cluster)

Prefer running k6 **inside the cluster** so traffic hits
`api-gateway.envoy-gateway-system` over the pod network (avoids Mac
port-forward / ephemeral-port limits).

```bash
# Create a post first and copy its id, then:
./loadtests/k6/run-in-cluster.sh \
  -e POST_ID=<post-uuid> \
  -e RPS=200 \
  -e DURATION=60s \
  -e WORKERS=1

# Distributed: total target ≈ RPS × WORKERS (example ~2000 RPS)
./loadtests/k6/run-in-cluster.sh \
  -e POST_ID=<post-uuid> \
  -e RPS=500 \
  -e DURATION=60s \
  -e WORKERS=4 \
  -e MAX_VUS=2000

kubectl -n fb-live-comments logs -l app=k6-write-comments -f --prefix
kubectl -n fb-live-comments get job,pods -l app=k6-write-comments
```

The helper syncs `loadtests/k6/write-comments.js` into ConfigMap
`k6-write-comments` and starts Job `k6-write-comments` (image
`grafana/k6:0.54.0`). Manifest: `loadtests/k6/k8s/job-write-comments.yaml`.

Minikube still will not sustain tens of thousands of successful write RPS;
use `WORKERS` to raise *offered* load and watch where the stack breaks
(gateway, comments-service HPA, Mongo).

---



## Verify everything

```bash
kubectl get all -n fb-live-comments
kubectl get gateway,httproute -n fb-live-comments
kubectl get svc -n envoy-gateway-system api-gateway
```

Expected pieces:

- Deployments: `postgres`, `mongodb`, `redis`, `post-service`, `comments-service`, `broadcast-service`, `frontend`
- Gateway API: `Gateway/api-gateway`, `HTTPRoute/frontend`, `HTTPRoute/post-service`, `HTTPRoute/comments-service`, `HTTPRoute/broadcast-service`
- Envoy proxy Service: `api-gateway` in `envoy-gateway-system` (NodePort `30080`)

Quick API check through the gateway:

```bash
GATEWAY="http://$(minikube ip):30080"

# Create a user
curl -s -X POST "$GATEWAY/v1/users" \
  -H 'Content-Type: application/json' \
  -d '{"id":"11111111-1111-1111-1111-111111111111","name":"DemoUser"}' | jq .

# Create a post
curl -s -X POST "$GATEWAY/v1/posts" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"11111111-1111-1111-1111-111111111111","content":"Hello live stream"}' | jq .

# List posts
curl -s "$GATEWAY/v1/posts?limit=10" | jq .
```

---



## How traffic is connected

1. Browser opens the **gateway** (`:30080`).
2. `HTTPRoute/frontend` serves `/` from **frontend** (Next.js).
3. On load, the UI creates a random tab user and calls same-origin `POST /v1/users`.
4. Other **HTTPRoute** rules on `Gateway/api-gateway` send:
  - `/v1/users`, exact `/v1/posts` → **post-service** → **postgres**
  - `/v1/posts/{id}/comments` (regex `$`) → **comments-service** → **mongodb** (+ Redis `PUBLISH`)
  - `/v1/posts/{id}/comments/stream` → **broadcast-service** → Redis `SUBSCRIBE` → SSE to browser
5. Comment UI opens SSE while expanded, and uses `cursor=` for older history pages.

Routing is declared in `k8s/gateway/httproute-*.yaml`.

---



## Useful kubectl commands

```bash
# Pod status
kubectl get pods -n fb-live-comments -o wide

# Gateway status
kubectl describe gateway api-gateway -n fb-live-comments
kubectl describe httproute post-service -n fb-live-comments
kubectl describe httproute comments-service -n fb-live-comments
kubectl describe httproute broadcast-service -n fb-live-comments

# Follow logs
kubectl logs -n fb-live-comments -l app=post-service -f
kubectl logs -n fb-live-comments -l app=comments-service -f
kubectl logs -n fb-live-comments -l app=broadcast-service -f
kubectl logs -n fb-live-comments -l app=frontend -f
kubectl logs -n envoy-gateway-system -l app.kubernetes.io/name=envoy -f

# Restart a deployment after rebuilding an image
kubectl rollout restart deployment/post-service -n fb-live-comments
kubectl rollout restart deployment/comments-service -n fb-live-comments
kubectl rollout restart deployment/broadcast-service -n fb-live-comments
kubectl rollout restart deployment/frontend -n fb-live-comments
```

---



## Tear down

```bash
kubectl delete -f k8s/monitoring/grafana-dashboard-fblive.yaml
kubectl delete -f k8s/monitoring/servicemonitor-envoy-gateway.yaml
kubectl delete -f k8s/monitoring/podmonitor-envoy.yaml
helm uninstall monitoring -n monitoring
kubectl delete namespace monitoring

kubectl delete -f k8s/gateway/httproute-frontend.yaml
kubectl delete -f k8s/gateway/clienttrafficpolicy-sse.yaml
kubectl delete -f k8s/gateway/backendtrafficpolicy-broadcast.yaml
kubectl delete -f k8s/gateway/httproute-broadcast.yaml
kubectl delete -f k8s/gateway/httproute-comments.yaml
kubectl delete -f k8s/gateway/httproute-posts.yaml
kubectl delete -f k8s/gateway/gateway.yaml
kubectl delete -f k8s/gateway/envoyproxy.yaml
kubectl delete -f k8s/gateway/gatewayclass.yaml
kubectl delete -f k8s/frontend/service.yaml
kubectl delete -f k8s/frontend/deployment.yaml
kubectl delete -f k8s/broadcast-service/hpa.yaml
kubectl delete -f k8s/broadcast-service/service.yaml
kubectl delete -f k8s/broadcast-service/deployment.yaml
kubectl delete -f k8s/comments-service/hpa.yaml
kubectl delete -f k8s/comments-service/service.yaml
kubectl delete -f k8s/comments-service/deployment.yaml
kubectl delete -f k8s/post-service/service.yaml
kubectl delete -f k8s/post-service/deployment.yaml
kubectl delete -f k8s/redis/service.yaml
kubectl delete -f k8s/redis/deployment.yaml
kubectl delete -f k8s/mongodb/service.yaml
kubectl delete -f k8s/mongodb/deployment.yaml
kubectl delete -f k8s/postgres/service.yaml
kubectl delete -f k8s/postgres/deployment.yaml
kubectl delete -f k8s/namespace.yaml

helm uninstall eg -n envoy-gateway-system
kubectl delete namespace envoy-gateway-system
```

Or delete the app namespace in one shot (still uninstall Envoy Gateway / monitoring separately):

```bash
kubectl delete namespace fb-live-comments
helm uninstall eg -n envoy-gateway-system
helm uninstall monitoring -n monitoring
```

---



## Local development (optional, outside Minikube)

Run Postgres + Mongo + Redis locally (or via Docker), then call services directly (no Gateway API needed locally):

```bash
# Post service
cd services/post-service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/posts
uvicorn app.main:app --reload --port 8000

# Comments service
cd services/comments-service
npm install
export MONGODB_URI=mongodb://localhost:27017/comments
export REDIS_URL=redis://localhost:6379
npm run dev

# Broadcast service (SSE)
cd services/broadcast-service
npm install
export REDIS_URL=redis://localhost:6379
npm run dev

# Frontend — optional rewrite to a local API origin while developing UI
cd services/frontend
npm install
export API_GATEWAY_URL=http://localhost:8000
npm run dev
```

Prefer Minikube + Gateway (`:30080`) for full UI + API + SSE routing.

---



## Design notes

- **Gateway API**: single entrypoint; `/` → frontend, `/v1/*` → post/comments/broadcast (Exact/PathPrefix/regex matches).
- **Redis pub/sub**: channel `post:{postId}:comments`; comments-service publishes after write; broadcast-service subscribes per connected SSE clients on that pod.
- **SSE live feed**: `GET /v1/posts/{postId}/comments/stream` while a comments section is open; stops when collapsed (component unmounts / `EventSource.close()`).
- **Cursor pagination**: timestamp cursors for posts (`limit=10`) and comments (`limit=20`).
- **Replicas**: app Deployments use `replicas: 2` where useful for basic horizontal redundancy in Minikube.

