---
remarp: true
block: 01
title: "Why AWSops"
---

<!-- Slide 1: Session Cover -->

@type: cover
@transition: fade

# AWSops
## AI-Powered AWS Operations Dashboard

Junseok Oh | Solutions Architect | AWS

:::notes
{timing: 1min}
안녕하세요, AWS Solutions Architect 오준석입니다.
오늘은 AWSops라는 AI 기반 AWS 운영 대시보드를 소개해 드리겠습니다.
클라우드 운영의 복잡성을 어떻게 해결하고, AI가 어떤 역할을 할 수 있는지 함께 살펴보겠습니다.
{cue: transition}
먼저 왜 이런 도구가 필요한지부터 시작하겠습니다.
:::

---

<!-- Slide 2: Agenda -->

@type: agenda

# Agenda

1. **Why AWSops** — 클라우드 운영의 도전 과제
2. **Architecture Deep Dive** — 기술 스택과 AI 에이전트
3. **Demo & Diagnosis Report** — 실전 시나리오와 종합진단

:::notes
{timing: 1min}
총 60분 세션으로 3개 파트로 나누어 진행합니다.
첫 번째로 왜 이런 도구가 필요한지, 두 번째로 어떻게 만들었는지, 세 번째로 실제로 어떻게 쓰는지를 보여드리겠습니다.
:::

---

<!-- Slide 3: The Challenge -->

@type: content
@transition: slide

# 클라우드 운영의 도전 과제

::: left

### Console Hopping

- EC2 확인 → CloudWatch → VPC → IAM → Cost Explorer
- **평균 5-7개 콘솔** 페이지를 오가며 문제 해결
- 멀티 어카운트 환경에서는 **로그인만 10번**

### 데이터 사일로

- CloudWatch 메트릭 ≠ Prometheus 메트릭 ≠ 로그 ≠ 트레이스
- **교차 분석 불가** → 근본 원인 파악 지연

:::

::: right

### 반복적 수작업

- "이 인스턴스 rightsizing 필요한가?"
- "미사용 리소스 정리해야 하는데..."
- **매번 같은 CLI 명령어** 반복 실행

### 보고서 작성 부담

- Well-Architected Review 수작업
- FinOps 리포트 매월 수동 작성
- **2-3일 소요** → 실시간성 부족

:::

:::notes
{timing: 3min}
클라우드 운영을 하다 보면 정말 많은 도전 과제에 직면합니다.

첫 번째는 Console Hopping입니다. 하나의 이슈를 해결하려면 EC2 콘솔에서 시작해서 CloudWatch로 메트릭 보고, VPC에서 네트워크 확인하고, IAM에서 권한 체크하고... 평균 5-7개 콘솔을 돌아다녀야 합니다. 멀티 어카운트면 로그인만 해도 지칩니다.

{cue: pause}

두 번째는 데이터 사일로입니다. CloudWatch 메트릭, Prometheus 메트릭, 로그, 트레이스가 각각 다른 시스템에 있어서 교차 분석이 어렵습니다. "CPU가 높아졌는데 어떤 서비스 때문이지?" 라는 질문에 답하려면 여러 도구를 동시에 봐야 합니다.

세 번째, 네 번째도 마찬가지로 반복 작업과 보고서 부담이 큽니다.

{cue: question}
여러분도 이런 경험 있으시죠? 특히 FinOps 리포트를 매달 수동으로 만들어 본 경험이 있으신 분?

{cue: transition}
AWSops는 이 4가지 문제를 동시에 해결합니다.
:::

---

<!-- Slide 4: AWSops Overview -->

@type: content
@transition: slide

# AWSops — Single Pane of Glass

:::html
<div class="tab-bar" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#00d4ff;color:#0a0e1a;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,0)">Data Layer</button>
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#1a2540;color:#b0b0b0;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,1)">AI Engine</button>
  <button class="tab-btn" style="padding:8px 16px;border:none;border-radius:6px;background:#1a2540;color:#b0b0b0;font-weight:bold;cursor:pointer;font-size:14px;" onclick="(function(b,i){var p=b.closest('.slide-body')||b.parentNode.parentNode.parentNode;p.querySelectorAll('.tc').forEach(function(c,j){c.style.display=j===i?'block':'none'});var btns=b.parentNode.querySelectorAll('.tab-btn');btns.forEach(function(x){x.style.background='#1a2540';x.style.color='#b0b0b0';x.classList.remove('active')});b.style.background='#00d4ff';b.style.color='#0a0e1a';b.classList.add('active')})(this,2)">Dashboard</button>
