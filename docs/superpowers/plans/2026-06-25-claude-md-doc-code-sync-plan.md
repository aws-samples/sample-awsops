# Plan: CLAUDE.md ↔ code discrepancy sync (2026-06-25)

## Context
A doc↔implementation audit (co-agent:harness, host=Claude, implementer=Codex, panel=kiro-cli/codex/agy)
verified CLAUDE.md's concrete claims against the actual Terraform/web/agent/scripts code on
`feat/v2-architecture-design`. The docs were recently consolidated (see
`docs/reviews/2026-06-21-docs-reality-audit.md`), so almost every claim MATCHES. Two genuine
discrepancies remain — both **doc-side** (the code is correct/intentional):

1. **EKS access-entry policy name** — CLAUDE.md says the web task role gets `AmazonEKSViewPolicy`,
   but `terraform/foundation/eks.tf:34` binds **`AmazonEKSAdminViewPolicy`** to it (intentional —
   the eks.tf:22 comment explains `View` cannot list cluster-scoped nodes; `AmazonEKSViewPolicy` is
   used only for the separate **istio-read** role at eks.tf:41-50). The doc is factually wrong.
   The claim appears in **6 CLAUDE.md locations** (verified): lines 17 & 153 (`AmazonEKSViewPolicy`,
   onboarding) and lines 26, 71, 162, 207 (`View policy`, phase-table + file-list). All six describe
   the **web task-role** binding and must move to AdminView; the separate istio-read `View` role
   (registered out-of-band) is NOT mentioned in CLAUDE.md and must not be invented.
2. **AgentCore slice count + gate** — CLAUDE.md says "Currently 2 read-only slices deployed
   (iam-mcp 14 tools→security, flow-monitor 1→network); full fleet is P3", and the `ai.tf` file-list
   rows (lines 69 & 205) say the agent Lambda slices are "**all `agentcore_enabled`-gated**". Both
   are imprecise: `ai.tf local.agent_lambdas` (`:543-574`) defines **27 slices split across two
   gates** — **21 on `agentcore_enabled`** (`:544-566`) + **6 on `integrations_enabled`**
   (`:567-573`: notion/clickhouse/prometheus/loki/tempo/mimir; `integ_count` at `:62` =
   `agentcore_enabled && integrations_enabled`), both default false. The "2 deployed" live fact and
   the per-slice tool counts are accurate and are KEPT.

No code bugs were found. Scope is limited to `CLAUDE.md` plus one self-contained consistency test.

> **Plan-gate round 1 (2026-06-25):** panel (Codex-weighted + kiro-cli + agy) returned BLOCKED —
> 1 CRITICAL (Task 1 missed 4 of 6 doc lines) + MAJORs (Task 2 single-gate framing wrong; lines
> 69/205 also drift; test under-specified). All verified against code; this revision (round 2)
> folds in the full must-fix list.

## Constraints
- **Doc-only changes** to `CLAUDE.md`. Do NOT touch `eks.tf`/`ai.tf` — the code is correct.
- Edit BOTH the Korean (top) and English (bottom) blocks of CLAUDE.md so they stay in sync.
- The repo's `tests/run-all.sh` baseline is RED for pre-existing, unrelated reasons
  (`docs/architecture.md` missing; root `vitest` needs root `node_modules`). Task 1's guard test
  is therefore a **self-contained bash structure test** that is provable red→green on its own,
  independent of the broken suite.

---

### Task 1: Correct the EKS access-entry policy name across ALL six CLAUDE.md locations
The web task role's EKS Access Entry is associated with `AmazonEKSAdminViewPolicy` (eks.tf:34),
not `AmazonEKSViewPolicy`. Fix all six CLAUDE.md mentions (both language blocks) and add a
self-contained consistency test that fails until the doc matches eks.tf.

**Files:**
- Modify: `CLAUDE.md`
- Test: `tests/structure/test-doc-code-consistency.sh`

- [ ] Write `tests/structure/test-doc-code-consistency.sh`: read
      `terraform/foundation/eks.tf` and confirm `aws_eks_access_policy_association.web*` binds
      `cluster-access-policy/AmazonEKSAdminViewPolicy` (the web task role). Then assert in CLAUDE.md:
      (a) the two EKS-**onboarding** lines (the ones naming a full `AmazonEKS…Policy`) say
      `AmazonEKSAdminViewPolicy`, NOT `AmazonEKSViewPolicy`; (b) the EKS **phase-table** and
      **file-list** lines that pair "Access Entry" with a view policy say "AdminView", NOT a bare
      "View policy". Implementation note: do NOT use a blunt file-wide `grep -c "AmazonEKSAdminViewPolicy"
      -eq 6` (only 2 of the 6 lines carry the full policy name → guaranteed false-fail). Instead
      assert per-pattern: zero occurrences of `AmazonEKSViewPolicy` AND zero occurrences of
      `Access Entry + View policy` (the web-role phrasings) remain. Pure bash + grep, TAP-style
      `ok`/`not ok`, standalone-invocable (`bash tests/structure/test-doc-code-consistency.sh`),
      independent of the RED `run-all.sh` baseline (no vitest/tfvars/node deps).
- [ ] In CLAUDE.md, fix all 6 web-task-role mentions:
      lines 17 & 153 `AmazonEKSViewPolicy` → `AmazonEKSAdminViewPolicy`;
      lines 26, 71, 162, 207 `Access Entry + View policy` → `Access Entry + AdminView policy`.
      Do NOT invent any istio-read text (that separate `AmazonEKSViewPolicy` role is not in CLAUDE.md).
- [ ] Run `bash tests/structure/test-doc-code-consistency.sh` → green.

### Task 2: Reconcile the AgentCore slice count + gate split in CLAUDE.md
Reword the "Currently 2 read-only slices deployed … full fleet is P3" claim AND the two `ai.tf`
file-list rows so they reflect the real two-gate split, without discarding the accurate "2 deployed"
live fact. `ai.tf local.agent_lambdas` (`:543-574`) defines 27 slices: **21 on `agentcore_enabled`**
+ **6 on `integrations_enabled`** (notion/clickhouse/prometheus/loki/tempo/mimir), both default false.

**Files:**
- Modify: `CLAUDE.md`

- [ ] Reword the AgentCore slice sentence in BOTH language blocks (lines ~15 KR / ~151 EN) to
      Codex's gate-accurate wording, keeping the per-slice tool counts and the "2 deployed" fact:
      *"Currently 2 read-only slices deployed (iam-mcp 14 tools → security, flow-monitor 1 → network).
      The full fleet (~27 slices: 21 gated on `agentcore_enabled`, 6 on `integrations_enabled`, both
      default false) is defined in `ai.tf` `local.agent_lambdas` but not live until the respective
      flags are enabled."* (P3.)
- [ ] Fix the `ai.tf` file-list rows (lines 69 KR / 205 EN): change "(all `agentcore_enabled`-gated)"
      to reflect the split, e.g. "(21 `agentcore_enabled`- + 6 `integrations_enabled`-gated)".
- [ ] (test_required:false — judgment doc edit; the gate split is verified against `ai.tf`
      `:543-574`/`:62` by the host + consensus gate, since "deployed-live vs TF-defined" is not
      mechanically unit-assertable.)
