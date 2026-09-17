> **Historical record (2026-09-13), not current validation.** The original observations, hashes and verdict below are retained for provenance. Later review corrected the empty-database setup order, ENI partial-evidence interpretation, CIS status list, unsupported absolute Logs Insights window, appendix-B font rendering, diagnosis sampling bounds, and SDK/degraded inventory disclosure. Use the [current validation scope](../VALIDATION-2026-09-17.md); older captures and passing flags do not validate the revised draft.

# Content Review Report — AgentCore Reader Path

## Current assessment

| Field | Result |
|---|---|
| Review date | 2026-09-13 |
| Governing scope | [EDITORIAL-SCOPE.md](../EDITORIAL-SCOPE.md), read first |
| Review target | Current Korean article, notes, README, renderer/preview and reader-path evidence; unchanged diagrams and earlier code examples |
| Reader goal | Understand how AgentCore connects an operational question to an actual AWS read, then find and try the selected sample |
| **Draft content verdict** | **PASS — 88.5/90; normalized 98.33/100** |
| Current scored findings | **0 Critical, 1 Warning, 0 Info** |
| **Publication status** | **HOLD — `publication_ready: false`** |
| Length | **7,030 words**, informational only; no minimum/maximum or reduction target |
| Snapshot | Final source hashes below; article references use this 549-line revision |

The draft now explains Runtime execution, Gateway tool definitions/dispatch, and Lambda's actual AWS reads through one ENI example. Four purposeful source links lead into a setup sequence and explicit success criteria. The missing Aurora migration-connectivity prerequisite found during review was corrected before this snapshot. The known small inline-diagram text is the remaining content warning.

**This content PASS is not publication approval.** The selected `aws-samples/sample-awsops` repository is still private in the supplied verified metadata. Anonymous readers cannot currently clone the primary sample or open its linked source/documents. The user explicitly selected this planned-publication repository with that limitation disclosed; the draft correctly describes it as something to be published with the article. No visibility change is authorized or was attempted.

This is a new assessment of the current reader-path revision. [The expanded review](CONTENT-REVIEW-2026-09-13-expanded.md) and earlier condensed report are historical, not this verdict. Only this report was written. No application/IaC changes, deployment, AWS invocation, repository visibility change, or git mutation was performed.

## Rubric and gates

Rubric: `/home/atomoh/.codex/plugins/cache/oh-my-cloud-skills/aws-content-plugin/1.17.0/agents/content-review-agent.md`.

Use the **90-point Markdown/Draw.io scale**. The auxiliary preview and supplied real Chromium evidence support visual observations; the separate 10 HTML Visual Testing points are exempt. No fresh browser session or external fetch was run by this reviewer. Length is excluded from scoring, and purpose-specific sample deep links are expressly allowed by current scope.

| Independent content band | Observed | PASS threshold | Result |
|---|---:|---:|---|
| Score | 88.5/90 | ≥77/90 | PASS |
| Normalized score | 98.33/100 | ≥85/100 | PASS |
| Critical findings | 0 | 0 | PASS |
| Warning findings | 1 | ≤3 | PASS |
| **Draft: worst band** | | | **PASS** |
| **Public reader access** | Seven planned sample destinations return anonymous 404 | Public access verified before publication | **HOLD** |

The seven known private URLs are not falsely counted as public-link successes. They are tracked as a publication dependency, not seven separate drafting defects. Their anonymous 404 responses were recorded separately from local visual testing; the browser evidence explicitly says those external URLs were not clicked. No browser-network Critical is invented from tests that did not navigate there.

## Open content warning

### W2 — Small inline diagram labels remain; original-size access mitigates them

| Field | Evidence |
|---|---|
| Severity | Warning |
| Category | Accessibility |
| Location | Four editable architecture diagrams, particularly `drawio/fig4-workers.drawio` cells `e2_label`, `e6_label`, `e10_label`, `e11_label`; `images/fig4-workers.svg`; `render_preview.py:60–62` |
| Quote/style | `③ ESM`, `Catch`, `running / succeeded`; source `fontSize=20`; worker SVG width `1210px` |
| Problem | Source labels scale to about 12.6px at 760px display width and 13.9px at 840px, below this rubric's 14pt target. Diagram pixels/source are unchanged, so the inline-size limitation remains. |
| Mitigation | Visible `그림 원본 크게 보기` links retained. CSS uses 19px text; supplied browser results record five 46.390625px-high controls and successful original-image navigation at all three widths. Notes retain the limitation. |
| Fix direction | Enlarge the smallest labels and adjust spacing in editable Draw.io sources if resolving the warning; re-export and inspect at publication width. Preserve Figure 1 unchanged. Retain original-size access in the publishing template. |
| Points | **−1.5 from Accessibility** |

