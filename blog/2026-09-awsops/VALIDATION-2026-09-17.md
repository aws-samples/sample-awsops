# 소스 복구 검증 — 2026-09-17

이 패키지는 미커밋 원고를 복구한 편집 초안이며 게시 승인이 아닙니다.
`blog-human.md`는 미완성 초기 착상 메모로 보존하며 검증·게시 대상이 아닙니다.
현재 편집 기준은 [EDITORIAL-SCOPE.md](EDITORIAL-SCOPE.md)입니다.
이전 리뷰·브라우저 캡처는 별도 이력 복구 대상이며 현재 검증의 근거로 삼지 않습니다.
미리보기는 `python3 blog/2026-09-awsops/render_preview.py`로 생성합니다.

이번 소스 검증에서 Python 구문, JSON·XML 구문, 원본 그림 해시,
여섯 draw.io 원본의 검증·레이아웃 검사, 미리보기 생성을 확인했습니다.
`drawio/test_build.py`의 세 회귀 검사는 출력 없는 성공 종료와 두 번째 출력 실패가
기존 그림을 교체하지 않는지, 두 출력 검증 뒤에만 교체하는지 확인합니다.

초기 DB 구성은 `INITIALIZE_EMPTY_DB=1 make migrate`를 웹 배포보다 먼저
수행하도록 수정했습니다. 기존 환경의 일반 마이그레이션과 구분합니다.
ENI 설명에 `partial`, `unknown`, `routeSelection` 해석을 추가하고,
컴플라이언스 상태에 `info`를 포함했습니다. Logs Insights 도구는 현재 시각으로
끝나는 상대 구간만 지원하므로 절대 구간 안내를 콘솔/API 절차와 구분했습니다. 해당 계약은 저장소의
`scripts/v2/migrate.mjs`, `agent/lambda/network_mcp.py`,
`scripts/v2/workers/compliance.py`와 대조했습니다.

정기 진단의 CloudTrail·Security Hub 기간/표본 제한과 인벤토리의 SDK 수집·
속성 미확인/degraded 상태를 본문에도 명시했습니다. 그림 2b에 직접 SDK 경로와
기본 비활성인 그래프 재구축을 표시하고 다시 출력·확인했습니다.

인증 보조 그림은 NFC 텍스트와 Noto Sans CJK KR 글꼴로 다시 출력했습니다.
새 PNG를 직접 확인해 하단 한글 문장의 자모 분리가 해소됐음을 확인했습니다.
SVG는 같은 원본에서 새로 생성하고 XML을 검증했습니다.
기존 브라우저 캡처는 이 새 출력의 검증 결과가 아닙니다.

게시 전에는 최종 템플릿의 모든 폭에서 그림·본문·원본 보기 접근을 다시 확인해야 합니다.
샘플 저장소의 비로그인 접근, 외부 링크, 실제 배포와 ENI 도구의 완전한 반환 근거는
이번 로컬 소스 검사로 검증하지 않았습니다. 원고의 게시 보류를 유지합니다.
