# v2 → main 머지 검증 시나리오 + 자동 검증 코드

Source: 2026-07-05 설계-대비-구현 감사(v2 브랜치 434커밋, main 머지 전). 감사 결론: 머지 차단
미구현은 없으나, 설계가 요구하는 **머지 불변식이 자동 검증 없이 문서로만 존재**한다. 이 플랜은
그 불변식을 실행 가능한 검증 코드로 고정한다.

베이스라인 (2026-07-05 측정):
- web vitest: 180 파일 / 1492 tests **그린**.
- scripts/v2 pytest: **파일 단위로는 전부 그린**(예: `test_incident.py` 단독 48 passed). 그러나
  `pytest scripts/v2` 통합 실행은 57건 위양성 실패 — 각 테스트 파일이 `sys.path.insert` +
  `os.environ` 전역을 공유해 파일 간 오염(동명 모듈 `db`/`handlers` 충돌, env 누수). 실제 회귀 아님.
- 테스트 CI 워크플로 부재(`.github/workflows/`에 review/deploy만 존재) — 머지 게이트가 없다.

검증 시나리오 (설계 문서 → 실행 가능 불변식):
- **S1 게이트 불변식** (BASELINE.md §2, ADR-005/006/007): 모든 `*_enabled` terraform 변수는
  default=false; **게이트 파일 10개**(incidents/remediation/writeback/k8sgpt/notify/steampipe/
  workers/ai/eks/secret-rotation.tf)의 모든 `resource` 블록은 count/for_each 게이트(파일당
  단일 flag 매핑 아님 — remediation.tf는 `local.iw`/`local.re_or_iw`로 2개 flag,
  incidents.tf는 `local.rwb` 부가 게이트, eks.tf는 `for_each onboard_eks_clusters`);
  `remediation_enabled` description에 FROZEN 마커(`DO NOT ENABLE` 정확 부분문자열) 유지;
  `terraform/` 아래 **추적되는** `*.tfvars`/`*.auto.tfvars`가 frozen/gated flag를 true로
  설정하지 않음.
- **S2 라우팅 정합** (ADR-004 개정 2026-06-24): catalog.py GATEWAYS 9개 ↔ web/lib/sections.ts
  섹션 키 ↔ web/lib/route.ts RULES 키 정합 + `agent/agent.py`의
  `_GATEWAY_ALIAS = {"observability": "external-obs"}` 존재(별칭의 런타임 측); v1 규칙 누출
  금지 — web/ 소스에 **따옴표로 시작하는** `/awsops/` 경로 리터럴 0건
  (주의: 단순 부분문자열 스캔은 `/ops/awsops-v2/...` SSM 경로로 위양성 18건 — 측정 완료).
