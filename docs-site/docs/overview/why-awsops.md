---
sidebar_position: 0
title: 왜 AWSops인가
description: 오픈소스 AWS-Native 운영 대시보드 — Steampipe 속도, Well-Architected AI 진단, 멀티 어카운트, OpenCost EKS 비용, 외부 관측성 자연어 쿼리
---

import Screenshot from '@site/src/components/Screenshot';

# 왜 AWSops인가

> **한 줄 요약** — AWSops는 **완전 오픈소스이며 AWS 매니지드 서비스만으로 구현된** AWS + Kubernetes 운영 대시보드입니다. Steampipe로 AWS API를 빠르게 끌어와 로컬에 캐싱하고, Amazon Bedrock AgentCore로 **Well-Architected 관점의 AI 진단**까지 한 화면에서 제공합니다.

<Screenshot src="/screenshots/overview/dashboard.png" alt="AWSops 대시보드 — 단일 화면 운영 현황" />

운영자가 콘솔 수십 개를 오가며 보던 것을 **하나의 대시보드 + 하나의 AI 어시스턴트**로 합쳤습니다. 아래는 고객 환경에 도입할 때 핵심이 되는 차별점입니다.

---

## 1. 완전 오픈소스 · AWS-Native (Architecture v1)

- **오픈소스** — 전체 소스가 공개되어 있어 그대로 가져다 자사 계정에 배포하고, 내부 요구에 맞게 수정할 수 있습니다. 벤더 락인이 없습니다.
- **AWS 매니지드 서비스만으로 구현** — 별도의 외부 SaaS 의존 없이 다음으로 구성됩니다:

| 레이어 | AWS 서비스 |
|--------|-----------|
| 엣지·인증 | CloudFront + Lambda@Edge + Cognito |
| 컴퓨트 | EC2 (t4g.2xlarge, ARM64 Graviton, Private Subnet) + ALB |
| AI | **Amazon Bedrock AgentCore** (Runtime/Gateway/Code Interpreter/Memory) + Bedrock 모델 |
| IaC | AWS CDK |

- 데이터·AI·인증·엣지가 전부 AWS 안에서 끝나므로 **데이터 거버넌스·컴플라이언스가 단순**합니다.

:::tip 세션 포인트
"이 대시보드 자체가 AWS Well-Architected하게 만들어졌다" — 오픈소스라 그 구현을 직접 검증할 수 있고, 32개의 ADR(Architecture Decision Record)로 모든 설계 결정이 문서화돼 있습니다.
:::

---

## 2. Steampipe — AWS API를 빠르게 끌어와 로컬 캐싱

