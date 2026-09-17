# AWSops AWS Blog 원고

게시용 제목: **Amazon Bedrock AgentCore와 읽기 전용 MCP 도구로 SRE 장애 조사와 정기 진단 연결하기**

SRE의 온콜 대응과 반복 점검에서 출발해, 데이터 수집·Resource Graph·AI 도구 연결·정기 진단이 각각 어떤 문제를 해결하는지 설명하는 한국어 원고입니다.

사용자 후속 지시에 따라 분량 상한과 강제 감축 기준을 해제했습니다. 현재 [편집 기준](EDITORIAL-SCOPE.md)에 따라 설계 이유, 계정·수집 범위, 보고서 해석과 운영 검증 설명을 충분히 담습니다.

독자의 첫 실행 경로는 **AgentCore의 역할 → ENI 질문의 처리 흐름 → 샘플 코드 → 배포와 성공 확인**으로 연결했습니다. 주 샘플은 공개 예정인 [aws-samples/sample-awsops](https://github.com/aws-samples/sample-awsops)입니다. 현재 비공개이므로 게시 전 공개 전환과 본문 링크의 비로그인 접근을 확인해야 합니다.

| 파일 | 용도 |
|---|---|
| [draft-awsops-architecture.md](draft-awsops-architecture.md) | 게시용 본문 |
| [blog-human.md](blog-human.md) | 초기 착상 메모, 미완성 표현을 포함하며 게시·검증 대상 아님 |
| [이전 편집 브리프](REVIEW-2026-09-13-codex-brief.md) | 철회된 지시·판정·경로를 포함한 과거 기록 |
| [렌더러](render_preview.py), [의존성](requirements-preview.txt) | 로컬 미리보기 생성 |
| [그림 출력 도구](drawio/build.py), [회귀 검사](drawio/test_build.py) | 원본 검증·출력과 실패 시 기존 파일 보존 검사 |
| `preview.html` (아래 명령으로 생성) | 로컬 브라우저에서 확인하는 가독성 미리보기 |
| [technical-notes.md](technical-notes.md) | 구현 근거, 지원 범위, 편집·검토 참고 자료 |
| [EDITORIAL-SCOPE.md](EDITORIAL-SCOPE.md) | 사용자 후속 지시를 반영한 현재 편집 기준 |
| [복구 검증 기록](VALIDATION-2026-09-17.md) | 현재 소스 검증 범위와 미검증 항목 |
| [그림 1](images/fig1-sre-workflow.png) | 운영 질문과 SRE 검증 흐름 |
| [그림 2a](images/fig2a-interactive.png) | 운영자 접근과 대화형 AI 조사 |
| [그림 2b](images/fig2b-diagnosis.png) | 인벤토리·관계 정보와 예약 진단 |
| [그림 3](images/fig3-agentcore.png) | AgentCore Runtime·Gateway·Lambda 조회 경로 |
| [그림 4](images/fig4-workers.png) | 비동기 워커와 상태 보정 |
| [images/](images/) | 각 그림의 PNG·SVG와 기술 노트용 보조 그림 |
| [drawio/](drawio/) | 편집 가능한 다이어그램 원본과 연결 사양 |

## 미리보기 재생성

저장소 루트에서 다음과 같이 실행합니다.

```bash
python3 -m venv /tmp/awsops-blog-preview-venv
/tmp/awsops-blog-preview-venv/bin/pip install -r blog/2026-09-awsops/requirements-preview.txt
/tmp/awsops-blog-preview-venv/bin/python blog/2026-09-awsops/render_preview.py
```

생성된 `preview.html`을 로컬 브라우저로 엽니다. 이미지와 스타일은 로컬 파일을 사용하며, 이미지 선택 시 원본 크기로 확인할 수 있습니다. 렌더러는 원고 옆의 `preview.html`만 갱신하고 AWS 호출이나 이미지 생성을 수행하지 않습니다.

## 출력 도구 회귀 검사

```bash
python3 -m unittest discover -s blog/2026-09-awsops/drawio -p test_build.py
```

## 이미지 수정

일반적인 편집에는 `drawio/`의 `.drawio` 파일을 사용합니다. PNG와 SVG도 함께 갱신해 본문과 미리보기에 반영합니다.

`.drawio`가 그림의 기준 원본이며 YAML은 구조 참고 자료입니다. `drawio/build.py`는 원본을 검증한 뒤 PNG·SVG를 내보냅니다. Draw.io CLI, 헤드리스 Linux의 `xvfb-run`, `aws-content-plugin`의 `architecture-diagram` 스킬이 필요하며 스킬 설치 경로는 `AWS_DIAGRAM_SKILL_DIR`로 지정할 수 있습니다.

```bash
python3 blog/2026-09-awsops/drawio/build.py --check
python3 blog/2026-09-awsops/drawio/build.py
```

그림 1은 원본 보존 대상으로 해시만 확인하고 다시 내보내지 않습니다. 본문 그림은 `fig1`, `fig2a`, `fig2b`, `fig3`, `fig4` 접두를 사용하며 기술 노트의 엣지·인증 보조 그림은 `appendix-a`, `appendix-b`로 구분합니다.

## 게시 준비

본문은 구현된 기능과 기존 워커 검증 결과를 설명하며, 범위가 확인되지 않은 발견 건수는 질적 서술로 바꾸었습니다. 사용자 제공 수치와 미검증 범위는 `technical-notes.md`에서 추적합니다. 저자 소개와 소속, 제출 채널의 메타데이터는 게시 단계에서 확정합니다. 기술 노트와 이 안내는 게시 본문이 아닌 편집 참고 자료입니다.
