# RCA Incident Orchestrator — Stage 3 (first slice) Implementation Plan

> **⚠️ STATUS (2026-06-23): NOT implemented on this branch.** The `agent/rca/*`, `agent/rca_orchestrator.py`, and `payload.mode == "rca"` structures below live on the **unmerged** branch `feat/v2-rca-orchestrator` (worktree `~/awsops-rca`, P4-passed), pending rebase onto the canonical line + merge. Decision of record: **ADR-006 (incident-analysis-only)**. Read-only; S4 autonomy frozen.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. **Implementer = Codex** (isolated worktree, per-task). Decision record: **"DevOps RCA Incident Orchestrator — EoG"** (currently `docs/decisions/046-*.md`; a concurrent session is renumbering ADRs — reference the decision **by title**, not number).

**Goal:** Light up a read-only, alert-triggered RCA path: a registered alert-source integration → existing `/api/incidents/webhook` → EoG orchestrator (AgentCore "+1" over the existing section gateways) produces a 1-hop root-cause analysis written to `incidents.rca`, shown at `/incidents/[id]`.

**Architecture:** The orchestrator is a NEW `payload.mode == "rca"` branch in the existing AgentCore runtime (reuses the image/runtime/provisioning; no new runtime). Its brain is a **deterministic EoG controller** (pure Python in `agent/rca/`): seed the failing entity from the alert → 1-hop neighbors from the resource graph → per node, gather **bounded** evidence by calling a **curated subset of existing gateway MCP tools** (reusing `create_gateway_transport`+`MCPClient`) → ask Bedrock for a per-node "cause vs symptom" label (identifiers anonymized first, fail-closed) → aggregate → write `incident_findings` + `incidents.rca`. Controller logic is unit-tested with gateway calls and Bedrock mocked.

**Tech Stack:** Python 3.11 (agent image), Strands `MCPClient`, boto3 Bedrock `invoke_model`, psycopg2 (Aurora), pytest. Next.js BFF for the `/incidents/[id]` render.

## Global Constraints
- **read-only**: no path performs an AWS-resource mutation, no SSM/Change-Manager, no autonomous action (S4 frozen). RCA lands in `incidents.rca` only — NO ADR-034 write-back (OpsCenter/Incident Manager) in this slice.
- **flag-OFF default**: gated by the existing `INCIDENT_LIFECYCLE_ENABLED` (web) + a new `rca_orchestrator_enabled` payload/env gate; default off → no autonomous trigger.
- **bounded tools only**: failing entity + 1-hop neighbors; ~50-line log bounds; NO `get_all_*`.
- **anonymize before every LLM call, fail-closed**: if anonymization fails, do NOT call Bedrock (FSI).
- **arm64** for the agent image (`docker buildx --platform linux/arm64`).
- **gateway fabric reuse**: bounded tools are existing gateway MCP tools (`tempo_get_trace`, `loki_query_range`, ops topology/inventory, k8sgpt) called via `MCPClient`; do NOT import the connector lambdas directly (no gateway bypass).
- All new Python under `agent/rca/`; tests colocated `agent/rca/test_*.py`.

## File Structure
- `agent/rca/__init__.py` — package marker.
- `agent/rca/graph.py` — `neighbors(entity_id, edges)` 1-hop neighbor derivation (pure).
- `agent/rca/anonymize.py` — `anonymize(text, mapping)` / `deanonymize(text, mapping)` (pod/table/PII masking), fail-closed helper.
- `agent/rca/tools.py` — `BoundedTools` — calls a curated set of gateway MCP tools with bounded args; returns compact evidence dicts.
- `agent/rca/reasoning.py` — `label_node(node, evidence, bedrock, anonymizer)` → `{"label": "cause"|"symptom"|"unknown", "rationale": str}`.
- `agent/rca/controller.py` — `run_rca(incident, graph, tools, reasoner)` → `RcaResult` (deterministic traversal + aggregation).
- `agent/rca/persist.py` — `write_rca(incident_id, result)` → `incident_findings` + `incidents.rca` (psycopg2).
- `agent/rca_orchestrator.py` — `handle_rca(payload)` entrypoint branch (wires graph+tools+reasoner+persist over the gateway MCPClients).
- `agent/agent.py` — MODIFY `handler` to dispatch `payload.get("mode") == "rca"` → `handle_rca`.
- `web/app/api/incidents/[id]/route.ts` / `web/app/incidents/[id]/*` — ensure `incidents.rca` renders (read-only).

