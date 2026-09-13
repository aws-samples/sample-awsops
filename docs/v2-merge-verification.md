# v2 Merge Verification / v2 머지 검증

이 게이트는 설계-대비-구현 감사에서 나온 v2 머지 불변식을 `feat/v2-architecture-design` →
`main` 머지 전에 실행 가능한 검증으로 고정한다.

- **S1**: `terraform/foundation/`의 frozen/gated 리소스가 여전히 default-off이고
  `count`/`for_each`로 게이트되어 있는지, 추적된 tfvars가 게이트된 flag를 활성화하지
  않는지 확인 (`scripts/v2/merge_invariants.py`).
- **S2**: AgentCore catalog·web sections·route rules 9개 섹션 키가 정합하는지,
  `observability`→`external-obs` 별칭이 라우팅 양쪽(카탈로그+에이전트 런타임)에 있는지,
  v1 `/awsops/` 경로 리터럴이 web 소스에 누출되지 않는지 확인 (`web/lib/merge-invariants.ts`).
- **S3**: 파일 격리 pytest + web vitest + 배포 Node 테스트를 필수 실행한다. 배포 Node 테스트는
  PyYAML과 Terraform **1.15.7**이 필수이며 누락 시 실패한다. 마지막 fmt/validate 진단만
  참고용이다. PR CI는 private migration 오프라인 테스트, 실제 PostgreSQL runner·웹 연결 단계 테스트,
  별도 복사본의 backend 비활성 Terraform mock 테스트도 필수로 실행한다
  (`scripts/v2/merge-verify.sh`, `scripts/v2/terraform-test.sh`, `.github/workflows/merge-verify.yml`).

**알려진 한계 (patch 대상 아님, 문서화만)**: `ungated_resources()`는 리소스 body 안의
`count=`/`for_each=` 라인 존재만 확인한다 — 중첩된 `dynamic` 블록의 `for_each`만 있고
최상위 게이트가 없는 리소스는 이론상 검출을 통과할 수 있다. 현재 10개 게이트 파일 중
이 패턴으로 실제 발생하는 위양성은 0건(측정 완료)이지만, 최상위 속성만 인정하도록
좁히는 것은 후속 작업이다.

---

This gate turns the v2 merge invariants from the design audit into executable checks before merging
`feat/v2-architecture-design` to `main`.

**Known limitation (documented, not patched this round):** `ungated_resources()` only checks
for the presence of a `count=`/`for_each=` line anywhere in a resource body — a resource whose
only gate is a nested `dynamic` block's `for_each` (with no top-level gate) could theoretically
slip through undetected. Zero false negatives from this pattern exist across the current 10
gated files (measured), but narrowing the check to top-level attributes only is a follow-up.

## Scenarios

| Scenario | Invariant | Design source | Verification code path | Command |
| --- | --- | --- | --- | --- |
| S1 | Frozen and gated Terraform resources stay default-off, gated by `count` or `for_each`, and tracked tfvars do not enable gated flags. | `docs/decisions/BASELINE.md`, ADR-005, ADR-006, ADR-007 | `scripts/v2/test_merge_invariants.py`, `scripts/v2/merge_invariants.py` | `python3 -m pytest scripts/v2/test_merge_invariants.py -q` |
| S2 | The 9 routed sections align across AgentCore catalog, web sections, route rules, and the `observability` to `external-obs` alias; v1 `/awsops/` route literals do not leak into v2 web sources. | ADR-004, ADR-038 | `web/lib/merge-invariants.test.ts`, `web/lib/merge-invariants.ts` | `cd web && npx vitest run lib/merge-invariants.test.ts` |
| S3 | Isolated Python, web vitest, deployment Node tests, offline migration tests, real PostgreSQL migration and web connection-phase tests, and backend-disabled Terraform mock tests. | 2026-07-05 v2 merge verification plan; root `CLAUDE.md` required-test rule | `scripts/v2/merge-verify.sh`, `scripts/v2/ci/`, `scripts/v2/terraform-test.sh`, `.github/workflows/merge-verify.yml` | All four commands below |

## Runner Usage

Use Node.js 20 (CI and web runtime; migration runtime image uses 22), Python 3.12, curl, OpenSSL, Terraform **1.15.7**
and a reachable Docker daemon. Install dependencies from the repository root. The private
migration suites use locked `pg` and AWS SDK dependencies from `scripts/v2/package-lock.json`.
The web connection-phase suite uses the locked driver and TypeScript from `web/`.
CI·웹 런타임 Node 20(migration 런타임 이미지 22)·Python 3.12·curl·OpenSSL·Terraform **1.15.7**·접근 가능한 Docker를
준비한다. private migration 테스트는 `scripts/v2`의 잠긴 `pg`·AWS SDK 의존성을,
웹 연결 단계 테스트는 `web/`의 잠긴 드라이버·TypeScript를 사용한다.

