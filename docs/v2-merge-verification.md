# v2 Merge Verification / v2 머지 검증

이 게이트는 설계-대비-구현 감사에서 나온 v2 머지 불변식을 `feat/v2-architecture-design` →
`main` 머지 전에 실행 가능한 검증으로 고정한다.

- **S1**: `terraform/foundation/`의 frozen/gated 리소스가 여전히 default-off이고
  `count`/`for_each`로 게이트되어 있는지, 추적된 tfvars가 게이트된 flag를 활성화하지
  않는지 확인 (`scripts/v2/merge_invariants.py`).
- **S2**: AgentCore catalog·web sections·route rules 9개 섹션 키가 정합하는지,
  `observability`→`external-obs` 별칭이 라우팅 양쪽(카탈로그+에이전트 런타임)에 있는지,
  v1 `/awsops/` 경로 리터럴이 web 소스에 누출되지 않는지 확인 (`web/lib/merge-invariants.ts`).
- **S3**: 파일 격리 pytest + web vitest + 배포 Node 테스트 + 선택적 Terraform 검사를 공통
  러너로 묶는다. PR CI는 별도 복사본의 backend 비활성 Terraform mock 테스트도 필수로 실행한다
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
| S3 | Merge verification runs isolated Python, web vitest and deployment Node tests; CI also requires isolated, backend-disabled Terraform mock tests. | 2026-07-05 v2 merge verification plan | `scripts/v2/merge-verify.sh`, `scripts/v2/terraform-test.sh`, `.github/workflows/merge-verify.yml` | `bash scripts/v2/merge-verify.sh` and `bash scripts/v2/terraform-test.sh` |

## Runner Usage

Use Node.js 20, Python 3.12, OpenSSL and Terraform **1.15.7**. Install the test dependencies
from the repository root (the Node smoke suite uses only Node built-ins):
Node.js 20·Python 3.12·OpenSSL·Terraform **1.15.7**을 준비하고 루트에서 의존성을 설치한다.
Node 스모크 테스트에는 별도 npm 의존성이 없다.

```bash
(cd web && npm ci)
python3 -m pip install \
  -r scripts/v2/requirements-test.txt \
  -r agent/requirements.txt \
  -r scripts/v2/incident/requirements.txt \
  -r scripts/v2/remediation/requirements.txt \
  -r scripts/v2/steampipe/requirements.txt \
  -r scripts/v2/workers/requirements.txt
```

Run both commands for the CI-equivalent merge checks from the repository root:
CI와 같은 범위의 검증에는 루트에서 두 명령을 모두 실행한다.

```bash
bash scripts/v2/merge-verify.sh
bash scripts/v2/terraform-test.sh
```

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

The Terraform stage runs `terraform -chdir=terraform/foundation fmt -check` when the binary is
available, and also runs `validate` when `terraform/foundation/.terraform` exists. Missing
Terraform tooling is reported as `SKIP`; Terraform diagnostics are non-blocking in this runner.
This opportunistic stage is separate from the **required CI mock-test step**.
`terraform-test.sh` requires 1.15.7, copies tracked working-tree files into a disposable directory,
strips deployment credentials/TF variables, initializes with
`-backend=false -input=false -lockfile=readonly` in a fresh `TF_DATA_DIR`, validates and runs
`tests/dns_deferred.tftest.hcl`. Providers are mocked; no real backend is initialized and no
AWS/DNS API is called. Local `.terraform`, backend config, tfvars and state are not copied.
Initialization installs locked providers; for fully offline use, point `TF_CLI_CONFIG_FILE`
at an existing filesystem mirror containing them with no `direct` fallback.

공통 러너의 선택적 Terraform 검사와 CI 필수 mock 검사는 별개다. `terraform-test.sh`는
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
   the localhost Terraform state-read test), web vitest, deployment Node tests and opportunistic TF checks.
4. Run `bash scripts/v2/terraform-test.sh`: required validate/mock-plan tests in an isolated tracked copy,
   initialized with `-backend=false`. A validation or test failure fails CI.

CI는 **main/dev** 대상 PR에서 Node 20·Python 3.12·Terraform 1.15.7을 설치한다.
pytest·PyYAML과 기존 하위 시스템 의존성 설치 후 공통 러너(격리 Python·web·Node)를 실행하고,
별도 복사본의 backend 비활성 Terraform validate/mock 테스트도 필수로 실행한다.

## Manual Gates Outside CI

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
