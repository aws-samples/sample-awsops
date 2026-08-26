# Plan — W2a: trigger_event persistence + migration (data foundation)

> 원천 / Source: spec §6.1/§9 + W2 P2 gate (glm+agy 수렴: **W2를 W2a 데이터 + W2b 검증기로 분할** — 롤백 안전·리뷰성). W2b(AlertValidation 워커 + SM splice + incidents.tf)는 별도 plan `…-w2b-validator-plan.md`.
> Scope: **W2a only** — CloudWatch AlarmArn 캡처 + trigger_event 스냅샷 영속(web+py 락스텝, New-path만, degrade-safe) + 마이그레이션(trigger_event/validation JSONB·stage/status CHECK superset·GIN). **동작 변화 없음**(아무도 trigger_event를 아직 읽지 않음 — W2b에서 소비); 순수 데이터 기반·inert.
> Posture: read-only 데이터 영속. AWS mutation 없음. 마이그레이션은 nullable JSONB(inert OFF). v1 `src/` 무수정.
> Branch `feat/v2-alert-validation-w2` (worktree). TDD red→green→commit.

## 표면 사실(근거)
- trigger_event 두 write 사이트 **락스텝**: web/lib/incident.ts New-win(:71/82) + scripts/v2/incident/triage.py `_dedup_insert` 반환 non-None(:153-154). New만; Linked는 기존 스냅샷 보존.
- **degrade-safe 우선**: 마이그레이션 미적용(컬럼 부재) 시 triage가 깨지면 안 됨 → trigger_event write는 **INSERT에 끼우지 않고 별도 try/catch UPDATE**(컬럼 부재 시 무시). atomicity보다 degrade-safety 우선(검증기는 스냅샷 부재 시 uncertain→escalate로 안전 저하).
- AlarmArn은 normalizeCloudWatch가 **미캡처**(msg.AlarmArn 안 읽음; TopicArn≠AlarmArn). AlertEvent에 `alarmArn?` 추가 필요.
- 마이그레이션: stage/status CHECK는 inline-unnamed(auto `incident_stages_stage_check`/`incidents_status_check`); DROP IF EXISTS + superset ADD(기존 값 전부 포함). nullable JSONB(NOT NULL/DEFAULT 없이, rca/mitigation_plan 선례). migrations/ 파일 schema_migrations INSERT 금지·작성후 불변(sha256). `-- since: 2.4.0`. GIN `jsonb_path_ops`.

## File scope
web/lib/incident-normalize.ts(+test), web/lib/incident.ts(+test), scripts/v2/incident/triage.py, scripts/v2/incident/test_incident.py, terraform/foundation/migrations/01KVYC5ZYXG6SKQRECWCWQ05ZH_incident_validation_stage.sql, scripts/v2/incident/test_w2_migration.py, this plan.

### Task 1: Capture CloudWatch AlarmArn (web, test-first)

**Files:**
- Modify: `web/lib/incident-normalize.ts`
- Modify: `web/lib/incident-normalize.test.ts`

- [ ] Test: CloudWatch SNS Notification whose `Message` JSON has `AlarmArn` → `AlertEvent.alarmArn===<arn>`; absent → undefined; non-CloudWatch → undefined; `TopicArn` NOT used as alarmArn.
- [ ] Impl: add `alarmArn?: string` to `AlertEvent`; `normalizeCloudWatch` reads `msg.AlarmArn`.
- [ ] Verify: `cd web && ../node_modules/.bin/vitest run lib/incident-normalize.test.ts` green.
- [ ] Commit: `feat(incident): capture CloudWatch AlarmArn in normalizeCloudWatch [W2a]`

### Task 2: Persist trigger_event snapshot on New (web+py lockstep, degrade-safe, test-first)

**Files:**
- Modify: `web/lib/incident.ts`
- Modify: `web/lib/incident.test.ts`
- Modify: `scripts/v2/incident/triage.py`
- Modify: `scripts/v2/incident/test_incident.py`