```bash
(cd web && npm ci)
npm ci --prefix scripts/v2 --ignore-scripts --no-audit --no-fund
python3 -m pip install \
  -r scripts/v2/requirements-test.txt \
  -r agent/requirements.txt \
  -r scripts/v2/incident/requirements.txt \
  -r scripts/v2/remediation/requirements.txt \
  -r scripts/v2/steampipe/requirements.txt \
  -r scripts/v2/workers/requirements.txt
```

Run all four commands for the CI-equivalent merge checks from the repository root:
CI와 같은 범위의 검증에는 루트에서 네 명령을 모두 실행한다.

```bash
bash scripts/v2/merge-verify.sh
node --test scripts/v2/ci/*.test.mjs
node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs
bash scripts/v2/terraform-test.sh
```

**Required PostgreSQL CI suites:** `scripts/v2/ci/migration.itest.mjs` (including initializer
regressions) and `scripts/v2/ci/web-db-connection.itest.mjs` both fail hard, unlike the
legacy optional `scripts/v2/*.itest.mjs` convention in root `CLAUDE.md`.
They use bare `docker` on PATH, without the legacy `DOCKER`
override/`sudo docker`; grant local daemon access before running. Missing Docker fails the
suite rather than skipping it. `*.test.mjs` stays offline: SDK transport is local, no AWS credentials.
The PostgreSQL fixture uses `postgres:17`, pulls only if missing, creates ephemeral
credentials/CA, binds a random loopback port and removes its own container/files.
Cache dependencies/images first for disconnected execution.

**필수 PostgreSQL CI 테스트:** initializer를 포함한 `scripts/v2/ci/migration.itest.mjs`와
`scripts/v2/ci/web-db-connection.itest.mjs`는 모두 루트 CLAUDE의 레거시 선택적 itest와 달리
실패 시 gate를 막는다. PATH의 `docker`를 직접
사용하므로 실행 전 daemon 접근을 준비하고 `DOCKER`/`sudo docker` 자동 처리를 기대하지 않는다.
Docker 부재는 skip이 아니다. `*.test.mjs`는 로컬 SDK transport로 AWS 없이 실행한다.
PG fixture는 필요 시 `postgres:17`을 pull하고 임시 자격증명·CA·loopback 포트만 사용하며
자체 리소스를 정리한다. 외부 연결 없는 검증은 의존성과 이미지를 미리 캐시한다.

The web observer's `db_connection_failed` event contains only the current connection phase
and elapsed milestone timings. Real PostgreSQL/TLS cases cover async password resolution,
provider failure, PostgreSQL authentication rejection and successful connections.
웹 observer의 `db_connection_failed` 이벤트는 현재 연결 단계와 단계별 경과 시간만 담는다.
실제 PostgreSQL/TLS 사례로 비동기 비밀번호 준비·provider 오류·PostgreSQL 인증 거절·정상 연결을 검증한다.

The runner discovers `test_*.py` under `scripts/v2` and `agent` by default, then runs each file in a
separate `python3 -m pytest` process from the file's own directory. Files in a `tests/` directory get
that directory's parent prepended to `PYTHONPATH` for that one pytest process, so adjacent module-root
imports such as `agent/anthropic_loop.py` resolve while failure summaries still use the original
discovered path. Override the Python search root for focused checks:

```bash
MERGE_VERIFY_PY_ROOT=/tmp/merge-fixtures MERGE_VERIFY_SKIP_WEB=1 bash scripts/v2/merge-verify.sh
```

Set `MERGE_VERIFY_SKIP_WEB=1` only for local fixture or runner development. The CI workflow runs the
web vitest stage. The deployment Node tests always run in the shared script; a Node failure,
like a Python or web failure, makes the runner fail. To run only that suite:

```bash
node --test scripts/v2/deployment-smoke.test.mjs
```

This required deployment suite loads workflow YAML using Python 3 with **PyYAML** and evaluates
an offline variable fixture with Terraform **1.15.7**. Real curl/HTTPS cases also require curl and
OpenSSL; they use only a loopback server and local test certificates. Missing prerequisites fail the suite and
the shared runner; these tests never skip. The fixture uses no providers, deployment backend or AWS.

The script's later formatting/validation diagnostics remain informational: it runs
`terraform -chdir=terraform/foundation fmt -check` when the binary is available and `validate`
when `terraform/foundation/.terraform` exists. A `SKIP` from this final stage does not waive
the deployment suite's Terraform requirement. The **required CI mock-test step** is also separate.
`terraform-test.sh` requires 1.15.7, copies tracked working-tree files into a disposable directory,
strips deployment credentials/TF variables, initializes with
`-backend=false -input=false -lockfile=readonly` in a fresh `TF_DATA_DIR`, validates and runs
`tests/dns_deferred.tftest.hcl`. Providers are mocked; no real backend is initialized and no
AWS/DNS API is called. Local `.terraform`, backend config, tfvars and state are not copied.
Initialization installs locked providers; for fully offline use, point `TF_CLI_CONFIG_FILE`
at an existing filesystem mirror containing them with no `direct` fallback.

