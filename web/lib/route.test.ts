import { describe, it, expect, vi } from 'vitest';
import { pickGateway, classifyRoute, matchedSections, ACTIVE_FALLBACK } from './route';

describe('pickGateway', () => {
  it('honors an explicit pin over keywords', () => {
    expect(pickGateway('이번 달 비용 알려줘', 'security')).toBe('security');
  });
  it('routes cost keywords', () => {
    expect(pickGateway('이번 달 비용 추세')).toBe('cost');
    expect(pickGateway('show me the billing forecast')).toBe('cost');
  });
  it('routes security keywords', () => {
    expect(pickGateway('이 IAM 역할 권한 점검')).toBe('security');
    expect(pickGateway('why is this action denied by policy')).toBe('security');
  });
  it('routes network keywords', () => {
    expect(pickGateway('두 인스턴스 통신이 안 돼요')).toBe('network');
    expect(pickGateway('check the security group ports')).toBe('network');
  });
  it('falls back to ops for unknown prompts', () => {
    expect(pickGateway('안녕하세요')).toBe('ops');
  });
  it('ignores a pin that is not a known section', () => {
    expect(pickGateway('이번 달 비용', 'bogus')).toBe('cost');
  });
});

describe('matchedSections', () => {
  it('returns distinct matched section keys', () => {
    // 'cost' has two RULES entries — must count as ONE distinct section
    expect(matchedSections('비용이 $100 늘었어')).toEqual(['cost']);
  });
  it('returns multiple keys for a cross-domain prompt', () => {
    const keys = matchedSections('EKS 파드가 RDS에 연결이 안 돼요');
    expect(keys).toContain('network'); // 연결
    expect(keys).toContain('container'); // EKS, 파드
    expect(keys).toContain('data'); // RDS
  });
  it('returns [] when nothing matches', () => {
    expect(matchedSections('안녕하세요')).toEqual([]);
  });
});

describe('ACTIVE_FALLBACK', () => {
  it('is an active section (never inactive ops)', () => {
    expect(ACTIVE_FALLBACK).toBe('network'); // first active section in SECTIONS order
  });
});

describe('classifyRoute', () => {
  it('pin wins and skips the classifier', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('이번 달 비용', 'security', { llmEnabled: true, classify });
    expect(r).toEqual({ primary: 'security', ranked: [{ key: 'security', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'security', score: 1, active: true }] });
    expect(classify).not.toHaveBeenCalled();
  });
  it('single distinct regex match short-circuits (no LLM call)', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('show me the billing forecast', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('cost');
    expect(r.method).toBe('regex');
    expect(classify).not.toHaveBeenCalled();
  });
  it('multi-match goes to the LLM and returns top-3 with active flags', async () => {
    const classify = vi.fn().mockResolvedValue([
      { key: 'network', score: 0.9 }, { key: 'data', score: 0.6 }, { key: 'container', score: 0.4 },
    ]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('llm');
    expect(r.primary).toBe('network');
    expect(r.ranked).toEqual([
      { key: 'network', score: 0.9, active: true },
      { key: 'data', score: 0.6, active: true }, // data activated in Wave-1
      { key: 'container', score: 0.4, active: true }, // container activated 2026-08-02
    ]);
  });
  it('no-match goes to the LLM too', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'ops', score: 0.7 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('llm');
    expect(r.primary).toBe('ops');
  });
  it('LLM empty result falls back to first-match regex when one exists', async () => {
    const classify = vi.fn().mockResolvedValue([]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('regex'); // first-match (network — RULES order) still beats a dead LLM
    expect(r.primary).toBe('network');
  });
  it('LLM failure + no regex match falls back to ACTIVE_FALLBACK (never inactive ops)', async () => {
    const classify = vi.fn().mockRejectedValue(new Error('bedrock down'));
    const r = await classifyRoute('안녕하세요', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('fallback');
    expect(r.primary).toBe(ACTIVE_FALLBACK);
  });
  it('llmEnabled=false keeps legacy first-match behavior (ops fallback allowed)', async () => {
    const r = await classifyRoute('안녕하세요', undefined, { llmEnabled: false });
    expect(r.primary).toBe('ops'); // legacy pickGateway behavior preserved when flag off
    expect(r.method).toBe('regex');
  });
  it('honors a pin to a now-active section, surfacing active:true (container activated 2026-08-02)', async () => {
    const r = await classifyRoute('아무거나', 'container', { llmEnabled: true, classify: vi.fn() });
    expect(r).toEqual({ primary: 'container', ranked: [{ key: 'container', score: 1, active: true }], method: 'pin', multiDomain: false, selected: [{ key: 'container', score: 1, active: true }] });
  });
  it('marks an unknown key from a custom classifier as active:false (contract)', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'bogus-section', score: 0.9 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify });
    // production classifyPrompt is enum-validated so this can't happen in the wired path;
    // this documents the policy-layer contract for any future custom classify injection.
    expect(r.method).toBe('llm');
    expect(r.ranked[0]).toEqual({ key: 'bogus-section', score: 0.9, active: false });
  });
});

