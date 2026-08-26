# 결정 (Decisions) — AI 안내

**현행 진실 = [`BASELINE.md`](BASELINE.md)** + 이 디렉토리의 통합 ADR(`0NN-*.md`). 여기부터 읽는다.

- **BASELINE.md** = 북극성(§0) + 불변식(§1) + 게이트/동결 register(§2) + 결정 인덱스(§3). 읽기 시작점.
- **0NN-*.md** = 통합 ADR(현행 결정 상세 + why). single Status.
- **옛 ADR(001~046) 본문은 트리에 없다** — git tag `adr-legacy-2026-06-22` 보존. 매핑 `../history/ADR-MAPPING.md`. 복원: `git show adr-legacy-2026-06-22:docs/decisions/<옛파일>.md`. **명시 요청 없이는 옛 본문을 읽지 않는다.**

## 새 ADR 추가
1. 번호 = 현재 최고번호 + 1 (현재 최고 = 016)
2. 구조 = Status(단일·Accepted)/Context/Decision/Consequences/6 Pillars. 번복 체인 서술 금지(현행 net만).
3. **같은 PR에서 `BASELINE.md` §3(또는 §2) 갱신 필수** — 갱신 없으면 "not live"(anti-drift).
4. 기준 = "AI가 이 문서만 보고 PR을 막/통과시킬 수 있는가".

## 규칙
- read-only 정의·동결/게이트는 BASELINE §1/§2가 결정론적 기준.
- AWS 리소스 변경·자율 = FROZEN(ADR-005). 완화는 새 ADR+멀티-AI 패널+owner-override.