</div>
<div class="tc" style="display:block;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
  <div style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);border-radius:8px;padding:20px;">
    <div style="color:#00d4ff;font-weight:bold;font-size:18px;margin-bottom:8px;">Aurora Serverless v2 — 영속 상태</div>
    <div style="color:#b0b0b0;line-height:1.6;">PostgreSQL 17 · 0.5–4 ACU · KMS CMK<br>worker jobs · chat threads · 진단 리포트 영속 저장</div>
  </div>
  <div style="display:grid;grid-template-rows:1fr 1fr;gap:12px;">
    <div style="background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#00d4ff;font-size:28px;font-weight:bold;">node-pg</div>
      <div style="color:#8b95a5;font-size:13px;">Durable State</div>
    </div>
    <div style="background:rgba(0,255,136,0.05);border:1px solid rgba(0,255,136,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#00ff88;font-size:28px;font-weight:bold;">~22</div>
      <div style="color:#8b95a5;font-size:13px;">Inventory Types (Steampipe sync)</div>
    </div>
  </div>
</div>
</div>
<div class="tc" style="display:none;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
  <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:20px;">
    <div style="color:#f59e0b;font-weight:bold;font-size:18px;margin-bottom:8px;">Bedrock AgentCore</div>
    <div style="color:#b0b0b0;line-height:1.6;">Claude Opus 4.8 / Sonnet 4.6 / Haiku 4.5<br>AgentCore Runtime + 섹션 에이전트<br>ADR-038 하이브리드 라우팅</div>
  </div>
  <div style="display:grid;grid-template-rows:1fr 1fr;gap:12px;">
    <div style="background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#f59e0b;font-size:28px;font-weight:bold;">8</div>
      <div style="color:#8b95a5;font-size:13px;">Section Gateways</div>
    </div>
    <div style="background:rgba(168,85,247,0.05);border:1px solid rgba(168,85,247,0.2);border-radius:8px;padding:12px;text-align:center;">
      <div style="color:#a855f7;font-size:28px;font-weight:bold;">~120</div>
      <div style="color:#8b95a5;font-size:13px;">Read-only Tools</div>
    </div>
  </div>
</div>
</div>
<div class="tc" style="display:none;padding:12px;background:rgba(15,22,41,0.5);border-radius:8px;">
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;">
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">Overview</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">Dashboard</div>
    <div style="color:#666;font-size:11px;">Cost · Bedrock · Inventory · Datasources</div>
  </div>
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">AI</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">Assistant · Diagnosis</div>
    <div style="color:#666;font-size:11px;">스트리밍 챗 + 종합진단 리포트</div>
  </div>
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;text-align:center;">
    <div style="color:#ef4444;font-size:32px;font-weight:bold;">Topology</div>
    <div style="color:#8b95a5;font-size:13px;margin-top:4px;">EKS · 리소스 그래프</div>
    <div style="color:#666;font-size:11px;">async worker tier가 무거운 작업 처리</div>
  </div>
</div>
</div>
:::

:::notes
{timing: 3min}
AWSops는 3개 레이어로 구성됩니다.

{cue: pause}
Data Layer는 Aurora Serverless v2가 중심입니다. PostgreSQL 17 기반으로 worker 작업, chat 스레드, 진단 리포트 같은 영속 상태를 안전하게 저장합니다. 인벤토리는 flag로 켜는 Steampipe sync가 약 22종 리소스 타입을 Aurora로 동기화해 화면에 보여주는 보조 역할입니다. 라이브 조회 엔진이 아니라 인벤토리 캐시라는 점이 핵심입니다.

AI Engine은 Bedrock입니다. Opus 4.8, Sonnet 4.6, Haiku 4.5를 상황에 맞게 쓰고, AgentCore의 8개 섹션 게이트웨이를 통해 약 120개의 읽기 전용 도구를 호출합니다. 라우팅은 ADR-038 하이브리드 방식으로 빠르고 정확합니다.

Dashboard는 Next.js 14 thin-BFF입니다. Overview, AI Diagnosis, Assistant, Cost, Bedrock, Topology, EKS, Inventory, Datasources 페이지가 있고, 무거운 작업은 비동기 워커 티어로 넘깁니다.

