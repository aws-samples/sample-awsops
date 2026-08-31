# 07. EKS Onboarding — v2 Reference

## Purpose / 목적

**EN** — Grant the v2 web task role read-only access to host-account EKS clusters so the dashboard can later query Kubernetes resources. Onboarding discovers clusters interactively, validates each cluster's auth mode, and provisions an EKS Access Entry + View policy through Terraform. Cluster connection info (endpoint/CA) is exposed as a Terraform output for P3 to consume.

**KO** — v2 웹 태스크 역할에 호스트 계정 EKS 클러스터에 대한 읽기 전용 접근을 부여하여, 대시보드가 추후 Kubernetes 리소스를 조회할 수 있게 한다. 온보딩은 클러스터를 대화식으로 탐색하고 각 클러스터의 인증 모드를 검증한 뒤, Terraform으로 EKS Access Entry + View 정책을 프로비저닝한다. 클러스터 연결 정보(endpoint/CA)는 P3가 소비하도록 Terraform output으로 노출된다.

## Current design / 현행 설계

**EN**
- `scripts/v2/configure.mjs` offers an **EKS multi-select** during `make configure`:
  - Discovers clusters via `eks:ListClusters` (`listEksClusters`).
  - Runs an **auth-mode preflight** per cluster (`eksAuthMode`): clusters in `API`/`API_AND_CONFIG_MAP` are selectable; `CONFIG_MAP`-only clusters are listed in a handoff message (Access Entry unavailable).
  - Writes the selection as `onboard_eks_clusters = [...]` into `terraform.tfvars`.
- `terraform/foundation/eks.tf` iterates that list with `for_each = toset(var.onboard_eks_clusters)`:
  - `aws_eks_access_entry.web` — registers the web task role (`awsops-v2-task`) as a `STANDARD` principal on each cluster.
  - `aws_eks_access_policy_association.web_view` — binds the AWS-managed **`AmazonEKSViewPolicy`** at **cluster** scope.
  - `aws_iam_role_policy.task_eks` — grants the task role `eks:DescribeCluster` / `eks:ListClusters` / `eks:DescribeAccessEntry` (created only when the list is non-empty).
  - `data.aws_eks_cluster.onboard` + `output "onboarded_eks_clusters"` — exposes endpoint / ARN / CA data per cluster for P3 kubeconfig registration.
- **Host-account only.** Empty default list → `for_each` over an empty set creates nothing (safe no-op until a cluster is selected).

**KO**
- `scripts/v2/configure.mjs`는 `make configure` 중 **EKS 멀티 선택**을 제공한다:
  - `eks:ListClusters`로 클러스터 탐색.
  - 클러스터별 **인증 모드 사전 점검**: `API`/`API_AND_CONFIG_MAP`은 선택 가능, `CONFIG_MAP` 전용은 핸드오프 목록으로 안내(Access Entry 불가).
  - 선택 결과를 `onboard_eks_clusters = [...]`로 `terraform.tfvars`에 기록.
- `terraform/foundation/eks.tf`는 `for_each`로 해당 목록을 순회: Access Entry + 클러스터 스코프 View 정책 + 태스크 역할 IAM + 클러스터 연결 정보 output.
- **호스트 계정 전용.** 기본값이 빈 목록이면 아무 리소스도 생성되지 않는다(안전한 no-op).

## Decisions (ADRs) / 결정

**EN** — No dedicated ADR exists for EKS onboarding (a documentation gap). Onboarding inherits the multi-account model of [ADR-011](../../decisions/011-multi-account.md), but here it is **host-account only** — cross-account assume-role onboarding is intentionally excluded. kubeconfig auto-registration and the Kubernetes query UI are **deferred to P3**.

**KO** — EKS 온보딩 전용 ADR은 없다(문서 공백). [ADR-011](../../decisions/011-multi-account.md)의 멀티 계정 모델을 계승하지만 여기서는 **호스트 계정 전용**이며, 교차 계정 assume-role 온보딩은 의도적으로 제외했다. kubeconfig 자동 등록과 Kubernetes 조회 UI는 **P3로 연기**되었다.

## Key files / 핵심 파일

| File / 파일 | Role / 역할 |
|---|---|
| `terraform/foundation/eks.tf` | `onboard_eks_clusters` var, Access Entry, View policy association, task-role EKS IAM, `onboarded_eks_clusters` output |
| `scripts/v2/configure.mjs` | EKS discovery (`listEksClusters`) + auth-mode preflight (`eksAuthMode`) + multi-select → tfvars |

## Status / 상태

**EN** — **P1e ✅ done.** `fsi-demo-cluster` onboarded and verified:
- Access entry principal = `awsops-v2-task`.
- `AmazonEKSViewPolicy` associated at cluster scope.
- `onboarded_eks_clusters` output returns endpoint / ARN / CA.
- Host clusters are all in `API_AND_CONFIG_MAP` auth mode, so Access Entry works without flipping any cluster.