---

### Task 1: 1-hop neighbor derivation (pure)

**Files:**
- Create: `agent/rca/__init__.py` (empty)
- Create: `agent/rca/graph.py`
- Test: `agent/rca/test_graph.py`

**Interfaces:**
- Produces: `neighbors(entity_id: str, edges: list[dict]) -> list[str]` — edges are `{"source": str, "target": str}` (mirrors `web/lib/topology.ts` `TopoEdge`; the orchestrator obtains edges from the ops-gateway topology tool, Task 6). Returns the deduped set of node ids directly adjacent to `entity_id` (either direction), excluding `entity_id` itself. Deterministic order (sorted).

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_graph.py
from rca.graph import neighbors

def test_neighbors_both_directions_dedup_sorted():
    edges = [
        {"source": "vpc:1", "target": "alb:a"},
        {"source": "alb:a", "target": "ec2:x"},
        {"source": "ec2:x", "target": "rds:db"},
        {"source": "alb:a", "target": "ec2:x"},  # dup
    ]
    assert neighbors("ec2:x", edges) == ["alb:a", "rds:db"]
    assert neighbors("alb:a", edges) == ["ec2:x", "vpc:1"]
    assert neighbors("absent", edges) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_graph.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'rca.graph'`

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/graph.py
"""1-hop neighbor derivation over a resource/service edge list (ADR: EoG bounded-neighborhood)."""

def neighbors(entity_id, edges):
    out = set()
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if s == entity_id and t:
            out.add(t)
        elif t == entity_id and s:
            out.add(s)
    out.discard(entity_id)
    return sorted(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_graph.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/__init__.py agent/rca/graph.py agent/rca/test_graph.py
git commit -m "feat(rca): 1-hop neighbor derivation (EoG bounded neighborhood)"
```

---

### Task 2: Identifier anonymization (fail-closed)

**Files:**
- Create: `agent/rca/anonymize.py`
- Test: `agent/rca/test_anonymize.py`

**Interfaces:**
- Produces: `anonymize(text: str) -> tuple[str, dict]` — returns `(masked_text, mapping)` where pod-like (`name-<hash>-<hash>`), ARNs, IPs, and email are replaced by stable tokens (`ENT_1`, …); `mapping` maps token→original. `deanonymize(text: str, mapping: dict) -> str` reverses it. Stable: same input → same tokens within a call. Used by `reasoning.label_node` (Task 4); fail-closed is enforced at the call site (if `anonymize` raises, no Bedrock call).

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_anonymize.py
from rca.anonymize import anonymize, deanonymize

def test_roundtrip_masks_and_restores():
    text = "pod web-7d9f8c6b5-x2k9 on 10.0.3.14 owner ops@corp.io"
    masked, mapping = anonymize(text)
    assert "web-7d9f8c6b5-x2k9" not in masked
    assert "10.0.3.14" not in masked
    assert "ops@corp.io" not in masked
    assert deanonymize(masked, mapping) == text

def test_stable_tokens_same_entity_same_token():
    masked, _ = anonymize("10.0.0.1 and 10.0.0.1")
    assert masked.count(masked.split()[0]) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_anonymize.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/anonymize.py
"""Mask identifiers before LLM calls (ADR: FSI anonymization, k8sgpt --anonymize pattern).
Stage-3 scope: pod names, IPv4, ARNs, emails. Reversible via the returned mapping."""
import re

_PATTERNS = [
    re.compile(r"arn:aws:[^\s\"']+"),                       # ARNs
    re.compile(r"\b[a-z0-9-]+-[a-f0-9]{8,10}-[a-z0-9]{5}\b"),  # k8s pod hash suffix
    re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"),             # IPv4
    re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),            # email
]