Reused independent evidence: [worker at 760px](../drawio/qa/fig4-workers-760.png), [diagnosis at 760px](../drawio/qa/fig2b-diagnosis-760.png), and prior [mobile original-size control](visual/mobile-figure-original-control.png). Current control/navigation evidence: [reader-path browser results](visual-reader-path/results.json). The 14pt target belongs to this rubric, not a universal WCAG font-size rule. Count this recurring scaling defect once.

## Material finding resolved during review

### W4 — Migration execution-host prerequisite: resolved

The initial setup text listed account/domain/state-bucket/tool prerequisites and then showed `make deploy` and `make migrate`, without explaining that migration needs direct connectivity to Aurora. This was a real first-run gap: the sample Makefile declares `deploy: migrate`; `scripts/v2/migrate.mjs:68–75` reads the Aurora endpoint and selects TCP 5432, and lines 109–114 create/connect a `pg.Client`. The sample's `terraform/foundation/data.tf` places Aurora in private subnets and limits DB ingress. AWS credentials alone do not provide that private network path.

I reported this during review. Final article line **474** now states:

> 배포 명령을 실행할 작업 환경에는 **Aurora 엔드포인트의 TCP 5432로 연결할 수 있는 네트워크 경로와 접근 허용**도 필요합니다.

The following sentences explain direct migration connectivity, its inclusion in `make deploy`, and the need for a VPC-internal or approved connected work environment. This resolves the missing prerequisite. The precise network implementation remains environment-specific; the draft no longer implies that an arbitrary laptop with CLI credentials can run the full migration flow.

**No current deduction.** Cached migration source matches the authenticated sample-tree blob. The locally available `data.tf`, migration script and Node package manifest were also hash-matched to the sample tree before being used as evidence. No connection or migration was attempted.

Previous acronym and sequential-report wording corrections remain in place; they are not reopened.

## Does the reader path meet the goal?

| Reader question | Current location | Independent assessment |
|---|---|---|
| What operational problem did AgentCore address? | 5, 56–64 | Explains the transition from manually collecting/pasting data to an agent selecting registered reads, consuming results and continuing the investigation. |
| What does Runtime do versus Gateway? | 60–64 | Runtime hosts the Strands execution loop; Gateway exposes definitions and dispatches selected calls; Lambda code and execution role determine the AWS read. No claim that a model automatically knows live AWS state. |
| What happens to one concrete question? | 170–180 | Five ENI steps distinguish domain routing, tool discovery/filtering, selection, AWS API reads and explanation. Returned fields match the actual network Lambda. |
| Where is that behavior implemented? | 184–189 | Four purpose-specific links map catalog, registration, agent execution and network implementation. Final display labels are short filenames; full URL targets remain unchanged. |
| How does a reader prepare the sample? | 464–485 | Correct selected repository, v2 onboarding, Seoul host-ENI scope, tool/configuration prerequisites and now explicit Aurora TCP connectivity. |
| What gets deployed, and in what order? | 487–507 | Saved Terraform plan/apply, deployment/migration, then AgentCore provisioning. Explicit repeat migration is explained; isolated target registration is optional for full-sample users. |
| What proves success? | 509–520 | Requires actual tool invocation, returned ENI/configuration correspondence and comparison with console values. Distinguishes natural-language output and security smoke from ENI-read success. |
| Can an anonymous reader do this today? | 9–11; README; notes; verification | **No.** The primary sample and six linked files are private. Draft says planned publication; publication remains held. |

The procedure is source-aligned and has syntax checks. It is **not a demonstrated fresh deployment or observed successful ENI invocation**. Those limits are preserved in the notes and verification data.

## Source fidelity and bounded checks

Source snapshot: supplied authenticated `aws-samples/sample-awsops` **dev** tree `6c17791a6bff89a2c9fe710c9eac7d7fd89ec070`, cached under `/tmp/awsops-publish-sample/`; tree metadata in `/tmp/awsops-sample-tree.json`. No credentials or new authenticated requests were used in this review.

