/**
 * build-awsops-intro-pptx.js — AWSops 고객 발표 덱 생성기 (60분: 발표 20 + 데모 25 + Q&A 15)
 *
 * static/presentation/awsops-intro/awsops-intro.pptx 의 재현 가능한 빌드 경로.
 * 웹 슬라이드(remarp 블록)와 별개로 제작되는 정식 덱이며, 웹 슬라이드 내용이 크게
 * 바뀌면 이 스크립트를 갱신해 다시 빌드하고 pptx를 교체 커밋한다.
 *
 * 사용법:
 *   npm ci            # pptxgenjs는 docs-site devDependency로 고정
 *   node scripts/pptx/build-awsops-intro-pptx.js [출력경로]
 *   # 기본 출력: static/presentation/awsops-intro/awsops-intro.pptx
 *
 * 디자인: AWS Light 테마(화이트 캔버스 · Pretendard · 퍼플→블루→그린 시그니처
 * 그라디언트) — ./deck_kit.js(벤더링된 AWS Korea V-team 라이트 킷) 기반.
 * Presenter: 오준석 / Solutions Architect / AWS
 */
const path = require("path");
const kit = require("./deck_kit.js");

const pres = kit.newDeck();
pres.author = "Junseok Oh";
pres.title = "AWSops — AI-Powered AWS Operations Dashboard";

const { C, FONT, W, PAD, autoH, safeText, icon, mkShadow, GRAD_PILL } = kit;
const CW = W - 2 * PAD; // 11.493

// 라이트 팔레트 액센트 (다크 덱의 도메인 색상 대응)
const A = {
  purple: C.purple,      // 핵심 강조 (구 subtitleOrange)
  blue: C.blue,          // 네트워크/인프라 (구 metaBlue)
  green: C.green,        // 데이터/신뢰 (구 openaiGreen)
  magenta: C.magenta,    // 워커/보안 (구 anthropicCoral)
  sky: C.gradBlue,       // 연동/외부 (구 azurePurple)
};

let pageNum = 1;

function newContent(title, subtitle) {
  const s = pres.addSlide();
  kit.applyBg(s);
  if (title) kit.addHeader(pres, s, title, subtitle);
  return s;
}

/** 하단 스탯 밴드 — 헤어라인 + 4개 수치 */
function addStatBand(s, stats) {
  s.addShape(pres.shapes.LINE, { x: PAD, y: 6.22, w: CW, h: 0, line: { color: C.hairline, width: 1 } });
  const gutter = 0.14;
  const w = (CW - gutter * 3) / 4;
  stats.forEach((st, i) => {
    const x = PAD + i * (w + gutter);
    s.addText(st.value, safeText({
      x, y: 6.32, w, h: 0.30,
      fontFace: FONT, fontSize: 16, bold: true, color: C.blueBright, charSpacing: -0.5, margin: 0, valign: "top",
    }));
    s.addText(st.label, safeText({
      x, y: 6.62, w, h: 0.38,
      fontFace: FONT, fontSize: 9, color: C.muted, margin: 0, valign: "top", lineSpacingMultiple: 1.1,
    }));
  });
}

/** 라이트 카드 (rounded, #F4F4F8) */
function card(s, x, y, w, h, opts = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: 0.1,
    fill: { color: opts.fill || C.card }, line: opts.border ? { color: opts.border, width: 1 } : { type: "none" },
    ...(opts.shadow ? { shadow: mkShadow() } : {}),
  });
}

/** 카드 좌측 컬러 노치 */
function notch(s, x, y, h, color) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y: y + 0.12, w: 0.07, h: h - 0.24, rectRadius: 0.03, fill: { color }, line: { type: "none" },
  });
}

/** 플로우 노드 — 흰 배경 + 컬러 보더 */
function flowNode(s, x, y, w, h, label, sub, accent, fillTint) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: fillTint || C.bg }, line: { color: accent || A.blue, width: 1.25 },
  });
  s.addText(label, safeText({
    x: x + 0.06, y: y + 0.10, w: w - 0.12, h: 0.34,
    fontFace: FONT, fontSize: 11, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0, charSpacing: -0.3,
  }));
  if (sub) s.addText(sub, safeText({
    x: x + 0.06, y: y + 0.44, w: w - 0.12, h: h - 0.52,
    fontFace: FONT, fontSize: 8.5, color: C.muted, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.15,
  }));
}

function flowArrow(s, x, y, w) {
  s.addShape(pres.shapes.LINE, {
    x, y, w, h: 0, line: { color: C.muted, width: 1.75, endArrowType: "triangle" },
  });
}

/** 그라디언트 필 헤더를 얹은 필러 카드 제목 */
function pillTitle(s, x, y, w, text) {
  // altText 필수 — pptxgenjs가 descr=altText||절대경로 를 기록(경로는 CI 파리티 파괴)
  s.addImage({ path: GRAD_PILL, x, y, w, h: 0.52, altText: "decorative gradient band" });
  s.addText(text, safeText({
    x, y, w, h: 0.52,
    fontFace: FONT, fontSize: 14, bold: true, color: "FFFFFF", align: "center", valign: "middle", charSpacing: 0.3, margin: 0,
  }));
}

const HIST = "\n\n[변경 이력]\n• 2026-08-11: 초기 작성\n• 2026-08-12: AWS Light 테마 재설계";

// ═════════════════════════ 1. COVER ═════════════════════════
kit.cover(pres, {
  product: "AWSops",
  subtitle: "AI 기반 AWS · Kubernetes 통합 운영 대시보드",
  presenter: { name: "오준석", title: "Solutions Architect", org: "AWS" },
  notes: `[요약]
• AWSops: AI 기반 AWS·K8s 통합 운영 대시보드
• 60분 구성 — 발표 20분 + 라이브 데모 25분 + Q&A 15분
• 핵심 키워드: 통합 가시성 · AI 진단 · 읽기 전용

안녕하세요, Solutions Architect 오준석입니다. 오늘은 AWSops라는 AI 기반 AWS·Kubernetes 통합 운영 대시보드를 소개해 드리겠습니다. 여러 계정에 흩어진 리소스와 이미 쓰고 계신 관측 도구를 하나의 읽기 전용 화면으로 모으고, 그 위에서 AI가 장애 원인과 비용 변동을 진단해 주는 플랫폼입니다. 앞의 20분은 문제 정의와 아키텍처, 이어지는 25분은 실제 운영 환경 라이브 데모, 마지막 15분은 질의응답으로 진행하겠습니다.` + HIST,
});

// ═════════════════════════ 2. AGENDA ═════════════════════════
kit.agenda(pres, {
  pageNum: ++pageNum,
  items: [
    { num: "01", title: "Why AWSops", desc: "새벽 3시의 장애 대응 · 운영팀 공통의 4대 페인", iconPath: icon("cloudwatch") },
    { num: "02", title: "AWSops 개요", desc: "읽기 전용 통합 대시보드 · 운영 동선 그대로의 기능 맵", iconPath: icon("aws_cloud") },
    { num: "03", title: "Architecture Deep Dive", desc: "프라이빗 엣지 · Bedrock AgentCore · 비동기 워커 · 안전 설계", iconPath: icon("gateway") },
    { num: "04", title: "핵심 가치 4", desc: "멀티계정 가시성 · 장애 RCA · 비용 원인 분석 · WA 자동 진단", iconPath: icon("evaluations") },
    { num: "05", title: "Live Demo & Q&A", desc: "실운영 환경 시나리오 4종 · 예상 질문 선답변", iconPath: icon("browser_tool") },
  ],
  notes: `[요약]
• 5개 챕터 — 문제 → 개요 → 아키텍처 → 가치 → 데모
• 발표 20분(챕터 1~4) + 데모 25분(챕터 5) + Q&A 15분

오늘 세션은 다섯 개 챕터로 진행합니다. 먼저 왜 이런 도구가 필요한지 운영 현장의 이야기로 시작하고, AWSops가 무엇인지 한 장으로 정리한 뒤, 아키텍처를 깊이 들여다보겠습니다. 이어서 네 가지 핵심 가치를 데모 시나리오와 연결해 설명드리고, 마지막 25분은 슬라이드가 아니라 실제 운영 중인 환경에서 라이브로 보여드리겠습니다.` + HIST,
});

// ═════════════════════════ 3. SECTION 1 ═════════════════════════
kit.sectionDivider(pres, {
  num: "01", title: "Why AWSops", kicker: "새벽 3시의 운영 현장", pageNum: ++pageNum,
  notes: `[요약]
• 운영 현장의 실제 경험담으로 문제 제기
• 페인 4개를 청중의 언어로 명명

첫 번째 챕터입니다. 기능 이야기 전에, 이 도구가 왜 만들어졌는지 — 운영 현장에서 실제로 겪는 새벽의 장애 대응 이야기부터 시작하겠습니다.` + HIST,
});

