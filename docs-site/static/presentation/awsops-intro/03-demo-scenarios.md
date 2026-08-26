---
remarp: true
block: 03
title: "Demo & Diagnosis Report"
---

<!-- Slide 1: Block 3 Intro -->

@type: section
@transition: fade

# Demo & Diagnosis Report
## 실전 시나리오와 종합진단

:::notes
{timing: 1min}
마지막 파트입니다. 지금까지 왜 필요한지, 어떻게 만들었는지를 봤고, 이제 실제로 어떻게 쓰는지를 데모로 보여드리겠습니다.
AI 어시스턴트, 비용/인벤토리/토폴로지 시나리오, 그리고 종합진단 리포트까지 순서대로 보겠습니다.
{cue: emphasis}
한 가지 먼저 짚고 갈 점은, 오늘 보여드리는 모든 데모는 read-only라는 것입니다. 조회와 진단만 하고, AWS 리소스를 변경하지 않습니다.
{cue: transition}
먼저 AI 어시스턴트 데모입니다.
:::

---

<!-- Slide 2: AI Assistant Demo Flow -->

@type: content
@transition: slide

# AI Assistant Demo

:::html
<div class="ai-query-demo-container">
  <style>
    /* Global CSS variables for theme */
    :root {
      --bg-color: #0f1629;
      --text-color: #ffffff;
      --accent-cyan: #00d4ff;
      --accent-green: #00ff88;
      --border-color: #333;
      --button-bg: #444;
      --button-hover-bg: #555;
      --disabled-color: #666;
      --error-color: #dc3545;
      --error-hover-color: #c82333;
    }

    /* Basic reset and container styling */
    .ai-query-demo-container {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      width: 100%;
      max-width: 900px; /* Adjusted for better fit on a 1920x1080 slide */
      max-height: 600px;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 20px;
      box-sizing: border-box;
      overflow: hidden; /* Important for max-height constraint */
      margin: 0 auto;
      border: 1px solid var(--border-color);
    }

    /* Utility class to hide elements */
    .hidden {
      display: none !important;
    }

    /* Input section styling */
    .input-section {
      display: flex;
      gap: 12px;
      align-items: center;
    }

    #queryInput {
      flex-grow: 1;
      padding: 12px 18px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      background-color: #1a2a4a;
      color: var(--text-color);
      font-size: 1.05em;
      outline: none;
      transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out;
    }

    #queryInput:focus {
      border-color: var(--accent-cyan);
      box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.2);
    }

    #queryInput::placeholder {
      color: var(--disabled-color);
    }

    /* Button styling */
    button {
      padding: 12px 25px;
      border: none;
      border-radius: 8px;
      background-color: var(--button-bg);
      color: var(--text-color);
      font-size: 1.05em;
      cursor: pointer;
      transition: background-color 0.2s ease-in-out, transform 0.1s ease-out;
      white-space: nowrap;
    }

    button:hover:not(:disabled) {
      background-color: var(--button-hover-bg);
      transform: translateY(-1px);
    }

    button:active:not(:disabled) {
      transform: translateY(0);
    }

    button:disabled {
      background-color: var(--disabled-color);
      cursor: not-allowed;
      color: #aaa;
    }

    /* Flow section for steps and details */
    .flow-section {
      display: flex;
      flex-direction: column;
      gap: 15px;
      padding-top: 15px;
      border-top: 1px dashed var(--border-color);
    }

    .step-indicators {
      display: flex;
      justify-content: center;
      gap: 25px;
      margin-bottom: 10px;
    }

    .step-circle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 35px;
      height: 35px;
      border-radius: 50%;
      border: 2px solid var(--disabled-color);
      color: var(--disabled-color);
      font-weight: bold;
      font-size: 1em;
      transition: all 0.3s ease-in-out;
      background-color: rgba(0, 0, 0, 0.2);
    }

    .step-circle.active {
      border-color: var(--accent-cyan);
      color: var(--accent-cyan);
      background-color: rgba(0, 212, 255, 0.15);
      box-shadow: 0 0 8px var(--accent-cyan);
    }

    .step-details > div {
      padding: 15px;
      background-color: #1a2a4a;
      border-radius: 10px;
      margin-bottom: 10px;
      white-space: pre-wrap;
      border: 1px solid rgba(0, 0, 0, 0.3);
    }

    .status-message {
      font-size: 1.15em;
      margin: 0 0 8px 0;
      color: var(--text-color);
    }

    .route-info, .data-sources {
      font-size: 0.95em;
      color: #ccc;
      margin: 0;
    }

    .accent-cyan {
      color: var(--accent-cyan);
    }

    .accent-green {
      color: var(--accent-green);
    }

    /* Output section for response and cursor */
    .output-section {
      position: relative;
      flex-grow: 1; /* Allows it to take available space within max-height */
      padding: 15px 0;
      border-top: 1px dashed var(--border-color);
      overflow-y: auto; /* Enable scrolling for long responses */
      display: flex;
      flex-direction: column;
    }

    #responseText {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: 'Dank Mono', 'Fira Code', 'Cascadia Code', monospace; /* Monospaced for code-like output */
      font-size: 0.95em;
      line-height: 1.7;
      margin: 0;
      padding-right: 15px; /* Space for cursor */
      flex-grow: 1; /* Allow text to grow */
    }

    #cursor {
      display: inline-block;
      width: 8px;
      height: 1.2em; /* Match line height of responseText */
      background-color: var(--accent-cyan);
      vertical-align: text-bottom;
      animation: blink 1s step-end infinite;
      margin-left: 3px;
      transition: opacity 0.2s ease-in-out;
    }

    @keyframes blink {
      from, to { opacity: 1; }
      50% { opacity: 0; }
    }

    #finalSavings {
      font-size: 1.3em;
      font-weight: bold;
      color: var(--accent-green);
      margin-top: 15px;
      padding: 12px 15px;
      background-color: rgba(0, 255, 136, 0.15);
      border-radius: 8px;
      border: 1px solid rgba(0, 255, 136, 0.3);
      text-align: center;
    }

    /* Reset button specific styling */
    #resetButton {
      align-self: flex-end;
      background-color: var(--error-color);
    }

    #resetButton:hover:not(:disabled) {
      background-color: var(--error-hover-color);
    }
  </style>

  <div class="input-section">
    <input type="text" id="queryInput" value="EKS 비용 개선점 찾아줘" placeholder="AI에게 질문하세요...">
    <button id="askButton">Ask</button>
  </div>

  <div class="flow-section">
    <div class="step-indicators">
      <span class="step-circle" id="stepIndicator1">1</span>
      <span class="step-circle" id="stepIndicator2">2</span>
      <span class="step-circle" id="stepIndicator3">3</span>
    </div>
    <div class="step-details">
      <div id="step1Details" class="hidden">
        <p class="status-message">🔍 하이브리드 라우팅 (regex + Haiku)...</p>
        <p class="route-info">Gateway: <span class="accent-cyan">cost</span> · 프롬프트 캐싱 hit</p>
      </div>
      <div id="step2Details" class="hidden">
        <p class="status-message">📊 AgentCore 섹션 에이전트 · 라이브 read-only 조회...</p>
        <p class="data-sources"><span class="accent-green">MCP Tools ✅</span> <span class="accent-green">Cost Explorer ✅</span> <span class="accent-green">EKS Metrics ✅</span></p>
      </div>
      <div id="step3Details" class="hidden">
        <p class="status-message">🤖 Bedrock 분석 · SSE 스트리밍...</p>
      </div>
    </div>
  </div>

  <div class="output-section">
    <pre id="responseText"></pre>
    <span id="cursor" class="hidden"></span> <!-- Initially hidden -->
    <div id="finalSavings" class="hidden"></div>
  </div>

  <button id="resetButton" class="hidden">Reset</button>

  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const queryInput = document.getElementById('queryInput');
      const askButton = document.getElementById('askButton');
      const resetButton = document.getElementById('resetButton');

      const stepIndicator1 = document.getElementById('stepIndicator1');
      const stepIndicator2 = document.getElementById('stepIndicator2');
      const stepIndicator3 = document.getElementById('stepIndicator3');

      const step1Details = document.getElementById('step1Details');
      const step2Details = document.getElementById('step2Details');
      const step3Details = document.getElementById('step3Details');

      const responseText = document.getElementById('responseText');
      const cursor = document.getElementById('cursor');
      const finalSavings = document.getElementById('finalSavings');

      let currentTimeout; // To manage animation delays
      let streamingInterval; // To manage character streaming

      // AI response text to be streamed
      const aiResponseContent = `Bedrock 분석 결과, EKS 클러스터의 비용 효율성을 개선할 수 있는 몇 가지 주요 영역이 확인되었습니다. (read-only 권장 — 자동 적용 없음)
1.  **워크로드 rightsizing:** 현재 클러스터에 불필요하게 높은 리소스를 할당하고 있는 워크로드가 감지되었습니다. 예를 들어, 일부 개발 환경 파드는 CPU 및 메모리 사용량이 낮음에도 불구하고 큰 인스턴스 타입에서 실행 중입니다.
2.  **스케줄링 정책 개선:** 비즈니스 시간 외에는 불필요하게 가동되는 파드가 있습니다. 스케일 다운 정책 적용으로 유휴 시간을 최소화할 수 있습니다.
3.  **Graviton 인스턴스 전환:** 현재 사용 중인 x86 인스턴스 대비 Graviton 인스턴스는 동일 성능에서 비용 절감 효과를 제공합니다. 호환성 검토 후 점진적인 전환을 권장합니다.

이러한 개선 사항들을 적용할 경우, **월 350만원** 가량의 EKS 비용 절감이 예상됩니다.`;

      function resetDemo() {
        clearTimeout(currentTimeout);
        clearInterval(streamingInterval);

        queryInput.value = "EKS 비용 개선점 찾아줘";
        queryInput.disabled = false;
        askButton.disabled = false;
        askButton.classList.remove('hidden');
        resetButton.classList.add('hidden');

        stepIndicator1.classList.remove('active');
        stepIndicator2.classList.remove('active');
        stepIndicator3.classList.remove('active');

        step1Details.classList.add('hidden');
        step2Details.classList.add('hidden');
        step3Details.classList.add('hidden');

        responseText.textContent = '';
        cursor.classList.add('hidden'); // Ensure cursor is hidden
        cursor.style.animation = 'none'; // Stop blinking animation
        finalSavings.classList.add('hidden');
        finalSavings.textContent = '';
      }

      function streamText(text, element, speed = 25) { // speed in ms per character
        let i = 0;
        cursor.classList.remove('hidden');
        cursor.style.animation = 'blink 1s step-end infinite'; // Start blinking animation

        function typeChar() {
          if (i < text.length) {
            element.textContent += text.charAt(i);
            // Auto-scroll to bottom as text is added
            element.scrollTop = element.scrollHeight;
            i++;
            streamingInterval = setTimeout(typeChar, speed);
          } else {
            cursor.classList.add('hidden'); // Hide cursor after streaming finishes
            cursor.style.animation = 'none'; // Stop animation explicitly
            finalSavings.classList.remove('hidden');
            finalSavings.textContent = '예상 절감액(권장): 월 350만원 · 자동 적용 없음';
            resetButton.classList.remove('hidden'); // Show reset button at the very end
          }
        }
        typeChar();
      }

      function animateStep3() {
        stepIndicator2.classList.remove('active');
        stepIndicator3.classList.add('active');
        step2Details.classList.add('hidden');
        step3Details.classList.remove('hidden');

        currentTimeout = setTimeout(() => {
          streamText(aiResponseContent, responseText, 25);
        }, 2000); // 2 seconds delay for "Bedrock 분석 중..."
      }

      function animateStep2() {
        stepIndicator1.classList.remove('active');
        stepIndicator2.classList.add('active');
        step1Details.classList.add('hidden');
        step2Details.classList.remove('hidden');

        currentTimeout = setTimeout(() => {
          animateStep3();
        }, 1500); // 1.5 seconds delay for data collection
      }

      function animateStep1() {
        resetDemo(); // Clear previous state before starting new animation
        queryInput.disabled = true;
        askButton.disabled = true;
        askButton.classList.add('hidden');

        stepIndicator1.classList.add('active');
        step1Details.classList.remove('hidden');

        currentTimeout = setTimeout(() => {
          animateStep2();
        }, 1000); // 1 second delay for question analysis
      }

      // Event Listeners
      askButton.addEventListener('click', animateStep1);
      resetButton.addEventListener('click', resetDemo);

      // Initial setup when the page loads
      resetDemo();
    });
  </script>
