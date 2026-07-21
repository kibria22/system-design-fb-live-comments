#!/usr/bin/env python3
"""Patch stock kube-prometheus Grafana dashboards for Minikube cAdvisor.

Minikube often only exposes pod-level cAdvisor series (no container/image labels).
Stock panels filter container!="" / image!="" and show "No data".

Requires PrometheusRule minikube-pod-usage (see prometheusrule-minikube-pod-usage.yaml).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys

NAMESPACE = "monitoring"

CONFIGMAPS = [
    "monitoring-kube-prometheus-k8s-resources-workload",
    "monitoring-kube-prometheus-k8s-resources-workloads-namespace",
    "monitoring-kube-prometheus-k8s-resources-namespace",
    "monitoring-kube-prometheus-k8s-resources-pod",
    "monitoring-kube-prometheus-k8s-resources-cluster",
]

# metric name -> recording rule (from prometheusrule-minikube-pod-usage.yaml)
METRIC_MAP = {
    "container_memory_working_set_bytes": (
        "node_namespace_pod_container:container_memory_working_set_bytes"
    ),
    "container_memory_rss": "node_namespace_pod_container:container_memory_rss",
    "container_memory_cache": "node_namespace_pod_container:container_memory_cache",
}

DROP_LABEL_RE = re.compile(
    r"""(?:,\s*)?(?:
        container\s*!=\s*""|
        container\s*!=\s*"POD"|
        image\s*!=\s*""|
        job\s*=\s*"kubelet"|
        metrics_path\s*=\s*"/metrics/cadvisor"
    )""",
    re.VERBOSE,
)


def rewrite_expr(expr: str) -> str:
    if "node_namespace_pod_container:" in expr and "container_memory_working_set_bytes{" not in expr:
        # already using recording rules for the common path; still fix any leftover raw refs
        pass

    out = expr
    for raw, recorded in METRIC_MAP.items():
        if raw not in out or recorded in out:
            continue
        # Only replace bare metric selectors, not recording-rule names that contain the same suffix
        out = re.sub(
            rf"(?<![:\w]){re.escape(raw)}\s*\{{",
            f"{recorded}{{",
            out,
        )

    if out == expr:
        return expr

    # Strip Minikube-hostile / redundant label matchers inside {...}
    def clean_selector(m: re.Match[str]) -> str:
        body = DROP_LABEL_RE.sub("", m.group(1))
        body = re.sub(r",\s*,", ",", body)
        body = re.sub(r"^\s*,\s*", "", body)
        body = re.sub(r",\s*$", "", body)
        body = re.sub(r"\s+", " ", body).strip()
        return "{" + body + "}"

    out = re.sub(r"\{([^{}]*)\}", clean_selector, out)
    # Pod dashboard groups by container; recording rules are pod-scoped
    out = out.replace("by (container)", "by (pod)")
    return out


def walk_panels(panels: list) -> int:
    changed = 0
    for panel in panels:
        for target in panel.get("targets", []):
            expr = target.get("expr")
            if not isinstance(expr, str):
                continue
            new_expr = rewrite_expr(expr)
            if new_expr != expr:
                target["expr"] = new_expr
                changed += 1
        if "panels" in panel:
            changed += walk_panels(panel["panels"])
    return changed


def patch_configmap(name: str) -> int:
    cm = json.loads(
        subprocess.check_output(
            ["kubectl", "get", "cm", "-n", NAMESPACE, name, "-o", "json"],
            text=True,
        )
    )
    total = 0
    for key, raw in list(cm["data"].items()):
        dash = json.loads(raw)
        n = walk_panels(dash.get("panels", []))
        if n:
            cm["data"][key] = json.dumps(dash, separators=(",", ":"))
            total += n

    if not total:
        print(f"{name}: no changes")
        return 0

    subprocess.run(
        ["kubectl", "apply", "-f", "-"],
        input=json.dumps(cm),
        text=True,
        check=True,
    )
    print(f"{name}: patched {total} panel query(ies)")
    return total


def main() -> int:
    total = 0
    for name in CONFIGMAPS:
        try:
            total += patch_configmap(name)
        except subprocess.CalledProcessError as exc:
            print(f"{name}: failed: {exc}", file=sys.stderr)
            return 1
    print(f"done: {total} queries updated")
    print("Reload Grafana (or wait ~30s for sidecar) and hard-refresh the browser.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
