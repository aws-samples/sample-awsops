# K8sGPT Operator Install (Out-of-Band) / K8sGPT 오퍼레이터 설치 (아웃-오브-밴드)

> 🛑 **OPERATOR ACTION — requires cluster-admin on the target EKS cluster. AWSops does NOT execute any step here (mirrors ADR-005's out-of-band install precedent — "KEDA install is out-of-band").**
> 🛑 **오퍼레이터 작업 — 대상 EKS 클러스터의 cluster-admin 권한이 필요합니다. 이 런북의 어떤 단계도 AWSops가 실행하지 않습니다 (ADR-005의 아웃-오브-밴드 설치 선례 — "KEDA 설치는 아웃-오브-밴드"와 동일 원칙).**

AWSops only **READS** the `Result` CRDs that the K8sGPT operator produces (HTTP GET only via the P1e `awsops-v2-task` Access Entry token — **no write verb is ever issued against the cluster API**). The operator install, its RBAC, the `--fix`-off configuration, and binding the Result-CRD read RBAC to `awsops-v2-task` are **all** cluster-admin / operator actions documented here. None of them run from AWSops.

AWSops는 K8sGPT 오퍼레이터가 생성한 `Result` CRD를 **읽기만** 합니다(P1e `awsops-v2-task` Access Entry 토큰으로 HTTP GET만 — **클러스터 API에 대한 쓰기 동사는 절대 발행하지 않음**). 오퍼레이터 설치, RBAC, `--fix` 비활성 설정, Result-CRD 읽기 RBAC를 `awsops-v2-task`에 바인딩하는 작업은 **모두** 여기에 문서화된 cluster-admin/오퍼레이터 작업이며, 어느 것도 AWSops에서 실행되지 않습니다.

---

## 증상 / When to use this runbook

- The AWSops EKS page "Diagnosis (K8sGPT)" panel shows **"operator not detected"** (empty) even though `k8sgpt_enabled = true` and the cluster is onboarded.
- You are an EKS cluster operator who needs to stand up the **deterministic-only** K8sGPT operator so AWSops can consume its findings.

- `k8sgpt_enabled = true` 이고 클러스터가 온보딩되었는데도 AWSops EKS 페이지의 "Diagnosis (K8sGPT)" 패널이 **"operator not detected"**(비어 있음)로 표시될 때.
- AWSops가 진단 결과를 소비할 수 있도록 **deterministic-only** K8sGPT 오퍼레이터를 세워야 하는 EKS 클러스터 오퍼레이터일 때.

## 원인 후보 / Diagnosis

| 후보 / Candidate | 확인 / Check |
|---|---|
| 오퍼레이터 미설치 / Operator not installed | `kubectl get pods -n k8sgpt-operator-system` 에 파드 없음 |
| Result CRD 미생성 / No Result CRDs | `kubectl get results.result.core.k8sgpt.ai -A` 가 비어 있음 |
| 읽기 RBAC 미바인딩 / Read RBAC not bound | `awsops-k8sgpt-result-reader` ClusterRole/Binding 부재 → AWSops 토큰이 `get/list` 불가 (403) |
| 버전 불일치 / Version skew | 설치된 오퍼레이터/CRD 세대가 `ADAPTER_K8SGPT_VERSION`(`web/lib/k8sgpt-adapter.ts`)과 불일치 |

---

## 조치 / Action — deterministic-only operator install

The operator MUST be installed **deterministic-only** per ADR-006 (H0 refinement + the deterministic-only / version-pin rules):
- **NO `ai.backend` / NO `--explain`** — K8sGPT runs deterministic analyzers only; all LLM narration is AWSops-side (AgentCore Haiku 4.5, in-region). K8sGPT v0.4.33's `amazonbedrock` backend has a stale model+region allow-list (no Haiku 4.5, no `ap-northeast-2`), so it is deliberately not used.
- **`--anonymize`** (`k8sgpt.deployAnonymized=true`) as defense-in-depth (Rule 5). Note: anonymize does **not** mask Event/Describe/ContainerStatus/ConfigMap values / env-var names / image URIs.
- **`--fix` OFF at the config level** (Rule 9 — defense-in-depth, not merely "not called"): no remediation block in the `K8sGPT` CR.
- **Pinned operator version** (Rule 7 — the version is part of the schema-compat contract).

오퍼레이터는 ADR-006(H0 정제 + deterministic-only/버전-핀 규칙)에 따라 반드시 **deterministic-only** 로 설치합니다:
- **`ai.backend` 없음 / `--explain` 없음** — K8sGPT는 결정론적 analyzer만 실행하고, 모든 LLM 서술은 AWSops 측(AgentCore Haiku 4.5, in-region)에서 수행합니다. K8sGPT v0.4.33의 `amazonbedrock` 백엔드는 모델/리전 allow-list가 오래되어(Haiku 4.5 없음, `ap-northeast-2` 없음) 의도적으로 사용하지 않습니다.
- **`--anonymize`** (`k8sgpt.deployAnonymized=true`) — 다층 방어(Rule 5). 단, anonymize는 Event/Describe/ContainerStatus/ConfigMap 값 / 환경변수 이름 / 이미지 URI를 마스킹하지 **않습니다**.
- **`--fix` 설정 레벨 비활성** (Rule 9 — "호출 안 함"이 아니라 구성 자체에서 차단): `K8sGPT` CR에 remediation 블록 없음.
- **버전 핀**(Rule 7 — 버전은 스키마 호환 계약의 일부).

> 🔒 **Rule 7 — keep versions in sync.** The pinned operator/CRD generation here (`PINNED_OPERATOR_VERSION` / `PINNED_K8SGPT_IMAGE`) **MUST match** `ADAPTER_K8SGPT_VERSION` in `web/lib/k8sgpt-adapter.ts` (currently `0.4.x/result.core.k8sgpt.ai/v1`). Bumping one without the other breaks the schema-compat contract and the AWSops adapter must be re-pinned + re-tested.
> 🔒 **Rule 7 — 버전 동기화 유지.** 여기서 핀한 오퍼레이터/CRD 세대(`PINNED_OPERATOR_VERSION` / `PINNED_K8SGPT_IMAGE`)는 `web/lib/k8sgpt-adapter.ts`의 `ADAPTER_K8SGPT_VERSION`(현재 `0.4.x/result.core.k8sgpt.ai/v1`)과 **반드시 일치**해야 합니다. 한쪽만 올리면 스키마 호환 계약이 깨지므로 AWSops 어댑터를 다시 핀하고 재테스트해야 합니다.

```bash
# 1) Pin the operator version (Rule 7 — the version is part of the schema-compat contract).
#    ADAPTER_K8SGPT_VERSION in web/lib/k8sgpt-adapter.ts MUST match this CRD generation.
helm repo add k8sgpt https://charts.k8sgpt.ai/
helm repo update

# 2) Install deterministic-only: NO ai.backend, NO --explain (H0 (b) fails; narration is AWSops-side).
#    --anonymize as defense-in-depth (Rule 5; note it does NOT mask Event/Describe/env-var/image values).
#    --fix OFF at config level (Rule 9 — defense-in-depth, not merely "not called").
helm upgrade --install k8sgpt-operator k8sgpt/k8sgpt-operator \
  --namespace k8sgpt-operator-system --create-namespace \
  --version <PINNED_OPERATOR_VERSION> \
  --set k8sgpt.deployAnonymized=true

# 3) Apply a K8sGPT CR with NO ai/backend block (deterministic analyzers only), --fix disabled:
cat <<'YAML' | kubectl apply -f -
apiVersion: core.k8sgpt.ai/v1alpha1
kind: K8sGPT
metadata: { name: k8sgpt-deterministic, namespace: k8sgpt-operator-system }
spec:
  version: <PINNED_K8SGPT_IMAGE>
  noCache: false
  # NO `ai:` block → deterministic analyzers only → Result CRDs, no LLM. (H0 refinement)
  # NO remediation / --fix.
YAML
```

---

## 조치 / Action — read-only RBAC + bind to the AWSops task principal

**Read-only RBAC + bind to the AWSops task principal (Rules 1/9 — out-of-band):**
- The operator runs with a **read-only ClusterRole**: `get/list/watch` only; `create/update/patch/delete` explicitly absent. (`--fix`/auto-remediation disabled at the config level.)
- Bind a **read-only ClusterRole for the `results.result.core.k8sgpt.ai` CRD** to the IAM principal that the **P1e Access Entry** maps for `awsops-v2-task`, so the AWSops BFF's presigned-STS token can `get/list` `Result` objects. The AWSops `awsops-v2-task` role is registered as a STANDARD Access Entry with the AWS-managed `AmazonEKSViewPolicy` at cluster scope (see `terraform/foundation/eks.tf`); this binding grants the additional Result-CRD read. Example (the operator applies it):

**읽기 전용 RBAC + AWSops 태스크 principal 바인딩 (Rule 1/9 — 아웃-오브-밴드):**
- 오퍼레이터는 **읽기 전용 ClusterRole**(`get/list/watch`만; `create/update/patch/delete` 명시적 부재)로 동작합니다. (`--fix`/자동 remediation은 설정 레벨에서 비활성.)
- **`results.result.core.k8sgpt.ai` CRD에 대한 읽기 전용 ClusterRole**을 **P1e Access Entry**가 `awsops-v2-task`에 매핑하는 IAM principal에 바인딩하면, AWSops BFF의 presigned-STS 토큰이 `Result` 객체를 `get/list`할 수 있습니다. AWSops의 `awsops-v2-task` 역할은 STANDARD Access Entry로 등록되어 클러스터 스코프에서 AWS 관리형 `AmazonEKSViewPolicy`를 받습니다(`terraform/foundation/eks.tf` 참조). 이 바인딩은 추가로 Result-CRD 읽기 권한을 부여합니다. 예시(오퍼레이터가 적용):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: awsops-k8sgpt-result-reader }
rules:
  - apiGroups: ["result.core.k8sgpt.ai"]
    resources: ["results"]
    verbs: ["get","list","watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: awsops-k8sgpt-result-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: awsops-k8sgpt-result-reader }
subjects:
  # Group/user that the P1e Access Entry maps awsops-v2-task to (see aws-auth / Access Entry).
  - apiGroup: rbac.authorization.k8s.io
    kind: Group
    name: <THE_GROUP_THE_P1E_ACCESS_ENTRY_GRANTS>
```

> ℹ️ The placeholders `<PINNED_OPERATOR_VERSION>`, `<PINNED_K8SGPT_IMAGE>`, and `<THE_GROUP_THE_P1E_ACCESS_ENTRY_GRANTS>` are filled in by the operator at install time (the last is whatever group the cluster's Access Entry maps the `awsops-v2-task` role to).
> ℹ️ 플레이스홀더 `<PINNED_OPERATOR_VERSION>`, `<PINNED_K8SGPT_IMAGE>`, `<THE_GROUP_THE_P1E_ACCESS_ENTRY_GRANTS>`는 설치 시점에 오퍼레이터가 채웁니다(마지막 값은 클러스터의 Access Entry가 `awsops-v2-task` 역할을 매핑하는 그룹).

---

## 검증 / Validation the operator runs (NOT AWSops)

```bash
kubectl get results.result.core.k8sgpt.ai -A          # Result CRDs flowing
kubectl get results.result.core.k8sgpt.ai -A -o json | jq '.items[0]'   # kind,name,error,details,parentObject
```

When this returns Results **AND** the `awsops-k8sgpt-result-reader` binding is live, the AWSops-side route (flag on) can read them. Until then, the AWSops route **degrades gracefully** (empty + "operator not detected") — and when `k8sgpt_enabled = false` the route is fully dark (503) with zero cluster read.

위 명령이 Results를 반환하고 **동시에** `awsops-k8sgpt-result-reader` 바인딩이 살아 있으면, AWSops 측 라우트(플래그 ON)가 이를 읽을 수 있습니다. 그 전까지 AWSops 라우트는 **우아하게 디그레이드**됩니다(빈 결과 + "operator not detected"). `k8sgpt_enabled = false` 이면 라우트는 완전히 어둡고(503) 클러스터 읽기가 전혀 없습니다.

---

## H3a remediation seam (twice-gated, NOT auto-invoked) / H3a remediation 심

The H3a path lets a deterministic K8sGPT finding **optionally** seed the downstream incident/remediation machinery — but it is **twice-gated, admin-initiated, and produces only a PROPOSAL** (ADR-006: no auto-apply; **no cluster write ever**). The route (`/api/eks/[cluster]/k8sgpt`) does **not** call it; the seam (`raiseIncidentFromFinding` in `web/lib/k8sgpt.ts`) is invoked only from an explicit, admin-initiated "raise incident" action (future H3a UI), so a finding never autonomously creates work.

**End-to-end gated path** (every gate below must be ON for a PROPOSAL to materialize; any one OFF stops the chain harmlessly):

```
K8sGPT finding  (deterministic FACT only — the Haiku llm_explanation does NOT cross the seam, ADR-006)
  │  gate 1: k8sgpt_enabled          (web env K8SGPT_ENABLED=true; else raiseIncidentFromFinding → {decision:'disabled'})
  ▼
raiseIncidentFromFinding → triageAndCreateOrLink   (web/lib/incident.ts)
  │  gate 2: incident_lifecycle_enabled  (INCIDENT_LIFECYCLE_ENABLED=true; else → {decision:'disabled'}, no incident)
  ▼
ADR-006 incident  → incident SM (correlation / RCA stages)
  │  gate 3: rca_writeback_enabled   (ADR-006 write-back stage of the incident SM → incidents.rca)
  ▼
ADR-006 write-back  (OpsCenter / Incident Manager observability write; ALSO requires gate 4)
  │  gate 4: remediation_enabled     (ADR-005 substrate; reuses the action_catalog + per-action role)
  ▼
ADR-005 remediation PROPOSAL   (action_catalog — EVERY row enabled=false by default + per-row `enabled`
                                     + kill-switch + 4-eyes approval)  →  PROPOSAL ONLY, never auto-applied
```

The seam carries **only deterministic facts** across the boundary (ADR-006): the incident `message` is the analyzer error text and `resources` is the `eks:<cluster>/<resource>` cross-boundary anchor (ADR-006). The LLM hypothesis (`llm_explanation`) is structurally excluded from the incident record. K8sGPT itself stays deterministic-only throughout. See ADR-006, `web/lib/k8sgpt.ts` (`raiseIncidentFromFinding`), `web/lib/incident.ts`, and `terraform/foundation/{incidents,writeback,remediation}.tf`.

H3a 경로는 결정론적 K8sGPT 발견이 하위 인시던트/remediation 기계를 **선택적으로** 트리거할 수 있게 합니다 — 단 **이중 게이트, 관리자 수동 개시, PROPOSAL만 생성**(ADR-006: 자동 적용 없음; **클러스터 쓰기 절대 없음**). 라우트(`/api/eks/[cluster]/k8sgpt`)는 이 심을 **호출하지 않습니다**. 심(`web/lib/k8sgpt.ts`의 `raiseIncidentFromFinding`)은 관리자가 명시적으로 개시하는 "raise incident" 액션(향후 H3a UI)에서만 호출되므로, 발견이 스스로 작업을 만들지 않습니다.

**엔드-투-엔드 게이트 경로**(아래 모든 게이트가 ON이어야 PROPOSAL 생성; 하나라도 OFF면 무해하게 중단):
1. `k8sgpt_enabled`(web env `K8SGPT_ENABLED=true`; 아니면 `raiseIncidentFromFinding` → `{decision:'disabled'}`),
2. `incident_lifecycle_enabled`(`INCIDENT_LIFECYCLE_ENABLED=true`; `triageAndCreateOrLink` 내부 게이트; 아니면 인시던트 생성 안 함),
3. `rca_writeback_enabled`(ADR-006 라이트백 스테이지),
4. `remediation_enabled` + 카탈로그 각 행의 `enabled`(전부 기본 false) + kill-switch + **4-eyes 승인**.

심은 결정론적 사실만 경계를 넘깁니다(ADR-006): 인시던트 `message`는 analyzer 에러 텍스트, `resources`는 `eks:<cluster>/<resource>` 교차경계 앵커(ADR-006). LLM 가설(`llm_explanation`)은 인시던트 레코드에서 구조적으로 제외됩니다. 최종 결과는 항상 **PROPOSAL만**이며 자동 적용되지 않습니다.

---

## 관련 파일 / Related files & ADRs

- ADR-006 — `docs/decisions/006-incident-analysis-only.md` (consolidates the K8sGPT hybrid in-cluster diagnosis decision: deterministic-only rules, H0 refinement, post-acceptance deviations)
- ADR-005 — out-of-band install precedent (KEDA) + change/remediation substrate (FROZEN)
- `web/lib/k8sgpt-adapter.ts` — `ADAPTER_K8SGPT_VERSION` (must match the pinned version above)
- `web/lib/k8sgpt.ts` — gate / read / dedup / narrate (fact vs hypothesis split)
- `web/lib/eks-incluster.ts` — the read-only `eksToken`/`clusterConn`/`k8sGet` path AWSops reuses (GET only)
- `terraform/foundation/eks.tf` — P1e Access Entry + `AmazonEKSViewPolicy` for `awsops-v2-task`
- `terraform/foundation/variables.tf` — `k8sgpt_enabled` flag (default false → route dark, $0)