</div>
:::

:::notes
{timing: 3min}
AI 어시스턴트의 동작 흐름을 보겠습니다. 자연어 질문 하나가 답변으로 이어지는 과정입니다.

사용자가 "EKS 비용 개선점 찾아줘"라고 질문합니다. 첫 단계는 ADR-038 하이브리드 라우팅입니다. regex fast-path가 먼저 매칭을 시도하고, 애매하면 Haiku 분류기가 판단합니다. 프롬프트 캐싱으로 약 59% 히트율을 내고, 이 질문은 cost 섹션 게이트웨이로 라우팅됩니다.

{cue: pause}

선택된 AgentCore 섹션 에이전트가 MCP 도구로 라이브 read-only AWS 조회를 수행합니다. Cost Explorer, EKS 메트릭 등 필요한 도구만 호출합니다. 그리고 in-account Bedrock이 결과를 분석합니다.

응답은 SSE 스트리밍으로 실시간 전달되고, 어떤 라우트와 도구가 쓰였는지 UI에 함께 표시됩니다. 대화는 Aurora에 thread로 영속 저장되어, 사이드바에서 이어보기가 가능합니다. resizable drawer나 /assistant 전체 화면 어디서든 같은 thread를 씁니다.

{cue: demo}
(데모) 어시스턴트에서 질문을 입력하고, 라우트 분류와 도구 호출, 그리고 스트리밍 답변을 보여줍니다.