- **Source-link identity:** recomputed Git blob hashes of all six linked cached source/document files and matched them against [links-reader-path.json](links-reader-path.json). This establishes the inspected file identity; it does not establish anonymous access.
- **ENI implementation:** `agent/lambda/network_mcp.py:20` defaults to `ap-northeast-2`. Lines 80–118 implement ENI/SG/NACL/route reads and return the stated `eniId`, `privateIp`, `vpcId`, `subnetId`, `securityGroups`, `nacl`, `routes` fields. The article supplies no invented live response and requires console comparison rather than claiming packet connectivity.
- **Agent execution:** cached `agent/agent.py:1156–1200` discovers Gateway tools, applies filtering and passes them into `Agent(tools=...)`. Lines 1209 onward contain the tool-less fallback. The walkthrough and fallback warning reflect those paths.
- **Provisioning:** cached catalog/provisioner agree on `get_eni_details`, its required `eni_id`, network Gateway mapping and `ensure_targets`. The existing Python example remains an optional setup illustration; `make agentcore` provisions full-sample targets.
- **Configure/dependencies:** `make configure` depends on `deps`, which installs `scripts/v2` dependencies. Configurator supports the named AgentCore/hybrid choices and reads `AWS_REGION`. The deployment build uses its own web image build; omitting a separate local web development install is not automatically a deployment defect.
- **Order and runtime:** Makefile declares `deploy: migrate`; `agentcore.mjs` requires prior Terraform apply/migration and builds the arm64 agent image before provisioning. The blog uses saved-plan apply without auto-approval.
- **Smoke scope:** `provision.py:1084–1096` sends an IAM-role request to the **security** Gateway and checks whether `role` occurs in the body. It does not prove `get_eni_details` ran. Article line 507 separates that smoke from the next ENI check; line 520 warns that natural-language fallback is not proof of tool success.
- **Shell verification:** three new shell blocks passed `bash -n` independently. They were parsed only, not executed. This does not validate IAM permissions, resource availability, successful Terraform application or runtime behavior.
- **Preservation:** read-only comparison with the earlier reviewed article confirms five protected prompts, five schedule steps, four original code blocks, five captions and five image references retained. The new five-step request walkthrough is a separate list; it is not mistaken for the protected schedule list.
- **Local rendering/references:** all local article/notes/README/scope links resolve. After the final label/prerequisite edits, renderer output generated with its write intercepted in memory matches saved `preview.html`. No preview file was written by the reviewer.

## Actual browser evidence and limitations

| Evidence inspected | Observation |
|---|---|
| [Opening, 1280px](visual-reader-path/opening-1280.png) | Operational problem, AgentCore path and planned sample link are visible near the beginning. |
| [Getting started, 1280px](visual-reader-path/getting-started-1280.png) | Setup section has clear hierarchy and separated clone/configure commands. |
| [Getting started, 375px](visual-reader-path/getting-started-375.png) | Heading, links and prerequisite prose wrap within the mobile column. |
| [Code map, 375px](visual-reader-path/code-map-375.png) | Inspected initial full-path-label capture; table wraps without page overflow. Final shorter filename labels and unchanged destinations were verified in source and reproduced HTML. |
| [Success criteria, 768px](visual-reader-path/success-criteria-768.png) | Deployment sequence, smoke limitation, example question and success criteria are visually separated and readable. |
| [Browser results](visual-reader-path/results.json) | At 1280/768/375: viewport/document widths match; five images load; nine TOC targets resolve; sample-section and original-image navigation work; control heights exceed 44px; error/bad-response arrays are empty. |

These are supplied local Chromium results, not a new reviewer browser run. Initial captures were inspected before the author's final label/prerequisite refresh; those final text changes were additionally checked in source and exact regenerated HTML. Refreshed evidence may replace the captures at these stable paths. The reviewer does not claim to have independently navigated private external URLs: `externalSampleLinksClicked` is false and the reason is explicitly recorded.

## Draft scoring

Apply the rubric's fixed deduction procedure: each category starts at full marks; each counted noncritical defect costs one quarter of its maximum; sum within category and round once to the nearest 0.5, with midpoint deductions rounded upward. W2 costs **1.5** in Accessibility. Resolved W4 costs zero. No deduction is based on length or the user's allowed source deep links.

| Category | Maximum | Score | Basis |
|---|---:|---:|---|
| Layout | 8 | 8 | Clear role/walkthrough/setup/verification hierarchy; fenced commands and purposeful code map. |
| Terminology | 8 | 8 | Runtime, Gateway, Lambda, ENI and earlier acronym definitions are distinguished. |
| No Hallucination | 12 | 12 | Returned fields/commands follow inspected source; no invented successful deployment or tool result. |
| Language Consistency | 8 | 8 | Korean explanation and technical naming consistent. |
| No Sensitive Data | 12 | 12 | Examples use placeholders; no credential/account disclosure identified; prior diagram checks reused. |
| Content-Type Quality | 2 | 2 | Final in-memory rendering matches HTML; local references resolve; new shell syntax checked. |
| Icon Usage | 5 | 5 | Unchanged diagram evidence reused; no helper score substituted. |
| Readability | 5 | 5 | Five-step request walkthrough and four-file map give concrete navigation through the explanation. |
| Accessibility | 5 | 3.5 | W2 retained; original-size controls mitigate access. |
| Structural Completeness | 5 | 5 | Missing migration-host prerequisite corrected; setup and actual-result criteria included. |
| Data Accuracy & External References | 5 | 5 | Source identity and link-state reporting are accurate. This scores draft accuracy, not anonymous availability; the latter is explicitly HOLD. |
| Legal Compliance | 5 | 5 | No supported legal defect; publication/author metadata remains an owner task. |
| Message Clarity | 5 | 5 | “How AgentCore solves it” leads to code and a bounded first exercise; smoke/fallback limits explicit. |
| Duplication/Gaps | 5 | 5 | Optional individual registration distinguished from full provisioning; no material remaining source omission found in scope. |
| **Draft total** | **90** | **88.5** | **98.33% normalized; 0 Critical, 1 Warning** |
| Separate HTML Visual Testing | 10 | Exempt | Markdown/Draw.io deliverable. |