- **S3 스위트 그린을 머지 게이트로**: 파일 격리 pytest 전체(scripts/v2 **+ agent/**, 재귀
  탐색) + web vitest + S1/S2를 한 번에 돌리는 러너 + **PR CI 워크플로**(머지 게이트 실체화)
  + 시나리오 문서. `routing-accuracy.mjs`는 실 Bedrock 호출이라 CI 제외(문서에 수동 게이트로 명기).

### Task 1: Terraform 게이트 불변식 검증 (S1)

**Files:**
- Create: `scripts/v2/merge_invariants.py`
- Test: `scripts/v2/test_merge_invariants.py`

- [ ] (host) `scripts/v2/test_merge_invariants.py` 작성 — `merge_invariants` 모듈을 import하여
      다음을 단언(모듈 부재로 레드):
      - `tf_flag_defaults(tf_dir)` → `terraform/foundation/*.tf`의 모든 `variable "…_enabled"`
        블록을 `{name: default}` dict로 반환하고, 전부 `false`여야 함. **변수 블록은 중괄호
        짝맞춤으로 경계 파싱**(validation 중첩 블록이 있는 `eks_auto_register_enabled` 등에서
        `default` 줄이 블록 밖/다른 블록의 것으로 오인되지 않도록)
      - `ungated_resources(tf_file)` → 해당 .tf의 `resource` 블록 중 본문에
        `count =`/`for_each =` 줄이 **하나도 없는** 블록 목록 반환; **게이트 10파일**
        (incidents/remediation/writeback/k8sgpt/notify/steampipe/workers/ai/eks/secret-rotation.tf)
        전부에 대해 빈 목록이어야 함(flag별 매핑 검증이 아니라 "게이트 없는 리소스 0건" —
        multi-flag 파일과 locals 간접 참조를 자연 흡수, 위양성 회피)
      - `frozen_marker_present(variables_tf)` → `remediation_enabled` 변수 description에
        정확 부분문자열 `DO NOT ENABLE` 존재 확인 (2026-07-05 현재 실제 텍스트 확인 완료)
      - `tracked_tfvars_enabling(tf_root)` → `git ls-files 'terraform/**/*.tfvars'
        'terraform/**/*.auto.tfvars'` 결과에서 `…_enabled\s*=\s*true` 설정 목록 반환; 빈
        목록이어야 함(frozen/gated flag의 커밋된 활성화 차단)
- [ ] (implementer) `scripts/v2/merge_invariants.py` 구현 — stdlib `re`+문자열 파싱만 사용
      (terraform 바이너리·hcl 파서 의존 금지).
- [ ] `python3 -m pytest scripts/v2/test_merge_invariants.py -q` 그린 확인.

### Task 2: 9-섹션 라우팅 정합 검증 (S2)

**Files:**
- Create: `web/lib/merge-invariants.ts`
- Test: `web/lib/merge-invariants.test.ts`

- [ ] (host) `web/lib/merge-invariants.test.ts` 작성 — `./merge-invariants`에서 헬퍼를 import하여
      단언(모듈 부재로 레드):
      - `readCatalogGateways()` → `scripts/v2/agentcore/catalog.py`의 `GATEWAYS` 리스트를 fs로
        읽어 파싱; 정확히 9개
      - `readSectionKeys()`(`web/lib/sections.ts`) / `readRouteRuleKeys()`(`web/lib/route.ts`) —
        두 키 집합이 일치하고, `observability`→`external-obs` 별칭 적용 시 GATEWAYS 집합과 일치
      - `readAgentAlias()` → `agent/agent.py`의 `_GATEWAY_ALIAS`에
        `"observability": "external-obs"` 매핑 존재(별칭의 런타임 측 — agent.py:38 확인 완료)
      - `scanV1PathLeak()` → `web/{app,lib,components}` + `web/middleware.ts` 소스(.ts/.tsx)에서
        정규식 `["'\`]\/awsops\/` (따옴표 3종 직후 `/awsops/`) 매치 0건. 단순 부분문자열 스캔
        금지 — `/ops/awsops-v2/...` SSM 경로 위양성 18건 측정됨
- [ ] (implementer) `web/lib/merge-invariants.ts` 구현 — node `fs`/`path`만 사용, 정규식 파싱.
      기존 코드(`sections.ts`, `route.ts`, `agent.py`) 수정 금지 — 읽기만.
- [ ] `cd web && npx vitest run lib/merge-invariants.test.ts` 그린 확인.

### Task 3: 머지 검증 러너 + CI 게이트 + 시나리오 문서 (S3)

**Files:**
- Create: `scripts/v2/merge-verify.sh`
- Create: `.github/workflows/merge-verify.yml`
- Create: `docs/v2-merge-verification.md`
- Test: `scripts/v2/test_merge_verify_runner.py`

- [ ] (host) `scripts/v2/test_merge_verify_runner.py` 작성 — 단언(러너 부재로 레드):
      - `scripts/v2/merge-verify.sh` 존재 + 실행 비트
      - **동작 증명(텍스트 검사 아님)**: 임시 디렉토리에 통과 1개 + 실패 1개 `test_*.py`
        픽스처를 만들고 `MERGE_VERIFY_PY_ROOT=<임시디렉토리> MERGE_VERIFY_SKIP_WEB=1`로 러너를
        실행 → exit≠0 + 요약에 실패 파일명 포함; 실패 픽스처 제거 후 재실행 → exit 0
      - `.github/workflows/merge-verify.yml` 존재 + `pull_request`(branches: main) 트리거 +
        러너 호출 포함
      - `docs/v2-merge-verification.md` 존재 + S1/S2/S3 시나리오 헤딩 포함
- [ ] (implementer) `scripts/v2/merge-verify.sh` 구현 — bash, repo 루트 기준 실행, 의존성 없음:
      1) `find` 재귀로 `${MERGE_VERIFY_PY_ROOT:-scripts/v2 agent}` 아래 모든 `test_*.py`를
         **파일별 개별 pytest 프로세스**로 실행(오염 회피 — 통합 실행은 57건 위양성), 실패 파일 집계
      2) `MERGE_VERIFY_SKIP_WEB=1`이 아니면 `cd web && npx vitest run`
      3) terraform 바이너리 있으면 `terraform -chdir=terraform/foundation fmt -check`
         (+ `.terraform` 초기화돼 있으면 `validate`), 없으면 `SKIP` 로그 — 실패로 치지 않음
      4) 스테이지별 PASS/FAIL 요약 출력, 실패 있으면 `exit 1`
- [ ] (implementer) `docs/v2-merge-verification.md` 작성 — S1~S3 시나리오 표(불변식 → 근거
      설계문서 → 검증 코드 경로 → 실행 명령), 러너 사용법(`bash scripts/v2/merge-verify.sh`),
      pytest 통합 실행 위양성 주의 1단락, CI 게이트(`merge-verify.yml`) 설명,
      **수동 게이트 명기**: `routing-accuracy.mjs`(실 Bedrock, ADR-038 golden-set ≥85%)와
      `npm run build`(web)는 CI 러너 밖 — 머지 전 수동 실행 항목
- [ ] (implementer) `.github/workflows/merge-verify.yml` — `pull_request`(main 대상) 트리거,
      node 20 + python 3.12 셋업, `cd web && npm ci`, `pip install pytest`, 러너 1회 실행
- [ ] `python3 -m pytest scripts/v2/test_merge_verify_runner.py -q` 그린 + 러너 실제 1회 실행 그린 확인.