{cue: transition}
다음은 비용 분석 시나리오입니다.
:::

---

<!-- Slide 3: Cost Analysis & Rightsizing Insight -->

@type: content
@transition: slide

# Scenario 1: Cost Analysis & Rightsizing

::: left

### 사용자 질문

> "비용 개선점 찾아줘"

### 동작 흐름 (read-only)

- **cost 섹션 에이전트** — Cost Explorer / Forecast 조회
- **Cost 대시보드** — 서비스별 비용·추이 시각화
- **EKS 메트릭** — request 대비 실사용량 (read-only)
- regex + Haiku 라우팅 → cost gateway

:::

::: right

### 분석 결과 예시 (권장만)

- "**payment** Pod: CPU request 500m, 실사용 50m → **90% 과할당** (rightsizing 권장)"
- "**frontend** Deployment: Memory limit 2Gi, 사용량 200Mi → **다운사이징 권장**"
- "Node 3대 중 **2대 활용률 15% 미만** → 통합 검토"
- "예상 월 절감 **$1,200** — 권장사항"

### Read-Only 원칙

> 권장사항만 제시 · **자동 적용 없음**
> (mutating 설치 버튼은 ADR-029 번복으로 폐기)

:::

:::notes
{timing: 3min}
첫 번째 시나리오는 비용 분석과 rightsizing 인사이트입니다.