// ═════════════════════════ 4. HOOK ═════════════════════════
{
  const s = newContent("장애의 절반은 '이동 시간'이다", "새벽 장애 대응에서 시간을 잡아먹는 것은 진단이 아니라 콘솔 간 화면 이동");
  const nodes = [
    ["CloudWatch", "알람 수신", A.purple, C.purpleTint],
    ["EC2 · VPC 콘솔", "리소스 상태", A.blue, null],
    ["LB · TG 콘솔", "타깃 health", A.blue, null],
    ["kubectl / K9s", "파드 · 이벤트", A.blue, null],
    ["Grafana", "메트릭 대조", A.blue, null],
    ["Cost Explorer", "비용 영향", A.blue, null],
  ];
  const gap = 0.30, nw = (CW - gap * 5) / 6, nh = 1.0, y0 = 2.0;
  nodes.forEach((n, i) => {
    const x = PAD + i * (nw + gap);
    flowNode(s, x, y0, nw, nh, n[0], n[1], n[2], n[3]);
    if (i < nodes.length - 1) flowArrow(s, x + nw + 0.05, y0 + 0.5, gap - 0.10);
  });
  card(s, PAD, 3.45, CW, 1.75, { shadow: true });
  s.addText([
    { text: "운영자가 매번 반복하는 질문 — \"어디부터 봐야 하지?\"\n", options: { fontSize: 14, bold: true, color: C.ink, breakLine: true } },
    { text: "장애의 90%는 답이 어려운 게 아니라, 답이 있는 화면을 찾아가는 데 시간이 갑니다. 신호(알람·메트릭·이벤트·비용)는 각 도구에 다 있지만, 그 신호들을 한 자리에서 조합해 주는 상황판이 없습니다. MTTR의 대부분은 진단 시간이 아니라 콘솔과 콘솔 사이의 '이동 시간'입니다.", options: { fontSize: 12, color: C.body } },
  ], safeText({ x: PAD + 0.3, y: 3.68, w: CW - 0.6, h: 1.35, fontFace: FONT, margin: 0, valign: "top", lineSpacingMultiple: 1.3 }));
  addStatBand(s, [
    { value: "6+", label: "장애 1건에 오가는 콘솔 수 (현장 경험치)" },
    { value: "30분+", label: "원인이 있는 화면에 도달하기까지" },
    { value: "90%", label: "'어디를 볼까'에 쓰는 대응 시간 비중" },
    { value: "1개", label: "정작 필요했던 것 — 통합 상황판" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 장애 대응 시간의 대부분은 진단이 아닌 화면 이동
• 신호는 도구마다 있지만 조합하는 상황판이 부재
• MTTR 단축의 열쇠 = 이동 시간 제거

새벽에 알람을 받고, CloudWatch에서 시작해 EC2 콘솔, 로드밸런서 타깃 그룹, kubectl, Grafana, 비용 화면까지 여섯 개 화면을 오갑니다. 각 화면에는 신호가 다 있습니다. 문제는 그 신호를 조합하는 일이 전부 사람 머릿속에서 일어난다는 겁니다. 그래서 장애의 90%는 답이 어려운 게 아니라, 답이 있는 화면을 찾아가는 데 시간이 갑니다. MTTR의 대부분은 진단 시간이 아니라 이동 시간입니다. AWSops는 그날 제가 갖고 싶었던 화면을 만든 것입니다.

[약어]
• MTTR(Mean Time To Recovery): 장애 발생부터 복구까지의 평균 소요 시간

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 5. 4 PAINS ═════════════════════════
{
  const s = newContent("도구는 늘었는데, 상황판은 없다", "도구 파편화 · RCA 지연 · 비용 불명 · 멀티계정 — 운영팀 공통의 4대 페인");
  const pains = [
    ["도구 파편화", "콘솔·CloudWatch·Grafana·비용 도구가 따로 놀아 '한 화면'이 없음. 도구가 늘수록 컨텍스트 스위칭 비용만 증가", A.purple],
    ["장애 원인 파악 지연", "신호는 넘치는데 상관관계 조합은 사람 머릿속에서. 담당자의 경험에 따라 MTTR이 널뛰기", A.magenta],
    ["비용 급증 원인 불명", "청구서는 결과만 말하고 원인은 말하지 않음. '지난달보다 왜 올랐지?'에 답하려면 며칠씩 소요", A.green],
    ["멀티계정 · 대량 워크로드", "계정이 늘수록 가시성은 반비례. 계정 스위칭·SSO 재로그인이 일상이 되고 전체 현황은 아무도 모름", A.blue],
  ];
  const gw = 0.30, cw = (CW - gw) / 2, chh = 1.85;
  pains.forEach((p, i) => {
    const x = PAD + (i % 2) * (cw + gw);
    const y = 2.0 + Math.floor(i / 2) * (chh + 0.25);
    card(s, x, y, cw, chh, { shadow: true });
    notch(s, x + 0.10, y, chh, p[2]);
    s.addText(p[0], safeText({ x: x + 0.34, y: y + 0.22, w: cw - 0.58, h: 0.34, fontFace: FONT, fontSize: 15, bold: true, color: C.ink, charSpacing: -0.4, margin: 0 }));
    s.addText(p[1], safeText({ x: x + 0.34, y: y + 0.62, w: cw - 0.58, h: 1.05, fontFace: FONT, fontSize: 11, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.25 }));
  });
  addStatBand(s, [
    { value: "4/4", label: "오늘 화면으로 답할 페인의 수" },
    { value: "5+", label: "운영팀이 병행하는 관측 도구 (통상)" },
    { value: "수십 개", label: "엔터프라이즈 평균 AWS 계정 규모" },
    { value: "0", label: "이 넷을 한 화면에 모은 기존 도구" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 페인 4개: 파편화 · RCA 지연 · 비용 불명 · 멀티계정
• 오늘 발표는 이 4개에 각각 화면으로 답하는 구조

이 네 가지는 제가 고른 것이 아니라, 운영하시는 분들을 만나면 항상 같은 순서로 나오는 이야기입니다. 첫째, 도구는 늘었는데 상황판이 없습니다. 둘째, 장애 신호는 넘치는데 조합은 여전히 사람 몫이라 원인 파악이 늦습니다. 셋째, 비용 청구서는 결과만 말하고 원인은 말하지 않습니다. 넷째, 계정이 늘수록 가시성은 반비례합니다. 오늘 발표의 구조는 단순합니다 — 이 네 가지 페인에 각각 실제 화면으로 답을 드리는 것입니다.

[약어]
• RCA(Root Cause Analysis): 장애·이상 현상의 근본 원인 분석

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 6. SECTION 2 ═════════════════════════
kit.sectionDivider(pres, {
  num: "02", title: "AWSops 개요", kicker: "읽기 전용 통합 대시보드", pageNum: ++pageNum,
  notes: `[요약]
• AWSops 한 문장 정의와 기능 맵 소개

두 번째 챕터입니다. AWSops가 무엇인지 한 문장으로 정의하고, 전체 기능을 운영 동선 관점에서 훑어보겠습니다.` + HIST,
});

// ═════════════════════════ 7. WHAT IS AWSOPS ═════════════════════════
{
  const s = newContent("흩어진 계정과 도구를, 한 화면으로", "멀티계정 리소스·기존 관측 자산·AI 진단을 묶는 읽기 전용 통합 운영 플랫폼");
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: PAD, y: 1.95, w: CW, h: 0.95, rectRadius: 0.1, fill: { color: C.blueTint }, line: { type: "none" } });
  s.addText("\"여러 계정에 흩어진 AWS 리소스와 이미 쓰고 있는 관측 도구를 하나의 읽기 전용 대시보드로 모으고, 그 위에서 AI가 장애 원인과 비용 변동을 운영자의 언어로 진단한다.\"", safeText({
    x: PAD + 0.35, y: 2.05, w: CW - 0.7, h: 0.75, fontFace: FONT, fontSize: 13.5, bold: true, italic: true, color: C.ink, margin: 0, valign: "middle", lineSpacingMultiple: 1.25,
  }));
  const cols = [
    ["통합", "INTEGRATION", "멀티계정 인벤토리·비용·보안·EKS를 계정/리전 스코프 셀렉터 하나로. Prometheus·ClickHouse 등 외부 관측 도구는 커넥터로 흡수 — 갈아엎지 않고 얹는다"],
    ["AI 진단", "DIAGNOSIS", "도메인별 전문 에이전트가 라이브 AWS 데이터를 직접 조회해 분석. 장애 RCA·비용 원인·Well-Architected 6기둥 리포트를 대화와 자동 리포트로"],
    ["읽기 전용", "TRUST", "모니터링 대상 계정은 읽기 전용으로만 조회. 변경·자동 조치는 거버넌스로 동결(단일 문서화 예외: 자기 웹 재시작, 기본 꺼짐). K8s는 읽기 verb만 — 안심하고 전 계정을 연결하는 근거"],
  ];
  const gw2 = 0.35, cw = (CW - gw2 * 2) / 3, cy = 3.55, chh = 2.45;
  cols.forEach((c, i) => {
    const x = PAD + i * (cw + gw2);
    card(s, x, cy, cw, chh, { shadow: true });
    pillTitle(s, x + 0.18, cy - 0.24, cw - 0.36, c[0]);
    s.addText(c[1], safeText({ x: x + 0.22, y: cy + 0.42, w: cw - 0.44, h: 0.22, fontFace: FONT, fontSize: 8.5, bold: true, color: C.muted, charSpacing: 1.5, margin: 0 }));
    s.addText(c[2], safeText({ x: x + 0.22, y: cy + 0.68, w: cw - 0.44, h: 1.62, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.25 }));
  });
  addStatBand(s, [
    { value: "16", label: "AI 챗 섹션 키 (정의 기준 — 게이트/플래그 의존)" },
    { value: "9", label: "도메인 전문 에이전트 게이트웨이" },
    { value: "8종", label: "외부 관측 데이터소스 (등록 기준)" },
    { value: "read-only", label: "모니터링 대상 계정 조회 원칙" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 정의: 멀티계정 + 외부 도구 + AI 진단의 읽기 전용 통합
• 키워드 3개 — 통합 · AI 진단 · 읽기 전용
• 기존 관측 도구는 대체가 아니라 연동

AWSops를 한 문장으로 정의하면 화면의 인용문과 같습니다. 키워드는 세 개입니다. 첫째 '통합' — 계정과 리전을 스코프 셀렉터 하나로 넘나들고, 이미 쓰고 계신 Prometheus나 ClickHouse 같은 도구는 커넥터로 흡수합니다. 갈아엎는 것이 아니라 얹는 것입니다. 둘째 'AI 진단' — 범용 챗봇이 아니라 도메인별 전문 에이전트가 라이브 데이터를 직접 조회해 분석합니다. 셋째 '읽기 전용' — 변경 기능이 코드 레벨에서 동결되어 있어서, 전 계정을 안심하고 연결할 수 있습니다. 이 세 키워드가 오늘 발표 전체를 관통합니다.

[출처]
• AWSops 아키텍처 문서 — 리포지토리 docs/architecture.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 8. FEATURE MAP ═════════════════════════
{
  const s = newContent("새벽 3시에 여는 화면만 모았다", "개요부터 EKS 드릴다운까지 — 운영 동선 그대로의 메뉴 구성");
  const menus = [
    ["개요", "AI 인사이트 · 보안 히어로 · 비용 KPI", A.purple],
    ["AI 진단", "WA 6기둥 리포트 · 건강 점수", A.purple],
    ["어시스턴트", "16개 섹션 AI 챗 · 슬래시 라우팅", A.purple],
    ["비용", "MoM · 서비스/usage-type 드릴다운", A.green],
    ["토폴로지", "요청 흐름 · 인프라 배치 · 서비스 맵", A.blue],
    ["네트워크 플로우", "NFM top-contributor · E2E 홉 경로", A.blue],
    ["보안", "Public S3 · Open SG · CVE · MFA", A.magenta],
    ["컴플라이언스", "CIS 벤치마크 실행 · 이력 관리", A.magenta],
    ["EKS", "클러스터 7탭 드릴다운 · OpenCost", A.green],
    ["통합 모니터링", "EC2/RDS 플릿 라이브 메트릭", A.blue],
    ["연동", "데이터소스 8종 · 커넥터 · 스킬", A.sky],
    ["계정 관리", "크로스계정 등록 + 즉시 검증", A.sky],
  ];
  const gw3 = 0.18, cw = (CW - gw3 * 3) / 4, chh = 0.92;
  menus.forEach((m, i) => {
    const x = PAD + (i % 4) * (cw + gw3);
    const y = 2.0 + Math.floor(i / 4) * (chh + 0.20);
    card(s, x, y, cw, chh);
    notch(s, x + 0.08, y, chh, m[2]);
    s.addText(m[0], safeText({ x: x + 0.28, y: y + 0.12, w: cw - 0.44, h: 0.26, fontFace: FONT, fontSize: 11.5, bold: true, color: C.ink, charSpacing: -0.3, margin: 0 }));
    s.addText(m[1], safeText({ x: x + 0.28, y: y + 0.42, w: cw - 0.44, h: 0.42, fontFace: FONT, fontSize: 8.5, color: C.muted, margin: 0, valign: "top", lineSpacingMultiple: 1.1 }));
  });
  addStatBand(s, [
    { value: "12", label: "상단 고정 메뉴 수" },
    { value: "5종", label: "네트워크 분석 메뉴 (NFM · DNS · IP …)" },
    { value: "7탭", label: "EKS 클러스터 드릴다운 탭" },
    { value: "Cmd-K", label: "페이지·리소스 유형 즉시 이동 팔레트" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 12개 상단 메뉴 — 운영 동선(현황→진단→조치 근거) 순서
• 네트워크 5종 메뉴 · EKS 7탭 드릴다운 포함
• Cmd-K 팔레트로 페이지·리소스 유형 즉시 이동

전체 기능을 메뉴 단위로 보면 이렇습니다. 왼쪽 위부터 — 접속하면 개요 대시보드에서 AI 인사이트와 보안 이슈, 비용 흐름을 한눈에 봅니다. 문제가 보이면 토폴로지와 네트워크 플로우로 내려가고, 비용이 이상하면 비용 메뉴에서 드릴다운합니다. 판단이 어려우면 어시스턴트에게 물어보고, 주기적인 건강 관리는 AI 진단 리포트가 담당합니다. EKS는 클러스터별 7개 탭으로 파드 단위까지 내려가고, 연동 메뉴에서 기존 관측 도구를 등록합니다. 중요한 것은 이 메뉴 순서가 실제 운영 동선이라는 점입니다 — 새벽에 여는 화면 순서 그대로입니다.

[약어]
• NFM(Network Flow Monitor): CloudWatch 기반 네트워크 플로우 관측 서비스
• WA(Well-Architected): AWS 6기둥 아키텍처 모범사례 프레임워크

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 9. SECTION 3 ═════════════════════════
kit.sectionDivider(pres, {
  num: "03", title: "Architecture Deep Dive", kicker: "프라이빗 엣지 · AgentCore · 비동기 워커", pageNum: ++pageNum,
  notes: `[요약]
• 아키텍처 4계층: 엣지 · 웹/데이터 · AI · 워커
• 실무 관점의 안전 설계 근거 제시

세 번째 챕터, 아키텍처입니다. 전체 그림 한 장을 먼저 보고, 프라이빗 엣지 · AI 레이어 · 비동기 워커 · 안전 설계 순으로 깊이 들어가겠습니다.` + HIST,
});

// ═════════════════════════ 10. ARCHITECTURE DIAGRAM ═════════════════════════
{
  const s = newContent("한 장으로 보는 AWSops", "프라이빗 엣지 → thin-BFF → Aurora, 그리고 AI 레이어·워커의 분리 구조");
  // 좌측: 요청 경로 + 3 서브시스템 다이어그램
  card(s, PAD, 1.95, 6.45, 4.05, { fill: C.cardSoft, border: C.hairline });
  const ra = [
    ["운영자", C.muted], ["CloudFront\n엣지 인증", A.purple],
    ["내부 ALB", A.blue], ["Fargate 웹", A.green], ["Aurora", A.green],
  ];
  const rag = 0.18, raw = (6.45 - 0.3 - rag * 4) / 5, ray = 2.18;
  ra.forEach((n, i) => {
    const x = PAD + 0.15 + i * (raw + rag);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: ray, w: raw, h: 0.62, rectRadius: 0.06, fill: { color: C.bg }, line: { color: n[1], width: 1.25 } });
    s.addText(n[0], safeText({ x, y: ray, w: raw, h: 0.62, fontFace: FONT, fontSize: 8.5, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0 }));
    if (i < ra.length - 1) flowArrow(s, x + raw + 0.02, ray + 0.31, rag - 0.04);
  });
  s.addText("프라이빗 엣지 — 퍼블릭 ALB 없음 (VPC Origin 전용)", {
    x: PAD + 0.15, y: 2.88, w: 6.1, h: 0.24, fontFace: FONT, fontSize: 8.5, color: C.muted, margin: 0,
  });
  const rb = [
    ["AI — AgentCore", "게이트웨이 9종 + Bedrock\n→ 멀티계정 Read-Only 조회", A.purple],
    ["비동기 워커", "SQS + Step Functions\n→ Lambda / Fargate 분석", A.magenta],
    ["외부 관측 연동", "Prometheus · ClickHouse\n등 8종 read-only", A.sky],
  ];
  const rbg = 0.2, rbw = (6.45 - 0.3 - rbg * 2) / 3, rby = 3.55;
  rb.forEach((n, i) => {
    const x = PAD + 0.15 + i * (rbw + rbg);
    s.addShape(pres.shapes.LINE, { x: x + rbw / 2, y: rby - 0.32, w: 0, h: 0.28, line: { color: C.muted, width: 1.5, endArrowType: "triangle" } });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: rby, w: rbw, h: 1.42, rectRadius: 0.06, fill: { color: C.bg }, line: { color: n[2], width: 1.25 } });
    s.addText(n[0], safeText({ x: x + 0.08, y: rby + 0.12, w: rbw - 0.16, h: 0.28, fontFace: FONT, fontSize: 9.5, bold: true, color: C.ink, align: "center", margin: 0 }));
    s.addText(n[1], safeText({ x: x + 0.08, y: rby + 0.46, w: rbw - 0.16, h: 0.88, fontFace: FONT, fontSize: 8.5, color: C.muted, align: "center", valign: "top", margin: 0, lineSpacingMultiple: 1.2 }));
  });
  s.addText("모니터링 대상 계정 조회는 읽기 전용 API — 변경 기능은 거버넌스 동결", {
    x: PAD + 0.15, y: 5.55, w: 6.1, h: 0.26, fontFace: FONT, fontSize: 8.5, bold: true, color: C.body, margin: 0,
  });
  // 우측: 4 레이어 요약
  const layers = [
    ["엣지", "CloudFront VPC Origin → 내부 ALB → Fargate. 퍼블릭 ALB 없음", A.blue],
    ["웹 · 데이터", "Next.js thin-BFF + Aurora Serverless v2. 무거운 일은 큐로", A.green],
    ["AI", "Bedrock AgentCore — 게이트웨이 9종이 라이브 AWS 조회", A.purple],
    ["워커", "SQS + Step Functions — Lambda/Fargate 비동기 분석", A.magenta],
  ];
  const lx = PAD + 6.75, lw = CW - 6.75;
  layers.forEach((l, i) => {
    const y = 1.95 + i * 1.05;
    card(s, lx, y, lw, 0.9);
    notch(s, lx + 0.08, y, 0.9, l[2]);
    s.addText(l[0], safeText({ x: lx + 0.3, y: y + 0.12, w: lw - 0.5, h: 0.26, fontFace: FONT, fontSize: 12, bold: true, color: C.ink, margin: 0 }));
    s.addText(l[1], safeText({ x: lx + 0.3, y: y + 0.42, w: lw - 0.5, h: 0.42, fontFace: FONT, fontSize: 9.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.15 }));
  });
  addStatBand(s, [
    { value: "0", label: "퍼블릭 로드밸런서 (진입은 CloudFront만)" },
    { value: "9", label: "AI 도메인 게이트웨이 (MCP 도구)" },
    { value: "2-tier", label: "워커 런타임 — Lambda + Fargate" },
    { value: "IaC", label: "Terraform 단일 루트 + 멱등 프로비저너 · 플래그 게이트" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 요청 경로: 사용자 → CloudFront → VPC Origin → 내부 ALB → Fargate
• 상태는 Aurora, AI는 AgentCore, 무거운 분석은 비동기 워커
• 모니터링 대상 계정은 읽기 전용 API로만 조회

전체 그림입니다. 왼쪽 사용자부터 오른쪽으로 — 모든 요청은 CloudFront를 지나 VPC Origin이라는 비공개 통로로 내부 ALB, 그리고 Fargate 웹 대시보드에 도달합니다. 대시보드의 상태는 Aurora에 저장되고, 무거운 분석 작업은 SQS와 Step Functions 기반 워커로 분리됩니다. 오른쪽 위 AI 레이어는 Bedrock AgentCore 위에 도메인별 게이트웨이 9종이 올라가 있고, 모니터링 대상 계정들을 읽기 전용 API로만 조회합니다. 아래 외부 관측 도구는 커넥터로 연결됩니다. 이 구조 전체가 Terraform 코드로 관리되고, 대형 기능은 플래그로 게이트되어 있습니다. 이제 각 계층을 하나씩 보겠습니다.

[약어]
• BFF(Backend for Frontend): 프런트엔드 전용 경량 백엔드 계층
• MCP(Model Context Protocol): AI 에이전트가 도구를 호출하는 표준 프로토콜

[출처]
• AWSops 아키텍처 문서 — 리포지토리 docs/architecture.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 11. PRIVATE EDGE ═════════════════════════
{
  const s = newContent("퍼블릭 로드밸런서가 없다", "CloudFront VPC Origin 전용 경로 + 엣지 RS256 서명 검증의 폐쇄형 진입 구조");
  const nodes = [
    ["CloudFront", "TLS 종단 + Lambda@Edge", A.purple, C.purpleTint],
    ["VPC Origin", "https-only 비공개 통로", A.blue, null],
    ["내부 ALB", "CloudFront SG만 허용", A.blue, null],
    ["Fargate 웹", "thin-BFF :3000", A.green, null],
  ];
  const gap = 0.55, nw = (CW - gap * 3) / 4, nh = 1.05, y0 = 2.0;
  nodes.forEach((n, i) => {
    const x = PAD + i * (nw + gap);
    flowNode(s, x, y0, nw, nh, n[0], n[1], n[2], n[3]);
    if (i < nodes.length - 1) flowArrow(s, x + nw + 0.08, y0 + 0.52, gap - 0.16);
  });
  const pts = [
    ["엣지에서 끝나는 인증", "앱 경로 요청은 Lambda@Edge가 RS256 서명·발급자·만료를 검증(정적 자산·health 등 소수 경로 제외). 통과 못 하면 오리진에 닿기 전에 로그인으로 회송"],
    ["자체 /login 폼 로그인", "자체 로그인 폼 → Cognito 인증으로 세션 토큰 발급(12시간). 클라이언트 시크릿 없는 공개 클라이언트, Hosted UI PKCE는 폴백으로 보존. 서명 검증은 JWKS 공개키 기반"],
    ["저장 데이터 보호", "Aurora는 KMS CMK 암호화 + RDS 관리형 시크릿. 자격증명 하드코딩 없음"],
  ];
  pts.forEach((p, i) => {
    const y = 3.5 + i * 0.85;
    s.addShape(pres.shapes.OVAL, { x: PAD + 0.02, y: y + 0.06, w: 0.14, h: 0.14, fill: { color: A.purple }, line: { type: "none" } });
    s.addText([
      { text: p[0] + " — ", options: { fontSize: 12, bold: true, color: C.ink } },
      { text: p[1], options: { fontSize: 11, color: C.body } },
    ], safeText({ x: PAD + 0.3, y, w: CW - 0.3, h: 0.80, fontFace: FONT, margin: 0, valign: "top", lineSpacingMultiple: 1.2 }));
  });
  addStatBand(s, [
    { value: "0", label: "인터넷 노출 로드밸런서" },
    { value: "RS256", label: "엣지 토큰 서명 검증 알고리즘" },
    { value: "12h", label: "세션 토큰 유효 시간" },
    { value: "KMS", label: "Aurora 저장 데이터 암호화" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 공개 진입점 0 — CloudFront VPC Origin 전용 경로
• 인증은 엣지에서 종료(RS256 JWKS + PKCE)
• Aurora KMS 암호화 + 관리형 시크릿

보안 담당자분들이 가장 먼저 물어보시는 부분입니다. AWSops에는 인터넷에 노출된 로드밸런서가 아예 없습니다. 유일한 진입점은 CloudFront이고, 거기서 VPC Origin이라는 비공개 통로로만 내부 ALB에 도달합니다. 내부 ALB의 보안 그룹도 CloudFront 관리형 그룹에서 오는 443만 허용합니다. 인증은 엣지에서 끝납니다 — 앱 경로 요청의 토큰 서명을 Lambda@Edge가 RS256으로 검증하고, 실패하면 오리진에 닿기 전에 로그인 페이지로 돌려보냅니다. 로그인은 자체 /login 폼에서 Cognito로 인증하는 방식이고(클라이언트 시크릿 없음, Hosted UI PKCE는 폴백), 저장 데이터는 KMS로 암호화됩니다. 운영 데이터를 다루는 도구이기 때문에, 진입 구조부터 폐쇄형으로 설계했습니다.

[약어]
• PKCE(Proof Key for Code Exchange): 시크릿 없는 공개 클라이언트를 위한 OAuth 확장
• JWKS(JSON Web Key Set): 토큰 서명 검증용 공개키 집합
• CMK(Customer Managed Key): 고객 관리형 KMS 암호화 키

[출처]
• AWSops 결정 기준선 — 리포지토리 docs/decisions/BASELINE.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 12. AI LAYER ═════════════════════════
{
  const s = newContent("범용 챗봇이 아니라, 전문 에이전트 9팀", "Bedrock AgentCore 게이트웨이 9종 + 챗 섹션 16키의 도메인 분업 구조");
  s.addText("도메인 게이트웨이 9종 — 각자 전문 도구를 들고 라이브 AWS 데이터를 직접 조회", {
    x: PAD, y: 1.92, w: CW, h: 0.26, fontFace: FONT, fontSize: 11.5, bold: true, color: C.body, margin: 0,
  });
  const gws = ["Network", "Container", "Data", "Security", "Cost", "Monitoring", "IaC", "Ops", "External-Obs"];
  const ggap = 0.12, gw4 = (CW - ggap * 8) / 9;
  gws.forEach((g, i) => {
    const x = PAD + i * (gw4 + ggap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.24, w: gw4, h: 0.55, rectRadius: 0.06, fill: { color: C.purpleTint }, line: { color: A.purple, width: 1 } });
    s.addText(g, safeText({ x, y: 2.24, w: gw4, h: 0.55, fontFace: FONT, fontSize: 9, bold: true, color: C.ink, align: "center", valign: "middle", margin: 0 }));
  });
  const cols = [
    ["대화형 어시스턴트", "ai_agent", "자연어 질문을 자동 라우팅하거나 슬래시(/)로 섹션을 지정. \"두 리소스 간 통신이 안 되는 원인\", \"이 IAM 역할 과다권한 점검\" 같은 운영 질문에 라이브 근거로 답변", A.blue],
    ["aws-data — 리소스 질의 섹션", "aws_cloud", "\"리전별 EC2 몇 개야?\" 같은 수량·목록 질문을 받는 generic 섹션. 라이브 AWS 조회는 AgentCore 게이트웨이 경유가 원칙(ADR-001/010) — 별도 SQL 라이브 실행 경로는 설계상 차단", A.green],
    ["전문 섹션 6종 (자동 수집형 설계)", "evaluations", "유휴 리소스 스캔 · EKS/DB/MSK 최적화 · 지연 분석 · 인시던트 — 근거 데이터를 먼저 모으고 분석하는 설계 — 현재는 설계 원칙(ADR-001/010)에 따라 비활성, 표준 라우팅으로 대응. 총 16개 챗 섹션 구성", A.magenta],
  ];
  const gw5 = 0.35, cw = (CW - gw5 * 2) / 3, cy = 3.15, chh = 2.85;
  cols.forEach((c, i) => {
    const x = PAD + i * (cw + gw5);
    card(s, x, cy, cw, chh, { shadow: true });
    notch(s, x + 0.10, cy, chh, c[3]);
    s.addImage({ path: icon(c[1]), x: x + 0.30, y: cy + 0.24, w: 0.48, h: 0.48, altText: c[1] + " icon" });
    s.addText(c[0], safeText({ x: x + 0.92, y: cy + 0.22, w: cw - 1.14, h: 0.60, fontFace: FONT, fontSize: 12.5, bold: true, color: C.ink, charSpacing: -0.3, margin: 0, valign: "middle", lineSpacingMultiple: 1.1 }));
    s.addText(c[2], safeText({ x: x + 0.30, y: cy + 0.94, w: cw - 0.56, h: 1.78, fontFace: FONT, fontSize: 10, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.25 }));
  });
  addStatBand(s, [
    { value: "9", label: "AgentCore 게이트웨이 (MCP 도구)" },
    { value: "16", label: "챗 섹션 키 (게이트웨이 9 + 로컬 7)" },
    { value: "3", label: "Bedrock 모델 티어 (상위·표준·경량)" },
    { value: "in-account", label: "Bedrock 계정 내 AI 호출 — 외부 AI SaaS 없음" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 도메인별 게이트웨이 9종이 각자 전문 도구로 라이브 조회
• 챗 16섹션 정의 = 게이트웨이 9 + aws-data + 전문 섹션 6 (로컬 7종은 현재 비활성 — 표준 라우팅 대응)
• 라이브 AWS 조회는 AgentCore 게이트웨이 경유 원칙

AI 레이어의 핵심은 '분업'입니다. 범용 챗봇 하나가 모든 질문을 받는 게 아니라, 네트워크·컨테이너·데이터·보안·비용·모니터링·IaC·운영·외부관측 아홉 개 도메인 게이트웨이가 각자 전문 도구를 들고 있습니다. 질문이 오면 해당 도메인 에이전트가 라이브 AWS 데이터를 직접 조회해서 답합니다. 여기에 두 가지가 더 있습니다. aws-data는 리소스 수량·목록 질문을 받는 generic 섹션이고 — 라이브 AWS 조회는 어디까지나 AgentCore 게이트웨이 경유가 원칙입니다. 그리고 유휴 리소스 스캔이나 인시던트 분석 같은 여섯 개 전문 섹션은 근거 데이터를 먼저 모으고 분석하는 자동 수집형 설계입니다 — 이 경로는 현재 설계 원칙(ADR-001/010)에 따라 비활성이며 해당 질문은 표준 라우팅이 대응합니다. 합쳐서 16개 섹션 정의입니다. 모델은 Bedrock의 Claude 계열을 용도별로 혼용합니다.

[약어]
• MCP(Model Context Protocol): AI 에이전트가 도구를 호출하는 표준 프로토콜
• MSK(Managed Streaming for Apache Kafka): AWS 관리형 Kafka 서비스

[출처]
• AWSops 결정 기준선 — 리포지토리 docs/decisions/BASELINE.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 13. ASYNC WORKERS ═════════════════════════
{
  const s = newContent("무거운 진단이 화면을 죽이지 않는다", "SQS · Step Functions 비동기 워커로 분석과 대시보드를 분리한 OOM-안전 구조");
  const nodes = [
    ["웹 BFF", "작업 접수 즉시 응답", A.green, null],
    ["SQS", "큐잉 + 킬스위치", A.blue, null],
    ["Dispatcher", "멱등 디스패치", A.blue, null],
    ["Step Functions", "런타임 선택 분기", A.purple, C.purpleTint],
    ["Lambda / Fargate", "짧은 작업 / 긴·무거운 작업", A.magenta, null],
  ];
  const gap = 0.42, nw = (CW - gap * 4) / 5, nh = 1.05, y0 = 2.0;
  nodes.forEach((n, i) => {
    const x = PAD + i * (nw + gap);
    flowNode(s, x, y0, nw, nh, n[0], n[1], n[2], n[3]);
    if (i < nodes.length - 1) flowArrow(s, x + nw + 0.07, y0 + 0.52, gap - 0.14);
  });
  const pts = [
    ["장애 격리", "15+1섹션 심층 진단·CIS 벤치마크처럼 무겁고 긴 작업이 워커에서 실패해도 대시보드 가용성에는 영향 없음 — 웹은 접수만 하고 즉시 응답"],
    ["끝까지 정합", "모든 작업은 상태 원장에 기록되고, 5분 주기 reaper가 유실·고아 작업을 정리. 실패는 실패로 정확히 남음"],
    ["이중 런타임", "짧은 작업은 Lambda, 메모리를 크게 쓰는 작업은 Fargate — 작업 성격에 따라 Step Functions가 자동 선택"],
  ];
  pts.forEach((p, i) => {
    const y = 3.5 + i * 0.85;
    s.addShape(pres.shapes.OVAL, { x: PAD + 0.02, y: y + 0.06, w: 0.14, h: 0.14, fill: { color: A.magenta }, line: { type: "none" } });
    s.addText([
      { text: p[0] + " — ", options: { fontSize: 12, bold: true, color: C.ink } },
      { text: p[1], options: { fontSize: 11, color: C.body } },
    ], safeText({ x: PAD + 0.3, y, w: CW - 0.3, h: 0.80, fontFace: FONT, margin: 0, valign: "top", lineSpacingMultiple: 1.2 }));
  });
  addStatBand(s, [
    { value: "2", label: "워커 런타임 — Lambda + Fargate" },
    { value: "5분", label: "reaper 상태 정합화 주기" },
    { value: "15+1", label: "Deep 진단 리포트 섹션 수 (의도 대비 실제 포함)" },
    { value: "0", label: "워커 장애의 웹 가용성 영향" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 웹은 접수만, 분석은 SQS→Step Functions 워커가 수행
• 워커가 죽어도 대시보드는 무영향 (장애 격리)
• 작업 상태 원장 + 5분 reaper로 끝까지 정합

운영 도구가 흔히 겪는 함정이 있습니다 — 진단 기능을 붙였더니 진단이 무거워서 도구 자체가 죽는 경우입니다. AWSops는 처음부터 이를 구조로 풀었습니다. 웹 대시보드는 작업을 접수만 하고 즉시 응답합니다. 실제 분석은 SQS 큐를 지나 Step Functions가 작업 성격에 따라 Lambda 또는 Fargate 워커를 골라 실행합니다. 15+1섹션짜리 심층 진단이나 CIS 벤치마크처럼 몇 분씩 걸리는 작업이 워커에서 메모리 부족으로 죽어도, 여러분이 보고 있는 화면에는 아무 일도 일어나지 않습니다. 모든 작업은 상태 원장에 기록되고 5분마다 reaper가 유실된 작업을 정리해서, 성공은 성공으로 실패는 실패로 정확히 남습니다.

[약어]
• OOM(Out Of Memory): 메모리 고갈로 인한 프로세스 강제 종료
• ESM(Event Source Mapping): Lambda와 큐를 잇는 트리거 연결(킬스위치 지점)

[출처]
• AWSops 워커 레퍼런스 — 리포지토리 docs/reference/06-workers.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 14. READ-ONLY TRUST ═════════════════════════
{
  const s = newContent("읽기 전용은 제약이 아니라 신뢰다", "변경 기능 코드 동결 + K8s 읽기 verb 한정 + 계정당 ReadOnly 역할 1개의 안전 설계");
  const cols = [
    ["거버넌스로 동결", "변경·자동 조치·코드 배포 기능은 아키텍처 결정 기록(ADR)으로 동결 — 해제는 별도 승인 절차가 필요한 제품 결정. 단일 문서화 예외(ADR-015): 시크릿 회전 시 자기 웹 서비스 재시작(기본 꺼짐, IAM 1개 ARN 한정)", A.purple],
    ["K8s는 읽기 verb만", "런타임 조회는 read-only verb(get·list·watch)만 발행 + BFF kind 허용목록으로 추가 제한. 온보딩은 opt-in Access Entry + AWS 관리형 read-only 정책 부여(제어부 권한 설정) — 워크로드 오브젝트는 변경하지 않음", A.green],
    ["계정 연결 = 역할 1개", "모니터링 대상 계정에는 ReadOnly 역할 하나만 요구. 3rd-party 연결은 ExternalId 필수로 혼동 대리인 차단(1st-party는 역할 ARN 고정 시 선택), 등록 시점에 실제 assume 검증 통과해야 연결", A.blue],
  ];
  const gw6 = 0.35, cw = (CW - gw6 * 2) / 3, cy = 2.0, chh = 2.55;
  cols.forEach((c, i) => {
    const x = PAD + i * (cw + gw6);
    card(s, x, cy, cw, chh, { shadow: true });
    notch(s, x + 0.10, cy, chh, c[2]);
    s.addText(c[0], safeText({ x: x + 0.30, y: cy + 0.22, w: cw - 0.56, h: 0.34, fontFace: FONT, fontSize: 13.5, bold: true, color: C.ink, charSpacing: -0.3, margin: 0 }));
    s.addText(c[1], safeText({ x: x + 0.30, y: cy + 0.64, w: cw - 0.56, h: 1.78, fontFace: FONT, fontSize: 10, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.22 }));
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: PAD, y: 4.85, w: CW, h: 1.1, rectRadius: 0.1, fill: { color: C.purpleTint }, line: { type: "none" } });
  s.addText("\"자동화가 두 번째 장애를 만드는 걸 여러 번 봤습니다. 그래서 변경은 사람이, 판단 근거는 AWSops가 — AI가 틀려도 최악은 '틀린 조언'이지 '틀린 변경'이 아닙니다.\"", safeText({
    x: PAD + 0.35, y: 4.97, w: CW - 0.7, h: 0.86, fontFace: FONT, fontSize: 12.5, bold: true, italic: true, color: C.ink, margin: 0, valign: "middle", lineSpacingMultiple: 1.25,
  }));
  addStatBand(s, [
    { value: "1개", label: "계정당 요구 IAM 역할 (ReadOnly)" },
    { value: "get·list·watch", label: "K8s에 발행하는 읽기 verb (BFF kind 허용목록)" },
    { value: "1", label: "문서화된 예외 — 자기 웹 재시작 (ADR-015 · 기본 off)" },
    { value: "근거 필수", label: "발견마다 근거(소스) 첨부 — 프롬프트 강제 설계" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 변경 기능은 거버넌스(ADR)로 동결 — 해제는 별도 승인 절차
• K8s 읽기 verb 한정 · 계정 연결은 ReadOnly 역할 1개 + 검증
• AI 오답의 최악 = 틀린 조언 (틀린 변경이 아님)

실무자 여러분께 가장 중요한 슬라이드입니다. AWSops에 변경 기능이 '없는' 것은 미완성이 아니라 설계 결정입니다. 자동 변경은 두 번째 장애의 가장 흔한 원인이고, 운영자가 도구를 신뢰하지 못하면 결국 쓰지 않게 됩니다. 그래서 변경·자동 조치 기능은 아키텍처 결정 기록으로 동결되어 있고, 해제하려면 별도 승인 절차가 필요합니다. 쿠버네티스에는 읽기 verb만 발행하고 — 온보딩 때 opt-in으로 Access Entry에 AWS 관리형 read-only 정책을 부여하는 것이 유일한 설정 변경이며 워크로드 오브젝트는 건드리지 않습니다 — 계정 연결에 요구하는 것도 읽기 전용 역할 하나뿐입니다. 유일한 문서화된 예외는 ADR-015 — 데이터베이스 시크릿 회전 때 자기 자신의 웹 서비스를 재시작하는 것 하나이며, 기본 꺼짐에 IAM도 해당 서비스 ARN 하나로 한정됩니다. 등록 시점에 실제로 역할을 assume해 봐서 성공해야만 연결됩니다. 이 원칙 덕분에 AI가 틀려도 최악의 경우가 '틀린 조언'입니다 — 인프라에는 아무 일도 일어나지 않습니다. 변경은 사람과 기존 IaC 파이프라인의 몫으로 남기고, AWSops는 판단 근거를 극단적으로 잘 만드는 데 집중합니다.

[약어]
• ADR(Architecture Decision Record): 아키텍처 결정과 근거를 남기는 공식 기록

[출처]
• AWSops 결정 기준선 — 리포지토리 docs/decisions/BASELINE.md

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 15. SECTION 4 ═════════════════════════
kit.sectionDivider(pres, {
  num: "04", title: "핵심 가치 4", kicker: "페인과 1:1 대응", pageNum: ++pageNum,
  notes: `[요약]
• 앞서 명명한 페인 4개에 화면으로 답하는 챕터
• 각 가치는 데모 시나리오와 1:1 연결

네 번째 챕터입니다. 앞서 말씀드린 네 가지 페인에 하나씩 답을 드리겠습니다. 각 가치는 잠시 후 라이브 데모 시나리오와 일대일로 연결됩니다.` + HIST,
});

// ═════════════════════════ 16. VALUE 1: UNIFIED VISIBILITY ═════════════════════════
{
  const s = newContent("계정이 열 개라도, 화면은 하나다", "스코프 셀렉터 기반 멀티계정 통합 + 외부 관측 도구 8종 read-only 연동");
  const gw7 = 0.30, cw = (CW - gw7) / 2;
  card(s, PAD, 2.0, cw, 3.95, { shadow: true });
  notch(s, PAD + 0.10, 2.0, 3.95, A.blue);
  s.addText("멀티계정 · 멀티리전 통합", safeText({ x: PAD + 0.34, y: 2.2, w: cw - 0.6, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.ink, margin: 0 }));
  s.addText(
    "• 사이드바 스코프 셀렉터에서 계정·리전 멀티 선택 — 전 페이지의 인벤토리·비용·보안 수치가 즉시 재집계\n" +
    "• 계정별 조회는 병렬 fan-out — 계정이 늘어도 대기 시간은 완만\n" +
    "• 보안 findings·비용 표에 Account 컬럼 자동 추가 — \"어느 계정 문제인가\"가 항상 명시\n" +
    "• 계정 추가는 ReadOnly 역할 등록 + 즉시 검증으로 수 분 내 완료",
    safeText({ x: PAD + 0.34, y: 2.62, w: cw - 0.62, h: 3.15, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.35 }));
  const x2 = PAD + cw + gw7;
  card(s, x2, 2.0, cw, 3.95, { shadow: true });
  notch(s, x2 + 0.10, 2.0, 3.95, A.sky);
  s.addText("외부 관측 자산 연동 — 대체가 아니라 승격", safeText({ x: x2 + 0.34, y: 2.2, w: cw - 0.6, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.ink, margin: 0 }));
  s.addText(
    "• Prometheus · Mimir · Loki · Tempo · ClickHouse · Jaeger · Datadog · Dynatrace — 8종 read-only 등록 지원(라이브 라우팅은 Prometheus·ClickHouse 중심, 단계적 확대)\n" +
    "• ClickHouse 트레이스가 서비스 맵(호출 그래프)을 채우고, Prometheus 메트릭이 AI 심층 진단의 근거로 흡수(진단 연동 활성화 시)\n" +
    "• 네이티브 쿼리 콘솔(PromQL·LogQL·SQL)로 등록 즉시 탐색 가능\n" +
    "• 기존 대시보드는 그대로 — 그 위에 '조합하는 층'을 얹는 개념",
    safeText({ x: x2 + 0.34, y: 2.62, w: cw - 0.62, h: 3.15, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.35 }));
  addStatBand(s, [
    { value: "수십 개", label: "동시 조회 가능한 계정 스코프" },
    { value: "8종", label: "외부 관측 데이터소스 (등록 기준)" },
    { value: "1클릭", label: "계정·리전 스코프 전환" },
    { value: "4개 언어", label: "UI 지원 — KO · EN · JA · ZH" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 페인 '멀티계정'과 '파편화'에 대한 답
• 스코프 셀렉터 하나로 전 페이지 재집계
• 외부 도구 8종은 read-only 연동으로 근거 데이터화

첫 번째 가치는 통합 가시성입니다. 왼쪽 — 사이드바의 스코프 셀렉터에서 계정과 리전을 골라 놓으면, 인벤토리·비용·보안 등 모든 페이지가 그 스코프로 즉시 재집계됩니다. 계정별 조회는 병렬로 처리되어 계정이 늘어도 대기 시간이 완만하고, 표에는 어느 계정의 것인지 Account 컬럼이 항상 붙습니다. 오른쪽 — 이미 쓰고 계신 관측 도구 여덟 종을 읽기 전용 데이터소스로 등록하면, ClickHouse의 트레이스가 서비스 호출 지도를 그리고 Prometheus의 메트릭이 AI 진단의 근거로 들어옵니다. 기존 도구를 대체하는 게 아니라, 그 데이터를 '판단의 근거'로 승격시키는 것입니다.

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 17. VALUE 2: RCA ═════════════════════════
{
  const s = newContent("원인이 있는 화면까지, 세 걸음", "토폴로지 포커스 → NFM 홉 경로 → AI 인시던트 분석으로 이어지는 RCA 동선");
  const cols = [
    ["① 토폴로지에서 좁히고", "요청 흐름 그래프(Route53→CloudFront→LB→타깃)에서 노드를 클릭하면 연결된 경로만 남는 포커스 모드. 타깃은 health 상태로 색칠되고, ALB의 IP 타깃은 실제 K8s 워크로드 이름으로 해석", A.blue],
    ["② 플로우로 확인하고", "Network Flow Monitor 라이브 조회로 top-contributor를 찾고, 행을 클릭하면 파드→NAT·TGW 경유→원격지의 E2E 홉 경로가 한 화면에. AZ 간 전송 과금 힌트까지", A.green],
    ["③ AI로 종합한다", "그래프에서 'AI에 질문'을 누르면 챗이 해당 리소스 컨텍스트를 물고 열림. 인시던트 질문에는 에이전트가 알람·변경 이력을 라이브 조회해 원인 후보를 서술 — 신호 조합을 AI가 대신", A.purple],
  ];
  const gw8 = 0.35, cw = (CW - gw8 * 2) / 3, cy = 2.0, chh = 3.95;
  cols.forEach((c, i) => {
    const x = PAD + i * (cw + gw8);
    card(s, x, cy, cw, chh, { shadow: true });
    notch(s, x + 0.10, cy, chh, c[2]);
    s.addText(c[0], safeText({ x: x + 0.30, y: cy + 0.24, w: cw - 0.56, h: 0.56, fontFace: FONT, fontSize: 13.5, bold: true, color: C.ink, charSpacing: -0.3, margin: 0, lineSpacingMultiple: 1.1 }));
    s.addText(c[1], safeText({ x: x + 0.30, y: cy + 0.92, w: cw - 0.56, h: 2.85, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.3 }));
  });
  addStatBand(s, [
    { value: "3클릭", label: "활성 경고 → 조치 방법 도달" },
    { value: "E2E", label: "NAT·TGW 경유 포함 홉 경로 시각화" },
    { value: "live", label: "K8s 타깃 이름 실시간 해석" },
    { value: "16", label: "질문을 받는 AI 섹션 수" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 페인 'RCA 지연'에 대한 답 — 좁히고, 확인하고, 종합
• 토폴로지 포커스 모드 + NFM E2E 홉 경로가 하이라이트
• AI가 알람·변경 이력을 자동 조합

두 번째 가치, 장애 원인 추적입니다. 동선은 세 걸음입니다. 먼저 토폴로지에서 좁힙니다 — 요청 흐름 그래프에서 문제 노드를 클릭하면 연결된 경로만 남고, 로드밸런서 뒤의 IP가 아니라 실제 쿠버네티스 워크로드 이름이 보입니다. 다음으로 네트워크 플로우에서 확인합니다 — 라이브 쿼리로 트래픽 상위 기여자를 찾고, 행 하나를 클릭하면 파드에서 NAT 게이트웨이를 지나 원격지까지의 홉 경로가 한 화면에 그려집니다. 마지막으로 AI가 종합합니다 — 그래프에서 바로 질문을 던지면 해당 리소스 맥락을 물고 챗이 열리고, 인시던트 질문에는 에이전트가 알람과 변경 이력을 조회해 원인 후보를 서술합니다. 사람이 하던 신호 조합을 AI가 대신하는 것입니다. 데모 시나리오 1번에서 이 동선을 그대로 보여드리겠습니다.

[약어]
• NFM(Network Flow Monitor): CloudWatch 기반 네트워크 플로우 관측 서비스
• TGW(Transit Gateway): VPC 간 중계 허브 게이트웨이

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 18. VALUE 3: COST ═════════════════════════
{
  const s = newContent("청구서는 결과만, 원인은 여기서", "MoM 감지 → 서비스 변화율 → usage-type 드릴다운 → 절감 목록화의 비용 동선");
  const nodes = [
    ["① 감지", "전월 대비(MoM) 배지가 급증·급감을 먼저 포착", A.purple, C.purpleTint],
    ["② 지목", "서비스별 변화율 정렬로 '무엇이' 올랐는지", A.blue, null],
    ["③ 원인", "usage-type 드릴다운 — '어떤 사용'이 올랐는지", A.blue, null],
    ["④ 절감", "AI 비용 섹션이 절감 후보를 금액 추정과 함께 서술", A.green, null],
  ];
  const gap = 0.42, nw = (CW - gap * 3) / 4, nh = 1.30, y0 = 2.0;
  nodes.forEach((n, i) => {
    const x = PAD + i * (nw + gap);
    flowNode(s, x, y0, nw, nh, n[0], n[1], n[2], n[3]);
    if (i < nodes.length - 1) flowArrow(s, x + nw + 0.07, y0 + 0.65, gap - 0.14);
  });
  card(s, PAD, 3.7, CW, 2.05, { shadow: true });
  s.addText([
    { text: "컨테이너 안까지 내려가는 비용 분해\n", options: { fontSize: 13, bold: true, color: C.ink, breakLine: true } },
    { text: "EKS는 OpenCost 기반으로 네임스페이스·파드 단위 비용을 분해하고, 파드별 네트워크 전송량(AZ 간·리전 간)에 과금 추정을 붙입니다. \"쿠버네티스 비용은 블랙박스\"라는 통념을 파드 단위 숫자로 바꿉니다. AI 비용 섹션은 \"이번 달 비용 추세와 가장 많이 오른 서비스\" 같은 질문에 리소스 단위 원인 후보까지 서술합니다.", options: { fontSize: 11.5, color: C.body } },
  ], safeText({ x: PAD + 0.3, y: 3.92, w: CW - 0.6, h: 1.68, fontFace: FONT, margin: 0, valign: "top", lineSpacingMultiple: 1.3 }));
  addStatBand(s, [
    { value: "MoM", label: "전월 대비 + 일평균 변화 상시 감시" },
    { value: "usage-type", label: "드릴다운 최하위 원인 단위" },
    { value: "pod 단위", label: "OpenCost 기반 K8s 비용 분해" },
    { value: "$ 추정", label: "AI 절감 제안의 금액 첨부" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 페인 '비용 불명'에 대한 답 — 감지→지목→원인→절감 4단계
• usage-type까지 내려가는 드릴다운
• EKS는 OpenCost로 파드 단위 비용 + 전송량 과금 추정

세 번째 가치, 비용입니다. 청구서는 결과만 말하지만, AWSops의 동선은 원인까지 네 걸음입니다. 먼저 전월 대비 배지가 급증을 포착하고, 서비스별 변화율 정렬로 무엇이 올랐는지 지목하고, 행을 클릭하면 그 서비스의 어떤 사용 유형이 올랐는지까지 내려갑니다. 마지막으로 AI 비용 섹션에 물으면 gp2에서 gp3 전환 같은 절감 후보를 금액 추정과 함께 서술해 줍니다. 원인 파악에서 절감 실행 목록까지 한 흐름입니다. 쿠버네티스도 예외가 아닙니다 — OpenCost 기반으로 파드 단위 비용을 분해하고, 파드별 네트워크 전송량에 과금 추정까지 붙입니다. 데모 시나리오 2번에서 실제 데이터로 보여드리겠습니다.

[약어]
• MoM(Month over Month): 전월 대비 증감률
• OpenCost: 쿠버네티스 비용 배분 오픈소스 표준

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 19. VALUE 4: WA DIAGNOSIS ═════════════════════════
{
  const s = newContent("Well-Architected 리뷰를, 자동 반복으로", "6기둥 건강 점수·심각도·공수·절감액을 담은 15+1섹션 AI 진단 리포트");
  const gw9 = 0.30, cw = (CW - gw9) / 2;
  card(s, PAD, 2.0, cw, 3.95, { shadow: true });
  notch(s, PAD + 0.10, 2.0, 3.95, A.purple);
  s.addText("리포트가 담는 것", safeText({ x: PAD + 0.34, y: 2.2, w: cw - 0.6, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.ink, margin: 0 }));
  s.addText(
    "• 인프라 건강 점수(0~100) — WA 6기둥 가중 합산, 신호 없는 기둥은 점수를 지어내지 않고 '데이터 부족' 명시\n" +
    "• 발견마다 [Critical/Warning/Info] + 우선순위 P1~P3 + 공수 + 근거 — 그대로 백로그에 넣는 형식\n" +
    "• 비용 발견에는 절감액 추정 첨부\n" +
    "• 이전 리포트 대비 변화 추적 — 의도 대비 실제(intended-vs-actual) 위반 중심",
    safeText({ x: PAD + 0.34, y: 2.62, w: cw - 0.62, h: 3.15, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.35 }));
  const x2 = PAD + cw + gw9;
  card(s, x2, 2.0, cw, 3.95, { shadow: true });
  notch(s, x2 + 0.10, 2.0, 3.95, A.green);
  s.addText("운영에 녹아드는 방식", safeText({ x: x2 + 0.34, y: 2.2, w: cw - 0.6, h: 0.32, fontFace: FONT, fontSize: 14, bold: true, color: C.ink, margin: 0 }));
  s.addText(
    "• 티어 선택: Light / Mid / Deep(15+1섹션) + 모델 선택(표준·상위)\n" +
    "• 매주·격주·매월 자동 예약 지원(활성화 시) + 완료 시 이메일 딥링크\n" +
    "• MD · DOCX · PDF 원클릭 내보내기 — 경영 보고서로 바로\n" +
    "• 비동기 워커 실행이라 진단이 돌아도 대시보드는 그대로\n" +
    "• 일회성 컨설팅이 아니라 '리뷰와 리뷰 사이'를 메우는 상시 관리",
    safeText({ x: x2 + 0.34, y: 2.62, w: cw - 0.62, h: 3.15, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.35 }));
  addStatBand(s, [
    { value: "0~100", label: "인프라 건강 점수 (6기둥 가중)" },
    { value: "15+1", label: "Deep 분석 섹션 (의도 대비 실제 포함)" },
    { value: "diff", label: "리포트 간 변화 추적 (위반 중심)" },
    { value: "3형식", label: "MD · DOCX · PDF 내보내기" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 페인 4개의 총결산 — WA 6기둥 자동 채점 리포트
• 발견 = 심각도 + 우선순위 + 공수 + 근거 + 절감액
• 자동 예약 실행 지원(활성화 시) + 리포트 간 변화 추적

네 번째 가치는 Well-Architected 자동 진단입니다. 파트너 리뷰의 문제는 리뷰가 끝난 지 석 달이면 문서가 낡는다는 것입니다. AWSops는 같은 6기둥 채점을 자동 반복으로 — 예약을 켜면 매주·격주·매월 — 돌릴 수 있습니다. 리포트 첫 장에는 0에서 100 사이의 인프라 건강 점수가 나오는데, 신호가 없는 기둥은 점수를 지어내지 않고 '데이터 부족'으로 명시합니다 — 날조하지 않는 것이 원칙입니다. 모든 발견에는 심각도, 우선순위, 공수, 근거가 붙어서 그대로 백로그에 넣을 수 있고, 비용 관련 발견에는 절감액 추정이 첨부됩니다. 이전 리포트 대비 변화 — 특히 의도 대비 실제 위반 — 가 추적되므로, 일회성 컨설팅이 아니라 상시 건강 관리가 됩니다. PDF로 내보내면 그대로 경영 보고서입니다. 데모 마지막에 실제 리포트를 보여드리겠습니다.

[약어]
• WA(Well-Architected): AWS 6기둥 아키텍처 모범사례 프레임워크

[출처]
• AWSops 진단 섹션 카탈로그 — 리포지토리 scripts/v2/workers/diagnosis/sections.py

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 20. SECTION 5 ═════════════════════════
kit.sectionDivider(pres, {
  num: "05", title: "Live Demo & Q&A", kicker: "실제 운영 환경", pageNum: ++pageNum,
  notes: `[요약]
• 지금부터 25분은 라이브 데모
• 스테이징·목업이 아닌 실운영 환경 강조

다섯 번째 챕터입니다. 지금부터는 슬라이드가 아니라 실제 운영 중인 환경을 그대로 보여드리겠습니다. 스테이징이 아니라 저희가 매일 쓰는 화면입니다.` + HIST,
});

// ═════════════════════════ 21. DEMO ROADMAP ═════════════════════════
{
  const s = newContent("25분, 네 개의 실전 시나리오", "통합 투어부터 WA 리포트까지 — 라이브 운영 환경 시연 로드맵");
  const rows = [
    ["⓪", "통합 대시보드 투어", "4′", "개요 → 스코프 셀렉터(멀티계정) → 활성 경고 클릭 → 보안 조치 방법까지 3클릭", A.blue],
    ["①", "장애 원인 추적", "8′", "토폴로지 포커스 모드 → NFM E2E 홉 경로 → AI 인시던트 분석", A.purple],
    ["②", "비용 급증 원인 분석", "6′", "MoM 감지 → 서비스 변화율 → usage-type 드릴다운 → AI 비용 절감 분석", A.green],
    ["③", "WA 6기둥 AI 리포트", "5′", "건강 점수 + 리포트 간 변화 + PDF 내보내기 + 라이브 실행(진행 패널)", A.magenta],
    ["＋", "연동 · 계정 관리 클로징", "2′", "데이터소스 8종 등록 화면 + '추가 + 검증' — 읽기 전용 신뢰로 마무리", A.sky],
  ];
  rows.forEach((r, i) => {
    const y = 2.0 + i * 0.82;
    card(s, PAD, y, CW, 0.68);
    notch(s, PAD + 0.08, y, 0.68, r[4]);
    s.addText(r[0], safeText({ x: PAD + 0.26, y, w: 0.5, h: 0.68, fontFace: FONT, fontSize: 16, bold: true, color: r[4], valign: "middle", margin: 0 }));
    s.addText(r[1], safeText({ x: PAD + 0.84, y, w: 2.85, h: 0.68, fontFace: FONT, fontSize: 13, bold: true, color: C.ink, valign: "middle", margin: 0, charSpacing: -0.3 }));
    s.addText(r[2], safeText({ x: PAD + 3.75, y, w: 0.55, h: 0.68, fontFace: FONT, fontSize: 13, bold: true, color: C.blueBright, valign: "middle", margin: 0 }));
    s.addText(r[3], safeText({ x: PAD + 4.45, y, w: CW - 4.65, h: 0.68, fontFace: FONT, fontSize: 10.5, color: C.body, valign: "middle", margin: 0 }));
  });
  addStatBand(s, [
    { value: "25′", label: "총 데모 시간" },
    { value: "4+1", label: "시나리오 수 (투어 + 클로징 포함)" },
    { value: "live", label: "실운영 환경 — 목업 없음" },
    { value: "3클릭", label: "경고에서 조치 방법까지" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 데모 로드맵 4+1 — 투어·RCA·비용·WA 리포트·클로징
• 각 시나리오는 앞의 가치 4와 1:1 대응
• WA 리포트는 사전 생성본 + 라이브 실행 병행

데모 로드맵입니다. 먼저 4분간 통합 대시보드를 투어하면서 멀티계정 스코프와 경고에서 조치 방법까지 3클릭 동선을 보여드립니다. 이어서 8분간 장애 원인 추적 — 토폴로지 포커스 모드에서 시작해 네트워크 홉 경로, AI 인시던트 분석까지 갑니다. 세 번째는 비용 급증 원인 분석 6분, 네 번째는 Well-Architected 리포트 5분입니다. 마지막 2분은 연동과 계정 관리 화면으로 '읽기 전용 신뢰'를 다시 확인하며 마무리합니다. 지금 보시는 순서 그대로 진행하겠습니다.

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 22. Q&A PREVIEW ═════════════════════════
{
  const s = newContent("가장 많이 받는 질문, 셋", "권한 · AI 신뢰 · 기존 도구 — 도입 검토에서 반드시 나오는 질문 선답변");
  const cols = [
    ["\"권한을 얼마나 줘야 하죠?\"", "읽기 전용 역할 하나입니다. 3rd-party 연결에는 ExternalId로 혼동 대리인을 차단하고, 등록 시점에 실제 assume 검증을 통과해야 연결됩니다. 모니터링 대상 계정에는 쓰기 권한을 요구하지도, 받지도 않습니다(호스트 자신에 대한 단일 문서화 예외는 ADR-015 웹 재시작뿐).", A.blue],
    ["\"AI가 틀리면요?\"", "에이전트는 수집된 라이브 데이터에만 근거하고, 신호가 없으면 '데이터 불가'로 답하도록 설계되어 있습니다. 모든 발견에 근거가 첨부되고 — 읽기 전용이라 최악의 경우가 '틀린 조언'입니다. Bedrock은 고객 데이터를 모델 학습에 쓰지 않습니다.", A.purple],
    ["\"기존 도구는 버리나요?\"", "아니요, 연동입니다. Prometheus·ClickHouse 등 8종을 읽기 전용으로 등록하면 그 데이터가 서비스 맵과 AI 진단의 근거로 흡수됩니다. 기존 대시보드는 그대로 두고 '조합하는 층'을 얹습니다.", A.green],
  ];
  const gw10 = 0.35, cw = (CW - gw10 * 2) / 3, cy = 2.0, chh = 3.95;
  cols.forEach((c, i) => {
    const x = PAD + i * (cw + gw10);
    card(s, x, cy, cw, chh, { shadow: true });
    notch(s, x + 0.10, cy, chh, c[2]);
    s.addText(c[0], safeText({ x: x + 0.30, y: cy + 0.24, w: cw - 0.56, h: 0.62, fontFace: FONT, fontSize: 13.5, bold: true, color: C.ink, charSpacing: -0.3, margin: 0, lineSpacingMultiple: 1.15 }));
    s.addText(c[1], safeText({ x: x + 0.30, y: cy + 0.98, w: cw - 0.56, h: 2.80, fontFace: FONT, fontSize: 10.5, color: C.body, margin: 0, valign: "top", lineSpacingMultiple: 1.3 }));
  });
  addStatBand(s, [
    { value: "1", label: "계정당 요구 역할 수 (ReadOnly)" },
    { value: "0", label: "모델 학습에 쓰이는 고객 데이터" },
    { value: "8종", label: "그대로 유지되는 기존 관측 도구" },
    { value: "read-only", label: "최악의 실패 모드 = 틀린 조언" },
  ]);
  kit.addFooter(pres, s, ++pageNum);
  s.addNotes(`[요약]
• 도입 검토 시 반드시 나오는 질문 3개 선답변
• 권한 최소 · AI 근거 강제 · 기존 도구 연동

질의응답에 앞서, 도입을 검토하실 때 반드시 나오는 세 가지 질문에 미리 답을 드립니다. 첫째, 권한은 계정당 읽기 전용 역할 하나입니다. 둘째, AI는 수집된 데이터에만 근거하도록 강제되고 모든 발견에 근거가 붙습니다 — 읽기 전용이라 틀려도 인프라에는 아무 일도 없습니다. Bedrock은 고객 데이터를 학습에 사용하지 않습니다. 셋째, 기존 관측 도구는 버리는 게 아니라 연동해서 판단의 근거로 승격시킵니다. 이 외의 질문은 지금부터 편하게 주시면 됩니다.

[변경 이력]
• 2026-08-11: 초기 작성
• 2026-08-12: AWS Light 테마 재설계`);
}

// ═════════════════════════ 23. CLOSING ═════════════════════════
kit.closing(pres, {
  pageNum: ++pageNum,
  notes: `[요약]
• 클로징 멘트 + Q&A 초대

운영을 오래 하면서 배운 것은, 좋은 도구란 일을 대신해 주는 도구가 아니라 판단을 빠르게 해 주는 도구라는 점입니다. AWSops에는 변경 버튼이 하나도 없는 대신, 새벽 3시에 '어디를 봐야 하는지'를 30초 안에 알려줍니다. 그 30초를 위해 만든 제품입니다. 감사합니다 — 질문 주시면 답변드리겠습니다.` + HIST,
});

// ═════════════════════════ WRITE ═════════════════════════
const out = process.argv[2] || path.join(__dirname, "../../static/presentation/awsops-intro/awsops-intro.pptx");
pres.writeFile({ fileName: out })
  .then(() => console.log("✓ Written: " + out))
  .catch((e) => { console.error("✗", e); process.exit(1); });
