#!/usr/bin/env python3
"""Approved, bounded nginx-only relocation; preserve all existing collectors."""
import argparse
import json
from pathlib import Path
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parent
KUBE = "/tmp/awsops-central-telemetry.bOV102/kubeconfig"
TARGETS = {
    "ekscluster01-iptables": "79026835-aff5-4138-91da-1917f9488ec0",
    "ekscluster01-ipvs": "0c3f4a86-4e92-41e1-8dd5-642b9885399b",
    "ekscluster01-nftables": "8d5ad718-b703-4c3a-a4c3-2ad041d19ae0",
}
COLLECTORS = {"telemetry-node", "telemetry-beyla"}
TERMINAL = {"Succeeded", "Failed"}


def interrupted(signum, _frame):
    raise InterruptedError(f"received signal {signum}")


def ready(pod):
    return (not pod["metadata"].get("deletionTimestamp")
            and any(c["type"] == "Ready" and c["status"] == "True"
                    for c in pod.get("status", {}).get("conditions", [])))


class Rebalance:
    def __init__(self, cluster, apply, headroom=0):
        self.cluster = cluster
        self.apply = apply
        self.headroom = headroom
        self.prefix = ["kubectl", "--kubeconfig", KUBE, "--context", cluster, "--request-timeout=20s"]
        journal = ROOT / f"rebalance-{self.cluster}.json"
        self.events = json.loads(journal.read_text()) if journal.exists() else []

    def log(self, action, **details):
        event = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "cluster": self.cluster, "action": action, **details}
        self.events.append(event)
        (ROOT / f"rebalance-{self.cluster}.json").write_text(json.dumps(self.events, indent=2) + "\n")
        print(json.dumps(event), flush=True)

    def k(self, *args, body=None):
        attempts = 3 if args[0] in ("get", "uncordon") else 1
        for attempt in range(attempts):
            result = subprocess.run(self.prefix + list(args), input=body, text=True,
                                    capture_output=True, timeout=30)
            if result.returncode == 0:
                return result.stdout
            if "exec: executable aws failed with exit code -1" not in result.stderr or attempt == attempts - 1:
                raise RuntimeError(result.stderr[-2000:])
            time.sleep(1)

    def get(self, *args):
        return json.loads(self.k("get", *args, "-o", "json"))

    def deployment(self):
        dep = self.get("deployment", "nginx-backend", "-n", "conntrack-test")
        assert dep["metadata"]["uid"] == TARGETS[self.cluster], "Deployment ownership changed"
        assert dep["spec"]["replicas"] == 180, "User changed desired replicas"
        return dep

    def wait_available(self, timeout=150):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if self.deployment()["status"].get("availableReplicas", 0) >= 180:
                return
            time.sleep(2)
        raise RuntimeError("nginx did not recover 180 Available; no further eviction")

    def node_collectors(self, node):
        pods = self.get("pods", "-n", "telemetry-system")["items"]
        found = set()
        for pod in pods:
            if pod["spec"].get("nodeName") != node or not ready(pod):
                continue
            owner = next((o for o in pod["metadata"].get("ownerReferences", [])
                          if o["kind"] == "DaemonSet" and o.get("controller")), {})
            if owner.get("name") in COLLECTORS:
                found.add(owner["name"])
        return found

    def assigned_collectors(self, node):
        pods = self.get("pods", "-n", "telemetry-system")["items"]
        return {
            owner["name"]
            for pod in pods if pod["spec"].get("nodeName") == node
            and not pod["metadata"].get("deletionTimestamp")
            for owner in pod["metadata"].get("ownerReferences", [])
            if owner["kind"] == "DaemonSet" and owner.get("controller") and owner["name"] in COLLECTORS
        }

    def free_slots(self, node):
        capacity = int(self.get("node", node)["status"]["allocatable"]["pods"])
        pods = self.get("pods", "-A", "--field-selector", f"spec.nodeName={node}")["items"]
        return capacity - sum(p["status"].get("phase") not in TERMINAL for p in pods)

    def satisfied(self, node):
        return self.node_collectors(node) == COLLECTORS and self.free_slots(node) >= self.headroom

    def candidates(self, node):
        sets = self.get("replicasets", "-n", "conntrack-test")["items"]
        owners = {r["metadata"]["uid"] for r in sets
                  if any(o.get("uid") == TARGETS[self.cluster] and o.get("controller")
                         for o in r["metadata"].get("ownerReferences", []))}
        pods = self.get("pods", "-n", "conntrack-test", "--field-selector", f"spec.nodeName={node}")["items"]
        return sorted([
            p for p in pods if ready(p) and
            any(o["kind"] == "ReplicaSet" and o["uid"] in owners and o.get("controller")
                for o in p["metadata"].get("ownerReferences", []))
        ], key=lambda p: p["metadata"]["name"])

    def run(self):
        identity = json.loads(subprocess.run(
            ["aws", "sts", "get-caller-identity", "--profile", "samples-atomoh"],
            check=True, capture_output=True, text=True, timeout=20).stdout)
        assert identity["Account"] == "061525506239"
        assert identity["Arn"].startswith("arn:aws:sts::061525506239:assumed-role/atomoh/")
        nodes = self.get("nodes")["items"]
        assert len([n for n in nodes if ready(n)]) >= 5, "Wait for approved fifth node to become Ready"
        self.wait_available()
        targets = [n for n in nodes if not self.satisfied(n["metadata"]["name"])]
        self.log("plan", nodes=[n["metadata"]["name"] for n in targets], apply=self.apply,
                 desired_nginx=180, max_evictions_per_node=4, pod_slot_headroom=self.headroom)
        if not self.apply:
            return
        for original in targets:
            node = original["metadata"]["name"]
            current = self.get("node", node)
            assert not current["spec"].get("unschedulable"), "Pre-existing cordon requires owner review"
            if self.satisfied(node):
                continue
            # Cordon only after the original nginx owner and availability checks.
            self.wait_available()
            self.k("cordon", node)
            self.log("cordon", node=node)
            try:
                for count in range(4):
                    if self.satisfied(node):
                        break
                    # An assigned collector already owns a Pod slot. Do not
                    # relocate nginx merely because its image/startup is slow.
                    warming = self.assigned_collectors(node) - self.node_collectors(node)
                    if warming:
                        until = time.monotonic() + 90
                        while time.monotonic() < until and (
                            self.assigned_collectors(node) - self.node_collectors(node)
                        ):
                            time.sleep(3)
                        if self.assigned_collectors(node) - self.node_collectors(node):
                            raise RuntimeError("Assigned collector is not Ready; diagnose before further eviction")
                        if self.satisfied(node):
                            break
                    nodepods = self.get("pods", "-A", "--field-selector", f"spec.nodeName={node}")["items"]
                    allocated = sum(p["status"].get("phase") not in TERMINAL for p in nodepods)
                    capacity = int(current["status"]["allocatable"]["pods"])
                    # Allow an in-flight pull/start to complete before evicting another nginx.
                    if allocated < capacity and self.node_collectors(node) != COLLECTORS:
                        until = time.monotonic() + 75
                        while time.monotonic() < until and self.node_collectors(node) != COLLECTORS:
                            time.sleep(3)
                        if self.satisfied(node):
                            break
                        allocated = sum(p["status"].get("phase") not in TERMINAL
                                        for p in self.get("pods", "-A", "--field-selector",
                                                          f"spec.nodeName={node}")["items"])
                        if allocated < capacity and self.node_collectors(node) != COLLECTORS:
                            raise RuntimeError("Pod slot is available but collector is not Ready; diagnose without further nginx eviction")
                    self.wait_available()
                    candidates = self.candidates(node)
                    assert candidates, "No approved nginx Pod on this node; cannot relocate other workloads"
                    pod = candidates[0]
                    name = pod["metadata"]["name"]
                    eviction = {
                        "apiVersion": "policy/v1", "kind": "Eviction",
                        "metadata": {"name": name, "namespace": "conntrack-test"},
                        "deleteOptions": {"gracePeriodSeconds": 30,
                                          "preconditions": {"uid": pod["metadata"]["uid"]}},
                    }
                    self.k("create", "--raw",
                           f"/api/v1/namespaces/conntrack-test/pods/{name}/eviction", "-f", "-",
                           body=json.dumps(eviction))
                    self.log("nginx-eviction", node=node, pod=name, original_uid=pod["metadata"]["uid"],
                             number=count + 1)
                    # Wait for the old Pod to leave before counting a recovered replacement.
                    until = time.monotonic() + 90
                    while time.monotonic() < until:
                        currentpods = self.get("pods", "-n", "conntrack-test")["items"]
                        if not any(p["metadata"]["uid"] == pod["metadata"]["uid"] for p in currentpods):
                            break
                        time.sleep(2)
                    else:
                        raise RuntimeError("Evicted nginx Pod has not terminated; stopping further relocation")
                    self.wait_available()
                    self.log("nginx-recovered", available=self.deployment()["status"]["availableReplicas"])
                    time.sleep(10)
                self.log("node-result", node=node, ready_collectors=sorted(self.node_collectors(node)),
                         free_pod_slots=self.free_slots(node))
            finally:
                self.k("uncordon", node)
                self.log("uncordon", node=node)
        self.wait_available()
        self.log("finished", available=self.deployment()["status"]["availableReplicas"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True, choices=sorted(TARGETS))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--headroom", type=int, choices=(0, 1, 2), default=0)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    Rebalance(args.cluster, args.apply, args.headroom).run()