"비용 개선점 찾아줘"라고 입력하면 cost 섹션 게이트웨이로 라우팅됩니다. cost 에이전트가 Cost Explorer와 Forecast를 read-only로 조회하고, Cost 대시보드가 서비스별 비용과 추이를 시각화합니다.

{cue: pause}

EKS 워크로드는 read-only 메트릭으로 request 대비 실사용량을 비교합니다. 과할당된 파드와 다운사이징 후보, 통합 가능한 노드를 식별합니다. 결과는 구체적인 절감 추정치와 함께 제시됩니다.

{cue: emphasis}

여기서 중요한 점은, AWSops는 권장사항만 제시한다는 것입니다. 어떤 변경도 자동으로 적용하지 않습니다. 과거 설계에 있던 OpenCost mutating 설치 버튼은 ADR-029 번복으로 폐기됐습니다. 진단과 권고까지가 AWSops의 역할이고, 적용 결정과 실행은 운영자의 몫입니다.

{cue: transition}
다음은 인벤토리와 유휴 리소스 점검입니다.
:::

---

<!-- Slide 4: Inventory & Idle Review -->

@type: content
@transition: slide

# Scenario 2: Inventory & Idle Review

::: left

### 사용자 흐름

> `/inventory/[type]` 페이지 → AgentCore 질의

### Inventory 플랫폼

- **~22 resource types** — `/inventory/[type]` 제네릭 페이지
- flag-gated **Steampipe sync** (warm Fargate) → **Aurora** 적재
- registry 기반 내비게이션 · fan-out sync
- 페이지별 **mini-dashboard** (KPI / donut / filters)

:::

::: right

### 점검 예시 (read-only)

- "미연결 EBS 볼륨 · 미사용 Elastic IP 후보 식별"
- "오래된 스냅샷 · 중지된 EC2 검토"
- "ENI 참조 없는 Security Group"
- AgentCore 라이브 조회로 현황 보강

### 라이브 vs 인벤토리

> Steampipe = **인벤토리 sync 전용** (Aurora 적재)
> 라이브 조회는 **AgentCore MCP 도구**가 담당

:::

:::notes
{timing: 2min}
두 번째 시나리오는 인벤토리와 유휴 리소스 점검입니다.

AWSops는 약 22가지 리소스 타입을 제네릭 `/inventory/[type]` 페이지로 제공합니다. 이 데이터는 flag-gated Steampipe sync가 warm Fargate에서 돌면서 Aurora로 적재한 것입니다. registry 기반으로 내비게이션이 자동 구성되고, 페이지마다 KPI, donut, 필터로 구성된 mini-dashboard가 붙습니다.

{cue: pause}

여기서 분명히 할 점은, Steampipe는 인벤토리 sync 전용이라는 것입니다. 라이브 쿼리 엔진이 아닙니다. 실시간 조회와 분석은 AgentCore MCP 도구가 담당합니다. 인벤토리 화면에서 후보를 좁히고, 에이전트로 라이브 현황을 보강하는 방식입니다.

미연결 EBS, 미사용 Elastic IP, 오래된 스냅샷, 중지된 EC2, 참조 없는 Security Group 같은 후보를 read-only로 점검합니다. 변경은 하지 않고, 검토 대상만 정리합니다.

{cue: transition}
세 번째 시나리오, 토폴로지입니다.
:::

---

<!-- Slide 5: Topology & Dependency Visualization -->

@type: content
@transition: slide

# Scenario 3: Topology & Dependencies

:::html
<div class="flow-h">
  <div class="flow-group bg-blue" data-fragment-index="1">
    <div class="flow-group-label">CloudFront</div>
    <div class="flow-box">배포 / 도메인</div>
    <div class="flow-box">VPC Origin</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-orange" data-fragment-index="2">
    <div class="flow-group-label">Load Balancer</div>
    <div class="flow-box">내부 ALB</div>
    <div class="flow-box">Listener / Rule</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-green" data-fragment-index="3">
    <div class="flow-group-label">Target Group</div>
    <div class="flow-box">ECS / EKS Target</div>
    <div class="flow-box">Health Status</div>
  </div>
  <div class="flow-arrow">&rarr;</div>
  <div class="flow-group bg-pink" data-fragment-index="4">
    <div class="flow-group-label">Database</div>
    <div class="flow-box">Aurora / RDS</div>
    <div class="flow-box">의존 리소스</div>
  </div>
</div>
:::

### Flow + Infra 그래프 · `/topology/resource/[id]` 상세 · blast radius 진단

:::notes
{timing: 3min}
세 번째 시나리오는 토폴로지와 의존성 시각화입니다.