def anonymize(text):
    mapping, counter, masked = {}, {"n": 0}, text
    seen = {}
    def repl(m):
        orig = m.group(0)
        if orig not in seen:
            counter["n"] += 1
            tok = f"ENT_{counter['n']}"
            seen[orig] = tok
            mapping[tok] = orig
        return seen[orig]
    for pat in _PATTERNS:
        masked = pat.sub(repl, masked)
    return masked, mapping

def deanonymize(text, mapping):
    for tok, orig in mapping.items():
        text = text.replace(tok, orig)
    return text
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_anonymize.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/anonymize.py agent/rca/test_anonymize.py
git commit -m "feat(rca): fail-closed identifier anonymization (pods/IP/ARN/email)"
```

---

### Task 3: Per-node cause/symptom reasoning (Bedrock, anonymized, fail-closed)

**Files:**
- Create: `agent/rca/reasoning.py`
- Test: `agent/rca/test_reasoning.py`

**Interfaces:**
- Consumes: `anonymize`/`deanonymize` (Task 2).
- Produces: `label_node(node_id: str, evidence: dict, invoke_model) -> dict` returning `{"label": "cause"|"symptom"|"unknown", "rationale": str}`. `invoke_model(prompt: str) -> str` is the injected Bedrock caller (mocked in tests; real one wraps `bedrock-runtime.invoke_model` Anthropic Messages, like `scripts/v2/workers/diagnosis/report.py`). On anonymization failure or model error → `{"label": "unknown", "rationale": "..."}` (NO raw identifiers ever sent).

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_reasoning.py
from rca.reasoning import label_node

def test_label_node_anonymizes_prompt_and_parses_label():
    seen = {}
    def fake_invoke(prompt):
        seen["prompt"] = prompt
        return '{"label": "cause", "rationale": "deploy ENT_1 regressed"}'
    out = label_node("ec2:x", {"logs": "error on 10.0.3.14"}, fake_invoke)
    assert out["label"] == "cause"
    assert "10.0.3.14" not in seen["prompt"]   # anonymized before send

def test_model_error_degrades_to_unknown():
    def boom(_): raise RuntimeError("bedrock down")
    out = label_node("ec2:x", {"logs": "x"}, boom)
    assert out["label"] == "unknown"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_reasoning.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/reasoning.py
"""Per-node 'cause vs symptom' labeling. The deterministic controller (controller.py) decides
WHICH node to label; this module does ONLY the local LLM judgment, on anonymized evidence."""
import json
from rca.anonymize import anonymize

_PROMPT = (
    "You are an SRE doing root-cause analysis on ONE node of a service graph. "
    "Given the node id and its bounded local evidence, decide if this node is the likely "
    "CAUSE or merely a SYMPTOM of the incident. Reply with strict JSON: "
    '{{"label": "cause"|"symptom"|"unknown", "rationale": "<one sentence>"}}.\n\n'
    "node: {node}\nevidence:\n{evidence}\n"
)

def label_node(node_id, evidence, invoke_model):
    try:
        masked, _ = anonymize(json.dumps(evidence, ensure_ascii=False)[:6000])
    except Exception:
        return {"label": "unknown", "rationale": "anonymization failed; skipped LLM (fail-closed)"}
    try:
        raw = invoke_model(_PROMPT.format(node=node_id, evidence=masked))
        obj = json.loads(raw)
        label = obj.get("label")
        if label not in ("cause", "symptom", "unknown"):
            label = "unknown"
        return {"label": label, "rationale": str(obj.get("rationale", ""))[:500]}
    except Exception as e:
        return {"label": "unknown", "rationale": f"model error: {type(e).__name__}"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_reasoning.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/reasoning.py agent/rca/test_reasoning.py
git commit -m "feat(rca): per-node cause/symptom labeling (anonymized, fail-closed)"
```

---

### Task 4: Deterministic EoG controller