describe('classifyRoute — ADR-044 multi-domain detection', () => {
  it('≥2 active routes above threshold ⇒ multiDomain + selected (desc, ≤3)', async () => {
    const classify = vi.fn().mockResolvedValue([
      { key: 'network', score: 0.9 }, { key: 'data', score: 0.6 }, { key: 'container', score: 0.5 },
    ]);
    const r = await classifyRoute('EKS 파드가 RDS에 연결이 안 돼요', undefined, { llmEnabled: true, classify });
    expect(r.multiDomain).toBe(true);
    // container is inactive ⇒ excluded from the fan-out set even though score ≥ threshold
    expect(r.selected.map((s) => s.key)).toEqual(['network', 'data', 'container']); // container 활성화(2026-08-02) — threshold 통과 3개 전부(≤3)
  });
  it('one dominant active route ⇒ single (multiDomain false, selected=[primary])', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'cost', score: 0.95 }, { key: 'data', score: 0.1 }]);
    const r = await classifyRoute('어제부터 뭔가 이상해요', undefined, { llmEnabled: true, classify }); // no regex match ⇒ LLM
    expect(r.method).toBe('llm');
    expect(r.multiDomain).toBe(false);
    expect(r.selected).toEqual([{ key: 'cost', score: 0.95, active: true }]); // data below threshold dropped
  });
  it('below-threshold routes are excluded from the fan-out set', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'network', score: 0.9 }, { key: 'data', score: 0.2 }]);
    const r = await classifyRoute('x', undefined, { llmEnabled: true, classify, minScore: 0.3 });
    expect(r.multiDomain).toBe(false); // only network clears 0.3
    expect(r.selected.map((s) => s.key)).toEqual(['network']);
  });
  it('two active routes both above an explicit minScore ⇒ multiDomain', async () => {
    const classify = vi.fn().mockResolvedValue([{ key: 'network', score: 0.55 }, { key: 'security', score: 0.45 }]);
    const r = await classifyRoute('x', undefined, { llmEnabled: true, classify, minScore: 0.4 });
    expect(r.multiDomain).toBe(true);
    expect(r.selected.map((s) => s.key)).toEqual(['network', 'security']);
  });
  it('pin and regex paths are never multiDomain', async () => {
    const pin = await classifyRoute('아무거나', 'cost', { llmEnabled: true, classify: vi.fn() });
    expect(pin.multiDomain).toBe(false);
    const rx = await classifyRoute('show me the billing forecast', undefined, { llmEnabled: true, classify: vi.fn() });
    expect(rx.multiDomain).toBe(false);
  });
});

describe('aws-data rule — LAST in RULES (v1 priority-10 parity)', () => {
  it('never steals questions a specialized domain keyword already claims', () => {
    expect(pickGateway('CrashLoop 파드 몇 개야?')).toBe('container');      // 파드 → container wins
    expect(pickGateway('how many CloudWatch alarms fired today')).toBe('monitoring');
    expect(pickGateway('IAM 역할 총 3개가 미사용이야?')).toBe('security'); // 역할 → security wins
    expect(pickGateway('RDS 인스턴스 개수 알려줘')).toBe('data');          // rds → data wins
  });
  it('catches unclaimed list/count questions (the v1 aws-data receiver)', () => {
    expect(pickGateway('EC2 인스턴스 몇 개야?')).toBe('aws-data');
    expect(pickGateway('S3 버킷 전체 목록 보여줘')).toBe('aws-data');
    expect(pickGateway('list all S3 buckets with encryption status')).toBe('aws-data');
    expect(pickGateway('EBS 볼륨 개수는?')).toBe('aws-data');
  });
  it('weak phrasings without a strong list/count pattern still fall through to ops', () => {
    expect(pickGateway('안녕하세요')).toBe('ops');
    expect(matchedSections('EC2 상태가 궁금해')).toEqual([]); // no 몇개/개수/목록 pattern → classifier decides
  });
  it('is a single distinct regex match → short-circuits without an LLM call', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('EC2 인스턴스 몇 개야?', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('aws-data');
    expect(r.method).toBe('regex');
    expect(classify).not.toHaveBeenCalled();
  });
});