AWSops는 flow 그래프와 infra 리소스 그래프 두 가지를 제공합니다. CloudFront에서 시작해 Load Balancer, Target Group, Database로 이어지는 CF → LB → TG → DB 체인을 한눈에 보여줍니다.

{cue: pause}

리소스 노드를 클릭하면 `/topology/resource/[id]` 상세 페이지로 이동합니다. 해당 리소스가 무엇에 연결되어 있고 무엇이 그것에 의존하는지를 추적할 수 있습니다.

이것이 진단에 중요한 이유는 blast radius, 즉 영향 범위 분석 때문입니다. 어떤 리소스에 문제가 생겼을 때 그 영향이 어디까지 전파되는지, 어떤 의존 관계를 끊어야 하는지를 그래프로 따라갈 수 있습니다. 과거의 자율 인시던트 수집 루프 대신, 사람이 그래프를 보며 의존 관계를 진단하는 read-only 방식입니다.

{cue: transition}
이제 플래그십 기능인 종합진단 리포트를 보겠습니다.
:::

---

<!-- Slide 6: AI Diagnosis Report -->

@type: content
@transition: slide

# AI Diagnosis Report

:::html
<style>
.ds{font-family:'Segoe UI',sans-serif;color:#fff;width:100%;max-width:580px;max-height:520px;margin:0 auto;overflow-y:auto;background:#1a2233;border-radius:10px;padding:20px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px;border:1px solid #334466}
.ds h3{text-align:center;color:#00d4ff;margin:0 0 8px;font-size:1.4em}
.ds-bw{width:100%;background:#334466;border-radius:5px;height:8px;overflow:hidden}
.ds-b{height:100%;width:0%;background:#00ff88;border-radius:5px;transition:width .3s}
.ds-i{display:flex;justify-content:space-between;font-size:.85em;color:#bbb}
.ds-btns{display:flex;justify-content:center;gap:12px}
.ds .db{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:.9em;font-weight:bold;color:#fff;transition:background .2s}
.ds .db:disabled{background:#555 !important;cursor:not-allowed;opacity:.6}
.ds .db1{background:#00d4ff}.ds .db2{background:#a855f7}.ds .db3{background:#334466}
.ds-sc{display:flex;flex-direction:column;gap:10px}
.ds-pg{background:#2a354d;border-radius:8px;padding:10px;border:1px solid #334466}
.ds-ph{font-weight:bold;font-size:.95em;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid}
.ds-si{display:flex;align-items:center;padding:4px 0;font-size:.85em}
.ds-si .ic{margin-right:8px;min-width:18px;text-align:center}
</style>
<div class="ds">
  <h3>AI 종합진단 리포트 (deep · 15 sections)</h3>
  <div class="ds-bw"><div class="ds-b" id="dBar2"></div></div>
  <div class="ds-i"><span>진행률: <span id="dPct2">0%</span></span><span>경과: <span id="dTm2">00:00</span></span></div>
  <div class="ds-btns">
    <button class="db db1" id="dSt2">진단 시작</button>
    <button class="db db2" id="dDl2" disabled>&#x2193; DOCX / PDF</button>
    <button class="db db3" id="dRs2" disabled>재설정</button>
  </div>
  <div class="ds-sc" id="dSc2"></div>
</div>
<script>
(function(){
  var S=[
    {n:"Executive Summary",p:"AI Synthesis",c:"#00ff88"},{n:"Security Posture",p:"Security",c:"#ef4444"},
    {n:"IAM & 자격 증명 심층",p:"Security",c:"#ef4444"},{n:"데이터 보호 & 암호화",p:"Security",c:"#ef4444"},
    {n:"네트워크 보안 / 노출",p:"Security",c:"#ef4444"},{n:"Network Architecture",p:"Reliability",c:"#00d4ff"},
    {n:"Compute Infrastructure",p:"Reliability",c:"#00d4ff"},{n:"Database & Storage",p:"Reliability",c:"#00d4ff"},
    {n:"신뢰성 & 고가용성",p:"Performance",c:"#a855f7"},{n:"관측성 & 알람 커버리지",p:"Performance",c:"#a855f7"},
    {n:"Cost Overview",p:"Cost Optimization",c:"#f59e0b"},{n:"비용 최적화 심층",p:"Cost Optimization",c:"#f59e0b"},
    {n:"Recent Changes",p:"AI Synthesis",c:"#00ff88"},{n:"Intended vs Actual",p:"AI Synthesis",c:"#00ff88"},
    {n:"Recommendations",p:"AI Synthesis",c:"#00ff88"}
  ];
  var el=document.getElementById('dSc2'),bar=document.getElementById('dBar2'),
      pct=document.getElementById('dPct2'),tm=document.getElementById('dTm2'),
      bS=document.getElementById('dSt2'),bD=document.getElementById('dDl2'),bR=document.getElementById('dRs2');
  var idx=0,run=false,t0=0,iv=null,to=null;
  var TOTAL_SIM_SECS=925;
  function fmt(s){return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
  function simTime(){return fmt(Math.round(idx/S.length*TOTAL_SIM_SECS))}
  function render(){
    while(el.firstChild)el.removeChild(el.firstChild);
    var g={};S.forEach(function(s,i){if(!g[s.p])g[s.p]={c:s.c,items:[]};g[s.p].items.push({n:s.n,i:i})});
    for(var p in g){
      var d=document.createElement('div');d.className='ds-pg';
      var h=document.createElement('div');h.className='ds-ph';h.textContent=p;h.style.borderColor=g[p].c;d.appendChild(h);
      g[p].items.forEach(function(it){
        var r=document.createElement('div');r.className='ds-si';r.setAttribute('data-idx',it.i);
        var ic=document.createElement('span');ic.className='ic';ic.textContent='⬜';
        var nm=document.createElement('span');nm.textContent=it.n;
        r.appendChild(ic);r.appendChild(nm);d.appendChild(r)});
      el.appendChild(d)}
  }
  function setI(i,v){var r=el.querySelector('[data-idx="'+i+'"] .ic');if(r)r.textContent=v}
  function prog(){var p=idx/S.length*100;bar.style.width=p+'%';pct.textContent=Math.round(p)+'%'}
  function tick(){if(run)tm.textContent=simTime()}
  function next(){
    if(idx<S.length){if(idx>0)setI(idx-1,'✅');setI(idx,'⏳');prog();idx++;to=setTimeout(next,800)}
    else{setI(S.length-1,'✅');prog();run=false;clearInterval(iv);tm.textContent='15:25';bD.disabled=false}
  }
  function start(){if(run)return;run=true;t0=Date.now();idx=0;bS.disabled=true;bR.disabled=false;bD.disabled=true;
    clearTimeout(to);clearInterval(iv);render();prog();tm.textContent='00:00';iv=setInterval(tick,1000);next()}
  function reset(){run=false;idx=0;clearInterval(iv);clearTimeout(to);render();bar.style.width='0%';pct.textContent='0%';
    tm.textContent='00:00';bS.disabled=false;bD.disabled=true;bR.disabled=true}
  render();bS.addEventListener('click',start);bR.addEventListener('click',reset);
  bD.addEventListener('click',function(){alert('DOCX / PDF download is a simulation.')});
})();
</script>
:::

:::notes
{timing: 3min}
AI 종합진단 리포트는 AWSops의 플래그십 기능입니다. 전부 read-only로 동작합니다.

리포트는 두 등급입니다. base는 8개 섹션, deep는 15개 섹션이고 Well-Architected Framework에 매핑됩니다. deep 등급은 기본 Sonnet으로 동작하고, 필요하면 cost-gate를 거쳐 Opus를 선택할 수 있습니다.

{cue: pause}

실행은 비동기 워커 티어에서 일어납니다. 웹은 thin-BFF라 무거운 작업을 직접 돌리지 않고 `POST /api/jobs`로 큐에 넣습니다. SQS, Step Functions, Lambda 또는 Fargate 워커가 받아서 섹션을 분석합니다. 진행 상황은 SSE로 실시간 표시됩니다. "3/15 Security Posture 분석 중" 같은 상태가 클라이언트에 흐릅니다.

완성된 리포트는 자동 제목과 태그가 붙고, 소프트 삭제를 지원합니다. 리포트 목록과 상세 화면에서 열람할 수 있습니다.

{cue: transition}
이 리포트를 어떻게 내보내는지 보겠습니다.
:::

---

<!-- Slide 7: Report Export & Lifecycle -->

@type: content
@transition: slide

# Report Export & Lifecycle

::: left

### 워커 기반 Export

- **DOCX** — python-docx
- **PDF** — chromium / playwright 렌더
- **Noto CJK** 폰트 (한글 깨짐 방지)
- 워커 티어에서 생성 · **실패 격리**

### 저장 / 다운로드

- S3 → `diagnosis/{id}.docx` · `diagnosis/{id}.pdf`
- **BFF 프록시 다운로드** 라우트 + UI 메뉴
- 생성 일시 **KST** 표기

:::

::: right

### 리포트 라이프사이클

- 자동 제목 (워커 LLM 1회, 격리)
- 태그 자동 제안 + 수동 편집
- 제목 수정 · **소프트 삭제** (`deleted_at`)
- 읽기 경로 = `deleted_at IS NULL`
- PATCH / DELETE = **fail-closed** (owner | admin)

### XSS 안전

> title / tags는 React-escape 렌더
> (raw HTML 주입 없음)

:::

:::notes
{timing: 2min}
완성된 리포트는 워커가 직접 문서로 내보냅니다.

DOCX는 python-docx로, PDF는 chromium과 playwright로 렌더링합니다. 한글이 깨지지 않도록 Noto CJK 폰트를 워커 이미지에 포함했습니다. 내보내기는 워커 티어에서 실행되고, 실패해도 본 리포트 생성과 격리되어 영향을 주지 않습니다. 과거의 브라우저 Print-to-PDF 방식을 대체한 것입니다.

{cue: pause}

생성된 파일은 S3의 `diagnosis/{id}.docx`와 `.pdf` 경로에 저장되고, BFF 프록시 라우트로 다운로드합니다. 생성 일시는 KST로 표기됩니다.

라이프사이클 측면에서는 자동 제목과 태그 제안, 제목 수정, 소프트 삭제를 지원합니다. 읽기 경로는 `deleted_at IS NULL`을 전제로 하고, 수정과 삭제는 owner 또는 admin만 가능한 fail-closed입니다. 제목과 태그는 React-escape로 렌더해 XSS 위험을 차단합니다.

{cue: transition}
데모에서 Datasources와 EKS 화면도 짚어보겠습니다.
:::

---

<!-- Slide 8: Datasources & EKS in the Demo -->

@type: content
@transition: slide

# Datasources & EKS

::: left

### Datasources Explore (`/datasources`)

- **read-only 커넥터 플랫폼** (5종)
- ClickHouse · Prometheus · Loki · Tempo · Mimir
- 커넥터 Lambda + **Aurora schema cache**
- **NL → query** + 챗 주입(injection)

:::

::: right

### EKS 페이지 (read-only)

- in-cluster 조회: **nodes / pods / deploy / svc**
- task-role **Access Entry + AmazonEKSViewPolicy**
- **presigned STS** 토큰 · BFF-direct
- access 배지 + CLI 가이드

### 공통 원칙

> 외부 관측성·클러스터 = **READ만**
> (변경·자율 없음)

:::

:::notes
{timing: 2min}
데모에서 두 가지 화면을 더 보겠습니다.

먼저 `/datasources` Explore 페이지입니다. AWSops는 ClickHouse, Prometheus, Loki, Tempo, Mimir 5종을 read-only 커넥터 플랫폼으로 통합합니다. 각 커넥터 Lambda가 데이터를 가져오고, 스키마는 Aurora에 캐시됩니다. 자연어를 쿼리로 변환하는 NL-to-query를 지원하고, 그 결과를 챗에 주입해 분석에 활용할 수 있습니다.

{cue: pause}

EKS 페이지도 read-only입니다. 클러스터 안의 nodes, pods, deployment, service를 조회합니다. 권한은 web task role에 부여된 Access Entry와 AmazonEKSViewPolicy, 그리고 presigned STS 토큰으로 처리하고, BFF가 직접 호출합니다. 접근 가능 여부는 배지로 표시하고, CLI 가이드도 함께 제공합니다.

{cue: emphasis}
공통 원칙은 동일합니다. 외부 관측성이든 클러스터든, 데이터는 읽기만 합니다.

{cue: transition}
배포 방법을 보겠습니다.
:::

---

<!-- Slide 9: Deployment -->

@type: content
@transition: slide

# Deployment

:::html
<div style="display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;gap:12px;align-items:stretch;">
  <div style="background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);border-radius:8px;padding:16px;min-height:220px;display:flex;flex-direction:column;">
    <div style="color:#00d4ff;font-weight:bold;font-size:14px;margin-bottom:12px;text-align:center;">1. Configure</div>
    <div style="flex:1;display:flex;flex-direction:column;gap:6px;justify-content:center;">
      <div style="background:rgba(0,212,255,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">make configure (TUI)</div>
      <div style="background:rgba(0,212,255,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">tfvars + backend.hcl</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;color:#00d4ff;font-size:24px;">→</div>
  <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:16px;min-height:220px;display:flex;flex-direction:column;">
    <div style="color:#f59e0b;font-weight:bold;font-size:14px;margin-bottom:12px;text-align:center;">2. Terraform</div>
    <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
      <div style="background:rgba(245,158,11,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">init (S3 backend)</div>
      <div style="background:rgba(245,158,11,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">plan -out tfplan</div>
      <div style="background:rgba(245,158,11,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">controller apply tfplan</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;color:#f59e0b;font-size:24px;">→</div>
  <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:16px;min-height:220px;display:flex;flex-direction:column;">
    <div style="color:#ef4444;font-weight:bold;font-size:14px;margin-bottom:12px;text-align:center;">3. make deploy</div>
    <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
      <div style="background:rgba(239,68,68,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">migrate (ULID)</div>
      <div style="background:rgba(239,68,68,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">buildx arm64 → ECR</div>
      <div style="background:rgba(239,68,68,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">ECS rolling</div>
      <div style="background:rgba(239,68,68,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">smoke /api/health</div>
    </div>
  </div>
  <div style="display:flex;align-items:center;color:#00ff88;font-size:24px;">→</div>
  <div style="background:rgba(0,255,136,0.1);border:1px solid rgba(0,255,136,0.3);border-radius:8px;padding:16px;min-height:220px;display:flex;flex-direction:column;">
    <div style="color:#00ff88;font-weight:bold;font-size:14px;margin-bottom:12px;text-align:center;">4. Flag-Gated</div>
    <div style="flex:1;display:flex;flex-direction:column;gap:6px;justify-content:center;">
      <div style="background:rgba(0,255,136,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">make agentcore</div>
      <div style="background:rgba(0,255,136,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">make workers</div>
      <div style="background:rgba(0,255,136,0.15);border-radius:6px;padding:8px;font-size:13px;text-align:center;">default off = $0</div>
    </div>
  </div>
</div>
:::

:::notes
{timing: 2min}
배포는 Terraform 기반이고, 네 단계로 정리됩니다.

먼저 `make configure`로 대화형 TUI를 돌려 VPC, 도메인, 버킷, EKS를 고르면 terraform.tfvars와 backend.hcl이 생성됩니다.

{cue: pause}

다음으로 Terraform을 init하고 plan을 tfplan으로 저장합니다. 공유 인프라에는 auto-approve를 쓰지 않고, 저장된 tfplan을 컨트롤러가 apply합니다. CloudFront나 Security Group처럼 오래 걸리는 apply는 서브에이전트 타임아웃 때문에 컨트롤러가 직접 실행합니다.

세 번째로 `make deploy`는 먼저 ULID 마이그레이션을 돌리고, arm64 이미지를 빌드해 ECR에 푸시한 뒤 ECS 롤링 배포를 하고, 마지막으로 `/api/health` 스모크로 검증합니다.

마지막으로 AgentCore와 워커는 flag-gated입니다. `make agentcore`, `make workers`로 활성화하며, 기본은 꺼져 있어 비용이 0입니다. 라이브 환경은 단일 계정 123456789012, 도메인 awsops-v2.example.com입니다.

{cue: transition}
마무리하겠습니다.
:::

---

<!-- Slide 10: Conclusion & Differentiators -->

@type: content
@transition: slide

# Conclusion & Differentiators

::: left

### AWSops가 제공하는 것

- **Read-only AWS 운영 대시보드** + AI 진단
- 자연어 챗 → 라이브 read-only 조회 (AgentCore MCP)
- 종합진단 리포트 (base 8 / deep 15 · Well-Architected)
- 인벤토리 · 토폴로지 · Datasources · EKS

### 핵심 차별점

- **in-account Bedrock** (외부 AI SaaS API 없음)
- **private edge** (공개 ALB 없음, CloudFront VPC Origin)
- OOM-safe 비동기 워커 티어

:::

::: right

### Read-Only 자세 (ADR-041)

- **AWS-리소스 변경 + 자율 = 영구 동결** (do-not-enable)
- 외부 관측성 **READ** 허용
- 외부 기록 / 티켓 / 메시지 **WRITE** 는 거버넌스 하 허용
  - SSRF · Secrets · DLP · human-gate · flag-OFF
- 변경되는 것은 **DATA**, AWS 리소스가 아님

### 시작하기

1. `make configure` → Terraform apply
2. `make deploy`
3. Cognito 사용자 추가 · `/login`
4. 어시스턴트에서 질문 시작

:::

:::notes
{timing: 2min}
AWSops를 정리하면, read-only AWS 운영 대시보드에 AI 진단을 결합한 제품입니다.

자연어로 물으면 AgentCore MCP 도구가 라이브 read-only 조회를 하고, 종합진단 리포트가 base 8섹션과 deep 15섹션으로 Well-Architected 관점의 진단을 제공합니다. 인벤토리, 토폴로지, Datasources, EKS 화면이 이를 뒷받침합니다.

{cue: pause}

차별점은 세 가지입니다. AI는 계정 안의 Bedrock으로 동작해 외부 AI SaaS API를 쓰지 않습니다. 엣지는 private edge라 공개 ALB가 없고 CloudFront VPC Origin으로만 들어옵니다. 무거운 작업은 OOM-safe 비동기 워커 티어가 처리합니다.

{cue: emphasis}

가장 중요한 원칙은 read-only 자세입니다. ADR-041 기준으로 AWS 리소스 변경과 자율 실행은 영구 동결입니다. 다만 외부 관측성 데이터를 읽고, 외부 기록이나 티켓, 메시지를 쓰는 것은 SSRF 방어, Secrets 관리, DLP, human-gate, flag-OFF 같은 거버넌스 아래에서 허용됩니다. 변경되는 것은 데이터일 뿐, AWS 리소스가 아닙니다.

시작은 간단합니다. configure하고 Terraform을 apply한 뒤 deploy하고, Cognito 사용자를 추가해 `/login`으로 들어오면 됩니다.

{cue: transition}
마지막 슬라이드입니다.
:::

---

<!-- Slide 11: Thank You -->

@type: cover
@transition: fade

# Thank You

## AWSops — AI-Powered AWS Operations Dashboard

Junseok Oh | Solutions Architect | AWS

:::notes
{timing: 1min}
감사합니다. 질문이 있으시면 지금 받겠습니다.

발표 후 추가 질문이 있으시면 언제든 연락 주세요. AWSops는 내부에서 계속 발전하고 있고, 새로운 기능이 지속적으로 추가되고 있습니다.

{cue: emphasis}
오늘 보여드린 하이브리드 라우팅, thin-BFF + 비동기 워커, read-only 진단 자세는 여러분의 프로젝트에도 적용할 수 있는 범용 아키텍처 패턴입니다.

감사합니다.
:::
