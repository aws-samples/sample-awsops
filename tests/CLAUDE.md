# 테스트 모듈 / Tests Module

## 역할 / Role
Bash 기반 구조/훅 테스트 스위트. v2 앱 자체 테스트(`web/`의 vitest, `agent/`의 pytest/unittest)와는 별개로, repo 전반의 도구/구조 계약을 검증한다.
(Bash-based structure/hook test suite. Separate from the v2 app's own tests — `web/`'s vitest, `agent/`'s pytest/unittest — this validates repo-wide tooling/structure contracts.)

## 구조 / Layout
| 경로 | 대상 | 실행기 |
|------|------|--------|
| `tests/hooks/test-*.sh` | `.claude/hooks/` 훅 스크립트 동작·시크릿 패턴 | `bash tests/run-all.sh` |
| `tests/structure/test-*.sh` | 에이전트 계약, PR 리뷰 워크플로, Steampipe/ExternalId terraform 배선 | `bash tests/run-all.sh` |
| `tests/fixtures/` | 시크릿 샘플, 거짓 양성 샘플 | 훅/시크릿 테스트에서 로드 |

`tests/run-all.sh`는 위 훅/구조 테스트에 더해 `agent/`의 Python unittest(다크패스 루프·계정 로직 등)도 함께 구동한다.

## 실행 / Running
```bash
bash tests/run-all.sh    # 전체 (TAP 포맷, 훅+구조+agent)
```

## 규칙 / Rules
- 출력은 TAP v13 — `ok N - desc` / `not ok N - desc`
- 새 훅 추가 시 `tests/hooks/`에 대응 테스트 파일 생성 (`test-<hook>.sh`)
- 시크릿 탐지 테스트: `tests/fixtures/secret-samples.txt`에 양성, `false-positives.txt`에 음성 케이스 추가
- 통합 테스트는 실제 Steampipe/AgentCore에 붙이지 말 것 — 픽스처/모킹 사용
- CI 훅 실패 시 우회 금지(`--no-verify` 사용 금지) — 근본 원인 수정