describe('topology / unused-resource routing → ops', () => {
  // The capability home (inventory_read MCP: load balancers, target groups, CloudFront, unused
  // detection) lives on the ops gateway. These nouns must route there deterministically.
  // v1-ladder port: a LONE 'ops' (catch-all) regex hit now CONSULTS the classifier — generic
  // nouns (LB, cert, S3) live in the ops rules while the intent is often network/cost/monitoring.
  it('consults the classifier on a lone catch-all ops match, keeps ops when it agrees', async () => {
    const prompt = '토폴로지를 봤을때 지금 미사용리소스라고 보이는것들을 추려줘 예를들면 origin에 아무것도 없거나 하는거 tg가 있는데 실제로 register가 없는것들';
    expect(matchedSections(prompt)).toEqual(['ops']); // single distinct match — but the catch-all
    const classify = vi.fn().mockResolvedValue([{ key: 'ops', score: 0.9 }]);
    const r = await classifyRoute(prompt, undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('ops');
    expect(r.method).toBe('llm');
    expect(classify).toHaveBeenCalledTimes(1);
  });
  it('falls back to the regex ops result when the classifier fails on a lone catch-all match', async () => {
    const prompt = '전체 토폴로지 보여줘';
    expect(matchedSections(prompt)).toEqual(['ops']);
    const classify = vi.fn().mockRejectedValue(new Error('bedrock down'));
    const r = await classifyRoute(prompt, undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('ops');
    expect(r.method).toBe('regex'); // never blocks chat — same answer as the legacy path
  });
  it('still short-circuits a lone SPECIFIC section match without any LLM call', async () => {
    const classify = vi.fn();
    const r = await classifyRoute('TGW 라우팅 테이블 보여줘', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('regex');
    expect(classify).not.toHaveBeenCalled();
  });
  it('routes unused / inventory / topology phrasings to ops', () => {
    expect(matchedSections('미사용 리소스 추려줘')).toContain('ops');
    expect(matchedSections('안 쓰는 리소스 정리하고 싶어')).toContain('ops');
    expect(matchedSections('리소스 인벤토리 현황')).toContain('ops');
    expect(matchedSections('전체 토폴로지 보여줘')).toContain('ops');
    expect(matchedSections('orphan resources cleanup')).toContain('ops');
  });
  it('routes load balancer / target group / cloudfront nouns to ops (where the tool lives)', () => {
    expect(matchedSections('로드밸런서 목록')).toContain('ops');
    expect(matchedSections('타겟그룹에 등록된 타깃 확인')).toContain('ops');
    expect(matchedSections('show me the target groups')).toContain('ops');
    expect(matchedSections('cloudfront 배포 목록')).toContain('ops');
    expect(matchedSections('빈 origin 인 distribution 찾아줘')).toContain('ops');
  });
  it('does NOT steal pure connectivity questions from network', () => {
    expect(matchedSections('두 인스턴스 통신이 안 돼요')).toEqual(['network']);
    expect(matchedSections('SG에서 막힌 포트')).toContain('network');
  });
});

describe('auto-collect collector rules — dedicated strong keywords only (v1 auto-collect port)', () => {
  it('unmistakable idle-scan phrasings match idle-scan', () => {
    expect(matchedSections('유휴 리소스 스캔해줘')).toEqual(['idle-scan']);
    expect(pickGateway('유휴 리소스 스캔해줘')).toBe('idle-scan');
    expect(matchedSections('run an idle scan')).toContain('idle-scan');
  });
  it("'미사용 리소스 찾아줘' matches BOTH ops and idle-scan → ambiguous → classifier arbitrates", async () => {
    const keys = matchedSections('미사용 리소스 찾아줘');
    expect(keys).toContain('ops');
    expect(keys).toContain('idle-scan');
    const classify = vi.fn().mockResolvedValue([{ key: 'idle-scan', score: 0.9 }, { key: 'ops', score: 0.4 }]);
    const r = await classifyRoute('미사용 리소스 찾아줘', undefined, { llmEnabled: true, classify });
    expect(r.method).toBe('llm');
    expect(r.primary).toBe('idle-scan');
  });
  it('generic unused/idle phrasings do NOT hit idle-scan (ops/security keep them)', () => {
    expect(matchedSections('미사용 리소스 추려줘')).toEqual(['ops']); // no 찾/스캔 → ops only
    expect(matchedSections('미사용 액세스 키 90일 이상')).not.toContain('idle-scan'); // golden case stays security
    expect(pickGateway('IAM 역할 총 3개가 미사용이야?')).toBe('security');
  });
  it('unmistakable eks-optimize phrasings match eks-optimize', () => {
    expect(matchedSections('rightsizing 권장값 계산해줘')).toEqual(['eks-optimize']);
    expect(pickGateway('rightsizing 권장값 계산해줘')).toBe('eks-optimize');
  });
  it("'EKS 비용 최적화' is ambiguous (cost+container+eks-optimize) → classifier arbitrates", async () => {
    const keys = matchedSections('EKS 비용 최적화');
    expect(keys).toContain('cost');
    expect(keys).toContain('container');
    expect(keys).toContain('eks-optimize');
    const classify = vi.fn().mockResolvedValue([{ key: 'eks-optimize', score: 0.9 }]);
    const r = await classifyRoute('EKS 비용 최적화', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('eks-optimize');
  });
  it('pod troubleshooting stays with container (no optimize keyword)', () => {
    expect(matchedSections('EKS 파드가 RDS에 연결이 안 돼요')).not.toContain('eks-optimize');
    expect(pickGateway('파드가 Pending인 이유')).toBe('container');
  });

  // ── db-optimize / msk-optimize: SERVICE noun + optimize verb required together ──
  it('db-optimize needs a DB noun + an optimize verb; ambiguity goes to the classifier', async () => {
    const keys = matchedSections('RDS 인스턴스 다운사이징 후보 찾아줘');
    expect(keys).toContain('data');        // rds noun
    expect(keys).toContain('db-optimize'); // rds + 다운사이징
    const classify = vi.fn().mockResolvedValue([{ key: 'db-optimize', score: 0.9 }]);
    const r = await classifyRoute('RDS 인스턴스 다운사이징 후보 찾아줘', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('db-optimize');
  });
  it('DB troubleshooting/listing phrasings do NOT hit db-optimize (data/aws-data keep them)', () => {
    expect(matchedSections('RDS 느린 쿼리 진단')).not.toContain('db-optimize');
    expect(matchedSections('RDS 인스턴스 개수 알려줘')).not.toContain('db-optimize');
    expect(matchedSections('rightsizing 권장값 계산해줘')).not.toContain('db-optimize'); // bare rightsiz stays eks-optimize
  });
  it('msk-optimize needs an MSK/broker noun + an optimize verb', () => {
    expect(matchedSections('브로커 다운사이징 해줘')).toEqual(['msk-optimize']); // 브로커 is not a data-rule noun
    expect(pickGateway('브로커 다운사이징 해줘')).toBe('msk-optimize');
    expect(matchedSections('MSK 브로커 rightsizing')).toContain('msk-optimize'); // + data(msk) → ambiguous → classifier
    expect(matchedSections('MSK 컨슈머 랙 확인해줘')).not.toContain('msk-optimize'); // lag troubleshooting stays data
  });

  // ── trace-analyze: explicit trace/dependency/bottleneck intents only ──
  it('unmistakable trace-analyze phrasings match trace-analyze', () => {
    expect(matchedSections('서비스 의존성 분석해줘')).toEqual(['trace-analyze']);
    expect(pickGateway('서비스 의존성 분석해줘')).toBe('trace-analyze');
    expect(pickGateway('latency bottleneck 찾아줘')).toBe('trace-analyze');
    expect(matchedSections('지연시간 병목 찾아줘')).toContain('trace-analyze');
  });
  it("a bare 'trace/트레이스' noun stays with monitoring; '트레이스 분석' is ambiguous → classifier", async () => {
    expect(matchedSections('grafana 대시보드에서 본 trace 이상해')).toEqual(['monitoring']);
    const keys = matchedSections('트레이스 분석해줘');
    expect(keys).toContain('monitoring');
    expect(keys).toContain('trace-analyze');
    const classify = vi.fn().mockResolvedValue([{ key: 'trace-analyze', score: 0.9 }]);
    const r = await classifyRoute('트레이스 분석해줘', undefined, { llmEnabled: true, classify });
    expect(r.primary).toBe('trace-analyze');
  });

  // ── incident: root-cause phrasings only ──
  it('unmistakable incident phrasings match incident', () => {
    expect(matchedSections('장애 원인 분석해줘')).toEqual(['incident']);
    expect(pickGateway('장애 원인 분석해줘')).toBe('incident');
    expect(pickGateway('지금 무슨 문제가 있어?')).toBe('incident');
    expect(matchedSections('incident analysis 돌려줘')).toContain('incident');
    expect(pickGateway('root cause 찾아줘')).toBe('incident');
  });
  it('plain failure reports without a root-cause ask are left to the classifier', () => {
    expect(matchedSections('배포 후에 장애가 났어')).toEqual([]); // no 원인/분석 → classifier decides
    expect(matchedSections('어제부터 뭔가 이상해요')).toEqual([]);
    expect(matchedSections('DynamoDB 스로틀링 원인 분석')).not.toContain('incident'); // no 장애/사고 noun → stays data
  });
});