{cue: transition}
구체적인 숫자를 보겠습니다.
:::

---

<!-- Slide 5: By the Numbers -->

@type: content

# AWSops — By the Numbers

| 항목 | 내용 | 설명 |
|------|------|------|
| **Infra** | Terraform MSA | 비공개 엣지 — CloudFront VPC Origin → 내부 ALB → Fargate |
| **Compute** | ECS Fargate | web thin-BFF + OOM-safe 비동기 워커 티어 (arm64) |
| **Data** | Aurora Serverless v2 | PostgreSQL 17 영속 상태 + ~22종 인벤토리 sync |
| **AI Tools** | 8 게이트웨이 / ~120 도구 | AgentCore 섹션 에이전트 (모두 read-only) |
| **AI Routing** | ADR-038 하이브리드 | regex fast-path + Haiku 분류기, 게이트 96.9% |
| **Diagnosis** | base 8 / deep 15 섹션 | Well-Architected 매핑, DOCX/PDF 내보내기 |
| **UX** | 3-테마 + 모바일 | 반응형 대시보드 + Cmd-K + 다크 테마 |

:::notes
{timing: 2min}
숫자보다 구조로 보면 더 명확합니다.

인프라는 Terraform 기반 MSA입니다. 공개 ALB 없이 CloudFront VPC Origin이 내부 ALB를 거쳐 Fargate로 들어오는 비공개 엣지 구조입니다. 컴퓨트는 ECS Fargate로, 웹 thin-BFF와 OOM에 안전한 비동기 워커 티어가 분리되어 있습니다. 모두 arm64입니다.

데이터는 Aurora Serverless v2, PostgreSQL 17로 영속 상태를 보관하고, 인벤토리는 약 22종 리소스 타입을 sync합니다.

AI는 8개 섹션 게이트웨이에 약 120개의 읽기 전용 도구가 있고, 라우팅은 ADR-038 하이브리드로 게이트 정확도 96.9%를 달성했습니다. 진단은 base 8섹션, deep 15섹션이며 Well-Architected에 매핑되고 DOCX/PDF로 뽑을 수 있습니다.

{cue: transition}
이게 어떤 가치를 만드는지 보겠습니다.
:::

---

<!-- Slide 6: Value Proposition -->

@type: content
@transition: slide

# AWSops가 주는 가치

::: left

### For DevOps / SRE

- **Console Hopping 제거** — 한 화면에서 모든 리소스
- **자연어 트러블슈팅** — "VPC Flow Log 분석해줘" (읽기 전용, 스트리밍 챗)
- **Topology / EKS 읽기 전용 뷰** — CF→LB→TG→DB 리소스 그래프
- **Datasource Explore** — Prometheus · Loki · Tempo · ClickHouse 교차 조회

:::

::: right

### For FinOps / Management

- **읽기 전용 비용 분석** — Cost 대시보드 + AgentCore 비용 도구
- **Rightsizing 인사이트** — 권고만 제시, 자동 적용 없음
- **종합진단 리포트** — base 8 / deep 15 섹션, Well-Architected 매핑
- **DOCX / PDF 내보내기** — 비동기 워커가 생성, 수작업 대체

:::

:::notes
{timing: 3min}
두 가지 관점에서 가치를 드립니다.

DevOps나 SRE 분들에게는 콘솔 호핑 없이 한 화면에서 모든 리소스를 보고, AI에게 자연어로 질문하면 됩니다. "이 EC2 인스턴스가 왜 느려?"라고 물으면 CloudWatch 메트릭을 확인하고, 네트워크 경로를 분석하고, 관련 로그를 찾아줍니다. 모두 읽기 전용이고, 응답은 스트리밍으로 흐릅니다. Topology와 EKS 읽기 전용 뷰, 그리고 Prometheus·Loki·Tempo 같은 데이터소스 Explore도 함께 제공합니다.

{cue: pause}

FinOps나 Management 분들에게는 읽기 전용 비용 분석과 rightsizing 인사이트를 드립니다. 중요한 건 권고만 제시하고 자동으로 바꾸지 않는다는 점입니다. 그리고 종합진단 리포트를 base 8섹션, deep 15섹션으로 만들고, Well-Architected에 매핑해 DOCX와 PDF로 내보냅니다. 무거운 생성 작업은 비동기 워커가 처리하므로 수작업 2-3일이 사라집니다.

{cue: transition}
가장 중요한 차별점을 보겠습니다.
:::