AWSops의 데이터 엔진은 [Steampipe](https://steampipe.io/)(내장 PostgreSQL, port 9193)입니다.

- **380+ AWS 테이블 + 60+ Kubernetes 테이블**을 SQL로 즉시 조회 — AWS API를 SQL처럼 다룹니다.
- 결과는 **node-cache로 5분 캐싱**, 대시보드 핵심 23개 쿼리는 **캐시 워머가 4분 주기로 미리 데워** 서브초 응답을 보장합니다.
- 모든 쿼리는 `src/lib/steampipe.ts`의 **pg Pool**(max 10, 8 sequential batch)을 통해서만 실행 — CLI(`steampipe query`)는 660배 느려 **코드 레벨에서 금지**(ADR-001).

→ 결과: 콘솔을 여러 번 새로고침하는 대신, **한 화면에서 전 리소스가 즉시** 뜹니다.

---

## 3. AWS 리소스 기본 대시보드 (43 페이지)

EC2·Lambda·ECS/ECR·EKS(Pod/Node/Deployment/Service/Explorer)·VPC·CloudFront·WAF·EBS·S3·RDS·DynamoDB·ElastiCache·MSK·OpenSearch 등 **43개 페이지**가 실시간 차트와 React Flow 토폴로지 맵으로 구성됩니다. MSK·RDS·ElastiCache·OpenSearch는 CloudWatch 메트릭까지 인라인 표시합니다.

---

## 4. Well-Architected AI 종합 진단

<Screenshot src="/screenshots/monitoring/ai-diagnosis.png" alt="AI 종합 진단 — Well-Architected Deep Dive 리포트" />

`/ai-diagnosis`는 Amazon Bedrock **Claude Opus 4.8**가 인프라 전반을 자동 분석해 정식 리포트를 만드는 도구입니다.

- **6개 Well-Architected 필러 스코어카드** — Executive Summary가 Operational Excellence·Security·Reliability·Performance Efficiency·Cost Optimization·Sustainability 전체에 점수를 매깁니다.
- **3개 필러 심층 분석(15섹션)** — Cost Optimization·Security·Reliability를 깊게 파고듭니다 (비용 개요/컴퓨팅/네트워크/스토리지, 유휴 리소스, 보안 현황, 네트워크·컴퓨팅·EKS·DB·MSK·스토리지 분석 등).
- **DOCX / Markdown / PDF / PPTX** 내보내기 + **주간/격주/월간 스케줄** + 완료 시 이메일 알림.

:::note 정직한 범위
현재 **심층 섹션은 Cost·Security·Reliability 3필러**에 집중돼 있고, 6필러 전체는 **Executive Summary 스코어카드** 수준으로 종합합니다. 나머지 3필러의 심층 섹션은 로드맵입니다.
:::

---

## 5. 비용 효율 (낮은 TCO)

운영 도구 자체의 비용이 낮도록 설계됐습니다:

- **단일 EC2 t4g.2xlarge (ARM64 Graviton)** — Steampipe 임베디드 PostgreSQL을 같이 돌려 **별도 관리형 DB 비용이 없습니다**.
- **AgentCore는 서버리스** — AI 런타임/게이트웨이는 호출 시에만 과금.
- Bedrock 모델은 작업에 맞게 선택 — 분류·라우팅은 **Sonnet 4.6**, 심층 진단은 **Opus 4.8**, 빠르고 저렴한 작업은 **Haiku 4.5**, 프롬프트 캐싱 적용(ADR-016).

그리고 도구가 **고객 인프라의 비용도 절감**합니다 — Cost Explorer 분석, 유휴 리소스 탐지, FinOps 권고가 진단 리포트에 포함됩니다.

<Screenshot src="/screenshots/monitoring/cost.png" alt="Cost Explorer — 서비스/리전별 비용 분석" />

---

## 6. 멀티 어카운트 (단일 창)

<Screenshot src="/screenshots/overview/accounts.png" alt="멀티 어카운트 관리" />

- Steampipe **Aggregator 패턴** — `aws` = 전 계정 통합, `aws_<id>` = 개별 계정. 상단에서 계정을 전환하거나 **전체를 합쳐서** 봅니다.
- 계정 추가/삭제는 `data/config.json`의 `accounts[]` 배열만 수정 — **코드 변경 불필요**(ADR-008). 교차 계정은 assume-role.

---

## 7. EKS 컨테이너 비용 추적 (OpenCost 기반)

<Screenshot src="/screenshots/compute/eks-container-cost.png" alt="EKS 컨테이너 비용 — OpenCost/Prometheus 기반" />

- **OpenCost + Prometheus**로 네임스페이스·Pod·노드 단위 **실사용량 기반 비용**(CPU·Memory·Storage·GPU)을 추적합니다.
- OpenCost가 없으면 **Request 기반 폴백**으로라도 추정합니다.
- ECS는 별도로 **CloudWatch Container Insights + Fargate 가격**으로 컨테이너 비용을 산출합니다.

---

## 8. 외부 관측성 통합 (7종) + 🆕 자연어 쿼리

<Screenshot src="/screenshots/monitoring/datasources.png" alt="외부 데이터소스 통합" />

AWS 데이터에 더해 기존 관측성 스택을 **데이터소스로 연동**합니다 (SSRF 방지 allowlist, ADR-011):

| 종류 | 플랫폼 |
|------|--------|
| Metrics | Prometheus · Dynatrace · Datadog |
| Logs | Loki · ClickHouse |
| Traces | Tempo · Jaeger |

**자연어 → 쿼리 자동 생성** — `/datasources/explore`에서 "결제 서비스 5xx 추이 보여줘" 같은 자연어를 입력하면 AI가 **PromQL / LogQL / TraceQL / SQL**로 변환해 실행합니다. AI 어시스턴트의 `datasource` 라우트가 외부 메트릭 질문을 자동 분류해 같은 엔진을 씁니다.

:::tip 세션 포인트
관측성 도구마다 다른 쿼리 언어를 외울 필요 없이, **자연어 한 줄**로 Prometheus든 Loki든 Jaeger든 조회 — 운영자 진입장벽을 크게 낮춥니다.
:::

---

## 코드에서 확인되는 추가 강점

| 강점 | 내용 |
|------|------|
| **AI 도구 아키텍처** | 8개 역할 기반 AgentCore Gateway · **125 MCP 도구** · 19 Lambda |
| **멀티 라우트 합성** | 분류기가 질문을 11개 라우트 중 1~3개로 분류해 **병렬 호출 후 종합**(ADR-002/025) |
| **알림 파이프라인** | 웹훅(CloudWatch SNS/Alertmanager/Grafana) → 상관 분석 → AI 자동 진단 → Slack(ADR-009) |
| **이벤트 사전 스케일링** | 과거 메트릭 분석 → Bedrock이 다단계 워밍업 플랜·스크립트 생성(ADR-010, 검토-후-실행) |
| **CIS 컴플라이언스** | Powerpipe로 CIS v1.5~v4.0, **431개 컨트롤** 벤치마크 |
| **보안 설계** | 외부 호출 SSRF allowlist, 관리자 게이트(adminEmails), 변경 작업 게이트 프레임워크(ADR-029) |
| **설계 투명성** | **32개 ADR** — 모든 주요 결정이 한국어/영어로 문서화 |

<Screenshot src="/screenshots/overview/agentcore.png" alt="AgentCore 대시보드 — Runtime/Gateway/도구 상태" />

---

## 권장 데모 흐름 (고객 세션)

1. **대시보드** — 전 계정/전 리소스가 한 화면에 (멀티 어카운트 전환 시연)
2. **AI 어시스턴트** — "보안 그룹 중 0.0.0.0/0 열린 거 찾아줘" 같은 자연어 질의 → 멀티 라우트 동작
3. **AI 종합 진단** — Well-Architected 리포트 생성 → DOCX/PDF 내보내기
4. **EKS 컨테이너 비용** — OpenCost 네임스페이스별 비용
5. **자연어 관측성 쿼리** — `/datasources/explore`에서 PromQL 자동 생성
6. **비용/인벤토리** — 추이와 절감 포인트

## 더 보기

- [대시보드 개요](./dashboard) · [AI 어시스턴트](./ai-assistant) · [AgentCore 상세](./agentcore) · [계정 관리](./accounts)
- [AI 종합 진단](../monitoring/ai-diagnosis) · [EKS 컨테이너 비용](../compute/eks-container-cost) · [외부 데이터소스](../monitoring/datasources)
- [AWSops 소개(아키텍처 전체)](../intro)