**Out-of-band expansion (live drift note, confirmed 2026-08-11):** `onboard_eks_clusters` only enumerates the Terraform-managed path. An operator can *also* onboard a cluster by running `create-access-entry` + `associate-access-policy` (view-only policies only) directly via the AWS CLI, outside Terraform. `eks_auto_register_enabled` (live: true) wires a read-only, CloudTrail-driven Lambda (`awsops-v2-eks-auto-register`, `scripts/v2/eks/auto_register.py`) that observes those calls and reflects the cluster into Aurora `eks_registrations` — the BFF's actual allow-list is `ONBOARDED_EKS_CLUSTERS` (env, Terraform) ∪ `eks_registrations` (runtime), not `onboard_eks_clusters` alone. As of 2026-08-11 the live task role (`awsops-v2-task`) holds Access Entries on **4** clusters — `fsi-demo-cluster` (Terraform) plus `mall-apne2-az-a`, `mall-apne2-az-c`, `mall-apne2-mgmt` (out-of-band, auto-registered 2026-06-11 – 2026-06-17). Ground truth: `aws eks list-access-entries --cluster-name <name>` + the `eks_registrations` table, not this doc's cluster count.

**KO** — **P1e ✅ 완료.** `fsi-demo-cluster` 온보딩 및 검증 완료(access entry = `awsops-v2-task`, View 정책, endpoint/ARN/CA output). 호스트 클러스터는 모두 `API_AND_CONFIG_MAP` 모드라 클러스터 전환 없이 Access Entry가 동작한다.

**Out-of-band 확장(라이브 드리프트 기록, 2026-08-11 확인):** `onboard_eks_clusters`는 Terraform 관리 경로만 나열한다. 운영자가 Terraform 밖에서 CLI로 `create-access-entry` + `associate-access-policy`(view-only 정책 한정)를 직접 실행해 클러스터를 추가로 온보딩할 수도 있다. `eks_auto_register_enabled`(라이브: true)가 그 CloudTrail 이벤트를 관찰하는 read-only Lambda(`awsops-v2-eks-auto-register`, `scripts/v2/eks/auto_register.py`)를 연결해두어, 그 클러스터를 Aurora `eks_registrations`에 반영한다 — BFF의 실제 allow-list는 `ONBOARDED_EKS_CLUSTERS`(env, Terraform) ∪ `eks_registrations`(runtime)이며 `onboard_eks_clusters` 단독이 아니다. 2026-08-11 기준 라이브 task role(`awsops-v2-task`)은 **4개** 클러스터에 Access Entry를 보유 — `fsi-demo-cluster`(Terraform) + `mall-apne2-az-a`/`mall-apne2-az-c`/`mall-apne2-mgmt`(out-of-band, 2026-06-11~06-17 자동등록). 사실 확인은 이 문서의 클러스터 수가 아니라 `aws eks list-access-entries --cluster-name <name>` + `eks_registrations` 테이블로.

## Learnings & gotchas / 학습·함정

**EN**
- **OpenCost = read-only out-of-band install bundle.** The UI generates a bundle the operator runs themselves; AWS-resource mutation stays **FROZEN (ADR-005, do-not-enable)** — NOT an in-app mutating action.
- **Multi-account is excluded** — host account only for P1e.
- **The web code consumes the `onboarded_eks_clusters` output in P3, not here.** P1e provisions access + exposes connection info; kubeconfig build and queries are downstream.
- `for_each` over the empty default list creates zero resources, so merging `eks.tf` is a safe no-op until a cluster is selected in tfvars.
- The correct CA attribute is `data.aws_eks_cluster.onboard[*].certificate_authority[0].data`.

**KO**
- **OpenCost = read-only out-of-band 설치 번들.** UI가 번들을 생성하고 운영자가 직접 실행; AWS-리소스 변경은 **FROZEN (ADR-005, do-not-enable)** — 인앱 변경 액션 아님.
- **멀티 계정 제외** — P1e는 호스트 계정 전용.
- **웹 코드는 P3에서 `onboarded_eks_clusters` output을 소비**한다. P1e는 접근 권한 부여 + 연결 정보 노출까지만 담당하고, kubeconfig 생성·조회는 후속 단계다.
- 빈 기본 목록에 대한 `for_each`는 리소스를 생성하지 않으므로 `eks.tf` 병합은 안전한 no-op이다.
- CA 속성은 `certificate_authority[0].data`가 정확하다.

## Source / 출처

- `docs/history/archive/2026-05-31-awsops-v2-p1e-eks-onboarding.md` (the P1e plan, after archival)