---

<!-- Slide 7: Key Differentiator -->

@type: content
@transition: fade

# 핵심 차별점

:::html
<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; margin-top: 32px;">
  <div style="background: rgba(0,212,255,0.1); border: 1px solid rgba(0,212,255,0.3); border-radius: 12px; padding: 24px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 12px;">🧠</div>
    <div style="color: #00d4ff; font-weight: bold; font-size: 18px; margin-bottom: 8px;">In-Account Bedrock AI</div>
    <div style="color: #8b95a5; font-size: 14px;">고객 계정 안에서 Bedrock 호출<br>외부 AI SaaS API 불필요 — 데이터가 밖으로 안 나감</div>
  </div>
  <div style="background: rgba(0,255,136,0.1); border: 1px solid rgba(0,255,136,0.3); border-radius: 12px; padding: 24px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 12px;">🔒</div>
    <div style="color: #00ff88; font-weight: bold; font-size: 18px; margin-bottom: 8px;">Read-Only Posture</div>
    <div style="color: #8b95a5; font-size: 14px;">AWS 리소스 변경·자율 실행 영구 동결<br>ADR-041 — 설계상 안전</div>
  </div>
  <div style="background: rgba(168,85,247,0.1); border: 1px solid rgba(168,85,247,0.3); border-radius: 12px; padding: 24px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 12px;">📊</div>
    <div style="color: #a855f7; font-weight: bold; font-size: 18px; margin-bottom: 8px;">AI Diagnosis Report</div>
    <div style="color: #8b95a5; font-size: 14px;">Well-Architected · base 8 / deep 15 섹션<br>비동기 워커 생성 → DOCX / PDF</div>
  </div>
</div>
:::

:::notes
{timing: 3min}
AWSops의 차별점은 세 가지로 압축됩니다.

첫째, In-Account Bedrock AI입니다. AI 추론을 고객 AWS 계정 안의 Bedrock에서 직접 호출합니다. OpenAI 같은 외부 AI SaaS API를 쓰지 않으므로 데이터가 계정 밖으로 나가지 않습니다. 금융, 공공, 의료처럼 데이터 주권이 중요한 환경에 적합합니다.

둘째, 읽기 전용 운영 태세입니다. ADR-041 기준으로 AWS 리소스 변경과 자율 실행은 영구 동결되어 있습니다. AI가 진단하고 권고할 뿐 직접 바꾸지 않으므로, 설계 단계에서부터 안전합니다.

셋째, AI 종합진단 리포트입니다. Well-Architected에 매핑된 base 8섹션, deep 15섹션 리포트를 비동기 워커가 생성하고 DOCX와 PDF로 내보냅니다.

{cue: question}
외부 AI SaaS에 운영 데이터를 보내는 게 부담스러웠던 분 계시죠? AWSops는 그 경로 자체가 없습니다.

{cue: transition}
이제 아키텍처를 자세히 살펴보겠습니다.
:::

---

<!-- Slide 8: Block 1 Key Takeaways -->

@type: content
@transition: fade

# Key Takeaways — Why AWSops

- **Console Hopping 문제** → Single Pane of Glass 대시보드
- **데이터 사일로** → AgentCore 읽기 전용 도구 + Datasource 커넥터 통합
- **반복 수작업** → 변경형 자동화 대신 읽기 전용 AI Assistant + 진단
- **보고서 부담** → 종합진단 리포트 자동 생성 (Well-Architected, base/deep, DOCX/PDF)
- **핵심 차별점** → In-account Bedrock AI + 읽기 전용 태세 (ADR-041)

:::notes
{timing: 2min}
첫 번째 파트를 정리하겠습니다.

AWSops는 클라우드 운영의 4대 도전 과제를 동시에 해결합니다.
콘솔 호핑 대신 한 화면, 데이터 사일로 대신 AgentCore 읽기 전용 도구와 데이터소스 커넥터 통합, 반복 수작업 대신 읽기 전용 AI Assistant와 진단, 수동 보고서 대신 자동 종합진단 리포트입니다.

그리고 가장 중요한 것은, AI 추론을 고객 계정 안 Bedrock에서 돌리고, AWS 리소스 변경과 자율 실행은 영구 동결한 읽기 전용 태세라는 점입니다. 설계상 안전합니다.

{cue: transition}
5분 쉬고 아키텍처를 자세히 보겠습니다.
:::