배포 Node 테스트는 curl·OpenSSL·Python 3·PyYAML·Terraform **1.15.7**을 필수로 요구한다.
HTTPS 사례는 loopback 서버와 로컬 테스트 인증서만 사용한다. 의존성이 누락하면
공통 러너도 실패하며 skip하지 않는다. 변수 fixture는 provider·배포 backend·AWS를 사용하지 않는다.
마지막 fmt/validate 참고용 진단과 CI 필수 mock 검사는 별개이며 참고 진단의 SKIP으로
필수 의존성을 생략할 수 없다. `terraform-test.sh`는
추적된 작업 파일만 별도 복사하고 배포 자격증명/TF 변수를 제거한다. 새 `TF_DATA_DIR`에서
`init -backend=false -input=false -lockfile=readonly`·validate·mock test를 실행한다.
실제 backend와 AWS/DNS API는 사용하지 않으며 로컬 상태/설정을 복사하지 않는다.
완전 오프라인 초기화에는 locked provider가 있는 filesystem mirror를 지정한다.

## Pytest Isolation

Do not replace the Python stage with a single aggregate `pytest scripts/v2 agent` command. The current
suite has known false positives when files share one Python process: tests mutate `sys.path` and
environment variables, and same-name helper modules such as `db` and `handlers` can collide. Running
each `test_*.py` file in its own pytest process preserves isolation and avoids the measured 57
aggregate-run false failures.

## CI Gate

`.github/workflows/merge-verify.yml` runs on pull requests targeting **main and dev**:

1. Check out the PR and set up Node.js 20, Python 3.12 and Terraform **1.15.7** (wrapper disabled).
2. Install web dependencies, `scripts/v2/requirements-test.txt` (**pytest and PyYAML**) and
   the existing agent/incident/remediation/Steampipe/worker requirements.
3. Run `bash scripts/v2/merge-verify.sh`: file-isolated pytest (including workflow fixtures and
   the localhost Terraform state-read test), web vitest, required deployment Node tests
   (PyYAML and Terraform 1.15.7), then informational fmt/validate diagnostics.
4. Install locked `scripts/v2` dependencies with `--ignore-scripts` and run
   `node --test scripts/v2/ci/*.test.mjs` (runtime/controller/workflow fixtures and mocked Terraform plans).
5. Run `node --test scripts/v2/ci/migration.itest.mjs scripts/v2/ci/web-db-connection.itest.mjs`
   against disposable PostgreSQL. Keep all migration cases:
   real initialization/ULIDs, rollback/retry/checksums, lock serialization, reader guards,
   permission denial, password rotation and TLS rejection. Also verify the web connection
   observer's phase/timing and error propagation. Docker failure is a gate failure.
6. Run `bash scripts/v2/terraform-test.sh`: required validate/mock-plan tests in an isolated tracked copy,
   initialized with `-backend=false`. A validation or test failure fails CI.

CI는 **main/dev** 대상 PR에서 Node 20·Python 3.12·Terraform 1.15.7을 설치한다.
pytest·PyYAML과 기존 의존성 설치 후 공통 러너를 실행하고 `scripts/v2` 의존성을
`--ignore-scripts`로 설치한다. migration offline 테스트·Docker PG migration/웹 연결 단계 테스트·별도 복사본의
backend 비활성 Terraform validate/mock 테스트 모두 필수다.

These PR-authored tests run only under `pull_request` with `contents: read`, no deployment
credentials, secrets or OIDC permissions. They must not move to `pull_request_target` or gain
secret access.
PR 코드는 `pull_request`·`contents: read`에서 배포 자격증명·시크릿·OIDC 없이 검사한다.
`pull_request_target` 전환이나 secret 접근을 추가하지 않는다. private migration 검사는
runtime·controller·workflow와 모의 Terraform 계획을 포함하며 실제 AWS는 호출하지 않는다.

## Manual Gates Outside CI

A runtime image build can be checked locally using the
[migration guide](../terraform/foundation/migrations/README.md). Merge Verify does not build it;
the manually dispatched Migrate Development Database workflow builds the ARM64 image before execution.
Merge Verify는 이미지를 빌드하지 않는다. 수동 Migrate Development Database 워크플로는
실행 전에 ARM64 이미지를 빌드하며 로컬 검증 방법은 migration 안내를 따른다.

Before the final merge, run the routing accuracy gate against real Bedrock:
This is a live manual gate, separate from the offline commands above; it requires the intended
account and explicit permission for live checks. 오프라인 검증과 별개의 라이브 수동 게이트이며,
의도한 계정과 라이브 검증 권한이 있어야 한다.

```bash
node scripts/v2/routing-accuracy.mjs
```

This is the ADR-038 golden-set check and must remain at or above 85%.

Also run the production web build manually:

```bash
cd web && npm run build
```