## Publication prerequisites — HOLD remains active

[Link evidence](links-reader-path.json) records **20 unique hyperlink destinations: 13 anonymous HTTP 200 public references and 7 anonymous HTTP 404 planned sample destinations**. The seven comprise the repository root plus four code files and two documents. Authenticated repository/file metadata is verified; anonymous clone and file access are not. The `.git` clone command is also unexecuted.

Before publishing the article:

1. The repository owner must complete the planned public release through their own authorized process. This reviewer has not changed visibility or requested permission to do so.
2. Verify anonymous clone and access to the root, README, v2 onboarding, SQL-reader runbook and all four code links. Recheck `dev` branch URLs against the actual published branch/release.
3. Correct the upstream README's older `Atom-oh/awsops` clone example so a reader moving from this article to the sample does not follow a conflicting repository path. The article's own clone target is correct. Keep the v2 onboarding path rather than the legacy v1 install guide.
4. Keep the deployment/invocation validation disclosure truthful. Do not turn static/source/syntax checks into a “live tested” claim. If a successful first ENI exercise is later claimed, capture actual tool/resource evidence in a controlled environment first.
5. Complete author/affiliation metadata and preserve original-image access in the publication template.

The current `publication_ready: false` is correct. A draft PASS must not be used to clear this hold automatically.

## Scope and source-omission cross-check

All requested reader additions are present: operational reason for Runtime/Gateway, the ENI request path, purpose-specific source links, early/concluding sample entry points, setup/configuration, saved plan/apply, migration/AgentCore sequencing, test question, resource-based success criteria, optional public learning sample and cleanup boundaries. W4's previously omitted execution-host network prerequisite is now present. No further material omission was found in this bounded pass.

No word/character cap, 40% reduction, table-count target or cap-motivated section cut was applied. Previous source-deep-link removal instructions are superseded by current scope. Existing read-only posture, provenance, protected content and diagram requirements continue to apply.

## Final disposition

- **DRAFT: PASS — 88.5/90.** W2 remains open; W4 is resolved.
- **PUBLICATION: HOLD.** Primary sample access, published branch/path consistency and release metadata must be completed and verified separately.
- No deployment, cloud invocation, visibility change or unrelated audit was performed. Only this report was modified.

## Final artifact fingerprints

These identify the source snapshot and recorded evidence assessed. They do not establish that the private sample is public or that the deployment ran successfully.

| Artifact | SHA-256 |
|---|---|
| `EDITORIAL-SCOPE.md` | `269e55ac2220709c5609c8041fdf819619ee93663b62cb516173d984c7ec6084` |
| `draft-awsops-architecture.md` | `55cf9edd121fb490d2b3f4bd2fd0851309dfa15835b37fc48d60eef1fd454ba1` |
| `technical-notes.md` | `5f160f8724b2ed7d3a10368cdcef48350e153534b13d42ed3908b451bc870a38` |
| `README.md` | `9f49fb085af095adbd165ab310cb86aad9c55d04d895c76b5f8bf40e971ba6bf` |
| `render_preview.py` | `076fb6738393556e6d60c6038f4619a803387a39804b57663a0dafa9b1598452` |
| `preview.html` | `0c787044cece0ea842b6c05c3fbe1317a04e9a6d3c8c397c3ac2f07193ed56ce` |
| `results/verification.json` | `4e1ecfd2100d42862e04f4243d403fbe509c82bf801777f5af75e27501190b1a` |
| `results/links-reader-path.json` | `76302b566d50c75a4f7201538eb6e62c4961ca37a3500f4b1a04b98d2e986056` |
| `results/visual-reader-path/results.json` | `d7084074ba4a90338c32d54ec60a1c3b6be3d81c34bad661c449eb5aaa85c7fc` |
