# awsops-intro 프레젠테이션

이 디렉터리에는 **서로 다른 두 개의 덱**이 공존한다. 자동으로 동기화되지 않는다.

| 자산 | 무엇인가 | 소스 / 재생성 경로 |
|---|---|---|
| `index.html` + `0N-*.html` (웹 슬라이드) | remarp 블록 기반 웹 프레젠테이션 (53장) | `_presentation.md` 매니페스트 + `0N-*.md` 블록에서 생성 |
| `awsops-intro.pptx` (정식 PPTX 덱) | 고객 발표용으로 별도 제작한 PowerPoint 덱 — **AWS Light 테마**(화이트 캔버스 · 퍼플→블루→그린 시그니처 그라디언트), 16:9, Pretendard 폰트(미설치 시 대체 폰트), 슬라이드마다 한국어 스피커 노트 포함 | `docs-site/scripts/pptx/build-awsops-intro-pptx.js` + `deck_kit.js` (pptxgenjs) — 아래 참조 |

## 정식 PPTX 덱 재생성

```bash
cd docs-site
npm ci            # pptxgenjs는 devDependency로 고정되어 있음
node scripts/pptx/build-awsops-intro-pptx.js
# → static/presentation/awsops-intro/awsops-intro.pptx 를 덮어씀 → 교체 커밋
```

- 슬라이드 구성·문구·스피커 노트는 전부 생성 스크립트가 단일 소스다. 내용을 고치려면 스크립트를 수정하고 다시 빌드한다. 디자인 시스템(토큰·커버/아젠다/디바이더/클로징 빌더)은 `scripts/pptx/deck_kit.js`(AWS Korea V-team 라이트 킷 벤더링본).
- PNG 자산 11종(배경 그라디언트 2 · 그라디언트 필 1 · AWS 로고 2 · 아이콘 6 — 전부 킷 번들, 스크린샷 아님; 덱이 실제 임베드하는 파일만 유지, 킷 예비 자산은 벤더링에서 제외)은 SHA-256을 고정한다. **해시 목록의 단일 소스는 `scripts/verify-deck.sh` 의 SUM 블록**(프로비넌스 pre-flight `sha256sum -c`)이다 — 자산 변경 시 같은 커밋에서 SUM 목록을 갱신할 것 (`cd docs-site && sha256sum scripts/pptx/assets/*.png` 출력이 SUM 형식과 동일). 킷 출처: AWS Korea V-team 라이트 템플릿(`aws-fcd-ppt-light` 스킬 번들)에서 벤더링, 이 덱이 쓰는 빌더만 트림.
- `export-utils.js` 의 "Export PPTX" 버튼(웹 슬라이드 스크린샷 기반)과는 무관하다.
- 웹 슬라이드 내용이 크게 바뀌면 이 덱도 함께 갱신할 것 — 두 덱은 자동으로 동기화되지 않는다.

## 발표자 가이드 (비공개 준비 사항)

- 슬라이드 4(오프닝 후크)는 발표자 개인의 실제 장애 경험담으로 시작하도록 설계되어 있다.
  **구체적 사례(날짜·서비스명)는 발표장에서 구두로만 풀 것** — 공개 배포되는 이 덱의
  스피커 노트/스크립트에는 실명 사례를 커밋하지 않는다 (아래 CI 스캔은 자유 서술형
  텍스트의 민감성까지는 판별하지 못한다).

## 배포/보안 유의

- 이 파일은 인증 없는 공개 docs-site 로 배포된다. **덱에 계정 ID·ARN·내부 호스트명·시크릿을 넣지 말 것** (스피커 노트 포함).
- `deploy-guide.yml` 의 build 검증이 **4중 게이트**로 막는다 (누락·위반 시 배포 실패):
  1. 존재 + zip 매직 + `ppt/presentation.xml` 구조 확인 + ZIP 컨테이너 사이드채널 차단(아카이브 코멘트·central/local extra 필드·data descriptor·레코드 사이 gap 바이트·EOCD 뒤 trailing 바이트 전부 금지)
  2. 콘텐츠 XML 민감정보 스캔 — 계정 ID·ARN·액세스 키·내부 호스트명·리소스 ID·사설 CIDR (theme 제외 전 XML/rels)
  3. **생성기 일치(프로비넌스)** — CI가 스크립트로 재빌드해 파트 목록 + 전체 아카이브(media 포함)를 diff. 손으로 바꾼 바이너리는 배포 불가
  4. 외부 관계 타깃(`TargetMode="External"`) 금지
- 게이트 3의 pre-flight로 **모든 `addImage`는 비어 있지 않은 `altText` 필수**(pptxgenjs가 `descr=altText||절대경로`를 기록 — 누락/빈 값이면 빌드 호스트 경로가 덱에 새고 머신 간 재빌드 파리티가 깨짐), 자산 핀은 **집합 일치**(`assets/` 전체 파일이 SUM 목록과 정확히 일치 — 미핀 파일 추가도 실패, 기대 수는 SUM에서 파생).
- **한계**: 임베드 이미지의 픽셀 내용은 스캔 불가 — 다만 프로비넌스 게이트가 media를 생성기 산출물로 고정하므로, 이미지 교체는 스크립트/자산 커밋 리뷰를 거쳐야만 가능하다. PNG 자산 11종은 전부 킷 번들 산출물 — 그라디언트류는 합성 그래픽, AWS 로고·서비스 아이콘은 AWS 브랜드 자산(스크린샷 아님; AWS 상표 가이드라인 하에 AWS 소개 목적으로만 사용).
- `.gitignore` 는 전역 `*.pptx` 를 무시하되 이 파일 하나만 예외 처리되어 있다.
