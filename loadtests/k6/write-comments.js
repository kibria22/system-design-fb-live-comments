/**
 * k6 load test: POST random comments to a post at a target RPS.
 *
 * Local (via port-forward — fine for low RPS):
 *   brew install k6
 *   kubectl -n envoy-gateway-system port-forward svc/api-gateway 8080:80
 *   k6 run loadtests/k6/write-comments.js \
 *     -e BASE_URL=http://127.0.0.1:8080 \
 *     -e POST_ID=<post-uuid> \
 *     -e RPS=20 \
 *     -e DURATION=30s
 *
 * In-cluster (preferred for higher RPS — no Mac port-forward limit):
 *   ./loadtests/k6/run-in-cluster.sh \
 *     -e POST_ID=<post-uuid> \
 *     -e RPS=500 \
 *     -e DURATION=60s \
 *     -e WORKERS=4
 *   # total target ≈ RPS × WORKERS
 *
 * Env:
 *   BASE_URL   Gateway base URL (default http://127.0.0.1:8080;
 *              in-cluster default is api-gateway.envoy-gateway-system)
 *   POST_ID    Required. Target post id
 *   RPS        Target comments per second (default 10)
 *   DURATION   How long to sustain that RPS (default 30s)
 *   PRE_VUS    Pre-allocated VUs (default max(RPS, 10))
 *   MAX_VUS    Max VUs for the arrival-rate executor (default RPS * 4)
 */

import http from "k6/http";
import { check, fail } from "k6";
import { Trend, Rate } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const POST_ID = __ENV.POST_ID;
const RPS = Number(__ENV.RPS || 10);
const DURATION = __ENV.DURATION || "30s";
const PRE_VUS = Number(__ENV.PRE_VUS || Math.max(RPS, 10));
const MAX_VUS = Number(__ENV.MAX_VUS || Math.max(RPS * 4, PRE_VUS));

if (!POST_ID) {
  fail("POST_ID is required. Example: -e POST_ID=11111111-1111-1111-1111-111111111111");
}

const commentLatency = new Trend("comment_latency_ms", true);
const commentFailRate = new Rate("comment_fail_rate");

const WORDS = [
  "live",
  "stream",
  "fire",
  "love",
  "wow",
  "lol",
  "great",
  "epic",
  "hello",
  "chat",
  "go",
  "team",
  "nice",
  "cool",
  "hype",
];

export const options = {
  scenarios: {
    write_comments: {
      executor: "constant-arrival-rate",
      rate: RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
    comment_fail_rate: ["rate<0.05"],
  },
};

function uuidv4() {
  // k6 has no crypto.randomUUID; generate RFC4122-ish v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function randomContent() {
  const n = 3 + Math.floor(Math.random() * 6);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  }
  return `${parts.join(" ")} #${Math.floor(Math.random() * 1e6)}`;
}

export default function () {
  const url = `${BASE_URL}/v1/posts/${POST_ID}/comments`;
  const payload = JSON.stringify({
    userId: uuidv4(),
    content: randomContent(),
  });

  const res = http.post(url, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /v1/posts/:postId/comments" },
  });

  commentLatency.add(res.timings.duration);

  const ok = check(res, {
    "status is 201": (r) => r.status === 201,
    "has comment id": (r) => {
      try {
        return Boolean(r.json("id"));
      } catch {
        return false;
      }
    },
  });

  commentFailRate.add(!ok);
}