Snapshot = `{ id, severity, source, services[], resources[], labels, metric, timestamp, account, alarmArn }` (isolated/normalized fields; NOT raw rawPayload). Written ONLY on the New-win path, via a **separate try/catch'd UPDATE** (degrade-safe: tolerates the column being absent pre-migration); never overwrites on Linked.

- [ ] Test (web): New win → a follow-up `UPDATE incidents SET trigger_event=$.. WHERE id=$..` carries the snapshot; Linked → no UPDATE; column-absent error is swallowed (degrade-safe) and the triage result is unaffected.
- [ ] Test (py): `triage.py` mirrors the UPDATE after `_dedup_insert` returns non-None; not on Linked; pg8000 error swallowed.
- [ ] Impl: web (node-pg `$n`) + python (pg8000 `:name`) build the identical snapshot from the isolated/normalized event (account = labels.account_id ?? annotations.accountId; alarmArn from Task 1) and run the degrade-safe UPDATE on New. Dedup `ON CONFLICT DO NOTHING` semantics unchanged.
- [ ] Verify: `vitest run lib/incident.test.ts` + `cd scripts/v2/incident && PYTHONPATH=.:../workers python3 -m pytest test_incident.py -q` green.
- [ ] Commit: `feat(incident): persist trigger_event snapshot on New (web+py lockstep, degrade-safe) [W2a]`

### Task 3: Migration — trigger_event/validation cols + stage/status CHECK + GIN (test-first)

**Files:**
- Create: `terraform/foundation/migrations/01KVYC5ZYXG6SKQRECWCWQ05ZH_incident_validation_stage.sql`
- Create: `scripts/v2/incident/test_w2_migration.py`

- [ ] Test: read the migration; assert `ADD COLUMN IF NOT EXISTS trigger_event JSONB`, `... validation JSONB`, stage CHECK superset incl. `'alert_validation'` + all 5 existing, status CHECK superset incl. `'validating'`,`'false_positive'` + all 9 existing, a `USING GIN (validation jsonb_path_ops)` index; assert NO `schema_migrations` and NO `ON CONFLICT`.
- [ ] Impl (ULID via `node -e "import('ulid').then(m=>console.log(m.ulid()))"`; `-- since: 2.4.0`; order ADD COLUMN → DROP+ADD CHECK → CREATE INDEX):
  - `ALTER TABLE incidents ADD COLUMN IF NOT EXISTS trigger_event JSONB;` + `... validation JSONB;`
  - `ALTER TABLE incident_stages DROP CONSTRAINT IF EXISTS incident_stages_stage_check; ALTER TABLE incident_stages ADD CONSTRAINT incident_stages_stage_check CHECK (stage IN ('triage','alert_validation','investigation','root_cause','mitigation_plan','prevention'));`
  - `ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_status_check; ALTER TABLE incidents ADD CONSTRAINT incidents_status_check CHECK (status IN ('triaged','validating','false_positive','investigating','root_cause','mitigation_planned','prevention','resolved','stalled','skipped'));`
  - `CREATE INDEX IF NOT EXISTS idx_incidents_validation ON incidents USING GIN (validation jsonb_path_ops);`
- [ ] Update Task 3 Files (and W2b scope) with the REAL ULID filename once generated (scope_guard matches the literal path).
- [ ] Verify: `cd scripts/v2/incident && PYTHONPATH=. python3 -m pytest test_w2_migration.py -q` green. Do not edit the file after authoring (sha256).
- [ ] Commit: `feat(incident): migration — trigger_event/validation + alert_validation stage + status [W2a]`

## Out of scope
- AlertValidation 워커·SM splice·incidents.tf·connector 추출 → **W2b**. SNS → W3. source_allowlist UX → W4. trigger_event는 W2a에서 *쓰기만*(읽기는 W2b). 동작 변화 없음.