**Files:**
- Create: `agent/rca/controller.py`
- Test: `agent/rca/test_controller.py`

**Interfaces:**
- Consumes: `neighbors` (Task 1), `label_node` (Task 3).
- Produces: `run_rca(failing_entity: str, edges: list[dict], gather_evidence, label) -> dict`. `gather_evidence(node_id) -> dict` is injected (Task 5 supplies the gateway-backed real one; mocked here). `label(node_id, evidence) -> dict` is injected (wraps Task 3). Returns `{"failing_entity": str, "nodes": [{"node": str, "label": str, "rationale": str}], "root_causes": [str]}`. Deterministic: visits failing_entity + its 1-hop neighbors in sorted order, exactly once each; `root_causes` = node ids labeled "cause". NO ReAct loop — the controller owns traversal.

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_controller.py
from rca.controller import run_rca

def test_run_rca_visits_entity_plus_neighbors_once_deterministic():
    edges = [{"source": "alb:a", "target": "ec2:x"}, {"source": "ec2:x", "target": "rds:db"}]
    visited = []
    def gather(n):
        visited.append(n)
        return {"node": n}
    def label(n, ev):
        return {"label": "cause" if n == "rds:db" else "symptom", "rationale": n}
    out = run_rca("ec2:x", edges, gather, label)
    assert visited == ["ec2:x", "alb:a", "rds:db"]      # entity first, then sorted neighbors, once each
    assert out["root_causes"] == ["rds:db"]
    assert [n["node"] for n in out["nodes"]] == ["ec2:x", "alb:a", "rds:db"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_controller.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/controller.py
"""Deterministic EoG controller: owns graph traversal + aggregation. The LLM (via `label`)
only labels individual nodes; it never drives control flow (ADR: EoG, ~7x ReAct, auditable)."""
from rca.graph import neighbors

def run_rca(failing_entity, edges, gather_evidence, label):
    order = [failing_entity] + neighbors(failing_entity, edges)
    nodes, root_causes = [], []
    for node_id in order:                       # 1-hop, each node exactly once (Stage 3)
        evidence = gather_evidence(node_id)
        verdict = label(node_id, evidence)
        nodes.append({"node": node_id, "label": verdict["label"], "rationale": verdict["rationale"]})
        if verdict["label"] == "cause":
            root_causes.append(node_id)
    return {"failing_entity": failing_entity, "nodes": nodes, "root_causes": root_causes}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_controller.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/controller.py agent/rca/test_controller.py
git commit -m "feat(rca): deterministic EoG controller (1-hop traversal + aggregation)"
```

---

### Task 5: Bounded gateway-tool evidence client

**Files:**
- Create: `agent/rca/tools.py`
- Test: `agent/rca/test_tools.py`

**Interfaces:**
- Produces: `BoundedTools(clients: dict[str, object])` where `clients` maps gateway-key → a Strands `MCPClient` (already entered into an ExitStack by the caller, Task 6). Methods:
  - `topology_edges() -> list[dict]` — calls the ops gateway's topology tool, returns `[{"source","target"}]`.
  - `gather(node_id: str) -> dict` — bounded evidence for one node: recent error logs (loki `loki_query_range` with a label/`trace_id` selector for this entity, `limit<=50`) + (if a trace id is present) `tempo_get_trace`. Returns a compact dict; never `get_all_*`. Calls go through `MCPClient.call_tool_sync(name, args)` (Strands) — confirm the exact call method name in `agent/agent.py`'s usage (`get_all_tools`/`list_tools_sync` are nearby, line ~631–637).
- Consumes: nothing from earlier tasks (graph edges feed Task 4 via Task 6).

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_tools.py
from rca.tools import BoundedTools

class FakeClient:
    def __init__(self, result): self._r = result; self.calls = []
    def call_tool_sync(self, name, arguments=None):
        self.calls.append((name, arguments))
        return self._r

def test_gather_bounds_loki_limit_and_returns_compact():
    loki = FakeClient({"result": [{"line": "error"}]})
    bt = BoundedTools({"monitoring": loki})
    ev = bt.gather("ec2:x")
    name, args = loki.calls[0]
    assert args["limit"] <= 50               # bounded, never get_all_*
    assert "logs" in ev
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_tools.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/tools.py
"""Bounded evidence over the EXISTING gateway MCP tools (no gateway bypass; no get_all_*).
Stage 3: error logs via loki on the monitoring gateway; extend with traces/metrics later."""
LOG_LIMIT = 50

def _call(client, name, args):
    return client.call_tool_sync(name, arguments=args)

class BoundedTools:
    def __init__(self, clients):
        self.clients = clients            # {gateway_key: MCPClient}

    def topology_edges(self):
        ops = self.clients.get("ops")
        if not ops:
            return []
        res = _call(ops, "get_topology", {})        # confirm tool name in ops gateway catalog
        edges = (res or {}).get("edges", []) if isinstance(res, dict) else []
        return [{"source": e.get("source"), "target": e.get("target")} for e in edges]

    def gather(self, node_id):
        ev = {"node": node_id}
        mon = self.clients.get("monitoring")
        if mon:
            logs = _call(mon, "loki_query_range",
                         {"query": f'{{entity="{node_id}"}} |= "error"', "limit": LOG_LIMIT})
            ev["logs"] = logs
        return ev
```

- [ ] **Step 2 note:** the exact gateway tool names (`get_topology`, `loki_query_range`) and the `MCPClient` call method (`call_tool_sync`) MUST be confirmed against `agent/agent.py` + the provisioned gateway targets before Step 3; adjust the literals if they differ. (loki args verified in `agent/lambda/loki_mcp.py:109`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_tools.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/tools.py agent/rca/test_tools.py
git commit -m "feat(rca): bounded gateway-tool evidence client (loki/topology, no get_all_*)"
```

---

### Task 6: Persist RCA (incident_findings + incidents.rca)

**Files:**
- Create: `agent/rca/persist.py`
- Test: `agent/rca/test_persist.py`

**Interfaces:**
- Produces: `write_rca(conn, incident_id: str, result: dict) -> None` — inserts one `incident_findings` row (`sub_agent='rca-orchestrator'`, `findings=result`) and updates `incidents.rca = result::jsonb`, `status='root_cause'` where id=incident_id. `conn` is a psycopg2 connection (injected; mocked in test via a fake cursor). Column names verified in `data/schema.sql` (`incident_findings(incident_id, sub_agent, findings)`, `incidents(rca, status)`).

- [ ] **Step 1: Write the failing test**

```python
# agent/rca/test_persist.py
from rca.persist import write_rca

class FakeCur:
    def __init__(self): self.sql = []
    def execute(self, q, p=None): self.sql.append((q, p))
    def __enter__(self): return self
    def __exit__(self, *a): return False
class FakeConn:
    def __init__(self): self.cur = FakeCur(); self.committed = False
    def cursor(self): return self.cur
    def commit(self): self.committed = True

def test_write_rca_inserts_finding_and_updates_incident():
    conn = FakeConn()
    write_rca(conn, "inc-1", {"root_causes": ["rds:db"]})
    joined = " ".join(q for q, _ in conn.cur.sql).lower()
    assert "insert into incident_findings" in joined
    assert "update incidents" in joined and "rca" in joined
    assert conn.committed
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_persist.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca/persist.py
"""Persist the RCA read-only: one incident_findings row + incidents.rca/status. In-VPC psycopg2
(AgentCore runtime can reach Aurora; SFN cannot). NO write-back to OpsCenter/Incident Manager."""
import json

def write_rca(conn, incident_id, result):
    payload = json.dumps(result, ensure_ascii=False)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO incident_findings (incident_id, sub_agent, findings) VALUES (%s, %s, %s::jsonb)",
            (incident_id, "rca-orchestrator", payload),
        )
        cur.execute(
            "UPDATE incidents SET rca = %s::jsonb, status = 'root_cause' WHERE id = %s",
            (payload, incident_id),
        )
    conn.commit()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && python -m pytest rca/test_persist.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/rca/persist.py agent/rca/test_persist.py
git commit -m "feat(rca): persist RCA to incident_findings + incidents.rca (read-only)"
```

---

### Task 7: Orchestrator entrypoint branch (`payload.mode == "rca"`)

**Files:**
- Create: `agent/rca_orchestrator.py`
- Modify: `agent/agent.py` (handler dispatch — the async-generator `handler`, ~line 690)
- Test: `agent/rca/test_orchestrator.py`

**Interfaces:**
- Consumes: `BoundedTools` (5), `run_rca` (4), `label_node` (3), `write_rca` (6), `create_gateway_transport`+`MCPClient` (agent.py).
- Produces: `handle_rca(payload: dict) -> dict` — reads `payload.incident_id`, `payload.failing_entity` (from the normalized alert), opens MCPClients for the needed gateways (`ops`, `monitoring`) in an `ExitStack`, builds `BoundedTools`, fetches `topology_edges()`, runs `run_rca(...)`, persists, returns `{"incident_id", "root_causes", "node_count"}`. `agent.py`'s `handler` dispatches to it when `payload.get("mode") == "rca"` (default path = existing chat). Gated: returns `{"disabled": true}` when `rca_orchestrator_enabled` env != "true".

- [ ] **Step 1: Write the failing test** (orchestrator wiring with all deps mocked)

```python
# agent/rca/test_orchestrator.py
import os, rca_orchestrator as o

def test_handle_rca_disabled_by_default(monkeypatch):
    monkeypatch.delenv("RCA_ORCHESTRATOR_ENABLED", raising=False)
    assert o.handle_rca({"incident_id": "i1", "failing_entity": "ec2:x"}) == {"disabled": True}

def test_handle_rca_runs_when_enabled(monkeypatch):
    monkeypatch.setenv("RCA_ORCHESTRATOR_ENABLED", "true")
    monkeypatch.setattr(o, "_open_clients", lambda stack, keys: {})
    monkeypatch.setattr(o, "BoundedTools", lambda c: type("T", (), {
        "topology_edges": lambda s: [{"source": "ec2:x", "target": "rds:db"}],
        "gather": lambda s, n: {"node": n}})())
    monkeypatch.setattr(o, "label_node", lambda n, ev, inv: {"label": "cause" if n == "rds:db" else "symptom", "rationale": n})
    seen = {}
    monkeypatch.setattr(o, "write_rca", lambda conn, iid, res: seen.update({"iid": iid, "res": res}))
    monkeypatch.setattr(o, "_aurora_conn", lambda: object())
    out = o.handle_rca({"incident_id": "i1", "failing_entity": "ec2:x"})
    assert out["incident_id"] == "i1"
    assert seen["res"]["root_causes"] == ["rds:db"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && python -m pytest rca/test_orchestrator.py -v`
Expected: FAIL — module missing

- [ ] **Step 3: Write minimal implementation**

```python
# agent/rca_orchestrator.py
"""RCA orchestrator entrypoint branch: the AgentCore "+1" over the existing section gateways.
Deterministic EoG controller; read-only; flag-gated (RCA_ORCHESTRATOR_ENABLED)."""
import os, functools
from contextlib import ExitStack
from strands.tools.mcp.mcp_client import MCPClient
from agent import create_gateway_transport, GATEWAYS, model  # reuse fabric + model
from rca.tools import BoundedTools
from rca.controller import run_rca
from rca.reasoning import label_node
from rca.persist import write_rca

RCA_GATEWAYS = ("ops", "monitoring")

def _open_clients(stack, keys):
    clients = {}
    for k in keys:
        url = GATEWAYS.get(k)
        if not url:
            continue
        c = MCPClient(lambda u=url: create_gateway_transport(u))
        stack.enter_context(c)
        clients[k] = c
    return clients

def _aurora_conn():
    import psycopg2  # reuse the agent image's pg driver
    return psycopg2.connect(os.environ["AURORA_DSN"])

def _bedrock_invoke(prompt):
    # minimal Anthropic Messages invoke via the shared BedrockModel's client (mirrors report.py)
    import boto3, json
    body = {"anthropic_version": "bedrock-2023-05-31", "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}]}
    br = boto3.client("bedrock-runtime", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))
    resp = br.invoke_model(modelId="global.anthropic.claude-sonnet-4-6", body=json.dumps(body))
    out = json.loads(resp["body"].read())
    return out["content"][0]["text"]

def handle_rca(payload):
    if os.environ.get("RCA_ORCHESTRATOR_ENABLED") != "true":
        return {"disabled": True}
    incident_id = payload.get("incident_id")
    failing_entity = payload.get("failing_entity")
    if not incident_id or not failing_entity:
        return {"error": "incident_id and failing_entity required"}
    with ExitStack() as stack:
        clients = _open_clients(stack, RCA_GATEWAYS)
        tools = BoundedTools(clients)
        edges = tools.topology_edges()
        result = run_rca(
            failing_entity, edges,
            gather_evidence=tools.gather,
            label=lambda n, ev: label_node(n, ev, _bedrock_invoke),
        )
    conn = _aurora_conn()
    try:
        write_rca(conn, incident_id, result)
    finally:
        conn.close()
    return {"incident_id": incident_id, "root_causes": result["root_causes"], "node_count": len(result["nodes"])}
```

- [ ] **Step 4: Modify `agent/agent.py` handler to dispatch**

In the async `handler` (after `build_conversation`, before gateway selection — ~line 690), add:

```python
    if payload.get("mode") == "rca":
        from rca_orchestrator import handle_rca
        result = handle_rca(payload)
        yield {"delta": __import__("json").dumps(result)}
        return
```

- [ ] **Step 5: Run tests**

Run: `cd agent && python -m pytest rca/ -v`
Expected: PASS (all rca tests). Then `python -m py_compile agent.py rca_orchestrator.py`.

- [ ] **Step 6: Commit**

```bash
git add agent/rca_orchestrator.py agent/agent.py agent/rca/test_orchestrator.py
git commit -m "feat(rca): orchestrator entrypoint branch (payload.mode=rca, flag-gated, read-only)"
```

---

### Task 8: Enqueue RCA from the incident webhook (AlertManager source)

**Files:**
- Modify: `web/lib/incident.ts` (`enqueueInitialStage` — confirm at ~line 90)
- Test: `web/lib/incident.test.ts` (add case)

**Interfaces:**
- Consumes: existing `triageAndCreateOrLink` (incident.ts) + the worker enqueue path.
- Produces: when `INCIDENT_LIFECYCLE_ENABLED === 'true'`, the initial stage payload includes `mode: 'rca'`, `incident_id`, and `failing_entity` (derived from the normalized alert's primary service/resource label), so the dispatcher routes an AgentCore RCA invocation. Default OFF → unchanged (no enqueue). This task ONLY adds the `failing_entity` + `mode` fields to the enqueued payload; the dispatcher→AgentCore invoke wiring is verified against `scripts/v2/workers/dispatcher.py` (incident_stage branch).

- [ ] **Step 1: Write the failing test**

```typescript
// web/lib/incident.test.ts (add)
it('includes failing_entity + mode=rca in the enqueued RCA stage payload', async () => {
  // arrange: enabled flag + a triaged incident with a service label
  // assert: the enqueued worker_jobs body has { mode: 'rca', incident_id, failing_entity }
});
```

- [ ] **Step 2: Run it / confirm fail** — `cd web && npx vitest run lib/incident.test.ts`
- [ ] **Step 3: Implement** the payload field addition in `enqueueInitialStage` (read the function first; add `failing_entity` from the incident's `services[0]`/`resources[0]`, `mode: 'rca'`).
- [ ] **Step 4: Run** — `cd web && npx vitest run lib/incident.test.ts` → PASS
- [ ] **Step 5: Commit** — `git add web/lib/incident.ts web/lib/incident.test.ts && git commit -m "feat(rca): enqueue mode=rca + failing_entity from triaged incident (flag-gated)"`

---

### Task 9: Render RCA at `/incidents/[id]` (read-only)

**Files:**
- Modify: `web/app/api/incidents/[id]/route.ts` (ensure `getIncident` returns `rca`) + the incident detail view component.
- Test: existing `web/app/api/incidents/[id]/route.test.ts` (add an `rca` field assertion)

**Interfaces:**
- Consumes: `getIncident` (incident.ts, returns `IncidentDetail`) — confirm `rca` is selected; if not, add it to the SELECT.
- Produces: the detail response includes `rca` (the orchestrator's `{failing_entity, nodes, root_causes}`); the view renders root causes + per-node labels read-only.

- [ ] **Step 1: failing test** — assert the `[id]` route response includes `rca` when the row has it.
- [ ] **Step 2: confirm fail** — `cd web && npx vitest run app/api/incidents/[id]/route.test.ts`
- [ ] **Step 3: implement** — add `rca` to the SELECT/mapping + a read-only render block (root_causes list + nodes table). React-escape all values (no `dangerouslySetInnerHTML`).
- [ ] **Step 4: run** → PASS
- [ ] **Step 5: commit** — `git commit -m "feat(rca): render incident RCA (root causes + node labels) read-only"`

---

### Task 10: Wire the RCA gate flag end-to-end + docs

**Files:**
- Modify: `agent/Dockerfile` (ensure `rca/` is COPY'd) + `terraform/foundation/ai.tf` (pass `RCA_ORCHESTRATOR_ENABLED` env to the runtime, default `"false"`, behind the existing agentcore gate) + `agent/requirements.txt` (psycopg2 already present).
- Test: N/A (infra) — verify by `python -m pytest agent/rca/ -v` (all green) + `terraform -chdir=terraform/foundation validate`.

**Interfaces:**
- Produces: the agent image contains `agent/rca/*` and `agent/rca_orchestrator.py`; the runtime receives `RCA_ORCHESTRATOR_ENABLED` (default false). No behavior change until flipped.

- [ ] **Step 1:** Add `COPY rca/ ./rca/` and `COPY rca_orchestrator.py .` to `agent/Dockerfile` (after the existing COPYs).
- [ ] **Step 2:** In `ai.tf`, add `RCA_ORCHESTRATOR_ENABLED = "false"` to the runtime container env (under the existing `agentcore_enabled` gate). **No `-auto-approve`; controller runs `apply tfplan`.**
- [ ] **Step 3:** Run `cd agent && python -m pytest rca/ -v` (all PASS) and `terraform -chdir=terraform/foundation validate`.
- [ ] **Step 4: Commit** — `git add agent/Dockerfile terraform/foundation/ai.tf && git commit -m "chore(rca): COPY rca module + RCA_ORCHESTRATOR_ENABLED env (default off)"`

---

## Self-Review notes
- **Spec coverage:** alert→webhook entry (Task 8) · EoG deterministic controller (Task 4) · bounded gateway tools, no get_all_* (Task 5) · 1-hop graph (Task 1) · anonymization fail-closed (Tasks 2–3) · AgentCore "+1" over gateways, payload.mode (Task 7) · read-only persistence, no write-back (Task 6) · UI (Task 9) · flag-OFF (Tasks 7,10).
- **Deferred (NOT this slice, by design):** multi-hop belief-propagation, Neptune (ADR-043, S2), S2 generalized detection, exemplar/metric tools breadth, multi-gateway beyond ops+monitoring, k8sgpt-source path, ADR-034 write-back, second runtime.
- **Confirm-before-implement literals (flagged in-task):** `MCPClient.call_tool_sync` method name + the ops topology tool name (`get_topology`) + loki tool name as provisioned — verify against `agent/agent.py` and the provisioned gateway targets (Task 5 Step-2 note). The dispatcher→AgentCore-invoke path for `mode=rca` (Task 8) — verify `scripts/v2/workers/dispatcher.py` incident_stage branch + how an AgentCore runtime invoke is issued for an incident stage.
