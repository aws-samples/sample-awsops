# Diagram revision review — 2026-09-13

| Item | Result |
|---|---|
| Review | Author diagram check; independent full-package review is recorded in [../../results/CONTENT-REVIEW-2026-09-13.md](../../results/CONTENT-REVIEW-2026-09-13.md) |
| Preliminary author score | 87/90; 0 Critical, 2 Warning. The final independent gate is recorded in the full-package review linked above. |
| Scale | Draw.io uses the 90-point rubric; browser captures additionally verify rendered PNG/SVG |
| Structural gate | All seven canonical sources pass XML validation |
| Layout gate | AgentCore scores 99/100; the other five revised/renamed sources score 100/100; threshold 80 |
| Exports | Draw.io CLI produced PNG at 2x and SVG for all five content-modified sources |
| Preserved assets | Workflow and appendix B source/PNG/SVG match the committed originals byte for byte |
| Browser evidence | Ten PNG/SVG assets loaded at 760 CSS pixels; no page errors or failed image requests |
| Reproduction | `python3 blog/2026-09-awsops/drawio/build.py --check`; omit `--check` to export |

`validation.json` records source counts, artifact dimensions and SHA-256 hashes.
`browser.json`, `width-check.html`, and `*-760.png` record the blog-width check.
The browser MCP could not launch because its configured Chrome binary was absent.
The screenshots were therefore captured with local Playwright and installed Chromium
151.0.7922.34; no browser installation or host configuration change was needed.

## Content and routing review

- `fig2a-interactive`: separate operator-access and interactive-AI flows. The two
  Web icons represent the same Web service in the two flows. Function headings have
  no VPC/Region/security-group frames. No footnotes.
- `fig2b-diagnosis`: inventory synchronization, Resource Graph, scheduled diagnosis,
  direct Bedrock inference, S3 output, and the separate digest Lambda. The digest
  lane deliberately does not imply that S3 triggers SNS. No footnotes or internal
  table/flag names.
- `fig3-agentcore`: seven service icons; no Memory, Code Interpreter, stray macron,
  or Lambda count. Gateway label retains nine domains. Lambda reads the host using
  its execution role, reads Aurora using SELECT, and uses AssumeRole for the target
  account. Only the host/target account containers describe boundaries.
- `fig4-workers`: all twelve execution/state-recording relationships remain.
  Workers write running/succeeded; the Catch path writes failed; EventBridge invokes
  the reaper, which corrects stale work. Labels use AWS Fargate, 정리 작업(reaper), and
  공통 작업 기록. Line jumps distinguish crossing return paths.
- Appendix A has the AWS Fargate wording correction and fresh exports. Appendix B
  is a rename only.

Sources checked: the original canonical draw.io sources; the supplied review brief;
`agent/lambda/cross_account.py` (`get_role_arn`, `_assume_role`);
`agent/lambda/inventory_read_mcp.py` (SELECT-only inventory access); and the existing
technical-note evidence mapping for inventory, report workers, and digest.

The AgentCore lint report records one non-blocking grid-alignment observation:
`e4_label` is at `(635, 388)`, two pixels off the five-pixel grid. The final PNG/SVG
inspection found no overlapping or clipped label there.

## Warnings for the main agent

1. **Readability — existing appendix labels are small at 760px.** Examples:
   appendix A's `web` label and appendix B's request/JWKS labels. These support
   diagrams retain their existing layout. Keep them in technical notes and link
   to the full-size PNG/SVG. Deduction: 1.5 from Readability.
2. **Accessibility — diagram labels are below the rubric's 14pt body-text target.**
   Main-figure labels remain readable in the captured 760px rendering; appendix
   labels require enlargement. Descriptive Markdown alt text and access to the
   full-size assets remain the renderer/article owner's responsibility.
   Deduction: 1.5 from Accessibility.

Per the rubric, each defect deducts one quarter of its category, rounded once to
the nearest half-point with midpoint deductions rounded upward. Basic inspection:
55/55. Extended inspection: 32/35. Preliminary author total: 87/90, within the
author-check PASS band. The independent full-package review determines the final gate.

## Main-agent integration notes

- Final article stems: `fig1-sre-workflow`, `fig2a-interactive`, `fig2b-diagnosis`,
  `fig3-agentcore`, `fig4-workers`.
- Technical-note stems: `appendix-a-private-edge`, `appendix-b-edge-auth`.
- Update article, README, technical-note and renderer references outside this
  agent's write scope.
- `.drawio` is canonical. The four new topology YAML files describe its final
  components and flows; `build.py` validates and exports that canonical source.
  It always verifies the three protected workflow hashes and never regenerates
  that figure.
- Publication text should retain feature enablement prerequisites, the separate
  digest's source of completed-report status, and ExternalId configuration
  qualifications; the simplified diagrams do not enumerate every data read.
- The removed implementation details and footnotes were intentional omissions
  approved in the review brief. No app or infrastructure behavior changed.
