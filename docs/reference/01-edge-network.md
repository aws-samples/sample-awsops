# 01. Edge & Networking — v2 Reference

> AWSops v2 foundation spine. Consolidated from the P1a execution plan and the live
> `terraform/foundation` module. 출처는 문서 하단 [Source](#source--출처) 참조.

## Purpose / 목적

The **private edge** of AWSops v2: the network path that carries every viewer request from
the internet to the web container, with **no internet-facing load balancer** anywhere on the
path. The whole spine is provisioned by Terraform with remote state, so it is reproducible and
destroyable as a single unit.

목표: 완전히 사설인 엣지 경로(CloudFront → VPC Origin → internal ALB → Fargate)를 Terraform으로
세우고, 헬스 엔드포인트와 SSE 스트림이 end-to-end로 동작함을 증명한다. P1a에서 이 spine은
일회용 Node 컨테이너로 검증되고, P1d에서 실제 Next.js 이미지로 교체된다.

## Current design / 현행 설계

End-to-end request path:

```
viewer ──TLS──> CloudFront ──TLS (https-only:443)──> VPC Origin
       ──HTTPS:443 (regional ACM cert)──> internal ALB ──HTTP──> Fargate awsops-v2-web:3000
```

- **CloudFront → ALB is TLS end-to-end.** The VPC Origin uses
  `origin_protocol_policy = "https-only"` (`http_port 80`, `https_port 443`,
  `origin_ssl_protocols = ["TLSv1.2"]`). The distribution origin `domain_name` is set to the
  **public FQDN** (not the ALB DNS name) so the TLS SNI matches the ALB's regional ACM cert.
- **Internal ALB only — no public ALB.** `aws_lb.internal` is `internal = true` with an
  **HTTPS:443 listener** backed by a **regional ACM certificate** (managed with shared
  validation CNAMEs, or an already-issued external certificate as described below).
  The ALB forwards to a `target_type = "ip"`
  target group on the Fargate container port (`3000`), health check path `/api/health`.
- **ALB security group** allows **443 only from the CloudFront managed SG
  `CloudFront-VPCOrigins-Service-SG`**, looked up via a plural `data "aws_security_groups"` with
  two filters: `group-name` + `vpc-id` (= `local.vpc_id`). The earlier broad VPC-CIDR :443 rule
  was dropped — a VPC-CIDR-only rule causes a persistent 504. **Fresh-VPC bootstrap:** that
  managed SG only appears once the first VPC origin in the VPC exists (this stack's own), so on a
  brand-new VPC the lookup is empty and the ALB SG has **no 443 ingress at all** (a `check` block
  warns; deliberately no CIDR fallback — it would serve no CloudFront traffic and only open an
  unauthenticated in-VPC path); the next plan/apply after the VPC origin exists adds the
  managed-SG rule in place. Bootstrap mode is a plan-able state, not a serving state.
- **VPC: new-or-reuse via `create_network`.** `true` (default) builds a new VPC
  (`10.20.0.0/16` default), 2 public + 2 private subnets, IGW, NAT, route tables. `false`
  reuses an existing VPC (`existing_vpc_id` + `existing_private_subnet_ids`, no `ec2:Create*`,
  no new NAT cost). Downstream resources reference `local.vpc_id` / `local.private_subnet_ids`
  / `local.vpc_cidr` to absorb the branch.
  Live: reused mgmt-vpc `vpc-0123456789abcdef0`, `10.254.0.0/16`.
- **Remote state:** partial S3 backend (`backend "s3" {}`), bucket `awsops-v2-tfstate`, key
  `foundation/terraform.tfstate`, `use_lockfile = true` (S3-native locking, **no DynamoDB**),
  `encrypt = true`. Injected at init via `backend.hcl`.
- **Toolchain:** Terraform `>= 1.15`, AWS provider `~> 6.0` (CloudFront VPC Origin needs
  5.73+/6.x), dual-region providers (`ap-northeast-2` + `aws.use1` for the CloudFront cert).
- **Caching:** default behavior uses `Managed-CachingDisabled` + `Managed-AllViewer`
  (SSE/dynamic); `/_next/static/*` uses `Managed-CachingOptimized`.

### Certificate ownership and deferred DNS / 인증서 소유권·DNS 보류

| Input | Default | Effect |
|---|---|---|
| `publish_service_dns` | `true` | Own service A aliases; false omits them and would delete existing aliases |
| `existing_cf_certificate_arn` | `null` | null retains Terraform ACM ownership; an external ARN reuses an issued `us-east-1` certificate covering every CloudFront alias |
| `existing_alb_certificate_arn` | `null` | null retains Terraform ACM ownership; an external ARN reuses an issued stack-Region certificate covering the origin hostname |
| `ci_domain_rollout` | `false` | CI metadata only; saved-plan true pins dev/full DNS scope to configured service A/ACM CNAME owners in the selected zone |

`local.certificate_validation_options` takes tokens from the managed CloudFront certificate,
or from the managed ALB certificate if only CloudFront is external. Both external means no
managed validation records or waiters. Both null retains the existing shared CNAME owner.
`publish_service_dns=false` alone does **not** prohibit certificate-validation writes.

When DNS changes are prohibited, the dispatch preflight reads Terraform state without
refreshing or locking it. It validates each existing managed certificate but keeps the
corresponding input as JSON **null**, never externalizes its ARN, and preserves existing
service alias publication. Otherwise it prefers the attached external certificate, excludes
all certificates managed in this state (including child modules) from external selection, and verifies
account, Region, SAN coverage, trusted CA chain and more than 24 hours of remaining validity.
A new/deferred stack keeps service aliases absent. Planned DNS creates, updates, replacements
and deletes are blocked, including validation CNAMEs and **all `aws_service_discovery*`**
resources. First-time Steampipe/Cloud Map DNS is therefore unavailable under this prohibition.

CloudFront supports RSA 2048/3072/4096 and ECDSA P-256/P-384 for this preflight; its deliberate
RSA minimum is 2048 even though AWS also supports 1024. See the
[official certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)
and [ACM key algorithm enum](https://docs.aws.amazon.com/acm/latest/APIReference/API_CertificateDetail.html).
External certificate owners must monitor expiry and arrange renewal/reimport before expiry.
Existing ACM validation records must remain intact; CI never creates validation records as a
workaround for an unavailable certificate in no-DNS mode.

The serving topology and Lambda@Edge authentication remain intact (ADR-002). Before service
DNS publication, CI and `make deploy` smoke tests connect to the CloudFront domain while
requesting the service URL with curl `--connect-to`, preserving Host, SNI and TLS verification.
Public users still need the service DNS record to resolve normally. Use explicit
same-branch/SHA dispatch plans throughout this lifecycle; PR/push plans are advisory.
Any later cutover follows ADR-016 and requires separate DNS authorization; see
[the deployment runbook §5](../runbooks/dev-repo-setup.md).

Dev PR/push plans preserve ownership/publication from state without live ACM/SAN/trust
validation. Advisory DNS allowance only reports changes; those plans can never be applied.
Repo-level `DOMAIN_NAME_DEV` / `HOSTED_ZONE_NAME_DEV` override dev console and plan together
through gitignored `ci-domain.auto.tfvars.json` (tracked copies are rejected).
`CERTIFICATE_MODE_DEV=managed` selects null external inputs and rejects conflicting ARNs.
Every authorized [domain-stage plan](../runbooks/dev-domain-rollout.md) sets
`domain_rollout=true`; apply reads its saved `ci_domain_rollout` marker, never an apply-time
toggle. Ordinary full plans retain broad DNS behavior only with explicit DNS permission.
Published old-domain retirement needs a separate expressly authorized old-configuration plan.
Public summaries include certificate suffixes/publication, change counts/addresses and,
for active rollout, public zone name/ID/NS. The explicit full-dev readiness summary additionally
publishes fixed scope/presence checks and a configured collector hash, never private values.
These summaries do not publish raw state/plan or full ARNs/account IDs.

DNS 금지 dispatch는 상태를 읽어 Terraform 관리 인증서를 JSON null로 유지하고 기존 서비스
별칭을 보존합니다. 외부 인증서는 기존 연결을 우선하며 이 상태의 관리 인증서는 검색에서
제외합니다. 검증 CNAME과 사설 Cloud Map을 포함한 모든 DNS 변경은 차단됩니다.
인증서가 없으면 배포를 중단하며, 외부 인증서 소유자가 만료 감시·갱신을 담당합니다.
서비스 DNS 게시 전 스모크는 CloudFront 연결만 우회하고 Host·SNI·TLS 인증은 유지합니다.
일반 사용자의 접근에는 DNS가 필요하며, 이후 전환은 별도 승인을 전제로 ADR-016을 따릅니다.
dev PR/push는 상태의 소유권·게시를 보존하고 실시간 인증서 검증 없이 DNS 변경을 보고하는
참고 계획이며 적용할 수 없습니다. 저장소 이름 변수는 console/plan에 함께 반영되며
`managed` 모드는 외부 ARN 충돌을 거부합니다. 활성 dev/full 전환은 plan에서
`domain_rollout=true`를 저장하고 apply는 그 메타데이터만 사용합니다. 일반 full DNS 변경도
명시적 승인이 필요하며 이전 도메인 폐기는 이전 설정의 별도 승인 계획으로만 진행합니다.
공개 요약에 제한된 존 이름·ID·NS를 포함하되 전체 ARN·계정·원본 상태/계획은 제외합니다.

## Decisions (ADRs) / 결정

- [ADR-001 — v2 foundation (ECS Fargate + Aurora split)](../decisions/001-v2-foundation.md):
  adopts the v2 topology — web on **ECS Fargate** (ARM64) behind an internal ALB, replacing the
  v1 single-EC2 host. This reference covers the edge/ALB/network half of that topology.
- [ADR-014 — cross-cutting (CloudFront CachingDisabled)](../decisions/014-cross-cutting-cache-i18n-cdn.md):
  the default cache behavior runs with `CACHING_DISABLED` so dynamic dashboard responses and
  SSE streams are never cached/buffered at the edge.
- ADR-002 preserves edge authentication and private HTTPS origin boundaries; ADR-016 governs
  alias/certificate cutover. These deployment controls grant no new DNS or runtime-mutation
  exception. ADR bodies remain in the private upstream repository.

## Key files / 핵심 파일

| File | Role |
|---|---|
| `terraform/foundation/edge.tf` | ACM (us-east-1) + DNS validation, CloudFront VPC Origin (`https-only`), distribution, Route53 alias |
| `terraform/foundation/network.tf` | VPC/subnets/IGW/NAT/routes (conditional on `create_network`) + `local.vpc_id`/`private_subnet_ids`/`vpc_cidr` |
| `terraform/foundation/providers.tf` | Dual-region providers — `ap-northeast-2` + `aws.use1` (us-east-1) for the CloudFront cert |
| `terraform/foundation/backend.tf` | Partial S3 backend (`backend "s3" {}`), TF `>= 1.15`, provider `~> 6.0` |
| `backend.hcl` | Generated by `make configure`; supplies bucket/key/region/`use_lockfile` at init (gitignored) |
| `scripts/v2/ci_dns_policy.py` | State-aware certificate selection, typed tfvars overrides and all-DNS plan gate |
| `scripts/v2/ci_dev_domain.py` | Dev overrides, immutable plan rollout marker and scoped public-zone/record checks |
| `scripts/v2/ci_plan_context.py` | Successful explicit dispatch, repository/branch/SHA provenance for saved-plan apply |
| `scripts/v2/ci_plan_inspect.py`, `scripts/v2/ci_failure_diagnostics.py` | Authenticated private inspection and bounded encrypted failure recovery; no plaintext staging during capture/sealing, and owned ciphertext cleanup only after confirmed upload success |
| `scripts/v2/ci_tf_assets.py`, `scripts/v2/ci/pg8000-requirements.txt` | Locked layer preparation and private plan-bound assets; caller owns encryption/cleanup / 레이어 준비·계획 결합 asset, 호출 측 암호화·정리 |
| `scripts/v2/test_ci_tf_assets.py` | Saved-plan artifact and local targeted-plan regressions / 저장 artifact·로컬 타깃 계획 회귀 검사 |
| `terraform/foundation/tests/dns_deferred.tftest.hcl` | Offline mocked plans; Python CI tests cover managed/external state roundtrips |

Also relevant: `terraform/foundation/workload.tf` (internal ALB, HTTPS:443 listener, ALB SG +
`CloudFront-VPCOrigins-Service-SG` lookup, ECS service/task) — the ALB-side counterpart to `edge.tf`.

## Status / 상태

**P1a ✅ GREEN.** `https://awsops-v2.example.com` → HTTP **200** + SSE streaming at **1 event/s**,
in account `123456789012` (mgmt-vpc reuse). The negative test confirms the ALB is `internal` and
unreachable directly from outside the VPC.

## Learnings & gotchas / 학습·함정

The 504 → 200 root cause (reuse-critical — re-read before changing the edge):

1. **CF → ALB must be TLS end-to-end.** Set the VPC Origin `origin_protocol_policy = https-only`
   **and** the distribution origin `domain_name` to the **public FQDN** (this drives the TLS SNI
   to match the ALB cert). The ALB needs an **HTTPS:443 listener + a regional ACM cert**,
   managed through shared validation CNAMEs or supplied as an issued external certificate.
2. **ALB SG must allow 443 from `CloudFront-VPCOrigins-Service-SG`.** A broad VPC-CIDR-only :443
   ingress rule produces a **persistent 504** — CloudFront's VPC Origin ENIs are reached via that
   managed SG, not by CIDR. Reference it with a plural `data "aws_security_groups"` lookup filtered
   on `group-name` + `vpc-id` — plural, because on a brand-new VPC the SG does not exist until this
   stack's own VPC origin is created (the singular lookup hard-fails every plan); the ALB SG has no
   443 ingress until then, and a second apply adds the managed-SG rule.
3. **A VPC Origin's protocol cannot update in-place** while attached to a distribution (409
   `CannotUpdateEntityWhileInUse`). Use `lifecycle { create_before_destroy = true }` + a **distinct
   name** (e.g. `*-alb-origin-tls`) + a `terraform apply -replace` so Terraform stands up the new
   `https-only` origin, repoints the distribution, then deletes the old one.

Also: SSE must not buffer at the edge — keep `CACHING_DISABLED` on the dynamic behavior (ADR-028)
and ensure origin read timeout exceeds the event interval. The real app (P1d) must emit an SSE
heartbeat at least every ~20s.

## Source / 출처

- Primary: `docs/history/archive/2026-05-30-awsops-v2-p1a-foundation-edge-spine.md`
  (the P1a execution plan; will be moved to `archive/` in a later consolidation step).
- Live module: `terraform/foundation/edge.tf`, `terraform/foundation/network.tf`, `terraform/foundation/workload.tf`, `terraform/foundation/providers.tf`, `terraform/foundation/backend.tf`.
- Root `CLAUDE.md` — "아키텍처 (v2)" and "알려진 이슈 / 학습" sections.
