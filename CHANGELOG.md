# Changelog

[![English](https://img.shields.io/badge/lang-English-blue.svg)](#english)
[![한국어](https://img.shields.io/badge/lang-한국어-red.svg)](#korean)

---

<a id="english"></a>

# English

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Entry convention:** describe net user-visible behavior per feature, one bullet per feature per category (a cross-feature infra/schema bullet, e.g. a shared migration list, is fine as its own line). No PR numbers, CI-review-round numbers, or iteration counts — those live in git history and the PR thread. When a later fix supersedes an earlier entry for the same feature, amend that entry in place rather than appending a new one.

## [Unreleased]

### Added


- NFM observation evidence: query responses retain original query bounds, result timestamps and contributor-cap metadata across cache hits. A standalone category loader preserves partial failures, unknown windows and closed error reasons with three-worker concurrency and cancellation. The loader remains unwired until topology integration; query bounds do not establish complete traffic coverage. Existing read operations and authentication remain unchanged.
- Deployment dependency readiness: authenticated probes verify the actual web-role account and fresh AgentCore SSM reads, then require a nonce-bound runtime response proving curated inventory access, a known fresh CloudFront record and a bounded model call. With an explicit private runtime configuration, the smoke utility checks collection and owned Lambda/Fargate completion. Every dev Deploy Web release uses a private Terraform contract and restricted workload session, proves the receipt/ECR image before matching-source private migration, promotes that verified digest, then requires exact healthy ECS/image verification followed by controller-generated full runtime evidence including login/DB; health, login or enqueue acknowledgement alone cannot pass. Retained build receipts bind the successful producing job/attempt and survive deploy-only retries; `build=false` requires `image_build_run_id`. Explicit older-image rollback requires schema compatibility acknowledgement, skips DDL and retains the same mandatory verification. The controller synchronously collects every current catalog type with at most four collectors and uses authenticated ledger-only reads to require complete post-marker success, known counts and zero unknown attributes. Partial, failed, stale, missing or unknown evidence blocks the release. Finite shared deadlines, nonce-bound SSM/runtime/model proof and both owned Lambda/Fargate completions remain mandatory; a proven contention retry revalidates all types. Structured collection attempts and inventory quality retain gap diagnostics without exposing private payloads. Manual collect-runtime separates existing-web preparation from full verification. The billed probe is restricted to administrators or deployment-verifiers, with one in-flight call and a per-process cooldown. Readiness uses the dedicated CI_READINESS_ENABLED_DEV override, not the runtime profile: empty preserves explicit tfvars/default false and true/false explicitly opt in/out on dev. A reviewed apply with AgentCore enabled creates only deployment-verifiers; membership additionally requires create_demo_user. Group removal does not immediately revoke existing 12-hour ID-token claims. Disabled AgentCore sets a web-only blank runtime SSM path respected by the status BFF; the incident bridge remains unchanged. No administrator or IAM role is granted. Manual development audits separately report scoped runtime/collector status, schedule metrics and SQL-reader counts/timestamps under restricted sessions, without claiming full readiness or complete collection. Collector code verification uses the configured archive fingerprint, so stale provider observations do not reject a correct rollout or bless unconfigured code. Explicit full-dev readiness plans also publish a bounded advisory view of recognized changes without private plan values; unknown changes still require private inspection.

- Web database connection-phase diagnostics: failed physical connections log only the current phase and elapsed milestone timings across TCP, TLS, IAM token generation and PostgreSQL authentication, with required PostgreSQL/TLS regression coverage. Optional manual dev diagnostics add bounded IAM-auth and pressure metrics for the configured instance, ACU bounds and advisory server lifecycle text; empty reads remain distinct from failures, and individual-probe outcomes remain unknown.
- Deferred-DNS deployment: explicit same-branch/SHA saved plans preserve existing certificate ownership and service records, verify operator-selected or attached external certificates without account-wide selection, block all public/private DNS changes and routine validation-CNAME retirement, check ECR before builds, and share Host/SNI-preserving smoke tests before service DNS publication. Required development verification resolves effective credentials privately and requires successful Cognito login plus an authenticated database response. Authorized runtime activation checks the configured CI account, restricts private DNS to owned runtime resources, pins inventory/worker images and transports verified Lambda assets with the saved plan; these checks alone do not prove successful collection. Legacy encrypted-artifact inspection authenticates run/SHA and signed assets before protected rendering. Explicit plan/apply failures retain bounded encrypted tails with authenticated per-attempt recovery. Sealing uses stdin without plaintext staging; local ciphertext is deleted only after confirmed upload success. Child processes preserve AWS STS credentials while excluding GitHub command channels and Terraform logging/argument overrides; Linux cancellation forwards one graceful interrupt, escalates a second and stops Terraform on capture-parent death. Fixed audit categories and numeric action counts replace raw logs without changing command exits or apply gates. Manual saved plans now publish to private versioned SSE-KMS storage, replacing the encrypted handoff with a safe reference. Operator inspection uses IAM/KMS without the CI key; apply requires the reviewed plan hash and existing asset HMAC/source checks. Deploy Web uses the composed image-promotion entrypoint after readonly image and service preflight; it retains the validated project/digest and enforces retained receipts for reuse, migration evidence for current-source dev releases and schema acknowledgement for older-image rollback before publication.
- Private database migration runtime: verified RDS TLS, in-memory credentials, atomic one-shot empty-database initialization and immutable baseline/ULID checksums. Migration audit notices and repair guidance remain readable without exposing connection or credential errors. Failed reader-output lookup, enabled sync with a missing role, elevated reader attributes, and connection/cleanup errors block migration and deployment. Every web migration forces `AUTOMATIC_MIGRATION=1` and checks the complete pending set. A missing ledger fails before automatic initialization; empty-DB bootstrap, historical and unsupported SQL require reviewed standalone migration and reader sync first. Concurrent runners fail immediately while locks cover reader sync. Web release verification adds bounded transient-read retries and prompt terminal-rollout diagnostics without retrying writes.
  The manual Build Development Runtime Image (`build-runtime-images.yml`) workflow builds Steampipe/worker ARM64 images and verifies their digests for the full runtime plan. Verified exported image configurations and platform-specific upload support classic and containerd image stores; Steampipe uses a checksum-pinned portable ARM64 Python runtime without Bullseye package downloads.
  A default-off private development migration capability, invoked manually or by the guarded current-source web release, builds a reviewed ARM64 image, runs one private Fargate task and verifies the stopped task, image digest and successful exit. Development AgentCore requires applied `ci_migrations_enabled=true` (`CI_MIGRATIONS_ENABLED_DEV=true`) and reuses that private migration; migration/build/provisioning require the configured account secret and retain immutable ARM64 digest checks. Required backend-repository ECR scopes must be provisioned; dev uses separate verified build/provision phases with fresh sessions of the same role, aggregate deadlines inside each one-hour session, and no rebuild during digest-bound provisioning. Bounded catalog/status diagnostics preserve failure exit codes. Gateway role and Lambda ARN/credential/schema drift converge while preserving deployed auth/protocol, known IDs and baseline Runtime/teardown behavior. The operator-owned CI deployer requires `bedrock-agentcore:GetGateway`; typed validation/conflict/not-found diagnostics are safe, and API acceptance does not assert readiness. Host provisioning prepares a private Python 3.12 environment with hash-pinned SDK dependencies and verifies imports/service models before AWS setup or image work. Optional AgentCore smoke runs after provisioning: strict producer-backed readiness on dev, advisory compatibility elsewhere without a development-metadata prerequisite before provisioning.
- Async workload observations: ownership-scoped acceptance→first worker start→terminal timing and an optional completion objective over a selected window. Wait includes queue/scheduling and worker lifecycle includes retries; missing/inverted timestamps and truncated samples withhold unsupported timing or attainment. Existing deployments remain compatible before the additive migration, with new timing reported as unknown.

- Donut charts with $ values keep cents (2 fraction digits) in the center total, legend, and tooltip — whole-dollar rounding showed real sub-dollar spend as $0 beside a nonzero slice and disagreed with the adjacent 2dp KPI tiles; capped breakdowns disclose the cap in a card subtitle AND relabel the center figure honestly (e.g. the EC2 instance-types donut says 'Top-10 sum', not 합계 — the fleet total lives in the adjacent EC2 KPI tile).
- EKS Service Resources charts + node network rate view: the /eks/services fleet page gains v1's 'Service Resources' charts — top-15 'CPU per Service (millicores)' and 'Memory per Service (MiB)' bars computed by joining each Service's selector to its Running pods' scheduler-effective requests (max of app-container sum and init-container max, plus overhead — the same figure the node bars use) per (cluster, namespace) (request/reservation values, not live usage — stated in the caption; selectorless or zero-match services are excluded rather than charted as 0, and a cluster whose pods fetch failed is excluded by name in the caption, never silently zeroed); the node-detail ENI traffic tiles additionally show the average rate (B/s–MB/s, packets/s) under the cumulative values, computed over the newest COMPLETE hour bucket (a still-filling bucket divided by the full hour would understate the rate ~12× just past the hour; CloudWatch has no per-ENI dimension — the tiles stay honestly instance-level, both disclosed in the tooltip).
- Transit Gateway parity completion: the TGW list gains ASN/DNS columns (ASN was already synced and shows immediately; the DNS column and the detail panel's full option set — DNS/VPN ECMP/multicast/auto-accept/default association+propagation and their route-table ids — populate on the next sync after the sync-lambda redeploy, blank until then), and the attachments table gains an inline Options column (DNS/IPv6/appliance-mode) read from the per-region VPC-attachment describe — options exist only for VPC attachments (other types read '—', disclosed in the card subtitle), and a denied options describe degrades to missing options without hiding attachments or routes, disclosed per region in the card subtitle (never presented as 'not a VPC attachment'); the options describe follows pagination and EVERY incomplete-view path — a failed page (already-fetched pages are kept), a leftover page past the pagination cap, or a VPC row the response never returned (e.g. RAM-shared cross-account) — is disclosed as incomplete rather than reported as success. The web task role gains the single read-only ec2:DescribeTransitGatewayVpcAttachments action (terraform apply required), with a test pinning every TGW SDK command to its IAM grant.
- Account-scoped resource trend + derived security-count history: the daily inventory snapshot is now written per account (over the sync's trusted-account set — an unreachable account keeps its last same-day row, a reachable-but-empty account records a genuine 0), the trend API accepts the accounts scope (validated CSV; `__all__` resolves server-side to self + the enabled member accounts — never an unfiltered read, which would sum backfill 'aggregate' rows and offboarded-account history) and returns per-day PER-TYPE account coverage, and the home trend chart, delta table, 7d net change, and cost-impact estimate all follow the account selector — the guards additionally require each compared type's coverage to equal the scope that type can ever reach (host-only SDK-collected types like S3 check against the host account; everything else against the full resolved scope — the sync runs per type, so an account can be silent for one type's run only, even on both compared days), so a silent (account, type) day — or the deploy boundary, before per-account history exists — renders '—' in the KPI and delta table, hides the cost-impact panel, and draws as a line gap in the chart (with a disclosure caption) instead of a fabricated fleet change; a CSV selection narrowed by dropped ids, or the all-accounts fallback when the accounts registry is unreadable, is disclosed under the chart, and the cost-impact panel hides whenever its own fetch degraded or resolved a different scope than the chart's (per-account history accrues from this deploy; snapshots still carry no region dimension, so a narrowed region scope keeps hiding the trend-derived KPIs). The sync also historizes three derived security series — Public S3 Buckets, Open Security Groups, Unencrypted EBS — by counting the just-synced inventory with the Security page's own predicates (lockstep-guarded), shown as delta rows and as the chart's own default-hidden Security-series toggle group (appended after the top real types so they are always reachable) but excluded from the day's total to avoid double-counting; EKS/K8s counts are deliberately not historized (v2 has no batch K8s collection — EKS reads are live on-request; ECS tasks/services already trend as their own synced types).
- Inventory/datasources i18n completion: the generic inventory pages (CloudFront/DynamoDB/WAF and every other type) and the datasources hub (form, tab, card dashboard, Explore, log view) now translate their Korean UI strings into en/zh/ja — 17 unregistered literals, the dynamic card/note catalogs (card_catalog titles, datasource-render result notes), the log-view caption pattern, and the donut/chart title patterns were registered; donut titles are composed fully in Korean so one tt() pass translates them (pre-translating the sample suffix produced untranslatable mixed strings); the two English action buttons (Add datasource / Test connection) are localized. A ratchet test pins the static-literal coverage on those surfaces (dynamic strings are covered by the registered catalogs and RULES — the test is a regression guard, not a completeness proof). Column/spec labels deliberately stay English.
- Full-fleet aggregates past the 500-row cap: capped inventory pages fetch server-side GROUP BYs (state tiles, distribution donuts, state-filter and facet dropdown options, and the exact total) over the WHOLE scoped fleet — v1 ran its aggregation SQL fleet-wide, and the v2 sample-based counts were silently inaccurate above 500 resources. Coverage is per-dimension: dimensions whose values are client-derived (lambda's runtime and dynamodb's billing donuts, ecs_task cluster/cpu/memory facets, opensearch's encryption-status donut, msk's kafka-version facet) stay sample-based, and an option list with 50+ distinct values falls back to the sample — every sample-based donut now discloses itself with the '(표본 기준)' qualifier (previously unlabeled). Full-fleet donut 'Other' buckets are computed against the fleet total, so they sum correctly regardless of the server's bucket cap. One aggregation call replaces the previous true-total summary call; the table, Top-N bars, and highlight cards deliberately stay sample-based.
- Per-datasource connection settings: the datasource form gains a Settings section — an upstream query timeout (seconds 1–60, default 10; forwarded as the Prometheus/Mimir API timeout param capped under the connector's HTTP timeout, and as ClickHouse max_execution_time) and a ClickHouse default database (identifier-only, validated on both the web tier and the connector before any HTTP call) — persisted per instance — the ClickHouse bound is the CEILING on every path (Explore, service graph, agent/worker — callers can only tighten it; default 10s, connector HTTP timeout aligned above it) while the Prometheus/Mimir bound applies on the Explore path capped at 10s, and the database rejects system/information_schema on both validation layers; v1's result-cache TTL is deliberately not ported (the v2 query path is uncached by design) and the timeout unit changed from ms to seconds, both disclosed in the guide. ClickHouse settings of 56–60s have an effective 55s ceiling under the Lambda wall limit; the guide distinguishes stored values from effective limits.
- Unified ECS overview page (/inventory/ecs, 'ECS Overview' in the sidebar's ECS subgroup): v1's one-screen posture restored — a summary KPI band (cluster/service counts from the loaded pages ['+' at the 500 cap], task count from the shared summary, and a tasks-below-desired attention tile aggregated only over an untruncated service page — a sample never presents a fleet total), plus the clusters and services tables stacked on one screen; each table links to its full type page for search/facets/detail (the overview is a read-only glance layer), labels a >=500-row page as a sample, shows a stale-data caption under a failed sync, and reads 'not collected yet' pre-sync instead of a fabricated empty fleet.
- Dashboard on-demand sync: the header gains an admin-only 'Sync all' action that dispatches one all-types inventory sync (async batch semantics disclosed in place — a queued acknowledgement [enqueue only, not a completion guarantee; already-running types are skipped], admin-only and sync-disabled states rendered distinctly from transient failures; data lands via the normal Refresh minutes later, no optimistic mutation).
- S3 security drill-downs: the S3 page gains v1's Bucket Map by Region (block tiles colored Public=red > Versioned=green > Standard=cyan with an explicit Unknown=gray — a bucket whose policy flag is unknown stays Unknown even when versioning is known (a denied policy lookup must not paint a reassuring color), never a confident Standard; block click opens the detail panel; sample-labeled past the 500-row cap), and the bucket detail gains an 'IAM Roles with S3 Access' section (ADMIN-ONLY — non-admins see a permission note; roles whose newly synced attached AWS-managed policies match the checked set [AmazonS3*/AdministratorAccess/PowerUserAccess/ReadOnlyAccess incl. job-function paths — other policies can also grant S3, so the empty state is matched-set-framed], max 30; the last sync run's status gates every conclusion — a failed/partial run shows a stale-data banner and the empty state is only conclusive under a succeeded run within 24h on an untruncated page (a data-as-of timestamp rides the footer); a 500-row sample is labeled; inline/bucket-policy access is explicitly out of scope, and pre-sync rows show a 'not synced' note rather than an empty all-clear — visible after a terraform apply + the next sync; note: a failed policy-list hydrate — an SCP block, or a fleet whose aggregate role count exceeds the sync's rate-limit budget — retries without the optional attached-policy column (other hydrates remain and may still fail) a successful fallback refreshes base iam_role rows and only this section shows 'not synced' (the run reports degraded freshness so readers see the blind spot); the whole-run last-good freeze on this path requires the base query to also fail — the final run status otherwise follows the normal sync lifecycle — the ADR-010 amendment's disclosed semantics).
- Grouped cost charts: the ECS Tasks page gains v1's Cost by Service chart (CPU vs Memory daily-cost split per cluster-scoped service from the shared estimator constants — FARGATE tasks only, top 10, sample-labeled past the 500-row cap; EC2 tasks are excluded [no estimate] and serviceless tasks are excluded [nothing to group under]; both $ series share ONE scale so the CPU-vs-Memory comparison stays real), and the EKS container-cost page gains the Node Daily Cost + Pod Count chart (from the page's own OpenCost node allocation + pods list, no new fetch, cost-desc sorted; Top 15 by cost with a counted title; a cluster with ANY unattributed pod renders '—' pod values on its nodes — a shown count could undercount, so it is never a confident number under incomplete attribution) — on a new multi-series grouped-bar primitive whose per-series scaling replaces v1's dual axis for MIXED-unit series only (value labels carry the real numbers/units, and a null value renders '—' with an empty track).
- Detail drill-down quick wins: the Bedrock model detail panel gains per-model Invocations / Token time-series charts over the selected range (the API now preserves per-model series instead of discarding them into the fleet sum; an empty series reads 'no time-series data'), the ElastiCache detail chains each attached security group to its inbound rules (the RDS drill-down section/route reused — synced inventory only, no live AWS call, unsynced SGs read 'not synced'), and the EBS volume detail gains live measured metrics (Read/Write IOPS via period-sum conversion, Queue Length, Burst Balance — latest values + 1-hour sparklines on the shared live-metric contract).
- WAF/EKS quick wins: two new synced inventory types — WAF Rule Groups (scope donut, WCU capacity bar) and WAF IP Sets (IPv4/IPv6 distribution, address counts; an absent addresses field reads unknown, never 0) — joining the Security group overview's per-type count tiles (v1's three-KPI waf page maps to the group overview + dedicated type pages; visible after a terraform apply + the next sync); the EKS container-cost page's remaining hardcoded Korean strings now translate (4-language registration for the title/subtitle/estimate banner/empty states/search placeholder); and the EKS nodes fleet's Total Memory tile gains an allocatable + reserved% hint (omitted when allocatable is unreported).
- Drill-down/onboarding quick wins: the S3 bucket detail gains a Tags section (per-bucket tags newly synced — a bucket with no tags reads '—', an access-denied bucket shows nothing; visible after a terraform apply [new read-only IAM grant + sync-lambda zip] and the next sync), the EKS node drilldown's pods table gains Pod IP and Service Account columns ('-' when unknown), and the /eks page shows a no-access banner when clusters are registered but zero live K8s data is reachable — with the raw per-cluster failure reason and a locale-aware link to the docs-site EKS overview guide.
- Compliance completion email: when a benchmark run successfully completes, a best-effort SNS email goes out with the benchmark name, scope, total/passed/failed counts, pass rate, and a /compliance link — reusing the AI-diagnosis notification topic, flag, and admin pause switch (paused or unconfigured ⇒ silently skipped; a mail failure never affects the run), limited to one mail per benchmark per 60 minutes (re-runs don't re-blast subscribers), with a durable per-run delivery record (a new compliance_runs notified_at/notify_outcome migration, agent read view re-projected; recorded as a dated ADR-013 amendment).
- ECS Tasks page: a collapsible Cost Calculation Basis panel documents the Daily $/Monthly estimates — the Fargate unit-price table and formula rendered from the SAME constants the estimator computes with (the deriver now imports the shared cost-basis source), a worked example, and caveats (Fargate launch type only, ephemeral storage not priced, static prices, ×30 monthly).
- Home dashboard: a Monthly Cost Impact (est.) DIVERGING BAR chart (signed bars around a shared zero axis — increase on the warm pole, decrease on the positive pole, symmetric scaling, the 30d count delta as a muted sub-figure — shown inline on wide screens and as a visible second line on small ones (a title tooltip never surfaces on touch); a non-finite value renders '—', never a fabricated $0; the pole pair's colorblind safety was validated — CVD ΔE 13.9 light / 12.2 dark, ≥ the 8 target — and every bar carries a visible signed label) — 30-day resource-count change × a static per-type unit-cost heuristic, sorted by |impact| (top 8), explicitly labeled as a heuristic rather than billing data; fed by its own fixed 35-day account-scoped trend fetch (visible on the default view), including fully-removed types' savings, hidden when the latest snapshot is stale, when the REGION scope is narrowed (snapshots carry no region dimension; a narrowed account scope now prices that account's own deltas), or when the latest day is missing a weighted type the baseline has (a partial sync fan-out), and excluding no-baseline/no-weight types rather than showing $0.
- Chart quick wins (compliance/S3/subnets): the Compliance page gains v1's Alarms by Section bar chart (alarm counts per section from the same client rollup the pass-rate list uses; zero-alarm sections get no bar, an all-clear run omits the chart), the S3 page gains a Security Status flag-bar chart (bucket counts per Policy Private/Policy Public/Versioned/Logging flag via a new generic independent-flag spec option — the Policy bars measure bucket-policy status only, not the Security page's full exposure predicate; a bucket with no policy counts as Policy Private (both S3 inventory types now share this semantic), an unknown (access-denied) bucket counts into neither side, and until the newly synced bucket-policy public flag lands after the next sync the Policy bars are hidden rather than rendered as a fabricated 0/0), and the Subnets page gains a Subnets-per-VPC count bar.
- Security/topology quick wins: the Security page gains v1's Security Issues Summary bar chart (one bar per issue class — the four checks by finding count plus CVE Critical/High summed from the ECR scan details; zero bars are filtered and an all-zero chart is omitted) and an explicit loading line on first fetch (no more zero-valued tiles/empty charts posing as an all-clear before data arrives); the request-flow topology page gains a kind/health color legend (chips for the kinds and target-health states present in the loaded graph, theme-aware), and the infra/K8s map legend now also explains the card status dots (ok/warn/bad/neutral).
- Chart quick wins: the ElastiCache page renders v1's Node Type Distribution count bar in the chart band alongside the engine donut (a new generic count-distribution spec option), and the OpenSearch page's second donut becomes the derived Encryption Status (Full/Partial/No, semantic colors; a domain with an unknown side is excluded rather than counted as unencrypted).
- Detail/column quick wins: the IAM roles table gains a Description column, the Lambda table gains a human-readable Code Size column (the detail panel shows the readable value instead of raw bytes), the Lambda detail gains a per-layer name:version list and a Network section with an explicit 'Not in VPC' state, and the WAF detail shows the default action as Allow/Block ahead of the raw JSON.
- EKS cost page: a collapsible Cost Calculation Basis panel — the OpenCost-vs-estimate method table (5 cost items), the estimate formula rendered from the SAME unit constants the estimator computes with (single source — the documented numbers can never drift), a worked example, and the caveats (Fargate-style rates, no Spot/RI discounts, requests ≠ usage, network/PV/GPU only with OpenCost).
- Cost page quick wins: Daily Average and Last Month KPI tiles plus an 'N services increasing >20%' subtext on the Services tile; a neutral no-data banner (with an on-demand availability check; the Cost Explorer onboarding hint renders only for the host account after a confirmed 'not enabled' verdict) when the load succeeds with zero data (enable it in the Billing console — up to 24h until data appears); and the service table gains DAY-NORMALIZED threshold-colored change cells (>20% red, >0 orange, <0 green; no-baseline rows read '—' and sort last) and share mini bars with real numeric sorting — the table also picks up the shared metric-table chrome (search box, shown/total counter, problems-only toggle) and switches from mobile cards to horizontal scroll.
- Detail-panel rendering quick wins: EBS attachments flag DeleteOnTermination when set (the volume dies with the instance), the EBS detail gains an encryption verdict banner (green with the KMS key / red with the encrypted-copy recommendation; unknown shows nothing) plus a snapshot-qualified idle-volume cost hint for volumes detached at the last sync, and ECS cluster settings render as label–value rows instead of a raw JSON block.
- Inventory quick wins: the CloudFront table gains a Name column (tag-derived), the CloudTrail table gains a Last Delivery (UTC) column (the most recent SUCCESSFUL delivery — the failure signal is the detail panel's delivery error) and its detail panel gains the CloudWatch Logs role plus the CloudWatch Logs / digest delivery timestamps-and-errors and stop-logging time (visible after the next sync run), and the ECR table gains an Encryption column (the type rendered as-is: AES256/KMS/KMS_DSSE etc.).
- AI diagnosis: an admin pause switch for the report/digest emails (one Aurora settings row — pausing needs no deploy; reports completed while a pause spans a digest run are dropped from email exactly like when no topic is configured, and a settings-read failure fails open to publishing), and a printable report view (new-tab white A4 page with a cover block, numbered anchor TOC, per-section page breaks, and Print/Close buttons) alongside the existing PDF export. A synthetic-case evaluation CLI measures evidence grounding, abstention, coverage, latency and known cost; model execution is opt-in and synthetic results are not production accuracy.
- Resource-tile micro-stat sublines (the /inventory/g category pages AND the dashboard-home tiles, rendered from one shared map so the two surfaces cannot drift): per-type state decompositions — EC2 running/stopped, Lambda runtimes (container-image functions count as 'custom') and >300s timeouts, EBS total GiB and unencrypted, RDS Multi-AZ/unencrypted, ECR scan-on-push/immutable, S3 public/versioning-off, IAM no-MFA, SG open-ingress, CloudFront enabled, VPC subnet·NAT·TGW composition, plus ECS services/tasks and WAF rule-groups/IP-sets cross-counts; the dashboard EKS tile adds a live ready-nodes/pods/deploys subline shown only when every registered cluster answered AND the account scope is all-accounts (the fleet read is unscoped — a partial or scoped read must not fabricate a confident decomposition) — all computed from the existing summary aggregation and fleet read (no new AWS calls); sublines and the health verdict are hidden, never zeroed, while loading OR when the aggregation fails.
- Compliance control detail: the slide-over now shows the control's description (the recommendation rationale) alongside Status/Reason/Resource — collected per control on new runs; rows from older runs read '—' rather than a fabricated rationale.
- EKS overview: a collapsible cluster/VPC facet filter — multi-select cluster and VPC chips (VPC chips carry their cluster counts), an active-filter badge, Clear all, and a filtered/total counter — narrowing the cluster cards and the fleet panels below. The shared read API now reports its configured region, including empty results, and whether the bounded 25-cluster enumeration has more pages; existing array consumers remain compatible.
- EKS nodes fleet page: per-node 3-segment capacity bars (Requested / Available / System-Reserved) for CPU and memory with 'avail X | rsv Y' captions; scheduler-requested totals come from a per-cluster pods read, and a cluster whose pods read fails shows 'requests unknown' rather than a fabricated zero; terminal (Succeeded/Failed) pods are excluded from requested totals on every surface (fleet list, overview node bars, node drill-down) to match scheduler reservations (native-sidecar init requests remain uncounted — a known follow-up), and above 40 nodes the list keeps degraded-data rows first, then the most pressured, with an explicit truncation note.
- EC2 diagnostics table: a Private IP column, and clicking a row slides in a 24-hour network panel — hourly NetworkIn/NetworkOut charts (KST axis) with Total In/Out (24h) tiles, scoped to the instance's own account and region; a missing series reads 'no data' and never fabricates a zero.
- RDS detail panel: each attached security group now chains to its inbound rules — protocol, port range, and source chips (CIDR with description, referenced SG, prefix list; open-internet sources highlighted) — resolved from the synced security-group inventory with no live AWS call; a group missing from inventory reads 'not synced' rather than claiming it has no rules.
- OpenSearch inventory sync gains eight detail columns (service software update availability, log publishing, endpoint HTTPS/TLS/custom-endpoint policy, Auto-Tune, snapshot hour, advanced options, access policies, upgrade state), surfaced as readable detail-panel fields — visible after the next sync run.
- EC2 inventory: a CPU Top 15 bar chart in the chart band ranks instances fleet-wide by their latest CloudWatch CPU (name-tag labels, instance-id fallback) — instances are queried per inventory region with batched GetMetricData, and the same batches feed the fleet-average KPI card.
- OpenSearch detail panel: the raw cluster_config/EBS/VPC/encryption JSON blobs are replaced by structured, labelled sections — Dedicated Master, Zone Awareness, Warm/Cold storage, Multi-AZ Standby, an EBS volume one-liner (type·size·IOPS·throughput), VPC/subnet/SG lists, the KMS key, and advanced-security flags as badges (the raw advanced-security/Cognito blobs stay visible for their underived fields).
- ElastiCache/OpenSearch/MSK detail sparklines + Lambda memory histogram (v1 parity): live-metric detail panels gain a 1-hour 5-minute sparkline block per spec metric (≤2 datapoints → the Avg/Max/Min fallback, a missing series reads 'no data'; one bounded read-only GetMetricData call behind the trends=1 contract, with the resource's own account AND region threaded through), and the Lambda page gains a memory-allocation histogram (function counts per memory size, top 10 numerically sorted) beside the existing Top-N bar via a new generic spec option.
- RDS instance detail time-series (v1 parity): the RDS slide-over gains three trend blocks — 1-hour 5-minute sparklines for the six v1 metrics (CPU, freeable memory, connections, read/write IOPS, free storage; a series with ≤2 datapoints renders the v1 Avg/Max/Min fallback instead of a misleading two-point line, and a missing series reads 'no data'), a 24-hour freeable-memory trend, and a 14-day daily CPU trend, each with Avg/Max/Min tiles. Two bounded, parallel read-only GetMetricData calls (a ~65-minute spark window + a 14-day trend window — Period sets resolution, not a window) behind an opt-in `trends=1` param that returns only the trends; the existing `?id=` response shape and its consumers are untouched; no IAM/Terraform changes.
- Home-dashboard trend quick wins (v1 parity): the resource-trend chart gains show/hide toggle chips grouped as Core Resources (top 5, visible by default) and Other Resources (default-hidden — the chart now DRAWS 5 lines by default where it previously drew 8; the hidden three re-enable with one click, and colors stay pinned when toggling), and an inline summary KPI bar shows tracked resource types · total resources · 7d net change (±-colored; '—' when fewer than two snapshots exist, when no snapshot lands within the delta table's ±2-calendar-day tolerance, when the only qualifying baseline IS the latest snapshot, when the REGION scope is narrowed (snapshots carry no region dimension, and one KPI row must not mix a region-scoped total with an unscoped delta; a narrowed ACCOUNT scope now shows that account's own net change), or when the two compared days snapshot different type sets — STRICT parity, since any diff over a partial sync day is a sync artifact presented as a fleet change; the adjacent delta table likewise renders '—' instead of a fabricated Current 0 / −100% for a type whose sync day is missing).
- EBS volume detail drill-downs (v1 parity): the volume slide-over now shows the attached EC2 instances as enrichment cards (Name/type/state pill from the synced inventory — an instance missing from the sync renders its id with a 'not in inventory' note, never a fabricated state) and the volume's snapshots as a sub-list (newest 20: id · size · encryption badge · date, with an explicit cap note and a 'no snapshots for this volume' empty state). Pure Aurora cross-queries over already-synced rows via one new account-scoped BFF route — no new AWS calls.
- Small v1-parity sweep: CloudTrail event rows open a detail slide-over (event id/region/source IP/user agent/access key/error code, every resource on the event, and — for ADMINS only, matching the repo's identity-data gating — a PROJECTED raw-event view + access key: the userIdentity block is reduced to selected identity attributes and credential-family keys inside request/response params are recursively masked by a normalized deny-list (defense-in-depth atop CloudTrail's own sensitive-field masking, not a completeness guarantee); same LookupEvents call, no new AWS surface); CloudWatch alarms sort worst-first by default, applied in SQL BEFORE the row cap so firing alarms always fit the page (ALARM → INSUFFICIENT_DATA → OK, newest state change first — a column-header click still overrides); the inventory '총 N' tile, page subtitle, filter total, and risk-hero total use a true DB count once the 500-row fetch cap is hit (now supplied by the per-type aggregation endpoint — see the full-fleet aggregates entry above) — and the summary endpoint (which the home dashboard also calls) now honors the region scope it was already being sent, so region-narrowed landing-page counts/splits narrow accordingly; Lambda rows show a formatted last-modified date and render a null runtime as 'custom' (container-image functions — table, donut, facet, and detail all agree); and the Bedrock page gains a 'Models used' KPI tile (models actually invoked in the selected range; the 30d range notes its ~2-week metric-discovery window).
- AI-diagnosis generation UX quick wins (v1 parity): a running diagnosis shows an mm:ss elapsed timer and a per-section checklist grid (completed / pending, in the UI language — driven by a new additive `completed` list the worker streams into the progress JSONB; no per-section spinner on purpose, since concurrent rendering leaves no in-flight telemetry to show; older in-flight rows and a drifted section catalog fall back to the bar-only view), a completed report shows a stats bar (section count · duration · report id — duration comes from a new `finished_at` column stamped at terminal write [one additive migration]; legacy rows without it omit the segment, never fabricated), the empty state previews the full section scope with Deep-tier tags, and completed history rows carry inline MD/DOCX download links (no need to open the report).
- AI-diagnosis parity batch (v1 parity): a completed report now renders as collapsible section cards with a sticky table-of-contents sidebar (click scrolls to the section) and a per-section severity icon derived from body keywords (a display heuristic, labeled as such — not a score; reports without section headings keep the continuous view); report generation language is selectable (한국어/English/中文/日本語 — defaults to the UI language, applies to manual runs and schedules; the language is part of the run's dedup key, so a same-hour language switch starts a new run instead of returning the previous language's report; a legacy dedup-key read fallback ships for one release for rolling-deploy compatibility — REMOVE in the release after this one); the auto-diagnosis schedule gains KST detail settings (weekday for weekly/biweekly, day-of-month 1–28 for monthly, run hour) plus a last-run timestamp display — unset fields keep the previous interval-only behavior; and admins can send a test notification to the diagnosis mailing list from the subscribers panel (one SNS publish scoped to the existing diagnosis topic — the web task's first, admin-only `sns:Publish`; a failed send surfaces its error, never a silent success).
- Inventory KPI/chart quick-win batch (v1 parity): EC2 gains a running total-vCPU tile (per-instance `cpu_options` cores×threads — actual vCPUs, not the type default); RDS a total allocated-storage tile; Lambda long-timeout (>300s, danger) and average-memory tiles; EBS volumes an encryption-rate tile (100% → accent, <80% → danger); ECS clusters get a dedicated KPI band (ACTIVE count, running tasks, active services, container instances) instead of the generic state tiles; ECR rows gain a Scan on Push column (a missing/malformed scanning config counts as No — the API default); and the CloudWatch alarm-state donut uses fixed semantic colors (green OK / red ALARM / gray INSUFFICIENT_DATA) instead of size-ordered palette colors.
- Datasource Explore/management parity batch: curated example-query and natural-language prompt chips for all 8 connector kinds, a dedicated Loki log-stream viewer (timestamps, label badges, scrollable pane), 7d/30d time-range presets (per-kind API bound: prometheus/mimir 30d with an upstream `timeout` forwarded by their connectors — the connector change ships via `terraform apply`, so run the apply before relying on 30d; Loki capped at 7d; the 5000-point density cap stays), a result metadata bar (rows/series · execution ms · query language · shape), a dismissible "AI generated from …" banner after NL→query drafting, KPI tiles and a manual refresh button on the management tab, an "AI로 진단" deep link on each kind's DEFAULT datasource row (the chat tool path resolves per-kind defaults; supported kinds only) that prefills the assistant composer with a section-pinned prompt (`/assistant?q=`, review-only — never auto-sends), and proportional duration bars on Tempo/Jaeger trace results.

- Datasource detail pages gain a pre-built card dashboard: registering a datasource (and each daily index run) derives an expected card set from the cached schema — the queries each card uses are stored ahead of time (new `datasource_dashboard_cards` table + a deterministic `card_catalog` in the index worker; prometheus/mimir 13 cards covering targets, CPU, memory, disk, load, network, containers, and restarts; loki 2, tempo 2, clickhouse 2) — ready Prometheus/Mimir cards are live-validated against the exact datasource before registration, through the same instant/range tool the page will execute (a conclusive PromQL error — body-derived, never a bare HTTP 4xx — disables only that card and is revalidated on the next daily run; a transient connector failure, a failed re-introspection, or a truncated schema that cannot decide a card requirement all preserve the previous card set; the connector metric-metadata tool also gains a definitive `exists` flag and 3-second upstream deadlines) — card building runs inside the existing datasource-index job, so it is gated on `datasource_diagnosis_enabled` (default false; requires `workers_enabled`/`agentcore_enabled`/`integrations_enabled`) like the diag-signal chips — and the page executes the stored queries live on view through the existing read-only query API (stat/timeseries/table cards; unavailable cards render dimmed with what's missing; a failed card shows an inline error, never a silent zero).
- Topology infra page gains two columnar map views — a 5-column infra resource map (External | VPC | Subnet | Compute | NAT) and a per-cluster K8s map (Ingress → Service → Pod → Node; host-account, connected clusters only — the in-cluster read path is host-scoped) — rendered as a real graph (fixed-column ReactFlow with edge lines), with click cross-highlighting, search highlighting, and a color legend. Built on existing inventory/EKS reads plus the pre-existing read-only `/api/tgw` live attachment describe (host-account scope only, first 20 TGWs — degradation is surfaced in the UI); the only server-side addition is the read-only `ingresses` in-cluster kind.
- FinOps baseline-recommendations engine (ADR-020, extends ADR-012, `finops_baseline_enabled`): a daily Fargate batch evaluates a rule catalog (unattached EBS volumes against a published rate card; EC2/RDS rightsizing via Compute Optimizer) against `inventory_resources` + Compute Optimizer — no CUR/Athena cost pipeline in this repo, so amounts come only from a published rate card or Compute Optimizer's own estimate, never invented; Cost Explorer/Cost Optimization Hub/Budgets-based rules are catalogued as future work, not called by this version. The deterministic engine owns status/amount (findings are ordered by amount; there is no separate engine-owned priority field yet); an LLM adds a short Korean explanation only, discarded if it states a different dollar amount. False-positive guards (protected tags, insufficient Compute Optimizer observation window, stale inventory data) demote to `needs_review` rather than hiding a finding. A rule that fails to evaluate no longer looks like a clean run — `finops_runs.status` gains a `partial` state, surfaced by the API/card, and that rule's prior findings are left untouched rather than wiped. Findings are scoped by account/region (not just resource_id), since `inventory_resources` spans every synced account/region. Read-only — no new AWS-mutation path. `ec2_rightsizing`/`rds_rightsizing` call Compute Optimizer only in the worker's host region (a per-region endpoint); each finding's evidence carries an explicit `coverage:"host-region-only"` marker rather than presenting single-region results as account-wide. New `/cost` section (`GET /api/finops/findings`); fixes the ADR-012/terraform drift where `cost-optimization-hub:*` was documented but never granted (the FinOps MCP's Cost Optimization Hub tool has been `AccessDenied` since ADR-012). **Known doc/DB drift (not fixable here):** its three migrations' `-- since: 0.8.0` header is stale — FinOps didn't exist when `[0.8.0]` was cut on 2026-08-19 — but those migrations already merged to main and are checksum-immutable, so the header can't be corrected without breaking `make migrate` for any environment that already applied them. This entry stays in `[Unreleased]` (the truthful release state); `schema_migrations.app_version` for these three rows will read `0.8.0` regardless.
- Add an SG Rules page (`/network/security-groups/rules`, `sg_rule_activity_enabled`, default false) — this is a SEPARATE, additive pipeline from the pre-existing Usage analysis (`[0.8.0]` below); it does not replace it. Rule inventory (rule id/fingerprint/version history) is derived from configured Security Groups; per-rule daily traffic evidence (`observed_compatible`/`overlapping`/`no_observed_evidence`/`unassessable`/`not_configured`) is computed by a Fargate worker (`sg_rule_scan.py`) that resolves ENI-to-SG membership snapshots and matches them against VPC Flow Logs read through Athena — via an isolated broker Lambda (`sg_rule_athena_broker.py`, ADR-019 Role B) that is the ONLY principal allowed to `sts:AssumeRole` into a target account's `AWSopsSgRuleAthenaRole`; the broker resolves account/table config server-side from an opaque `flow_source_id` (never a caller-supplied query/account), re-validates every identifier against strict allowlists, and requires the workgroup to enforce its own `BytesScannedCutoffPerQuery`. A flow can match more than one rule; partition-projection-aware watermarking and per-day SKIPDATA/truncation coverage flags feed the same honest-degrade contract used elsewhere in this app — an incomplete or unattributable day is `unassessable`, never a confident false zero. **SG-reference resolution across a genuinely cross-account or cross-region VPC-peering/RAM-shared reference is a known, disclosed gap, not a working feature today**: this release has no peering/RAM topology data source, so a rule referencing a security group that cannot be found ANYWHERE in the current account/region's own ENI-membership snapshot resolves `unassessable` (never a confident empty match) — that data source can only be populated in a future change. Matching is **day-granular, not per-flow**: `sg_rule_inventory_versions.valid_from`/`valid_to` are *observation* timestamps (the scan run that first/last saw a fingerprint), not the actual rule-change instant, so a day within the actual gap to the previous successful scan of a version boundary is also `unassessable` rather than confidently attributed to either shape (see "Fixed" below).
- Add a Network Path Check page (`/network-paths`, top-level nav entry, `network_path_check_enabled`, default false): define a source/destination check (ENI, SG, subnet route, NACL, TGW, peering/VPN/DX boundary, Network Firewall, ALB listener/target-group health, K8s NetworkPolicy/Calico/Cilium/Istio-stub layers, DNS/L7) and run it via a Fargate worker (`network_path.py`, resolve → discover → verify → conclude) that never invents a confident verdict from missing/ambiguous data for any SINGLE layer it evaluates (`unknown`/`conditional` instead of a false `allowed`/`blocked` at that layer). **This is a per-layer guarantee, not yet a full-path one**: every layer is still primarily a source-side check, so a candidate path can still report an overall `allowed` based on less than the full bidirectional policy surface for peering/TGW/VPN/DX-fronted destinations whose own ENI isn't resolved, and for ALB/NLB-fronted targets (the target's own SG is not independently checked past `target-group`) — see `network_path.py`'s own "Known structural gap" docstring section. **`fetch_live_topology` is now real** — best-effort candidate-path discovery from CACHED Aurora topology (`topology_nodes`/`topology_edges`, `class='infra'`), no longer the `NotImplementedError` stub this bullet originally described — but a full LIVE AWS/Kubernetes re-read at run time remains deliberately unimplemented, so starting a NEW run (`POST`) in `web/app/api/network-paths/[id]/runs/route.ts` still 503s (`status: "unimplemented"`) via `networkPathLiveTopologyCapabilityGate()` (`web/lib/network-path-gate.ts`); existing check definitions and prior run history remain fully viewable. `LIVE_TOPOLOGY_IMPLEMENTED` stays `false` until that separate live re-read path exists. Calico, Route 53, and K8s Ingress→Service→EndpointSlice now have REAL evaluators (given already-fetched data); Cilium/Istio remain correctly-stubbed `unknown` (never guessed). `resolve_identities()` still reads Pod/Node/ENI identity from the saved check definition's own fields, but a `pod`/`node` source declaring a `cluster` additionally gets that identity CONFIRMED against a live, read-only K8s/EC2 read (`resolve_live_identity`) rather than trusting the definition's fields as already-verified. A rule inventory row now also surfaces its own `vpc_id`.
- Inventory sync: quota-safe collection — Steampipe plugin rate limiter (env-tunable), durable per-type freshness ledger (last_success_at, partial status, unknown_attribute_count disclosure), content-preserving partial runs, and per-type freshness in the inventory MCP tools. An opt-in host guard verifies STS and registry scope, retries transient identity failures within a fixed budget, and exits nonzero after rejected scope without a concurrent restart reviving collection. Unknown attribute coverage recorded as NULL is now degraded rather than healthy; inventory pagination uses a complete key order so tied capture times cannot repeat or omit rows across pages. Exact CloudFront identity lookup returns one disclosed identity-only row; a miss is not evidence of AWS absence. Empty Steampipe scans use the pinned per-account identity table and require exactly one matching account; unverified probes preserve last-good inventory and remain partial. Verified dev profiles support the optional nonsecret `CI_STEAMPIPE_AWS_FILL_RATE_DEV` refill override on full plans; absence preserves tfvars/defaults and Apply replays the reviewed plan. (ADR-021) Sync results, ledger counts and account snapshots use distinct persisted account/region/resource identities, preserving last-row-wins values. Hydrate-fallback unknown-attribute counts use the same persisted identity basis.
- 6 new DB migrations backing the three features above: `sg_rule_activity` (flow sources / rules / rule versions / daily activity / scan runs tables), `network_path_check` (checks / runs / step results tables), `network_path_runs_error` (adds a nullable `error` column to `network_path_runs` so a failed run has somewhere to record why), and `sg_rule_inventory_vpc_id` (adds a `vpc_id` column to the rule inventory so a rule row can surface which VPC it belongs to), `inventory_sync_freshness` (adds `run_token`/`last_success_at`/`last_success_row_count` to `inventory_sync_runs`, widens the status CHECK with 'partial', and recreates the `sql_reader.inventory_sync_runs` view — still excluding `error`/`run_token`), and `inventory_sync_unknown_attrs` (adds `unknown_attribute_count` to the table and the reader view).

### Changed

- Configuration topology evidence: independently scoped EKS/ECS candidates require active pods or RUNNING tasks; Succeeded/Failed pods and STOPPED/DELETED tasks cannot claim reused IPs, while unknown states and conflicting references remain unverified. Duplicate IPs across clusters in one region/VPC are withheld even when names match. Unreadable known scopes block matching IPs; unknown or truncated EKS enumeration withholds account-wide ownership. Saved account scope, generation/cancellation guards and same-account retained-graph notices protect partial refreshes; complete empty results replace prior data. All inventory and enrichment reads share two lanes per load, with sequential critical paging (20 × 500 rows) and the shared 30-second browser deadline. Each page requires the single-statement rows/ledger snapshot marker and stable global sweep metadata; ownership never depends on a browser/database clock comparison. Aggregate sweep health, read failures and per-account uncertainty remain distinct. EKS runs only for exact host scope; member/all scopes show non-enumeration reasons. Unconnected clusters use cluster_not_connected rather than a read-failure reason, while their scopes still block unknown ownership. Region metadata is validated. Inventory remains account-scoped, and genuine row caps use the configured limits; an incomplete first page does not claim the full cap. Capture ranges and the Refresh freshness chip use source/eligible last-success timestamps in viewer-local time, so rereading old data does not make it fresh. Cached target labels, target-group-only targetCapturedAt and SQL-projection limits remain explicit; no AWS mutation or projection/grant change.
- Runtime IAM narrowing applies on the next Terraform apply to every already-enabled stack, including main, independently of the dev profile: exact three web SSM parameters, runtime discovery/token actions, own-cluster task control and Claude-only model resources. Read conditions include known regions, including future opt-ins. Host-only account registration rejects foreign accounts with HTTP 409; dev host-only configuration requires the verified profile.

- Relocated the security group usage analysis page from `/inventory/security_group` to its own top-level `/network/security-groups/usage` page — the embedded `SgAnalysisSection` component's own behavior/IAM is unchanged, but the new page itself additionally carries a relationship graph, a fixed-24h hits request, and a link to the Rules page; moved out of the generic inventory-type page so it can sit alongside the new SG Rules page under one `security-groups` route group.

### Fixed

- Tempo query generation: preserve discovered attribute scopes and observed value types for four selected HTTP-status/service-name attributes, render legacy cached tags with valid unscoped TraceQL syntax, and check AI drafts with Grafana's TraceQL parser before returning them (one correction attempt). Disable stale-value early termination for schema discovery while retaining count/time bounds; keep virtual intrinsics separate, use scoped v2 tag-value lookups with legacy fallback, and validate generated custom attributes, literal types, and explicit HTTP-status filters; disclose per-attribute sampling limits, treat truncated legacy type evidence as unknown, and distinguish name-discovery limits from type-sampling limits. Complete empty observations refresh after a short one-minute TTL and explain historical queries through Grafana/Tempo API or intrinsic-only recent queries; incomplete empty results retry discovery and report collection failure instead of an idle window. Tempo catalog hashes exclude schema content because these catalogs depend only on successful introspection; catalog versions and generation flags still invalidate them. Admin schema GET/POST summaries expose custom-attribute counts and discovery/type limits. The richer metadata requires deploying the Tempo connector Lambda and refreshing its schema, and updated gateway tool descriptions require AgentCore provisioning; see the [Tempo query-generation runbook](docs/runbooks/tempo-query-generation.md).
- Trace service maps: scope service identities by datasource/account/region/environment/namespace/cluster and preserve asynchronous span links and identifiable broker/queue relationships. The same qualified queue ARN joins callers across accounts/regions within one datasource/environment, with claimed account/region rederived only from destination ARN qualifiers in the writer, API and SQL/AI readers, including retained rows. Non-ARN/malformed destinations and missing qualifiers have null claims, with no reporter/legacy fallback; the UI shows claim values beside the unverified-telemetry disclaimer. It never establishes AWS queue ownership or an inventory bridge. DB host matching adds an explicit-account branch matching trusted configured `HOST_ACCOUNT_ID`, alongside the existing absent-account/`self` branches. Tempo zero-trimmed/64-bit hex IDs match full OTLP bytes, and zero parents mean absent without accepting zero trace/span IDs. APIs, UI and AI reader views expose failed/partial/empty/stale collection, preserve prior graphs on collection failure, and keep traffic counts separate from confidence. Collection panels keep source details collapsed and bounded, show source windows and node/edge loss or unavailable-context evidence, and treat absent metadata as unknown rather than a collector failure. Graph-publication age follows the configured rebuild cadence; inventory source age separately uses the shared inventory threshold and requires successful producer evidence. Apply the projection migration (`make migrate`) and redeploy `inventory_read_mcp` through the Terraform operator flow; see the [rollout and identity contract](docs/runbooks/source-sync-observability.md). Graph reads admit at most two requests per pool with acquisition included in the deadline, release before normalization/serialization and disclose bounded row truncation/read failures separately from collection outcomes. Saved source clocks/status remain visible; legacy single-account row clocks remain display-only. Apply the named collection projection/read-index migrations and web environment binding separately; see the [graph read contract](docs/runbooks/graph-read-contract.md). The reader accepts flow/infra metadata without claiming the inventory publisher is already active. Empty graph publication requires affirmative producer completion; legacy unmarked empty responses remain unconfirmed and retain the prior graph. Paired connector producers compute completion markers from observed response shape, limits and warnings; matching Tempo search IDs without fetched spans remain incomplete. Valid nonempty capped/warning-bearing reads refresh explicitly partial snapshots; unconfirmed empty and missing/failed child data retain the saved graph. Tempo search pins the default limit to 20 and reaching it remains partial. Diagnosis partial/unknown results carry incompleteness and observed counts, not query errors. Deploy the paired producer Lambdas and updated diagnosis worker through the reviewed rollout before expecting these contracts.
- AI diagnosis evidence: missing, failed or partial observations cannot become healthy verdicts or improvements. Valid-zero/observed-violation tests exercise the normalized evaluator contract; current diagnosis collectors emit X-Ray `to_ref` without `to` and no `inventory.unencrypted` aggregate, so live edge/encryption invariants remain `unknown` until those adapters provide the required evidence. Reports persist assessment coverage and unassessed verdicts, render their counts/reasons deterministically in Intended vs Actual, and show the same scope in the UI and exports; historical reports without coverage are marked assessment unavailable. Missing incident confidence is conservative, and PDF rendering blocks external resource requests.
- FinOps tools: read resource-specific Compute Optimizer recommendations and savings using the actual SDK contracts; distinguish unknown savings from observed zero and withhold complete totals for missing/error/currency-incompatible evidence.
- ENI configuration evidence (`network-mcp`): preserve security-group peers and IPv6/ICMP details within an explicit 200-row per-group bound, select route tables only from established subnet or VPC-main associations, and retain reported route targets without inventing `local`. Expose incomplete evidence through `partial`/`unknown`, attribute failed/truncated/missing SG reads to their group IDs, and report per-group completeness so unassessed empty arrays remain distinct from confirmed ruleless groups while successful evidence is retained. Initial ENI SDK failures return sanitized non-success evidence; the live tool catalog and network prompt prohibit absence or connectivity verdicts from incomplete evidence. Rollout requires redeploying the `network-mcp` Lambda through the Terraform operator flow, redeploying the AgentCore Runtime for the network prompt, and reconciling the Gateway tool description through the v2 provisioner.
- Explore NL→PromQL generation is anchored to the datasource's FULL cached metric list, ADVISORY: an unknown name (e.g. a recording rule absent from the target, like ':node_memory_MemAvailable_bytes:sum') triggers one corrective retry that shows the model its previous answer and suggests near-miss schema names, and a surviving violation returns the draft WITH a visible warning naming the tokens (softened when the cache is truncated or stale) — never a hard error, since the tokenizer and the cache can both be wrong and the connector stays the runtime authority; the prompt additionally forbids ':'-style recording-rule names not in the schema and label-mismatched vector arithmetic. Korean requests now rank the right metrics into the prompt (a curated 한국어→metric-term vocabulary — '메모리 사용률' floats node_memory_*/container_memory_*; before, a Korean request contributed zero ranking terms and the alphabetical head filled the prompt), the Prometheus/Mimir schema cache grows from the first 500 to 3000 metric names (kube-prometheus stacks lost whole node_*/kube_* families past the old cap — a cache that looks like an old-cap snapshot is re-introspected in the background (cooldown-bounded), and an over-size schema is stored as a bounded copy by every cache writer instead of not at all), and a recording-rule miss is corrected even on a truncated cache when every unknown name's raw core IS a cached metric (the result keeps a review note). Recorded as ADR-018 §D (live, draft-only path) with BASELINE updated in the same change.

- EKS cost request-estimate: the fallback's RAM cost was effectively $0.00 for every pod (the MiB-valued memory request was divided by 1e9 as if bytes) — memory now contributes at GiB semantics, so estimated pod costs rise accordingly.
- Live-metric displays: ElastiCache `CacheHitRate` arrives as a 0–1 ratio and now renders as a real percentage (0.92 → 92%, not 0.9%), and OpenSearch `FreeStorageSpace` — which AWS/ES reports in megabytes — no longer gets divided by 1e6 as if bytes (an ~1,000,000× understatement in the latest-value grid); OpenSearch queries also send the OWNING account's `ClientId`, so member-account domains return data instead of a silent 'no data'.
- SG Rules & Usage (`sg_rule_activity_enabled`): the Athena/Glue flow-log matching path now fails closed instead of producing a confident wrong answer, or silently refusing every scan forever. Account/region scoping resolves from the union of Glue partition keys and table columns (accepting hyphenated aliases like `account-id`); the Athena SQL partition predicate uses a properly typed `DATE '...'`/`TIMESTAMP '...'` literal for a genuinely date/timestamp-typed catalog column (a plain string literal there fails every scan with a type error), while the Glue `GetPartitions` existence check — which parses a subtly different Expression grammar — always double-quotes identifiers and uses a plain string literal instead (a typed literal there risks Glue rejecting the call outright); both sides widen to a two-day {D, D+1} window (a half-open range for a `timestamp`-typed key), since Hive delivery-time partitioning can land a day's flow in the next day's file. The `partition_projection` strategy is validated at two points: at save time, a single date key needs `type=date`+`format=yyyy-MM-dd`, a Hive `year/month/day` layout needs `type=integer` on all three (`digits=2` for month/day only, since Athena's unpadded default doesn't match this module's zero-padded query literals), and a declared `range` must be present and not a closed literal date range already confirmed expired; at scan time, the day being scanned is checked against the full `NOW±N<unit>` grammar and refused if a bound can't be confidently resolved — together closing the "validates `status: valid` yet every real scan errors or false-zeros" failure class end to end. A source whose validation predates these checks self-heals on its next run (re-validates and persists through the broker's own response shape); a re-validation that itself fails refuses the run (`awaiting_validation`) rather than scanning on stale data. `observation_lag` (the day-boundary uncertainty window) is derived from the actual gap to the last successful scan, not a fixed nominal cadence.
- Network Path Check (`network_path_check_enabled`): the per-layer "never invent a confident verdict from missing/ambiguous data" contract now holds across the real evaluators. Calico policy evaluation matches the actual Calico v3 `Rule` schema — `action` is required (a missing or unrecognized action vetoes a confident verdict rather than defaulting to Allow), ports/protocol are read from the correct `source`/`destination` EntityRule (including numeric IANA protocol values), a rule- or policy-level field this adapter doesn't model (negations, ICMP/HTTP matchers, etc.) is caught by an allowlist rather than a growing deny-list, and `order` — modeled only conservatively, since this adapter still has no cross-policy precedence model — still degrades to `unknown` whenever a matching Deny/Pass rule coexists with a matching Allow. SG/NACL/K8s NetworkPolicy peer matching also treats a malformed `peer_ip` the same as a missing one, distinguishes an unresolved `peer_sg_ids` (unknown) from a confirmed-empty `peer_sg_ids=[]` (a decidable non-match), and no longer confidently denies on an unresolvable named port or a `podSelector`/`ipBlock` peer missing identity/namespace confirmation. Route 53 resolution correctly follows CNAME/ALIAS chains (re-checking multi-record/weighted-set ambiguity at every hop, not just the entry name), detects targetless pointers and cycles, synthesizes wildcards from the true RFC 4592 closest encloser, and recognizes an NS-without-SOA zone delegation at any ancestor — including the query name itself, and even when the payload carries no SOA at all — as `unknown` rather than a confident NXDOMAIN `blocked`. Ingress→Service→EndpointSlice resolution follows Kubernetes' real precedence for host (exact > one-label wildcard) and path (`Exact` > longest `Prefix`), validates the referenced port against the Service's declared ports, and degrades to `unknown` — rather than falling back to a lower-precedence match — whenever a host-matching `ImplementationSpecific`-with-path rule's own controller-defined precedence can't be confidently determined. `eval_vpn_or_dx` treats both `aws_side_state` and `route_present` as tri-state (`None` = not fetched → `unknown`, distinct from a confirmed-down/absent value → `blocked`). Live identity resolution (`resolve_live_identity`) validates every check-definition-authored field (account id, namespace/pod/node/cluster names, region) against a safe charset and a registry-backed external-id lookup before using it in a live AWS/K8s call; the EKS access-entry registration script grants a minimal Kubernetes RBAC group instead of an AWS-managed admin-view policy, merging rather than replacing existing group membership; and the target-account CFN template (`infra/cfn/awsops-target-account-role.yaml`, ADR-011) now takes an additive, optional `WorkerTaskRoleArn` parameter so a member-account read from either worker's own task role — not only the host web task role — can be trusted, requiring an operator re-deploy of that stack to take effect (`docs/runbooks/onboard-target-account.md`).
- Direct Connect: partial AWS failures now degrade honestly instead of rendering confident wrong numbers — `/api/dx` gained `degradedRegions` / `metricsDegradedRegions` / `gatewaysDegraded` / per-gateway `associationsAvailable` / `totals.gatewaysAssociationsUnknown`; the UI shows a warning banner, `+`/`≥` lower-bound markers on affected KPI tiles, an "undetermined" (not red "unassociated") badge when the association lookup itself failed, and per-query CloudWatch `StatusCode` failures (PartialData/InternalError) now count as metric degradation. Incomplete evidence inside successful responses also withholds health/redundancy passes; observed missing device metadata fails the metadata-availability check without asserting network failure. Connection health explicitly covers deployed dedicated/hosted rows (ConnectionState supports both), allows only `available`/`down`, discloses all other states (including deleting/unknown/missing) as excluded and unassessed, withholds any whole-fleet health claim and reports missing state evidence. API down totals, the scoped KPI and the deployed-health checklist share one classification; excluded lifecycle metadata alone is not a failure, while an explicit metric-zero observation on an excluded connection stays visible with critical severity and period/current-deployment context. Graph connections, location links and LAG up counts use the same affirmative evidence, with unknown/unassessed members labeled separately. Location summaries count only identified sites across deployed owned/hosted connections, exclude every other connection state, retain proven two-site redundancy alongside unknown-site coverage, and keep owned-only SLA counts separate; unknown sites cannot raise an SLA tier.
- PR review pipeline: chair timeout 600→900s with a one-shot fast-fail retry, code-first three-pass diff ordering (code → decisions/runbooks → docs prose), and a sanitized, narrowly-scoped truncated-file guard that downgrades unverifiable absence-claims to MINOR instead of dropping them. Each L2–L5 lens requires completed Codex and Claude reviews; every Codex and Claude panel lens has a 1200s budget, the job is bounded at 90 minutes, and the same OIDC role obtains fresh credentials immediately before each model phase after setup. Failed or timed-out panel/chair output cannot count as a completed review, with hard-kill grace retained. Lockfile change metadata remains visible when generated contents are omitted. A SHA-pinned recovery label selects a commit, while a GitHub protected environment requires a designated reviewer before execution; exact environment/ref trust subjects replace coarse PR/repository trust. Automatic CI scripts come from the trusted default commit, model context comes from the target base, and stale verdicts are not published.

## [0.9.0] - 2026-08-22

### Added

- Add a topology diagram + resilience assessment to the Direct Connect page (modeled on aws-samples/sample-network-resilience-agent, fitted to the house React Flow conventions): an on-premises → DX location → connection/LAG → VIF → DX Gateway → TGW/VGW layered graph (dagre layout, state-colored nodes/edges — down connections and BGP-down VIFs in red, degraded LAGs and non-associated gateway links in amber/dashed, unattached VIFs dashed), node click opens the existing side detail panel, and a resilience card scoring the AWS Direct Connect SLA tier (Maximum 99.99% = 2+ connections at each of 2+ locations · High 99.9% = 2+ locations · Single 95%) with a critical/warn checklist (connection/VIF health, location redundancy, per-location dual connections, unassociated DXGWs, unattached VIFs) — built entirely from data the page already fetches, no new AWS API calls; 4-language i18n.

## [0.8.0] - 2026-08-19

### Added

- Make the dashboard installable as an iPhone/iPad home-screen app (PWA): web app manifest (standalone display, root scope) + Apple meta tags (apple-touch-icon, apple-mobile-web-app-capable) + 4 generated icons (180 full-bleed apple-touch, 192/512 rounded, 512 maskable), all served without the auth cookie via new Lambda@Edge public-allowlist entries (iOS fetches manifest/icons credential-less — a 3-way lockstep test pins manifest ↔ public/ files ↔ edge allowlist). Safe-area handling for notch devices (viewport-fit=cover with top/bottom/left/right env() padding on the mobile shell, scroll-gap compensation for the grown tab bar), and the browser theme-color meta now tracks the runtime theme (cobalt/teal/dark) instead of tinting dark screens cobalt. No service worker by design: live authenticated ops data gains nothing from offline caching, and iOS install does not require one.
- Rework the Network Firewall rule-hit table for readability and interactivity: the hand-rolled table is replaced with the shared MetricTable (header-click sort on every string/number column, text search, per-element action facets, danger-rows-only toggle), clicking a row opens the rule in the standard side detail panel (SID, rule groups, tri-state hit basis and why-n/a note), and two hit-count charts are added — an action-distribution donut fed by the untruncated per-action aggregation (matches the card badges) and a top-10 rule hits bar with an explicit notice when the top-100 SID aggregation is truncated; both the donut and the "no rule hits" empty state honor `alertCoverageComplete` the same way the bar chart and joined table already do, rather than presenting a temporally-partial window as definitive. MetricTable itself gains three opt-in props reused here: multi-value facets (element-level matching so filtering 'blocked' also matches 'drop, blocked' rows), a render-stage row cap that keeps search/sort operating on the full set while preserving idle rows, and a per-row class hook (restores the idle-rule dimming).
- Add stateful rule hit counts to the Network Firewall page (the 2026-08 AWS feature, which aggregates existing Alert logs rather than exposing a new API — verified against the API reference, latest botocore, and CloudWatch): the Alert-log card now aggregates hits per SID (pre-aggregated across signature/action, with a per-region overfetch and a 100-SID join cutoff — both truncation modes surfaced honestly rather than shown as exact) over the CloudWatch Logs destination and joins them with the SIDs parsed server-side from configured stateful rule groups (sid/msg/action/noalert only — rule bodies still never leave the server), surfacing configured rules with zero matches in range (policy blind spots / shadow rules) — gated on an inference (from ALERT log-group creation time/retention, not proof) that log coverage spans the selected range, not just the current logging config, and on the rule group's own `lastModified` predating the range — separately, any in-scope policy's OR any non-STATELESS rule group's `lastModified` after the range start (or `null`, treated as unknown rather than unmodified) taints attribution for the whole account (not just the groups it currently references, since a removed/deleted/edited rule group can't be enumerated from current topology), as does any ALERT log target reached via prefix-discovery rather than a confirmed logging config (that region's topology is unverifiable, and its hits still merge globally by SID like any other region's). Both range-start comparisons anchor on the earlier of the topology and log-Insights fetches' own server timestamps rather than the browser clock, since the two are independently cached. When the `ruleHits` query fails outright, a region's log groups are chunk-split (`alertTopNPartial`), or discovery is unknown, the joined table is skipped and only the pre-existing raw top-signatures fallback is shown (pass/`noalert` rows don't appear in that fallback) — the join-cutoff and per-region-cap truncations above are a distinct, milder case that keeps the joined table, marking affected rows `?`/`≥N` instead of hiding it. Otherwise, pass rules and `noalert` rules are honestly rendered n/a since neither emits alert log entries, unknown SIDs (managed rule groups) are labeled as such, and domain-list rule groups (unparseable AWS-internal SIDs) taint attribution for the account, when policy-referenced, rather than being silently ignored. Known residual gaps, documented but not closed: a firewall switching policies mid-range, or a firewall deleted mid-range outright, escape every guard above (no per-firewall "policy attached since" timestamp, and no `lastModified` at all, exist in the API) — closing this would require correlating the already-fetched CloudTrail audit stream.
- Add security group usage analysis to the `/inventory/security_group` page (`/api/sg`): usage detection (attached via ENI `Groups` + cross-referenced as a source by other SGs → flags unused cleanup candidates, excluding the non-deletable default SG), rule source/destination identification (sg-references resolved to names, CIDRs matched to inventory VPC names, `0.0.0.0/0`·`::/0` → whole-internet, `pl-` → managed prefix-list names), and per-SG traffic **hit matching** on row click — VPC Flow Logs (CloudWatch Logs destination, default-format parse; ACCEPT rows are attributed to matching ingress rules, REJECT rows surface as peer traffic only) with an NFM fallback (top-contributors over all categories, 1h cap) that identifies traffic peers only — NFM aggregates bytes bidirectionally so hits are never attributed to rules (no false idle signals); hits degrade to unconfirmed (not a confident zero) whenever the underlying evidence is incomplete — no ENI, no query result, the Insights 200-row/50-ENI caps, ICMP type/code fields, or a peer SG outside the scanned scope — so idle-rule counts only ever reflect rules with real matching evidence; scoped to the same regions as the inventory table above (host account); KPI tiles + attached-kind donut; read-only `ec2:DescribeSecurityGroups`/`DescribeManagedPrefixLists`/`DescribeFlowLogs` IAM (applied, terraform in lockstep); 4-language i18n.
- Add a Network Firewall page (`/network-firewall`, Network group): firewall / policy / rule group inventory with per-region fan-out and `AWS/NetworkFirewall` traffic aggregation over the selected range (received / passed / dropped / rejected packets and drop rate; only the 3-dimension `(AZ, Engine, FirewallName)` metric variant is summed — the `EndpointName` variant is published in parallel and would double-count; received packets/bytes additionally sum `Engine=Stateless` only, since Stateful-forwarded traffic is a re-publication of the same packets and would double the drop-rate denominator), plus five analysis lenses — protection settings off (delete / subnet change / policy change), ALERT-logging gaps (no threat visibility; a denied describe call renders as “unknown”, distinct from “off” — observed with an SCP-style deny that hits only the task role), `aws:pass` stateless default actions (traffic bypasses the stateful engine), rule group capacity (immutable after creation, flagged at 80%+) and unassociated rule groups (cleanup candidates), and per-AZ endpoint / config-sync health; KPI tiles, type/capacity charts, a firewall-checks card, three tables with sectioned detail panels; rule bodies (`RulesSource`) are deliberately excluded from responses; read-only IAM grant of 7 explicit `network-firewall:List*`/`Describe*` actions — no wildcard (applied, terraform in lockstep); 4-language i18n. Per the owner's monitoring guide the page also covers the log and audit layers: TLS-inspection metric counters, an Alert-log Insights card (which rule/sid blocked what — top sources/destinations, CloudWatch Logs destinations only with a prefix-discovery fallback when the logging describe is denied; stateful rule hit counts covered separately above), a Flow-log Insights card (top talkers, protocol distribution), a CloudTrail change-audit card (who changed policies/rules, write events first), and a 4-language collapsible diagnosis guide (metrics / logs / complementary sources with per-goal priorities).

## [0.7.0] - 2026-08-05

### Added

- Add a Direct Connect page (`/direct-connect`, Network group): connection / VIF / DX gateway inventory with per-region fan-out (gateways are global, fetched once) and `AWS/DX` CloudWatch analysis — down detection over the selected range (`ConnectionState`/`VirtualInterfaceBgpStatus` minimums), per-VIF monitoring numbers (average/peak Bps, average Pps, peak utilization from the percent-published `VirtualInterfaceUtilization*` metrics with a peak-bps ÷ bandwidth fallback covering LAG bandwidth, and latest `BgpPrefixesAccepted`/`Advertised` counts — hosted sub-1G connections only publish VIF-level Bps), BGP route visibility via the 2026-07 `ListVirtualInterfaceRoutes` API (accepted/advertised routes with AS path, communities, installed time; 200-route cap per VIF, honest degrade where unsupported), and a location-redundancy lens that flags a single-location single point of failure (Resiliency Toolkit recommends 2+ locations); KPI tiles, VIF type/traffic charts, four tables with sectioned detail panels; BGP secrets (`authKey`, `customerRouterConfig`) are stripped and never leave the server; read-only `directconnect:Describe*`+`ListVirtualInterfaceRoutes` IAM grant (applied, terraform in lockstep); 4-language i18n.

## [0.6.0] - 2026-08-03

### Added

- Add a VPC Endpoints page (`/vpc-endpoints`, Network group): all-region endpoint inventory with three analysis lenses — unused Interface endpoints via `AWS/PrivateLinkEndpoints` BytesProcessed (idle endpoints bill hourly per ENI/AZ, shown as an est. $0.0126/h), security signals (full-access policies, private DNS off), and per-VPC S3/DynamoDB Gateway coverage gaps; KPI tiles, type/service charts, a faceted table with sectioned detail; read-only `ec2:DescribeVpcEndpoints` IAM grant; 4-language i18n.
- Add the aws-data chat route (v1 parity): route listing/count/config questions to a BFF-local handler that generates SQL with the codegen model, runs it against the live Steampipe listener (single-statement SELECT-only guard, 200-row cap), self-corrects once on error, streams the SQL preview in status frames, then streams an analysis grounded in the rows; fail-open at every step — Steampipe unreachable degrades to normal routing, double SQL failure falls back to Bedrock with an explicit no-live-data notice.
- Add auto-collect analysis chat routes (v1 parity): 6 registry-based collectors — idle-scan, eks-optimize, db-optimize, msk-optimize, trace-analyze, incident — each collects live context (Steampipe SQL, CloudWatch, CloudTrail; missing sources are marked unavailable instead of failing) and streams a grounded analysis with per-step status frames; total collection failure falls back to Bedrock with an honest notice.
- Activate the container and iac chat sections: EKS/ECS/Istio and CFN/CDK/Terraform questions now route to their gateways instead of the inactive notice (all 9 gateways have READY MCP targets).
- Add EKS fleet-node drilldown: `/eks/nodes` rows open the same rich drilldown as the overview (CPU/Memory tri-split, pods on node, ENI) via a shared `NodeDrilldownPanel` — the overview reuses it too.

### Fixed

- `opencost_config` — read-only OpenCost install config (cluster-scoped helm version/values)
- `prevention_insights` — ADR-032 Phase 4 cross-incident proactive-prevention tier
- `eks_registrations` — EKS runtime registration (in-app query onboarding; EventBridge auto-register)
- `worker_jobs.requested_by` — server-derived requester identity on every enqueue, used to scope
  `GET /api/jobs`(`/[id]`) to the caller's own jobs (2026-07-22 pentest report remediation)
- `worker_jobs` idempotency-per-requester — adds two partial unique indexes (per-requester, plus a
  NULL-requester bucket for internal enqueues) **alongside** the existing global
  `UNIQUE(idempotency_key)` (that column-level constraint is NOT dropped in this PR). This is
  Phase 1 of a two-phase rollout — dropping the old global constraint is deliberately deferred to
  a separate, later PR once this deploy is confirmed stable (round-5 review: shipping both phases
  in one PR would race `make deploy`'s migrate-then-roll-out ordering and cause a guaranteed
  enqueue outage)

### Security

- Ownership is now enforced on the diagnosis and compliance read paths too, not just jobs:
  `GET /api/diagnosis` (list), `GET /api/diagnosis/[id]`, `GET /api/diagnosis/[id]/download`, and
  `GET /api/compliance/runs` (list) + `GET /api/compliance/runs/[id]` all gate on owner-or-admin.
  Before this, any authenticated user could read or download another user's diagnosis report and
  read another user's CIS compliance run (kiro review: the security changelog omitted these)
- `POST /api/jobs` now requires auth and enforces ownership on `GET /api/jobs`(`/[id]`); the
  generic `report`/`compliance` job types were removed from its allowlist entirely — those job
  types trust client-supplied `report_id`/`run_id`/`requested_by` with no ownership check, so
  reaching them via the generic route was a cross-user IDOR write. They're only enqueueable via
  `/api/diagnosis` and `/api/compliance/run`, which compute `requestedBy` server-side
- Idempotency-key conflict lookup (`lib/jobs.ts`) is now scoped to the requesting user — a
  guessable, deterministic key (e.g. a diagnosis report key derived from the victim's email) could
  otherwise return another user's `job_id`/status and attach the attacker's payload to it
- `enqueueJob` now catches a `23505` unique_violation raised by the legacy global
  `UNIQUE(idempotency_key)` constraint above (it isn't the `ON CONFLICT` arbiter, so Postgres
  still enforces it independently) and falls back to the same requester-scoped lookup: a
  same-requester retry still dedupes cleanly, and a genuine cross-requester key collision now
  fails with a clean `409` (`IdempotencyKeyCollisionError`) instead of an opaque `500`. This
  **mitigates** the cross-user idempotency-key collision as an interim measure — full closure
  still requires the follow-up PR that drops the legacy global constraint (see the Phase 1/Phase 2
  note above; PR #195 round-6 review)
- `POST /api/jobs` now namespaces a caller-supplied `idempotency_key` as `u:<requester>:<key>`
  before it reaches the ledger. Because the legacy global `UNIQUE(idempotency_key)` is still
  enforced during Phase 1, an authenticated attacker could otherwise POST a victim's deterministic
  diagnosis key (`report:<email>:<tier>:<model>:<scope>:<hour>` — guessable from the email) to squat
  it, making the victim's own `POST /api/diagnosis` hit `23505`, fail its requester-scoped recovery
  lookup, and `409` + `markReportFailed` for that whole hour bucket. Namespacing makes squatting
  structurally impossible (a caller can only collide with their own keys) and closes the DoS
  **within this PR**, independent of the Phase 2 constraint drop. Server-minted keys (diagnosis,
  compliance) are unchanged — they already derive from the requester's own identity (PR #195
  round-7 review)
- `GET /api/compliance/runs/[id]` now uses the same dual-key (`identity()` + raw `sub`) ownership
  check as the list route and `GET /api/jobs/[id]`, instead of a direct `requested_by !==`
  comparison — a legacy sub-keyed run was visible in the list but 403'd on this detail route
  (PR #195 round-6 review)
- `/api/eks/[cluster]/register` now returns 413 (not a silent default-registration fallback) when
  the request body exceeds the size cap
- Request-body size caps (`readJsonBounded`) on several routes that previously read unbounded JSON
- Stabilize the aws-data route (4 fixes): raise the Steampipe statement timeout to 35s (cold multi-region wide scans exceeded the previous 15s) and the chat route `maxDuration` to 180s (a cold scan plus one self-correction plus a long analysis stream overran 60s); read all text blocks from the codegen response (a leading thinking block made the SQL parser return empty) and raise codegen `max_tokens` to 1024 and analysis `maxTokens` to 8192 (full listings were truncated); drop assistant turns starting with the fallback marker from codegen history (poisoned history); log SQL-generation and per-attempt failure reasons so fail-open never hides the cause.
- Stop aws-data answers claiming rows are missing and restore natural streaming: move the analysis context from a 2k-char JSON slice to compact TSV under a 24k-char budget with an explicit shown/total note, and drain SSE deltas through an adaptive typewriter buffer.
- Restore the eks-optimize collector: the curated Steampipe read policy had no EKS actions, so `aws_eks_cluster` got AccessDenied and collection returned zero rows — grant read-only `eks:Describe*`/`eks:List*` and log the per-leg collection summary on total failure.
- Resolve each Transit Gateway's region from inventory before querying: default-region clients silently returned nothing for off-region TGWs — the detail and metrics paths now fan out per-region clients with per-region degrade (partial results kept).

## [0.5.0] - 2026-08-02

First release of the **v2 line** (versioned independently from the v1 1.x line, starting at 0.5).

### Added

- **Platform — Terraform MSA, private edge & auth**
  - Rebuild the stack as a Terraform MSA (ADR-001): single `terraform/foundation/` root, partial S3 backend, feature-flag gates on every large feature (default false → `plan` = No changes) — CDK dropped.
  - Serve a fully private edge path: CloudFront (TLS) → VPC Origin `https-only:443` → internal ALB HTTPS:443 (regional ACM) → Fargate `awsops-v2-web` (arm64, root path — no basePath); no public ALB.
  - Authenticate at the edge (ADR-002): Cognito User Pool + Lambda@Edge RS256 JWKS verification (iss/aud/token_use) + PKCE public client; self-hosted `/login` form (BFF `InitiateAuth` mints a 12h `awsops_token`); keep the Hosted UI PKCE flow as a dark fallback.
  - Run web as a Next.js 14 thin-BFF exposing 80 API routes — enqueue heavy work, never run it inline.
  - Add the async worker backbone (ADR-009): `POST /api/jobs` → `worker_jobs` ledger + SQS → ESM (kill-switch) → idempotent dispatcher Lambda → Step Functions `$.runtime` Choice → Lambda (short) or `ecs:runTask.sync` Fargate (long/OOM) → status_updater + 5-minute reaper.
  - Ship a Makefile deployment flow: `make configure` (interactive TUI) / `deploy` / `agentcore` / `workers` / `migrate` / `upgrade`.
- **Data — Aurora & migrations**
  - Persist all app state in Aurora Serverless v2 (PG 17.9, 0.5–4 ACU, KMS CMK, RDS-managed master secret) via node-pg — replaces v1 `data/*.json`.
  - Add the v2 DB migration framework (`make migrate`): collision-free ULID files, advisory-locked, fail-loud, version-stamped `app_version` ledger; `make migrate-status`; `scripts/v2/upgrade.sh` (`make upgrade`): RDS snapshot → migrate → idempotency check → deploy (PREVIEW unless `CONFIRM=go`). Migrations in this line include `opencost_config`, `prevention_insights`, `eks_registrations`.
  - Feed inventory through a flag-gated warm Steampipe Fargate (FDW) + sync Lambda → Aurora pipeline (`steampipe_enabled`); back-fill v1 history via `backfill-*.mjs`.
- **Inventory — 41 resource types**
  - Compute (6): EC2, Lambda, ECS Clusters, ECS Services, ECS Tasks, ECR.
  - Storage & DB (11): S3, EBS Volumes, EBS Snapshots, RDS, DynamoDB, ElastiCache, ElastiCache Replication Groups, OpenSearch, OpenSearch Serverless, MSK, Neptune.
  - Network (17): VPC, Subnet, Route Table, NAT Gateway, Internet Gateway, Transit Gateway, Security Group, Route53 Records, CloudFront, CloudFront VPC Origins, ALB, NLB, Target Group, ALB Listener Rules, API Gateway (HTTP), API GW Integrations, API GW Routes.
  - Security (6): IAM Roles, IAM Users, IAM Policies, WAF Web ACLs, CloudTrail Trails, S3 Public Access.
  - Monitoring (1): CloudWatch Alarms.
  - Give every type facet filters with live counts, a state SegmentedControl, tailored highlight KPI cards, distribution donuts + Top-N bars, and a sectioned DetailPanel; flag EOL Lambda runtimes; add CloudTrail event lookup, summary + daily-trend APIs (up to 90 days), and per-type refresh (Steampipe → Aurora sync trigger).
- **EKS suite**
  - Overview with cluster filter + node drilldown; fleet pages for nodes/pods/deployments/services (server-side live aggregation; per-cluster failures degrade to `reachable:false`).
  - K9s-style read-only in-cluster explorer with per-object describe (secrets excluded).
  - Container cost via OpenCost: saved per-cluster config, 1-day allocation (KPI + per-pod cost), install-bundle download (values.yaml + install.sh, run out-of-band), install-status badge.
  - Cluster register/unregister + Access Entry status with onboarding guidance (Terraform grants Access Entry + AmazonEKSAdminViewPolicy, read-only); control-plane + Container Insights metrics; per-instance-type ENI IPv4 limits.
- **Diagnosis tiers — 12 services**
  - Provide range-scoped CloudWatch metric tables for EC2, RDS, ElastiCache, OpenSearch, MSK (broker nodes), DynamoDB, S3, EBS, Lambda, ALB, NLB, and EKS (layered: control plane / nodes / workloads / addons).
  - Attach collapsible per-service diagnosis guides in all 4 UI languages; add a Target Group health table and TGW detail section.
- **Network tools**
  - Network Flow Monitor: live NFM top-contributor queries (pod-level endpoints, 1-hour API window), End-to-End hop-path visualization, onboarding-aware menu gating.
  - DNS query logs: Route53 Resolver + CoreDNS analysis via Logs Insights aggregation (RCODE/type/top domains/NXDOMAIN/sources/firewall; resolver comparison with honest latency gaps).
  - IP addresses: ENI-based IP→resource lookup (15+ owner kinds), unused-EIP / detached-ENI detection, EKS pod-IP join.
  - Topology: read-only graph API (flow/infra classes, `?from=` subgraphs) with infra / resource / services views; AWS-console-style VPC Resource Map.
- **AI**
  - AI assistant: hybrid routing (regex fast-path + Haiku classifier, ADR-003) across 9 chat sections (network/container/data/security/cost/monitoring/iac/ops/observability) with cross-domain auto-synthesis; SSE streaming (markdown renders while streaming); thread history with search, per-thread and delete-all; slash menu, preset chips, follow-up suggestions, session stats bar, floating 🤖 launcher; Bedrock Sonnet 5 / Opus 4.8 / Haiku 4.5.
  - AgentCore (ADR-004): 9 section gateways (8 AWS domains + external-obs) + shared Strands Runtime + Memory + Code Interpreter, provisioned idempotently via boto3 with SSM as config source of truth; control-plane status page.
  - AI comprehensive diagnosis (ADR-008): 15-section parallel Bedrock rendering (bounded concurrency, per-section timeout isolation, `partial` degrade), md/docx/pdf artifacts via S3 proxy download, Intent Engine (`architecture_intent`), report management UI.
  - AI insights: cached insight cards on the Overview dashboard + admin-gated regeneration enqueue (fail-closed when the flag is off, duplicate-job dedup).
  - K8sGPT read-only in-cluster diagnosis per cluster (GET-only Result reads, admin + cluster allowlist, `k8sgpt_enabled`-gated).
  - Agent Space customization: skills/agents catalog CRUD with routing keywords and gateway/model/language selection (admin).
- **Cost**
  - Cost overview: 1m/3m/6m/12m period filter, per-service detail, Cost Explorer availability probe (1h cache, `?force=1`).
  - Container cost: OpenCost per-pod EKS cost incl. NFM per-pod transfer cost; Fargate daily/monthly cost estimates on ECS tasks and MTD cost on ECS clusters in inventory.
  - Bedrock cost: app token spend from `ai_usage_daily` aggregates + per-model usage metrics (client fan-out for "All accounts") on the Bedrock page.
- **Security & compliance**
  - Security findings: Public S3, open security-group ingress, unencrypted EBS, IAM users without MFA — derived read-only in the BFF from `inventory_resources`, with a re-sync endpoint.
  - Container-image CVE findings from ECR image scanning (v2-native successor to v1's Trivy CVE tab).
  - CIS compliance: run Powerpipe benchmarks as async Fargate `compliance` jobs with `compliance_runs`/`compliance_results` history and a static benchmark allowlist.
- **Integrations**
  - External datasources (8 kinds): Prometheus, Mimir, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog — instance CRUD + credential storage (admin), SSRF-guarded connection test, per-kind default selection, read-only query execution, natural-language query drafting (review-only, never auto-executed), predefined diagnosis signals.
  - Integration registry under ADR-007 governance: egress connectors + ingress webhook sources, single Secrets Manager secret keyed by kind slug, schema introspection/cache.
  - Multi-account (ADR-011): account CRUD with `GetCallerIdentity` anti-spoof verification, per-account region enable/disable, STS AssumeRole read-only fan-out, account/scope selectors in the shell.
- **Operations**
  - Async job queue UI: enqueue/list jobs with per-job status lookup.
  - Per-user auto-diagnosis schedules executed by the worker `schedule_dispatcher`.
  - Diagnosis-completion email notifications via SNS with subscriber management (LIVE under ADR-007 governance).
  - Incident lifecycle (flag-gated, analysis-only per ADR-006): HMAC-signed webhook ingest with active/standby secret rotation, manual trigger, detail views, cross-incident prevention insights.
  - Actions framework (kill-switch gated): list/detail/execute split between integrations-write and mutating-actions gates, fail-closed on empty action names.
  - Operational self-healing (ADR-015, default-off): Aurora secret-rotation event → `ecs:UpdateService force-new-deployment` on the host's own web service only.
- **UI/UX**
  - 4-language UI (Korean/English/Chinese/Japanese) with a language toggle; per-language diagnosis guides.
  - 3 themes (Cobalt/Teal/Dark) with a theme toggle and theme-aware chart colors.
  - Sidebar IA: collapsible groups + 2-level subgroups + per-group overview pages with attention splits; CommandPalette; mobile bottom-tab bar and mobile nav.
  - Reusable UI kit: sortable DataTable, sectioned DetailPanel, StatCard / StatTile / Meter / StatePill / SegmentedControl, resizable panels.
  - Changelog modal + sidebar version display fed by the bilingual CHANGELOG.md.
- **Observability**
  - Monitoring hub: EC2/RDS fleet tabs + single-resource time series with range selection; CloudWatch alarm inventory page.
  - Chat/AgentCore operational telemetry: per-gateway call volume, success rate, and average latency surfaced in the UI.

### Changed

- **BREAKING:** v1 (CDK/EC2/Steampipe monolith, `/awsops` basePath) is decommissioned per ADR-016 —
  v2 serves at the root path with its own auth and data plane.

### Security

- AWS-resource mutation + autonomy frozen (ADR-005); BFF never proxies secrets; in-cluster reads are
  GET-only; auth tokens are write-only in the registration API.

## [1.9.0] - 2026-05-27

### Added

- Event-driven pre-scaling — Phase 1+2 (ADR-010) ([#13](https://github.com/whchoi98/awsops/pull/13))
  - New `/event-scaling` admin page: register events, collect historical CloudWatch metrics (ASG/RDS/MSK/EBS/ALB), Bedrock Sonnet 4.6 multi-phase warmup plan via `PLAN_JSON` marker, downloadable bash scripts per resource type (KEDA/HPA, Aurora reader, MSK partition expansion, ASG warm pool, EBS IOPS)
  - **Review-then-run**: scripts are downloaded for operator review; the dashboard never executes mutating actions
  - New API route `/api/event-scaling` (GET/POST/PUT/DELETE, admin-only)
  - New SQL query file `event-scaling.ts` with CloudWatch GetMetricData batch + resource-state queries
  - 3 new libraries: `event-scaling.ts` (data model + JSON persistence), `event-scaling-prompts.ts`, `event-scaling-scripts.ts`
- ADR-029 (Proposed): Mutating Action Framework — gate model for any future write actions (ADR-010 Phase 3 dependency)
- ADR-030 (Accepted): ECS Fargate + Aurora App State + Dual-Tier ECR
  - **Phase 1 foundation** (this release): `AwsopsDataStack` CDK stack provisioning Aurora Serverless v2 PostgreSQL 15.5 (0.5–4 ACU, writer + reader, KMS-encrypted, IAM auth, private subnets), idempotent 7-table schema (`infra-cdk/data/schema.sql`), app-side pg Pool (`src/lib/db.ts`) with DSN/discrete env var resolution, and deploy script `scripts/13-deploy-aurora.sh` (deploy / schema / status / dsn subcommands)
  - Gated behind `cdk deploy AwsopsDataStack -c enableAurora=true` — default-off, doesn't affect existing single-host deployments
  - **Phase 1 dual-write** (next release): 7 source files will gain Aurora write alongside the current `data/*.json` write; reads stay on JSON until 7-day parity gate clears
- AI code-review workflow ([#12](https://github.com/whchoi98/awsops/pull/12)) — automated PR reviews via GitHub Actions invoking Claude
- Test coverage analysis and improvement plan ([#11](https://github.com/whchoi98/awsops/pull/11)) — `docs/TEST-COVERAGE-PLAN.md` with current gaps and prioritized targets

### Fixed

- Zombie connection cleanup hardened to survive Steampipe FDW hangs — uses a dedicated short-lived `Client` (not pool) so it works even when the pool is exhausted; threshold lowered to 90s for Cost Explorer / IAM summary FDW paths
- CIS benchmark fails with `relation does not exist` in single-account mode — schema resolution fixed for non-aggregator setups
- Benchmark parameter validated against allowlist before shell invocation (prevents command injection)
- `global.anthropic.claude-sonnet-4-6` model ID used for alert diagnosis (was returning a 4xx with the regional ID)

### Infrastructure

- New CDK stack `AwsopsDataStack` (`infra-cdk/lib/awsops-data-stack.ts`) — opt-in via `enableAurora` context flag
- `infra-cdk/data/schema.sql` is source-controlled (negation rule added to `.gitignore`)
- 4 CDK stacks total: `AwsopsStack`, `AwsopsCognitoStack`, `AwsopsAgentCoreStack`, `AwsopsDataStack`

### Documentation

- ADR-029 (Proposed), ADR-030 (Accepted) — 2 new ADRs (29 → 30)
- `docs/architecture.md` — Future: ECS Fargate + Aurora Migration section, data-layer description for Aurora

## [1.8.1] - 2026-04-23

### Added

- Alert-triggered AI diagnosis pipeline (ADR-009): automatic root cause analysis from external alert sources ([#10](https://github.com/whchoi98/awsops/pull/10))
  - Webhook endpoint (`/api/alert-webhook`) for CloudWatch Alarms (SNS), Prometheus Alertmanager, Grafana Alerting, SQS, and generic webhooks
  - Alert correlation engine: groups related alerts into incidents (30s buffer, time/service/resource matching, dedup, severity escalation)
  - Investigation orchestrator: auto-selects collectors + datasource queries based on alert context, change detection (CloudTrail + K8s rollouts)
  - Bedrock Sonnet root cause analysis with structured output (timeline, remediation, prevention)
  - `AlertContext` scopes collector queries to firing alert's services/resources/namespaces (±10min window)
  - Slack notification client (Block Kit, severity-based channel routing, thread updates for webhook + bot modes, resolved state)
  - Knowledge base with monthly summary persistence (`data/alert-diagnosis/summary-YYYY-MM.json`) and past incident similarity search
  - SQS background poller, Alert Settings admin page (`/alert-settings`)
  - HMAC-SHA256 webhook authentication and rate limiting
  - Active incidents exposed via `GET /api/alert-webhook`; header badge + home card poll every 30s
- Documentation expansion:
  - 18 new ADRs (011-028) covering datasources, SNS, reports, Bedrock model, cache warmer, Cognito, SSE, HMAC, adminEmails, CDK split, multi-route, i18n, code interpreter, CloudFront
  - 5 new runbooks: alert pipeline, cache warmer, Cognito auth, deploy flow, multi-account
  - 11 new module CLAUDE.md files (docs/, runbooks/, decisions/, agent/, scripts/, tests/, infra-cdk/, ai-diagnosis/, alert-settings/, k8s/, collectors/)
  - Web guide: new `monitoring/ai-diagnosis.md` and `monitoring/alerts.md` pages (KO+EN), intro/FAQ updates
- `LICENSE` file (MIT)

### Fixed

- Report download buttons use proxy URLs instead of raw S3 presigned URLs (STS session expiry fix)
- SSRF protection for SNS SubscribeURL, admin auth for alert config, PromQL/LogQL injection prevention
- Alert correlation: bounded retry, timer cleanup, dedup map cap, rate limit hardening
- Collector dynamic import restricted to code files via `webpackInclude` magic comment (prevents CLAUDE.md from breaking build)
- `global.anthropic.claude-sonnet-4-6` model ID used for alert diagnosis
- Duplicate AI diagnosis menu item removed from sidebar
- Unused `batchTopics` variable removed; env var replacement fixed
- Dynamic `reportBucket` config restored; 30min stale timeout
- SNS→SQS queue + DLQ + SNS subscription auto-created in `setup-alert-pipeline`
- SNS email notifications strip markdown to plaintext

### Security

- `.gitignore` tracks `.env` + `.env.*`; `.env.example` allowlisted

## [1.8.0] - 2026-04-07

### Added

- External datasource integration with 7 observability platforms: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog ([#10](https://github.com/whchoi98/awsops/pull/10))
- Datasource management page (`/datasources`) with CRUD, connection test, and auth configuration
- Datasource Explore page (`/datasources/explore`) with direct query execution and AI query generation (natural language to PromQL/LogQL/TraceQL/SQL)
- Multi-datasource AI correlation: cross-analyze external metrics with AWS resources via `datasource` route
- AI routing expanded from 10 to 11 routes (added `datasource` route for external platform queries)
- EKS Access Entry status display and kubeconfig registration ([#11](https://github.com/whchoi98/awsops/pull/11))
- EKS Service Resources tab with clickable navigation and node ENI traffic metrics
- AI comprehensive diagnosis with 15-section Bedrock Opus analysis ([#13](https://github.com/whchoi98/awsops/pull/13))
- Diagnosis report export to DOCX, Markdown, and browser Print-to-PDF
- Scheduled auto-diagnosis (weekly/biweekly/monthly) via report scheduler
- Print-friendly report page (`/ai-diagnosis/report`) with A4 page breaks
- SSRF protection with allowlist-based private network access and defense-in-depth URL validation
- Converse Stream API for multi-route synthesis with real-time SSE streaming
- Typing effect simulation for AgentCore gateway responses
- Automatic zombie PostgreSQL connection cleanup (queries running longer than 5 minutes)
- App version displayed in sidebar, auto-read from package.json

### Fixed

- Exclude Steampipe internal FDW connections (`client_addr IS NULL`) from zombie cleanup
- Remove monitoring queries from cache warmer to prevent pg pool exhaustion from slow CloudWatch FDW calls
- Add time range filters to all monitoring metric queries to prevent unbounded query execution
- Prevent AI chat bubble width jump during SSE streaming ([#8](https://github.com/whchoi98/awsops/pull/8))
- SQL injection prevention: sanitize nodeName and validate ENI IDs before SQL interpolation in EKS pages
- Add missing `involved_object_kind`, `involved_object_name`, `count` columns to warningEvents query
- Fix undefined `errorFile` variable in benchmark route
- Add missing `ClipboardCheck` icon import in Sidebar

### Security

- SSRF defense in depth: URL validation in `datasource-client.ts` protects all outbound fetch paths including AI route
- Admin-only access enforced on datasource query and AI query generation actions
- IPv6 private/link-local address detection added (`fc00::/7`, `fe80::/10`)
- Regex capture groups for safe Tempo/Jaeger trace ID URL insertion
- Remove hardcoded S3 bucket with account ID from report route, read from `config.reportBucket`

## [1.7.0] - 2026-03-24

### Added

- Multi-account support with Steampipe Aggregator pattern (`aws` = all accounts, `aws_{id}` = single account)
- Account management page (`/accounts`) with add/remove/test functionality (admin-only via `adminEmails` config)
- `AccountSelector` dropdown and `AccountBadge` component for per-account navigation
- `buildSearchPath(accountId)` for per-account query scoping and `runCostQueriesPerAccount()` for cost data merging
- `account_id` column added to all 25 SQL query files for multi-account filtering
- Cross-account IAM role setup script (`scripts/11-setup-multi-account.sh`)
- Real-time Bedrock streaming via `InvokeModelWithResponseStreamCommand` with SSE chunk events
- Background cache pre-warming (`cache-warmer.ts`) for dashboard queries on 4-minute interval
- Cache warmer status bar displayed on dashboard, monitoring, and AgentCore pages
- Configurable customer logo in sidebar (`customerLogo`, `customerName`, `customerLogoBg` in config)

### Changed

- All 35 pages integrated with `useAccountContext()` for multi-account awareness
- DataTable auto-adds Account column when multi-account data detected
- Cache key format changed to `sp:{accountId}:{sql}` for per-account cache isolation
- Config `accounts[]` array manages accounts without code changes
- Deployment scripts expanded to 11 steps (Step 11: multi-account setup)

### Fixed

- Pool exhaustion prevention with `RESET search_path` failure handling and connection destruction

### Security

- **CRITICAL**: AssumeRole audit logging with structured JSON for CloudWatch tracking
- **CRITICAL**: ExternalId required for cross-account AssumeRole (Confused Deputy prevention)
- **HIGH**: Admin endpoint rate limiting (5 req/min/user, HTTP 429)
- **HIGH**: Alias/Region input validation (64-char limit, regex pattern)
- **HIGH**: Replace `execSync` with `execFileSync` to prevent shell injection ([#6](https://github.com/whchoi98/awsops/pull/6))

## [1.6.0] - 2026-03-21

### Added

- i18n support with Korean/English language toggle (React Context + localStorage)
- 500+ translation keys in `translations/en.json` and `ko.json`
- AI responses follow language setting (English or Korean output)
- Bedrock monitoring page (`/bedrock`) with per-model usage dashboard (CloudWatch + AWSops token tracking)
- Account Total vs AWSops usage comparison charts
- Token cost display in AI chat (input/output tokens, USD cost)
- ECS container cost page (`/container-cost`) with Fargate pricing and Container Insights metrics
- EKS container cost page (`/eks-container-cost`) with OpenCost API and request-based fallback
- OpenCost installation script (`06f-setup-opencost.sh`) for Prometheus + OpenCost on EKS
- AgentCore Memory Store for conversation history persistence (365-day retention, per-user isolation)
- Conversation history toggle panel at bottom of AI Assistant page

### Changed

- Default Bedrock dashboard time range from 24 hours to 7 days
- Cross-region model IDs added to Bedrock pricing map

## [1.5.2] - 2026-03-15

### Added

- EBS page (`/ebs`) with volumes, snapshots, encryption status, EC2 attachment mapping, idle volume detection
- MSK page (`/msk`) with Kafka clusters, broker node metrics table (CPU/Memory/Network), KRaft controllers
- OpenSearch page (`/opensearch`) with domains, encryption (N2N/At-Rest), VPC config, cluster metrics
- Resource Inventory page (`/inventory`) with 18 resource count trends, multi-line chart, cost impact estimation ([#1](https://github.com/whchoi98/awsops/pull/1))
- CloudWatch metrics tables for MSK, RDS, ElastiCache, and OpenSearch (progress bars + metric values)
- Valkey engine support in ElastiCache with color-coded engine badges
- Cost Explorer MSP/Direct Payer auto-detection at install time
- Cost snapshot fallback showing last known data on query failure
- AgentCore config externalized to `data/config.json` (no hardcoded account ARNs)
- MCP tool usage inference from response keywords displayed as badges in AI chat
- AgentCore Memory with auto-save (question/summary/route/tools/response time per conversation)

### Changed

- Dashboard cards expanded with EBS, MSK, OpenSearch in Network & Storage row
- Pool max connections increased from 3 to 5, batch size from 3 to 5
- Multi-route fallback to Bedrock Direct added, timeout increased from 60s to 90s
- Sign Out moved from Header to Sidebar (next to logo)

### Fixed

- HttpOnly cookie sign-out via server-side API (`POST /api/auth`) instead of client-side deletion

## [1.4.0] - 2026-03-13

### Added

- Multi-route AI classification: 1-3 gateways called in parallel with Bedrock response synthesis
- AgentCore dashboard page (`/agentcore`) with Runtime status, 8 Gateway cards, 125 tool inventory
- AgentCore status API (`/api/agentcore`) for Runtime/Gateway state queries
- CloudFront page (`/cloudfront-cdn`) with distributions, origins, aliases, WAF, protocol settings
- WAF page (`/waf`) with Web ACL list, rules, IP sets
- ECR page (`/ecr`) with repositories, scan config, encryption, tag mutability
- Sign Out button in Header with cookie deletion and Cognito re-authentication
- S3 Bucket TreeMap visualization by region with Public/Versioned/Standard color coding
- S3 IAM Roles section showing roles with S3 access
- RDS Security Groups with inbound rules and chained resource display
- RDS CloudWatch metrics: CPU, Memory, Connections, IOPS, Storage mini-charts
- ElastiCache Security Groups and CloudWatch metrics
- Monitoring instance detail view with full-screen metrics and date range filter (1h/6h/24h/7d/30d)
- Resource Topology redesign: Infrastructure Graph/Map views + Kubernetes 4-column resource map
- VPC Resource Map with AWS Console-style 4-column layout and click highlight
- EKS node cards with CPU/Memory progress bars and ENI detail view
- Cost Explorer period filter, service filter, projected monthly cost, and MoM change

### Changed

- Dashboard layout redesigned to 18 cards (6x3) with 1:1 sidebar mapping
- CIS Compliance updated to v4.0.0 baseline
- AI Assistant header styled to match EC2/VPC pages with ONLINE badge

### Fixed

- PieChart/BarChart Steampipe bigint string to `Number()` conversion across 8 pages
- Cost query `COALESCE(unblended, blended, 0)` for accounts with null blended_cost
- Multi-route build TypeScript implicit any type errors

## [1.3.0] - 2026-03-12

### Added

- 18 dashboard StatsCards (6x3 layout) with 1:1 sidebar menu mapping and sub-metrics
- CIS Compliance pass rate display with alarm/skip/error breakdown
- Monthly Cost sub-metrics: daily average, last month comparison, MoM change
- SSE streaming in AI Assistant with real-time progress indicators
- Response time display, clipboard copy, and follow-up question suggestions in AI chat
- EC2 memory/network info via `aws_ec2_instance_type` JOIN
- Multi-filter support in EC2: text search + State + Instance Type + VPC dropdown
- K8s Overview node cards with CPU/Memory usage progress bars
- K8s node detail view with ENI cards, per-ENI traffic, and Pods table
- EKS Explorer: Status/Node filters, pagination (25/50/100/200), cluster selector
- Route Table tab in VPC with associations, routes, and target/state details
- TGW Route Tables and Attachment detail views

### Changed

- Sidebar font size increased (`text-sm` to `text-[15px]`), icon size 16px to 18px
- StatsCard auto-shrink for long values, unified `h-full` card height

### Fixed

- RDS/ElastiCache metric chart overlap resolved with direct Recharts rendering
- Monitoring EC2 detail chart sizing with dedicated Recharts components
- K8s `parseMiB` const hoisting issue resolved by moving function outside component
- AgentCore `bedrock-agentcore:*` permission and `<tool_call>` tag cleanup
- Bedrock region changed from us-east-1 to ap-northeast-2 (global.* inference)
- Cognito custom domain `SupportedIdentityProviders` and callback URL path fixes

## [1.2.0] - 2026-03-11

### Added

- Network Gateway (17 tools) split from Infra Gateway for VPC, TGW, VPN, ENI, Firewall, Reachability, Flow Logs
- Container Gateway (24 tools) split from Infra Gateway for EKS, ECS, Istio
- AI test script `scripts/test-ai-routes.py` with interactive menu, 104 questions, 9 categories, content validation
- Test guide `docs/AI_TEST_GUIDE.md` with usage, output interpretation, and troubleshooting

### Changed

- **BREAKING:** Infra Gateway (41 tools) split into Network (17) + Container (24) for 54% faster container responses
- Gateway count increased from 7 to 8, route count from 9 to 10
- Bedrock region changed to ap-northeast-2 with global.* inference profile for ~20% latency reduction
- Benchmark route Steampipe password changed from hardcoded to dynamic lookup

### Fixed

- AgentCore permission failure with missing `bedrock-agentcore:*` in IAM role
- EKS access entry `arn:aws:sts::` to `arn:aws:iam::` format conversion
- K8s PVC `capacity`/`access_modes` JSONB serialization error with `::text` casting
- AgentCore response `<tool_call>` tag exposure cleaned with regex removal
- Cognito custom domain `SupportedIdentityProviders` and callback URL path

## [1.1.0] - 2026-03-07

### Added

- 7 role-based AgentCore Gateways replacing single gateway (Network/IaC/Data/Security/Monitoring/Cost/Ops)
- 19 Lambda functions as MCP tool targets with 125 total tools
- Dynamic gateway routing via `payload.gateway` parameter in `agent.py`
- 9-route priority keyword-based routing in `route.ts`
- Role-specific system prompts for each gateway specialist
- `create_targets.py` script for automated Gateway Target creation
- All 16 Lambda source files version controlled under `agent/lambda/`

### Changed

- **BREAKING:** Single gateway (29 tools) replaced with 7 specialized gateways (125 tools) for improved tool selection accuracy
- `network-mcp` rewritten from 1 tool (693B) to 15 tools (17KB)
- `steampipe-query` upgraded from boto3 keyword fallback to real SQL via pg8000
- Legacy gateway (`awsops-gateway-g0ihtogknw`) removed

## [1.0.1] - 2026-03-07

### Added

- CDK infrastructure stack (`awsops-stack.ts`) with VPC, EC2, ALB, CloudFront
- Cognito User Pool with OAuth2 Authorization Code flow
- Lambda@Edge (Python 3.12, us-east-1) for CloudFront JWT authentication
- AgentCore Runtime with Strands agent (arm64 Docker, ECR)
- AgentCore Gateway with MCP protocol and Code Interpreter
- 4 sub-step AgentCore scripts: Runtime (6a), Gateway (6b), Tools (6c), Interpreter (6d)
- Claude Code project scaffolding with auto-sync hooks and module documentation
- Git commit-msg hook to auto-strip Co-Authored-By lines

### Fixed

- CloudFront CachePolicy TTL=0 rejection resolved with managed `CACHING_DISABLED`
- ALB Security Group rules limit with CloudFront prefix list 120+ IPs consolidated to port range
- EC2 UserData Steampipe installation running as root instead of ec2-user
- Steampipe listen mode changed from `local` to `network` for VPC Lambda access
- Gateway Target API structure corrected to `mcp.lambda` with `credentialProviderConfigurations`
- Code Interpreter naming restriction: hyphens changed to underscores
- psycopg2 Lambda incompatibility resolved by switching to pg8000

## [1.0.0] - 2026-03-07

### Added

- AWSops Dashboard with 21 pages and 5 API routes
- Next.js 14 (App Router) with Tailwind CSS dark navy theme
- Steampipe embedded PostgreSQL integration (380+ AWS tables, 60+ K8s tables)
- Recharts metrics visualization and React Flow network topology
- Powerpipe CIS v1.5~v4.0 benchmarks
- AI routing: Code Interpreter, AgentCore, Steampipe+Bedrock, Bedrock Direct
- Bedrock Claude Sonnet/Opus 4.6 integration

[Unreleased]: https://github.com/whchoi98/awsops/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/whchoi98/awsops/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/whchoi98/awsops/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/whchoi98/awsops/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/whchoi98/awsops/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/whchoi98/awsops/releases/tag/v0.5.0
[1.8.1]: https://github.com/whchoi98/awsops/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/whchoi98/awsops/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/whchoi98/awsops/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/whchoi98/awsops/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/whchoi98/awsops/compare/v1.4.0...v1.5.2
[1.4.0]: https://github.com/whchoi98/awsops/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/whchoi98/awsops/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/whchoi98/awsops/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/whchoi98/awsops/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/whchoi98/awsops/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/whchoi98/awsops/releases/tag/v1.0.0

---

<a id="korean"></a>

# 한국어

이 프로젝트의 모든 주요 변경 사항은 이 파일에 기록됩니다.
이 문서는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 기반으로 하며,
[Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 따릅니다.

**작성 규칙:** 기능별로 실제 사용자에게 보이는 최종 동작을 서술하며, 카테고리별로 기능당 1개 항목만 둔다(공유 마이그레이션 목록처럼 여러 기능에 걸치는 인프라/스키마 항목은 별도의 한 줄로 두어도 된다). PR 번호·CI 리뷰 라운드 번호·시도 횟수는 적지 않는다 — 그런 정보는 git 히스토리와 PR 스레드에 남는다. 같은 기능에 대한 이후 수정이 이전 항목을 대체하면 새 항목을 추가하지 말고 기존 항목을 고쳐 쓴다.

## [Unreleased]

### Added


- NFM 관측 근거: 쿼리 응답의 원래 조회 구간·결과 시각·상위 기여자 상한 정보를 캐시 적중 시에도 유지합니다. 독립형 분류 로더는 3개 작업자의 동시 실행과 취소를 지원하며 부분 실패·미확인 구간·고정된 오류 사유를 보존합니다. 로더는 토폴로지 통합 전까지 연결하지 않으며, 조회 구간은 전체 트래픽 수집의 증거가 아닙니다. 기존 읽기 작업과 인증은 유지합니다.
- 배포 의존성 검증: 인증된 요청으로 실제 웹 역할의 계정과 최신 AgentCore SSM 조회를 확인하고, nonce로 연결된 런타임 응답에서 지정 인벤토리 도구 접근·알려진 최신 CloudFront 레코드·제한된 모델 호출의 성공을 검증합니다. 명시적 비공개 런타임 설정을 전달하면 스모크 도구가 수집과 사용자 소유 Lambda·Fargate 완료를 검사합니다. 모든 dev Deploy Web 배포는 비공개 Terraform 계약과 제한된 workload 세션을 사용하며, 읽기 전용 영수증·ECR 증거를 동일 소스 사설 migration 전에 확인하고 검증된 digest를 승격합니다. 정확한 정상 ECS·이미지 검증 다음에는 로그인·DB를 포함한 controller의 전체 런타임 증거가 필수이며 health·로그인·작업 접수만으로 통과하지 않습니다. 빌드 영수증은 실제 성공한 job/attempt에 연결되어 배포만 재시도해도 유지되며, `build=false`에는 `image_build_run_id`가 필요합니다. 이전 이미지 롤백은 스키마 호환 확인 후 DDL 없이 동일한 필수 검증을 수행합니다. controller는 현재 카탈로그의 모든 타입을 최대 4개 동시 수집기로 동기 수집하고, 인증된 수집 원장 전용 조회로 기준 시각 이후의 완전한 성공·확인된 개수·미확인 속성 0개를 요구합니다. 부분·실패·오래됨·누락·미확인 근거는 배포를 차단합니다. 공유된 제한 시간, nonce로 연결된 SSM·런타임·모델 증거와 사용자 소유 Lambda·Fargate 완료도 필수이며, 확인된 경합 재시도는 전체 타입을 다시 검증합니다. 수집 시도와 인벤토리 품질은 비공개 응답을 노출하지 않고 누락 진단을 보존합니다. 수동 collect-runtime은 기존 웹 준비와 전체 검증을 구분합니다. 유료 probe는 관리자·deployment-verifiers로 제한하고 프로세스별 단일 실행·호출 간격을 적용합니다. readiness는 런타임 프로필 대신 전용 CI_READINESS_ENABLED_DEV로 제어합니다. 미설정은 명시적 tfvars·기본 false를 유지하고 true/false는 dev에서 명시적으로 활성화·비활성화합니다. 검토된 적용 시 AgentCore가 있어야 deployment-verifiers를 만들며 멤버십에는 create_demo_user도 필요합니다. 그룹 제거가 기존 12시간 ID 토큰의 권한을 즉시 폐기하지는 않습니다. AgentCore 비활성 시 웹 전용 빈 SSM 경로를 상태 BFF가 존중하며 incident bridge는 변경하지 않습니다. 관리자·IAM 역할은 부여하지 않습니다. 별도 수동 개발 감사는 제한된 세션으로 런타임·수집기 상태, 스케줄 지표와 SQL reader의 개수·시각을 보고하며 전체 준비 상태나 완전한 수집을 확정하지 않습니다. 수집 코드 검증은 설정된 아카이브 해시를 기준으로 하여 이전 공급자 조회 값 때문에 정상 배포를 거부하거나 설정 밖 코드를 승인하지 않습니다. 명시적 전체 dev readiness 계획은 비밀 값을 제외한 제한된 변경 요약을 제공하며, 확인되지 않은 변경은 계속 비공개 검토가 필요합니다.

- 웹 DB 연결 단계 진단: 물리 연결 실패 시 TCP·TLS·IAM 토큰 생성·PostgreSQL 인증의 현재 단계와 단계별 경과 시간만 기록하며, 필수 PostgreSQL/TLS 회귀 테스트로 검증합니다. 선택적 수동 dev 진단에 설정된 인스턴스의 제한된 IAM 인증·부하 지표, ACU 범위와 참고용 서버 lifecycle 텍스트를 추가하며, 빈 조회와 실패를 구분하고 개별 probe 결과는 미확인으로 유지합니다.
- DNS 보류 배포: 같은 브랜치·SHA의 명시적 저장 계획으로 기존 인증서 소유권과 서비스 레코드를 보존하고, 계정 전체 검색 없이 운영자가 지정했거나 이미 연결된 외부 인증서를 검증합니다. 모든 공용·사설 DNS 변경 및 일반 배포의 검증 CNAME 삭제·교체를 차단하고, 빌드 전 ECR 확인과 서비스 DNS 게시 전 Host·SNI를 유지하는 공통 스모크 테스트를 제공합니다. 개발 환경의 필수 검증은 유효 자격증명을 비공개로 평가하고 실제 Cognito 로그인과 인증된 DB 응답까지 확인합니다. 승인된 런타임 활성화는 CI 대상 계정을 검사하고 사설 DNS를 소유 런타임 리소스로 제한하며 인벤토리·워커 이미지 고정과 저장 계획에 결합된 Lambda asset 검증을 제공합니다. 이 검사만으로 수집 성공을 확정하지 않습니다. 기존 암호화 아티팩트 검토는 실행·SHA와 서명된 asset을 인증한 뒤 보호된 파일로 렌더링합니다. 명시적 plan/apply 실패는 인증된 시도별 복구를 지원하는 제한된 암호화 로그 끝부분을 보존합니다. 평문 임시 파일 없이 표준 입력으로 암호화하며 업로드 성공이 확인된 경우에만 로컬 암호문을 삭제합니다. 자식 프로세스는 AWS STS 자격증명을 유지하되 GitHub 명령 채널과 Terraform 로그·인수 환경변수를 제외하며, Linux에서 첫 취소는 정상 종료를 요청하고 두 번째 취소는 프로세스 그룹을 종료하며, 캡처 부모가 종료되면 Terraform도 종료합니다. 원문 대신 고정 진단 분류·작업 수를 보고하고 명령 종료 상태와 apply gate는 변경하지 않습니다. 수동 저장 계획은 비공개 버전 관리·SSE-KMS 저장소에 게시하고 암호화 전달 파일을 안전한 참조로 대체합니다. 운영자는 CI 키 없이 IAM·KMS로 검토하며, 적용에는 검토한 계획 해시와 기존 자산 HMAC·소스 검증이 필요합니다. Deploy Web은 읽기 전용 이미지·서비스 사전 검증 후 통합 이미지 승격 진입점을 사용하며, 검증된 프로젝트·다이제스트를 유지하고 게시 전에 재사용 경로의 보관된 영수증, 현재 소스 dev 배포의 마이그레이션 증거, 이전 이미지 롤백의 스키마 호환성 확인을 검사합니다.
- Private DB migration runtime: RDS TLS 검증·메모리 내 자격증명·빈 DB의 원자적 일회성 초기화·불변 baseline/ULID checksum을 제공합니다. 연결·자격증명 오류 원문을 노출하지 않으면서 migration 감사 notice와 복구 안내를 보존합니다. reader output 조회 실패·동기화 활성 상태의 롤 부재·elevated reader 속성·연결 및 정리 오류는 migration과 배포를 차단합니다. 모든 웹 migration은 `AUTOMATIC_MIGRATION=1`을 강제하고 전체 미적용 집합을 검사합니다. 원장이 없으면 자동 초기화 전에 거부하며, 빈 DB bootstrap·과거 SQL·미지원 SQL은 검토된 별도 migration과 reader 동기화를 먼저 완료해야 합니다. 경합은 즉시 실패하고 잠금은 reader 동기화까지 유지합니다. 웹 배포 검증은 읽기 일시 오류를 제한 시간 안에서 재시도하고 종료된 배포 실패를 빠르게 진단하며 쓰기는 재시도하지 않습니다.
  수동 Build Development Runtime Image(`build-runtime-images.yml`) 워크플로는 Steampipe/worker ARM64 이미지를 빌드하고 전체 런타임 계획에 사용할 digest를 검증합니다. 내보낸 이미지의 실제 config 검증·플랫폼별 업로드로 classic·containerd 이미지 저장소를 지원하며 Steampipe는 Bullseye 패키지 다운로드 대신 checksum을 고정한 ARM64 Python 런타임을 사용합니다.
  기본 비활성 사설 개발 migration 기능은 수동 실행 또는 현재 소스 웹 배포의 보호된 호출로 검토된 ARM64 이미지를 빌드하고 사설 Fargate task 하나를 실행하며 종료 상태·이미지 digest·성공 종료 코드를 확인합니다. 개발 AgentCore는 적용된 `ci_migrations_enabled=true`(`CI_MIGRATIONS_ENABLED_DEV=true`)를 요구하고 사설 migration을 재사용하며 migration·빌드·provisioning 모두 설정 계정 시크릿과 고정 ARM64 digest 검증을 사용합니다. 필요한 백엔드 저장소 ECR 권한 범위를 사전에 준비해야 하며 dev의 검증된 빌드·provision 단계를 동일 역할의 새 세션과 각 1시간 이내 전체 deadline으로 분리하고 digest 기반 provisioning에서는 재빌드하지 않습니다. 제한된 catalog/상태 진단과 실패 종료 코드를 보존합니다. 기존 인증·프로토콜, 알려진 ID 및 Runtime·정리 동작을 유지하면서 Gateway 역할과 Lambda ARN·자격 유형·스키마 차이를 반영합니다. 운영자 소유 CI 배포 역할에는 `bedrock-agentcore:GetGateway`가 필요하며 validation/conflict/not-found 오류를 안전한 코드로 구분하고 API 요청 수락을 readiness로 간주하지 않습니다. 호스트 provisioning은 hash를 고정한 SDK를 비공개 Python 3.12 환경에 설치하고 AWS 설정·이미지 작업 전에 import/API 모델을 검사합니다. 선택 AgentCore smoke는 provisioning 후 실행하며 dev는 producer 기반 readiness를 요구하고 다른 스택은 개발 metadata 부재로 provisioning을 막지 않는 참고용 호환 검사를 유지합니다.
- 비동기 워크로드 관측: 사용자 소유권을 적용한 작업별 접수→최초 워커 시작→종료 시간과 선택 기간의 완료 목표를 제공한다. 대기에는 큐·스케줄링을, 워커 경과 시간에는 재시도를 포함하며 누락·역전된 시각과 잘린 표본에서는 시간·달성률을 확정하지 않는다. 기존 배포는 추가 마이그레이션 전에도 동작하며 새 시간은 미확인으로 표시된다.

- $ 값 도넛 차트가 중앙 합계·범례·툴팁에서 센트(소수 2자리)를 유지 — 달러 반올림이 실존하는 1달러 미만 비용을 0이 아닌 조각 옆에 $0으로 표시하고 인접한 2자리 KPI 타일과 어긋났음; 캡이 있는 분포는 카드 부제로 캡을 공지하고 중앙 수치 라벨도 정직하게 교체(예: EC2 인스턴스 유형 도넛은 합계가 아니라 '상위 10 합계' — 플릿 전체 수는 옆의 EC2 KPI 타일).
- EKS Service Resources 차트 + 노드 네트워크 rate 표기: /eks/services 플릿 페이지에 v1의 'Service Resources' 차트 추가 — 각 Service의 셀렉터를 (클러스터, 네임스페이스) 단위로 Running Pod의 스케줄러 유효 요청량(앱 컨테이너 합과 init 컨테이너 최댓값 중 큰 쪽 + overhead — 노드 바와 동일 산식)과 조인해 'CPU per Service (millicores)'·'Memory per Service (MiB)' top-15 바 2개(요청량/예약 기준이며 실사용량 아님을 캡션에 명시; 셀렉터 없음·매칭 0건 서비스는 0으로 그리지 않고 제외, pods 조회 실패 클러스터는 캡션에 이름과 함께 제외 — 조용한 0 없음); 노드 상세 ENI 트래픽 타일에 평균 rate(B/s–MB/s, pkts/s)를 누적값 아래 병기 — 완결된 직전 1시간 버킷 기준(진행 중 버킷을 3600으로 나누면 정시 직후 ~12× 과소 표시; CloudWatch에 ENI별 차원이 없어 타일은 인스턴스 레벨 유지 — 둘 다 툴팁에 공지).
- Transit Gateway 패리티 완결: TGW 목록에 ASN·DNS 컬럼 추가(ASN은 기존 동기화 컬럼이라 즉시 표시; DNS 컬럼과 상세 패널의 전체 옵션 — DNS/VPN ECMP/멀티캐스트/auto-accept/기본 연결·전파와 해당 라우트 테이블 ID — 은 sync 람다 재배포 후 다음 sync부터 채워지며 그전에는 빈 값), 어태치먼트 테이블에 인라인 Options 컬럼(DNS/IPv6/어플라이언스 모드 — 리전별 VPC 어태치먼트 describe에서 조회) 추가. options는 VPC 어태치먼트에만 존재(다른 타입은 '—', 카드 부제에 공지)하며, options 조회가 거부돼도 어태치먼트/라우트는 그대로 표시되며 누락은 카드 부제에 리전별로 공지('VPC 어태치먼트 아님'으로 오인시키지 않음); options 조회는 페이지네이션을 따르고 모든 불완전 경로 — 페이지 실패(이미 받은 페이지는 유지), 페이지 캡 초과 잔여분, 응답에 없는 VPC 행(예: RAM 공유 크로스 계정) — 를 성공으로 보고하지 않고 불완전으로 공지. 웹 태스크 롤에 read-only ec2:DescribeTransitGatewayVpcAttachments 1종 추가(terraform apply 필요), TGW SDK 커맨드-IAM 매핑을 고정하는 테스트 포함.
- 계정별 리소스 추이 + 파생 보안 카운트 이력화: 일별 인벤토리 스냅샷을 계정별로 기록(sync의 신뢰 계정 집합 기준 — 미도달 계정은 당일 기존 행 보존, 도달했지만 0건인 계정은 진짜 0 기록), 추이 API가 accounts 스코프를 수용(검증된 CSV; `__all__`은 서버에서 self+활성 멤버 계정으로 해석 — 필터를 걷어내지 않음: 무필터 조회는 백필의 'aggregate' 행과 오프보딩된 계정 이력까지 합산)하고 일자·타입별 계정 커버리지를 반환, 홈 추이 차트·수량 변화 테이블·7일 순증감·비용 영향 추정이 계정 선택을 따름 — 가드는 비교 두 시점에서 각 타입의 커버리지가 그 타입이 도달 가능한 스코프와 정확히 일치할 것을 추가로 요구(S3 등 호스트 전용 SDK 수집 타입은 호스트 계정 기준, 나머지는 해석된 전체 스코프 기준 — sync는 타입별로 돌므로 한 계정이 특정 타입 run에서만, 두 시점 모두에서도, 침묵 가능)해, 침묵한 (계정, 타입) 일자나 계정별 이력이 없는 배포 경계는 플릿 변화를 지어내지 않고 KPI·변화 테이블은 '—', 비용 영향 패널은 숨김, 차트는 해당 시점을 공백(라인 갭)으로 표시(공지 캡션 포함); 유효하지 않은 ID로 좁혀진 CSV 선택이나 계정 레지스트리 조회 실패 시의 전체 계정 폴백은 차트 아래에 공지되고, 비용 영향 패널은 자체 조회가 폴백됐거나 차트와 다른 스코프로 해석된 경우 숨김(계정별 이력은 본 배포 이후부터 축적; 스냅샷에는 여전히 리전 차원이 없어 리전 스코프를 좁히면 추이 기반 KPI는 계속 숨김). sync가 파생 보안 시리즈 3종(Public S3 Buckets·Open Security Groups·Unencrypted EBS)을 보안 페이지의 판정 술어 그대로(락스텝 가드) 방금 동기화된 인벤토리에서 COUNT해 이력화 — 변화 테이블 및 차트의 기본 숨김 '보안 시리즈' 토글 그룹(상위 실제 타입 뒤에 항상 추가되어 접근 가능)으로 표시되지만 이중 계산 방지를 위해 일별 total에서는 제외. EKS/K8s 카운트는 의도적으로 미이력화(v2에는 K8s 배치 수집이 없음 — EKS는 온디맨드 라이브 조회; ECS tasks/services는 자체 동기화 타입으로 이미 추이 존재).
- 인벤토리/데이터소스 i18n 완결: 범용 인벤토리 페이지(CloudFront/DynamoDB/WAF 포함 전 타입)와 데이터소스 허브(폼·탭·카드 대시보드·Explore·로그 뷰)의 한국어 UI 문자열이 en/zh/ja로 번역됨 — 미등록 리터럴 17건, 동적 카드/노트 카탈로그(card_catalog 제목, datasource-render 결과 note), 로그 뷰 캡션 패턴, 도넛/차트 제목 패턴을 등록. 도넛 제목은 완전 한국어로 조합해 tt() 1회로 번역(표본 접미사 선번역은 번역 불가한 혼합 문자열을 만들었음), 영문 액션 버튼 2종(Add datasource/Test connection) 현지화. 래칫 테스트가 정적 리터럴 커버리지를 고정(동적 문자열은 등록된 카탈로그와 RULES로 커버 — 완전성 증명이 아닌 회귀 방지 장치). 컬럼/스펙 라벨은 의도적으로 영어 유지.
- 500행 캡 초과 시 전수 집계: 캡에 도달한 인벤토리 페이지가 서버 측 GROUP BY(상태 타일, 분포 도넛, 상태 필터·패싯 드롭다운 옵션, 정확한 총계)를 전체 스코프 플릿 기준으로 조회 — v1은 집계 SQL을 전 플릿에 실행했고 v2의 표본 기반 수치는 500대 초과 시 조용히 부정확했음. 커버리지는 차원별: 클라이언트 파생 값 차원(lambda runtime·dynamodb billing 도넛, ecs_task cluster/cpu/memory 패싯, opensearch 암호화 상태 도넛, msk kafka 버전 패싯)은 표본 유지, 고유값 50개 이상 옵션 목록도 표본 폴백 — 표본 기반 도넛은 모두 '(표본 기준)'으로 자체 공지(종전엔 무표기). 전수 도넛의 '기타'는 플릿 총계 기준으로 계산되어 서버 버킷 캡과 무관하게 합계가 맞음. 집계 호출 1회가 기존 총계용 summary 호출을 대체하며, 테이블·Top-N 바·하이라이트 카드는 의도적으로 표본 유지.
- 데이터소스별 연결 설정: 데이터소스 폼에 Settings 섹션 추가 — 업스트림 쿼리 타임아웃(초 1–60, 기본 10; Prometheus/Mimir는 API timeout 파라미터로 커넥터 HTTP 타임아웃 아래로 캡, ClickHouse는 max_execution_time)과 ClickHouse 기본 database(식별자만, 웹 계층과 커넥터 양쪽에서 HTTP 호출 전 검증) — 인스턴스별로 저장 — ClickHouse 제한은 모든 경로(Explore·서비스 그래프·에이전트/워커)의 상한으로 적용되고(호출자는 더 짧게만 조정 가능; 기본 10초, 커넥터 HTTP 타임아웃을 그 위로 정렬) Prometheus/Mimir 제한은 Explore 경로에 10초 캡으로 적용되며, database는 system/information_schema를 양쪽 검증 계층에서 거부. v1의 결과 캐시 TTL은 의도적으로 미이식(v2 질의 경로는 무캐시 설계), 타임아웃 단위는 ms→초 변경 — 모두 가이드에 공지. ClickHouse의 56–60초 설정은 Lambda 한도 때문에 유효 55초로 단축되며 가이드에서 저장 값과 실제 상한을 구분한다.
- ECS 통합 개요 페이지(/inventory/ecs, 사이드바 ECS 서브그룹의 'ECS 개요'): v1의 한 화면 뷰 복원 — 요약 KPI 밴드(클러스터/서비스 수는 로드된 페이지 기준[500 캡 도달 시 '+'], 태스크 수는 공용 summary, Desired 대비 미달 태스크 타일은 비절단 서비스 페이지에서만 집계 — 표본을 전체 합계처럼 제시하지 않음)와 클러스터·서비스 테이블을 한 화면에 세로로 배치. 각 테이블은 검색/패싯/상세가 있는 타입 페이지로 '전체 보기' 링크(개요는 읽기 전용 글랜스 레이어), 500행 이상은 표본 표기, sync 실패 시 오래된 데이터 캡션, 미수집 시 '미수집' 표시(빈 플릿 조작 없음).
- 대시보드 온디맨드 동기화: 헤더에 관리자 전용 '전체 동기화' 버튼 추가 — 전체 타입 인벤토리 sync를 1회 dispatch(비동기 배치 시맨틱을 그 자리에서 공지 — 큐 등록 확인일 뿐 완료 보장이 아니며 이미 실행 중인 타입은 건너뜀; 관리자 전용·sync 비활성 상태를 일시 오류와 구분해 표시; 데이터는 수 분 후 일반 Refresh로 반영, 낙관적 갱신 없음).
- S3 보안 드릴다운: S3 페이지에 v1의 리전별 버킷 맵(블록 타일 — Public=빨강 > Versioned=초록 > Standard=시안, 플래그 미동기화 버킷은 명시적 Unknown=회색으로 표시해 확정 Standard로 읽히지 않음; 블록 클릭 시 상세 패널, 500행 캡 초과 시 표본 기준 표기; Public 플래그 미상 버킷은 버저닝이 알려져 있어도 Unknown — 거부된 정책 조회가 안심 색으로 가려지지 않음), 버킷 상세에 'S3 접근 권한 보유 IAM Role' 섹션(관리자 전용 — 비관리자에겐 권한 안내 표시; 신규 sync되는 연결 AWS 관리형 정책이 검사 세트[AmazonS3*/AdministratorAccess/PowerUserAccess/ReadOnlyAccess, job-function 경로 포함]에 일치하는 경우 최대 30개 — 다른 정책도 S3를 부여할 수 있어 빈 결과는 검사-세트 한정 문구; 마지막 sync run 상태가 모든 결론을 게이트 — 실패/부분 run에는 오래된 데이터 배너, 빈 결과는 24시간 내 성공·비절단 run에서만 확정(하단에 기준 시각 표기); 500행 표본 표기; 인라인/버킷 정책 경유 접근은 범위 밖임을 명시, 정책 목록 sync 전에는 '미동기화' 안내 — terraform apply + 다음 sync 후 표시; 참고: 정책 목록 하이드레이트 실패(SCP 차단, 또는 전 계정 합산 role 수가 rate-limit 예산 초과) 시 선택적인 연결 정책 열을 제외해 재시도하며(다른 추가 조회는 남아 있어 실패할 수 있음) 기본 iam_role 인벤토리는 유지되고 이 섹션만 '미동기화'로 표시(run은 degraded freshness로 공개) — 이 경로의 run 전체 failed·전 계정 last-good 동결은 기본 쿼리까지 실패한 경우이며 그 외 최종 run 상태는 통상 sync 라이프사이클을 따름 — ADR-010 개정의 공지된 시맨틱) 추가.
- 그룹 비용 차트: ECS Tasks 페이지에 v1의 Cost by Service 차트(클러스터 스코프 서비스별 CPU vs Memory 일일 비용 분해 — 공용 추정 상수 사용, FARGATE 한정 상위 10, 500행 캡 초과 시 표본 기준 표기; EC2 태스크는 추정 불가로·서비스 없는 태스크는 그룹 기준 부재로 제외; 두 $ 시리즈는 하나의 공용 스케일 사용 — CPU vs Memory 비교가 실제 비율 유지), EKS 컨테이너 비용 페이지에 Node별 일일 비용 + Pod 수 차트(페이지 자체의 OpenCost 노드 할당 + pods 목록, 신규 fetch 없음, 비용 내림차순; 비용 상위 15개 + 개수 표기 제목; 귀속 안 된 pod가 하나라도 있는 클러스터는 그 노드들의 Pod 값을 '—'로 표시 — 불완전 귀속에서는 표시 수치가 과소집계일 수 있으므로 절대 확정 숫자로 그리지 않음) 추가 — 신규 멀티 시리즈 그룹 바 프리미티브 기반, v1 이중 축의 시리즈별 자체 스케일 대체는 혼합 단위 시리즈에만 적용(값 라벨이 실제 수치/단위 표기, null 값은 빈 트랙과 '—').
- 상세 드릴다운 퀵윈: Bedrock 모델 상세 패널에 선택 기간 기준 모델별 호출/토큰 시계열 차트(API가 모델별 series를 합산에 버리지 않고 보존; 빈 시리즈는 '시계열 데이터 없음'), ElastiCache 상세에 연결된 보안 그룹별 인바운드 규칙 전개(RDS 드릴다운 섹션/라우트 재사용 — 동기화 인벤토리만 사용, 라이브 AWS 호출 없음, 미동기화 SG는 'not synced'), EBS 볼륨 상세에 실측 라이브 메트릭(기간 합계 환산 Read/Write IOPS·Queue Length·Burst Balance — 최신값 + 1시간 스파크라인, 공용 라이브 메트릭 계약) 추가.
- WAF/EKS 퀵윈: 신규 sync 인벤토리 타입 2종 — WAF Rule Groups(scope 도넛, WCU 용량 바)·WAF IP Sets(IPv4/IPv6 분포, 주소 수 — addresses 필드 부재는 0이 아닌 미상) — Security 그룹 개요의 타입별 카운트 타일에 합류(v1의 waf 3-KPI 페이지는 그룹 개요 + 전용 타입 페이지 구조로 대응; terraform apply + 다음 sync 후 표시); EKS 컨테이너 비용 페이지의 잔여 한국어 하드코딩 문자열 번역 적용(제목/부제/추정 배너/빈 상태/검색 placeholder 4개 언어 등록); EKS 노드 플릿의 Total Memory 타일에 allocatable + reserved% 힌트(allocatable 미보고 시 생략) 추가.
- 드릴다운/온보딩 퀵윈: S3 버킷 상세에 Tags 섹션(버킷별 태그 신규 sync — 태그 없음은 '—', 권한 거부 버킷은 미표시; terraform apply[신규 읽기 전용 IAM 권한 + sync 람다 zip] 후 다음 sync부터 표시), EKS 노드 드릴다운 Pods 테이블에 Pod IP·Service Account 컬럼('-'=미상), /eks 페이지에 접근 불가 배너(클러스터는 등록됐지만 라이브 K8s 데이터를 하나도 읽지 못할 때 — 클러스터별 실패 원문과 언어별 docs 사이트 EKS 개요 가이드 링크 표시) 추가.
- 컴플라이언스 완료 이메일: 벤치마크 실행이 성공적으로 완료되면 벤치마크명·scope·전체/통과/실패 건수·통과율·/compliance 링크가 담긴 best-effort SNS 이메일 발송 — AI 진단 알림의 토픽·플래그·관리자 일시중지 스위치를 재사용(중지/미설정이면 조용히 생략, 메일 실패는 실행 결과에 영향 없음), 벤치마크당 60분 1건 제한(재실행 재발송 방지), 실행별 내구 배달 레코드(compliance_runs notified_at/notify_outcome 신규 마이그레이션, agent 읽기 뷰 재투영; ADR-013 개정으로 기록).
- ECS Tasks 페이지: 접이식 '비용 계산 근거' 패널 — Daily $/Monthly 추정의 Fargate 단가표와 수식을 추정기가 실제로 쓰는 동일 상수로 렌더링(deriver가 공용 cost-basis 소스를 import하도록 변경), 계산 예시와 주의사항(FARGATE launch type 한정, 임시 스토리지 미반영, 고정 단가, ×30 월 추정) 포함.
- 홈 대시보드: '월 비용 영향 추정' DIVERGING 바 차트(공유 0축 기준 서명 바 — 증가는 warm 극, 감소는 positive 극, 대칭 스케일, 30일 수량 델타는 보조 수치 — 넓은 화면은 인라인, 좁은 화면은 눈에 보이는 둘째 줄(title 툴팁은 터치에서 뜨지 않음); 비정상 값은 $0을 지어내지 않고 '—'; 색상쌍 색각 안전성 검증 CVD ΔE 라이트 13.9/다크 12.2 — 목표 8 이상, 모든 바에 서명된 값 라벨) — 30일 리소스 수량 변화 × 타입별 정적 단가 휴리스틱, |영향| 내림차순 상위 8, 청구 데이터가 아닌 근사임을 명시; 전용 35일 계정 스코프 추이 조회로 기본 화면에서도 표시, 완전히 제거된 타입의 절감도 포함, 최신 스냅샷이 오래됐거나 리전 스코프가 좁혀졌거나(스냅샷에 리전 차원 없음; 계정 스코프를 좁히면 해당 계정의 변화량으로 산정) 기준일에 있던 가중치 타입이 최신일에 누락(부분 sync fan-out)이면 숨김, 30일 기준값·단가 항목 없는 타입은 $0로 표시하지 않고 제외.
- 차트 퀵윈(컴플라이언스/S3/서브넷): Compliance 페이지에 v1의 Alarms by Section 막대 차트(pass-rate 목록과 동일한 클라이언트 롤업 기반 섹션별 Alarm 건수 — 0건 섹션은 막대 없음, 전부 통과 run은 차트 생략), S3 페이지에 Security Status 플래그 바 차트(Policy Private/Policy Public/Versioned/Logging 플래그별 버킷 수 — 신규 generic 독립 플래그 spec 옵션; Policy 막대는 버킷 정책 기준만 측정(전체 노출 판정은 Security 페이지 몫), 정책 없는 버킷은 Policy Private로 집계(두 S3 인벤토리 타입이 동일 시맨틱 공유), 미상(권한 거부) 버킷은 어느 쪽에도 세지 않으며, 새로 sync에 추가된 버킷 정책 공개 플래그가 다음 sync로 채워지기 전에는 Policy 막대를 0/0으로 그리지 않고 숨김), Subnets 페이지에 VPC별 서브넷 수 카운트 바 추가.
- 보안/토폴로지 퀵윈: Security 페이지에 v1의 Security Issues Summary 막대 차트(이슈 클래스별 1개 막대 — 4개 점검의 발견 건수 + ECR 스캔 상세에서 합산한 CVE Critical/High; 0건 막대는 제외, 전부 0건이면 차트 자체를 생략)와 최초 조회 중 명시적 로딩 표시(데이터 도착 전 0값 타일/빈 차트가 이상 없음처럼 보이던 문제 해소) 추가; 요청 흐름 토폴로지 페이지에 종류/health 색상 범례(현재 그래프에 존재하는 종류·타깃 health 상태 칩, 다크 모드 대응) 추가, 인프라/K8s 맵 범례에 카드 상태 점(ok/warn/bad/neutral) 설명 추가.
- 차트 퀵윈: ElastiCache 페이지에 v1의 Node Type Distribution 카운트 바를 차트 밴드에 표시(엔진 도넛과 같은 화면)(신규 generic 카운트 분포 spec 옵션), OpenSearch 페이지의 두 번째 도넛을 파생 Encryption Status(Full/Partial/No, 시맨틱 색상 — 한쪽이라도 미상인 도메인은 미암호화로 세지 않고 제외)로 교체.
- 상세/컬럼 퀵윈: IAM 역할 테이블에 Description 컬럼, Lambda 테이블에 사람이 읽는 Code Size 컬럼(상세 패널도 원시 바이트 대신 표시), Lambda 상세에 레이어별 name:version 목록과 명시적 'Not in VPC' 상태의 Network 섹션, WAF 상세에 원시 JSON 앞에 Allow/Block 기본 액션 표시 추가.
- EKS 비용 페이지: 접이식 '비용 계산 근거' 패널 — OpenCost 실측 vs 요청 기반 추정 비교표(5개 비용 항목), 추정기가 실제로 계산에 쓰는 동일 단가 상수로 렌더링되는 수식(단일 소스 — 문서 숫자가 계산과 어긋날 수 없음), 계산 예시, 주의사항(Fargate형 단가, Spot/RI 할인 미반영, 요청≠사용량, Network/PV/GPU는 OpenCost 설치 시에만).
- 비용 페이지 퀵윈: 일평균·전월 총액 KPI 타일 + 서비스 타일의 'N개 >20% 증가' 서브텍스트, 로드는 성공했지만 데이터가 0건일 때 중립적 데이터 없음 배너(온디맨드 가용성 확인 버튼 포함; Cost Explorer 온보딩 안내는 호스트 계정에서 'not_enabled' 판정이 확인된 경우에만 표시 — 활성화 후 표시까지 최대 24시간), 서비스 테이블의 일평균 정규화 임계값 색상 변화율 셀(>20% red, >0 orange, <0 green; 기준월 없는 행은 '—'로 표시하고 마지막에 정렬)과 점유율 미니 바 + 실제 숫자 정렬 — 공용 메트릭 테이블 크롬(검색·표시/전체 카운터·문제만 토글)이 함께 적용되고 모바일은 카드 대신 가로 스크롤로 전환.
- 상세 패널 렌더링 퀵윈: EBS attachment에 DeleteOnTermination 플래그(설정 시 — 인스턴스와 함께 볼륨 삭제), EBS 상세에 암호화 판정 배너(green+KMS 키 / red+암호화 사본 권고; 미상은 표시 안 함)와 마지막 sync 시점 미연결 볼륨의 유휴 비용 힌트(스냅샷 기준 명시), ECS 클러스터 settings를 raw JSON 대신 라벨–값 행으로 렌더링.
- 인벤토리 퀵윈: CloudFront 테이블에 Name 컬럼(태그 파생), CloudTrail 테이블에 Last Delivery (UTC) 컬럼(가장 최근의 성공한 배달 시각 — 실패 신호는 상세의 배달 오류) + 상세 패널에 CW Logs 역할과 CloudWatch Logs/다이제스트 배달 시각·오류, 로깅 중지 시각(다음 sync 실행 후 표시), ECR 테이블에 Encryption 컬럼(타입 값 그대로 — AES256/KMS/KMS_DSSE 등) 추가.
- AI 진단: 리포트/다이제스트 이메일의 관리자 일시중지 스위치(Aurora 설정 1행 — 배포 없이 중지; 다이제스트 실행을 걸친 일시중지 동안 완료된 리포트는 토픽 미구성 때와 동일하게 이메일에서 제외되며, 설정 조회 실패 시 발송 쪽으로 fail-open) + 인쇄용 리포트 뷰(새 탭 흰 배경 A4 — 커버 블록, 번호 앵커 목차, 섹션별 page-break, 인쇄/닫기 버튼)를 기존 PDF 내보내기와 함께 제공. 합성 사례 평가 CLI로 근거 일치·판단 유보·커버리지·지연·확인된 비용을 측정하며, 모델 실행은 명시적 선택이고 합성 사례 결과는 운영 정확도가 아니다.
- 리소스 타일 마이크로스탯 서브라인(/inventory/g 카테고리 페이지와 대시보드 홈 타일 — 하나의 공유 맵에서 렌더링되어 두 표면이 드리프트하지 않음): 타입별 상태 분해 — EC2 running/stopped, Lambda 런타임 수(컨테이너 이미지 함수는 'custom'으로 집계)·>300s 타임아웃, EBS 총 GiB·미암호화, RDS Multi-AZ/미암호화, ECR scan-on-push/immutable, S3 public/versioning off, IAM no-MFA, SG open-ingress, CloudFront enabled, VPC 서브넷·NAT·TGW 구성, 그리고 ECS services/tasks·WAF rule groups/IP sets 크로스 카운트; 대시보드 EKS 타일에는 라이브 ready 노드/파드/디플로이 서브라인 추가 — 등록된 모든 클러스터가 응답하고 계정 스코프가 전체일 때만 표시(fleet 조회는 스코프 미적용이라 부분 응답·스코프 선택 시 확정 분해를 지어내지 않음) — 모두 기존 summary 집계·fleet 조회에서 계산(신규 AWS 호출 없음); 로딩 중이거나 집계가 실패하면 서브라인과 상태 판정 모두 0을 지어내지 않고 숨김.
- 컴플라이언스 컨트롤 상세: 슬라이드오버에 Status/Reason/Resource와 함께 컨트롤 description(권고 배경 설명) 표시 — 새 실행부터 컨트롤별로 수집하며, 이전 실행의 행은 설명을 지어내지 않고 '—'로 표시.
- EKS 개요: 접이식 클러스터/VPC facet 필터 — 멀티 선택 클러스터·VPC 칩(VPC 칩에 클러스터 수 표시), 활성 필터 배지, 전체 해제, filtered/total 카운터 — 클러스터 카드와 하단 fleet 패널을 함께 좁힘. 공통 읽기 API는 빈 결과에도 설정된 리전을 명시하고 최대 25개 클러스터 조회 뒤 추가 페이지가 있는지 보고하며, 기존 배열 소비자는 그대로 호환됩니다.
- EKS 노드 fleet 페이지: 노드별 3분할 용량 바(Requested / Available / System-Reserved, CPU·메모리) + 'avail X | rsv Y' 캡션; 스케줄러 요청 합계는 클러스터별 pods 조회로 계산하며, pods 조회가 실패한 클러스터는 0으로 조작하지 않고 '요청량 미상'으로 표시; 종료(Succeeded/Failed) 파드는 모든 표면(fleet 목록·개요 노드 바·노드 드릴다운)의 요청 합계에서 스케줄러 예약과 일치하도록 제외(native-sidecar init 요청은 미집계 — 알려진 후속 과제), 40개 초과 시 저하 데이터 행 우선 → 압박 큰 노드 순으로 표시하고 잘림을 명시.
- EC2 진단 테이블: Private IP 컬럼 추가, 행 클릭 시 24시간 네트워크 패널 슬라이드인 — 시간별 NetworkIn/NetworkOut 차트(KST 축) + Total In/Out(24h) 타일, 인스턴스의 계정·리전 스코프 적용; 누락 시리즈는 0을 만들지 않고 '데이터 불가'로 표시.
- RDS 상세 패널: 연결된 각 보안 그룹의 인바운드 규칙 체이닝 — 프로토콜, 포트 범위, 소스 칩(설명 포함 CIDR, 참조 SG, prefix list; 전체 인터넷 소스 강조) — 동기화된 보안 그룹 인벤토리에서 해석하며 라이브 AWS 호출 없음; 인벤토리에 없는 그룹은 '규칙 없음'이 아닌 '미동기화'로 표시.
- OpenSearch 인벤토리 sync에 상세 컬럼 8종 추가(서비스 소프트웨어 업데이트 가용성, 로그 퍼블리싱, 엔드포인트 HTTPS/TLS/커스텀 엔드포인트 정책, Auto-Tune, 스냅샷 시각, 고급 옵션, 액세스 정책, 업그레이드 상태) — 상세 패널에 읽기 쉬운 필드로 표시, 다음 sync 실행 후 반영.
- EC2 인벤토리: 차트 밴드에 최신 CloudWatch CPU 기준 인스턴스 Top 15 바 차트(Name 태그 라벨, 없으면 인스턴스 ID) — 인벤토리 리전별로 배치 GetMetricData를 호출해 fleet 전체를 순위화하고, 같은 배치가 fleet 평균 KPI 카드도 공급.
- OpenSearch 상세 패널: cluster_config/EBS/VPC/암호화 원시 JSON 블롭을 구조화된 섹션으로 대체 — Dedicated Master, Zone Awareness, Warm/Cold 스토리지, Multi-AZ Standby, EBS 볼륨 한 줄 요약(타입·크기·IOPS·처리량), VPC/서브넷/SG 목록, KMS 키, 고급 보안 플래그 배지(파생되지 않는 필드를 위해 고급 보안/Cognito 원시 블롭은 계속 노출).
- ElastiCache/OpenSearch/MSK 상세 스파크라인 + Lambda 메모리 히스토그램(v1 패리티): 라이브 메트릭 상세 패널에 스펙 메트릭별 최근 1시간 5분 단위 스파크라인 블록 추가(포인트 ≤2개는 Avg/Max/Min 폴백, 시리즈 부재는 '데이터 불가'; trends=1 계약의 bounded read-only GetMetricData 1회 — 리소스의 계정·리전을 그대로 전달), Lambda 페이지에 기존 Top-N 바 옆 메모리 할당 히스토그램(메모리 크기별 함수 수, 상위 10개 숫자 정렬 — 신규 generic 스펙 옵션) 추가.
- RDS 인스턴스 상세 시계열(v1 패리티): RDS 슬라이드오버에 추이 블록 3종 추가 — v1 6개 메트릭(CPU·여유 메모리·커넥션·Read/Write IOPS·여유 스토리지)의 최근 1시간 5분 단위 스파크라인(포인트 ≤2개는 오해를 부르는 2점 선 대신 v1 Avg/Max/Min 폴백, 시리즈 부재는 '데이터 불가'), 여유 메모리 24시간 추이, CPU 14일 일별 추이(각각 Avg/Max/Min 타일 포함). read-only GetMetricData 2회 병렬 호출(스파크용 ~65분 윈도우 + 장기 추이용 14일 윈도우 — Period는 윈도우가 아니라 해상도), opt-in `trends=1`은 추이만 반환 — 기존 `?id=` 응답 형태와 소비자는 그대로; IAM/Terraform 변경 없음.
- 홈 대시보드 추세 퀵윈(v1 패리티): 리소스 추세 차트에 Core Resources(상위 5종, 기본 표시)/Other Resources(기본 숨김 — 기본 뷰가 기존 8라인에서 5라인으로 바뀌며 숨긴 3종은 칩 클릭 한 번으로 복원; 토글해도 라인 색상은 고정) 그룹의 시리즈 토글 칩 추가, 인라인 요약 KPI 바(추적 리소스 타입 수 · 전체 리소스 · 7일 순증감 ± 색상 — 스냅샷 2개 미만, 델타 테이블과 동일한 ±2 캘린더일 허용 범위 내 스냅샷 부재, 유일한 기준점이 최신 스냅샷 자신인 경우[동기화 지연], 리전 스코프 축소 시(스냅샷에 리전 차원이 없어 리전 스코프된 총계와 스코프되지 않은 증감을 한 줄에 섞지 않음; 계정 스코프 축소 시에는 해당 계정의 순증감을 표시), 그리고 두 비교 시점의 스냅샷 타입 구성이 다른 경우(엄격 패리티 — 부분 동기화 일자에 대한 어떤 diff도 플릿 변화로 위장된 동기화 아티팩트이므로) 0을 지어내지 않고 '—') 추가. 인접한 리소스 수량 변화 테이블도 동기화 일자가 없는 타입을 Current 0/−100%로 지어내지 않고 '—'로 표시.
- EBS 볼륨 상세 드릴다운(v1 패리티): 볼륨 슬라이드오버에 연결된 EC2 인스턴스 enrichment 카드(동기화된 인벤토리의 Name/타입/상태 배지 — 동기화에 없는 인스턴스는 상태를 지어내지 않고 id + 'inventory에 없음'으로 표시)와 해당 볼륨의 스냅샷 서브리스트(최신 20개: id · 용량 · 암호화 배지 · 날짜, 상한 표시와 '이 볼륨의 스냅샷 없음' 빈 상태 포함)를 추가. 이미 동기화된 행에 대한 순수 Aurora 교차조회(계정 스코프 BFF 라우트 1개 신설) — 신규 AWS 호출 없음.
- 소규모 v1 패리티 스윕: CloudTrail 이벤트 행 클릭 시 상세 슬라이드오버(이벤트 ID/리전/소스 IP/유저 에이전트/액세스 키/에러 코드, 이벤트의 모든 리소스, 그리고 **관리자 전용**(저장소의 신원 데이터 게이팅 관례와 일치)의 프로젝션된 raw 이벤트 뷰 + 액세스 키 — userIdentity는 선별된 신원 속성으로 축소되고 request/response 파라미터 내 자격증명 계열 키는 정규화된 deny-list로 재귀 마스킹(CloudTrail 자체 민감 필드 마스킹 위의 defense-in-depth — 완전성 보장은 아님); 동일한 LookupEvents 호출, 신규 AWS 표면 없음); CloudWatch 알람 기본 정렬을 worst-first로 — 행 캡 이전 SQL에서 적용되어 발화 중 알람이 항상 페이지에 포함(ALARM → INSUFFICIENT_DATA → OK, 최신 상태 변경 우선 — 컬럼 헤더 클릭 정렬은 그대로 우선); 인벤토리 '총 N' 타일·페이지 부제목·필터 총계·리스크 히어로 총계가 500행 fetch 캡 도달 시 실제 DB 카운트를 사용하며(현재는 타입별 집계 엔드포인트가 공급 — 위 전수 집계 항목 참조), summary 엔드포인트(홈 대시보드도 호출)가 이미 전달받던 리전 스코프를 이제 실제로 반영해 리전 축소 시 랜딩 페이지 카운트/스플릿도 함께 축소됨; Lambda 행의 최종 수정일 포맷 + null 런타임을 'custom'으로 표시(컨테이너 이미지 함수 — 테이블·도넛·패싯·상세 일치); Bedrock 페이지에 '사용 모델' KPI 타일(선택 기간 내 실제 호출된 모델 수; 30d 범위는 ~2주 지표 탐색 윈도우를 표기) 추가.
- AI 진단 생성 UX 퀵윈(v1 패리티): 생성 중 mm:ss 경과 타이머와 섹션별 체크리스트 그리드(완료/대기 2단계, UI 언어로 표시 — 워커가 progress JSONB에 추가로 스트리밍하는 `completed` 목록 기반; 동시 렌더 특성상 진행 중 섹션 텔레메트리가 존재하지 않아 스피너는 의도적으로 제공하지 않음; 이전 형식의 진행 중 행·카탈로그 드리프트 시 기존 진행 바 뷰로 폴백), 완료 리포트에 통계 바(섹션 수 · 소요 · 리포트 ID — 소요는 종료 시점에 기록되는 신규 `finished_at` 컬럼[추가 마이그레이션 1건] 기반; 값이 없는 레거시 행은 소요를 생략하고 절대 임의 산출하지 않음), 빈 상태에 Deep 티어 태그가 붙은 전체 섹션 범위 프리뷰, 완료된 히스토리 행에 인라인 MD/DOCX 다운로드 링크(리포트를 열지 않고 즉시 다운로드) 추가.
- AI 진단 패리티 배치(v1 패리티): 완료 리포트를 접을 수 있는 섹션 카드 + 고정 목차 사이드바(클릭 시 해당 섹션으로 스크롤) + 본문 키워드 기반 섹션별 심각도 아이콘(점수가 아닌 표시 휴리스틱임을 명시; 섹션 헤딩이 없는 리포트는 기존 연속 뷰 유지)으로 렌더링; 리포트 생성 언어 선택(한국어/English/中文/日本語 — UI 언어 기본값, 수동 실행·스케줄 모두 적용; 언어가 실행 dedup 키에 포함되어 같은 시간대 언어 전환 시 이전 언어 리포트를 재사용하지 않고 새로 실행; 롤링 배포 호환을 위한 레거시 dedup 키 read 폴백이 이번 릴리스 한정으로 포함 — 다음 릴리스에서 제거); 자동 진단 스케줄에 KST 상세 설정(매주/격주 요일, 매월 1–28일, 실행 시각)과 최근 실행 시각 표시 추가 — 미설정 필드는 기존 주기-간격 동작 유지; 구독자 패널에서 관리자가 테스트 알림을 발송 가능(기존 진단 토픽 한정 SNS publish 1건 — web 태스크 최초의 관리자 전용 `sns:Publish`; 발송 실패는 조용한 성공이 아니라 에러로 표시).
- 인벤토리 KPI/차트 퀵윈 배치(v1 패리티): EC2에 실행 중 총 vCPU 타일(인스턴스별 `cpu_options` 코어×스레드 — 타입 기본값이 아닌 실제 vCPU), RDS에 총 할당 스토리지 타일, Lambda에 장기 타임아웃(>300s, danger)·평균 메모리 타일, EBS 볼륨에 암호화율 타일(100% → accent, <80% → danger) 추가; ECS 클러스터는 일반 상태 타일 대신 전용 KPI 밴드(ACTIVE 수·실행 태스크·활성 서비스·컨테이너 인스턴스)를 표시; ECR 행에 Scan on Push 컬럼 추가(스캔 설정 누락/파싱 불가 시 API 기본값인 No로 집계); CloudWatch 알람 상태 도넛은 크기순 팔레트 색 대신 고정 시맨틱 컬러(초록 OK / 빨강 ALARM / 회색 INSUFFICIENT_DATA)를 사용.
- 데이터소스 Explore/관리 패리티 배치: 8개 커넥터 타입 전부에 큐레이트 예제 쿼리·자연어 프롬프트 칩, Loki 전용 로그 스트림 뷰어(타임스탬프·라벨 배지·스크롤 패널), 7d/30d 기간 프리셋(kind별 API 상한: prometheus/mimir는 커넥터가 업스트림 `timeout`을 전달하는 조건으로 30d — 커넥터 변경은 `terraform apply`로 배포되므로 30d 의존 전 apply 필요; Loki는 7d; 5000-포인트 밀도 캡 유지), 결과 메타데이터 바(행/시리즈 수 · 실행 ms · 쿼리 언어 · 형태), NL→쿼리 생성 후 닫을 수 있는 "AI 생성됨" 배너, 관리 탭 KPI 타일과 수동 새로고침 버튼, kind별 DEFAULT 데이터소스 행의 "AI로 진단" 딥링크(챗 도구 경로가 kind별 default를 해석하므로 default 행·지원 kind 한정, 섹션 고정 프롬프트로 `/assistant?q=` 컴포저 프리필 — 검토 전용, 자동 전송 없음), Tempo/Jaeger 트레이스 결과의 비례 duration 바 추가.

- 데이터소스 상세 페이지에 사전 생성 카드 대시보드 추가: 등록 시(및 일일 인덱스 배치마다) 캐시된 스키마로부터 예상 카드 세트를 도출하고 각 카드가 사용할 쿼리를 미리 저장(신규 `datasource_dashboard_cards` 테이블 + 인덱스 워커의 결정론적 `card_catalog` — prometheus/mimir는 타깃·CPU·메모리·디스크·로드·네트워크·컨테이너·재시작을 포괄하는 13종, loki 2종·tempo 2종·clickhouse 2종) — ready Prometheus/Mimir 카드는 등록 전에 해당 데이터소스에서, 페이지가 실제 실행할 instant/range 툴 그대로 라이브 검증하며(확정 PromQL 오류 — 응답 본문 기반, 단순 HTTP 4xx 아님 — 는 해당 카드만 비활성화하고 다음 일일 실행에서 재검증, 일시적 커넥터 장애·재수집 실패·카드 요구 메트릭을 판정할 수 없는 절단 스키마는 모두 기존 카드 세트 보존; 커넥터 metric-metadata 툴에는 확정 `exists` 플래그와 업스트림 3초 제한 추가) — 카드 빌드는 기존 datasource-index 잡 내부에서 실행되므로 diag-signal 칩과 동일하게 `datasource_diagnosis_enabled` 게이트(기본 false; `workers_enabled`/`agentcore_enabled`/`integrations_enabled` 선행) 하에 동작 — 페이지가 저장된 쿼리를 기존 read-only 쿼리 API로 조회 시점에 라이브 실행해 렌더링(stat/시계열/테이블 카드, 미충족 카드는 누락 항목과 함께 비활성 표시, 실패 카드는 조용한 0이 아니라 인라인 에러로 표시).
- 토폴로지 인프라 페이지에 컬럼형 맵 뷰 2종 추가 — 5컬럼 인프라 리소스 맵(External | VPC | Subnet | Compute | NAT)과 클러스터별 K8s 맵(Ingress → Service → Pod → Node — in-cluster 조회 경로가 host 스코프라 host 계정의 connected 클러스터만 대상) — 고정 컬럼 ReactFlow에 실제 엣지 연결선을 그리는 그래프로 렌더링되며, 클릭 교차 하이라이트·검색 하이라이트·색상 범례 포함. 기존 인벤토리/EKS 조회와 기존 read-only `/api/tgw` 라이브 어태치먼트 조회(호스트 계정 스코프 한정·최대 20개 — 미조회 시 UI에 표시)를 사용하며, 서버 측 추가는 read-only `ingresses` in-cluster kind 1종뿐.
- FinOps 기본 권장 엔진 추가(ADR-020, ADR-012 확장, `finops_baseline_enabled`): 일별 Fargate 배치가 룰 카탈로그(공개 요율표 기반 미사용 EBS 볼륨; Compute Optimizer 기반 EC2/RDS rightsizing)를 `inventory_resources`/Compute Optimizer에 평가 — 이 저장소엔 CUR/Athena 비용 파이프라인이 없어 금액은 공개 요율표 또는 Compute Optimizer 자체 추정치로만 산출되며 절대 발명되지 않음. Cost Explorer/Cost Optimization Hub/Budgets 기반 룰은 이번 버전에서는 호출되지 않고 카탈로그에 향후 확장으로만 등록됨. 결정론적 엔진이 판정·금액을 소유하며(별도 우선순위 필드는 아직 없고 금액순 정렬만 있음), LLM은 한국어 설명만 덧붙이며 확정 금액과 다른 달러 금액을 말하면 폐기됨. 오탐 가드(보호 태그, Compute Optimizer 관측 기간 부족, 인벤토리 데이터 staleness)는 항목을 숨기지 않고 `needs_review`로 강등. 룰 평가 실패가 더 이상 정상 실행처럼 보이지 않도록 `finops_runs.status`에 `partial` 상태를 추가해 API/카드에 노출하며, 실패한 룰의 기존 finding은 그대로 보존됨. finding은 계정/리전으로 스코프됨(`inventory_resources`가 여러 계정/리전을 아우르므로 resource_id만으로는 식별이 불충분). read-only — 신규 AWS-변경 경로 없음. `ec2_rightsizing`/`rds_rightsizing`은 Compute Optimizer를 워커 호스트 리전(리전별 엔드포인트)에서만 호출 — 각 finding의 evidence에 `coverage:"host-region-only"` 마커를 명시해 단일 리전 결과를 계정 전체로 표기하지 않음. `/cost`에 새 섹션 추가(`GET /api/finops/findings`); ADR-012/terraform 드리프트 수정(`cost-optimization-hub:*`가 문서화됐지만 실제로 부여된 적이 없어 FinOps MCP의 Cost Optimization Hub 툴이 ADR-012 이후 상시 `AccessDenied`였음). **알려진 문서/DB 불일치(여기서 고칠 수 없음):** 관련 마이그레이션 3건의 `-- since: 0.8.0` 헤더는 오래된 값이다 — `[0.8.0]`이 2026-08-19에 컷될 때 FinOps는 아직 존재하지 않았다 — 하지만 그 마이그레이션들은 이미 main에 병합돼 체크섬이 불변이라, 이미 적용한 어떤 환경에서든 `make migrate`를 깨뜨리지 않고는 헤더를 고칠 수 없다. 이 항목은 (사실에 맞게) `[Unreleased]`에 남긴다 — `schema_migrations.app_version`의 해당 3행은 계속 `0.8.0`으로 남는다.
- SG Rules 페이지 추가(`/network/security-groups/rules`, `sg_rule_activity_enabled`, 기본 false) — 기존 Usage 분석(`[0.8.0]` 아래)과는 **별개의, 추가적인** 파이프라인이며 이를 대체하지 않는다. 룰 인벤토리(룰 id/fingerprint/버전 히스토리)는 설정된 보안 그룹에서 도출하고, 룰별 일일 트래픽 근거(`observed_compatible`/`overlapping`/`no_observed_evidence`/`unassessable`/`not_configured`)는 Fargate 워커(`sg_rule_scan.py`)가 ENI-SG 멤버십 스냅샷을 Athena로 조회한 VPC Flow Logs와 매칭해 계산 — 격리된 브로커 Lambda(`sg_rule_athena_broker.py`, ADR-019 Role B)를 통해서만 이루어지며, 이 브로커만이 대상 계정의 `AWSopsSgRuleAthenaRole`에 `sts:AssumeRole`할 수 있다; 브로커는 opaque한 `flow_source_id`로부터 계정/테이블 설정을 서버 측에서 직접 해석(caller가 넘긴 쿼리/계정을 절대 신뢰하지 않음)하고 모든 식별자를 엄격한 allowlist로 재검증하며, workgroup이 자체 `BytesScannedCutoffPerQuery`를 강제하도록 요구한다. 한 플로우가 여러 룰에 매칭될 수 있음; 파티션-projection 인지 워터마킹과 일별 SKIPDATA/절단 커버리지 플래그는 이 앱의 다른 곳과 동일한 정직한 강등 원칙을 따름 — 불완전하거나 귀속 불가능한 날은 확신에 찬 거짓 0이 아니라 `unassessable`로 표시. **계정/리전 간(cross-account/cross-region) VPC 피어링·RAM 공유 참조의 SG-참조 해석은 이번 릴리스에서 실제로 동작하지 않는, 명시적으로 남겨둔 갭이다**: 현재 피어링/RAM 토폴로지 데이터 소스가 없으므로, 현재 계정/리전의 ENI 멤버십 스냅샷 어디에도 없는 참조 SG는 확신에 찬 빈 매칭이 아니라 `unassessable`로 처리된다 — 해당 데이터 소스는 향후 별도 변경에서만 채워질 수 있다. 매칭은 **일(day) 단위이며 개별 플로우 단위가 아니다**: `sg_rule_inventory_versions`의 `valid_from`/`valid_to`는 (룰이 실제로 바뀐 시각이 아니라) 그 fingerprint를 처음/마지막으로 관찰한 스캔 실행 시각이므로, 버전 경계로부터 이전 성공한 스캔까지의 실제 간격 이내에 있는 날은 어느 한쪽 형태로 확신 귀속하지 않고 마찬가지로 `unassessable`로 표시한다(아래 "Fixed" 참조).
- Network Path Check 페이지 추가(`/network-paths`, 최상위 nav 항목, `network_path_check_enabled`, 기본 false): 출발지/목적지 체크(ENI, SG, 서브넷 라우트, NACL, TGW, 피어링/VPN/DX 경계, Network Firewall, ALB 리스너/타겟그룹 헬스, K8s NetworkPolicy/Calico/Cilium/Istio-stub 계층, DNS/L7)를 정의하고 Fargate 워커(`network_path.py`, resolve → discover → verify → conclude)로 실행 — 개별 레이어 평가에서는 데이터가 없거나 모호할 때 확신에 찬 거짓 `allowed`/`blocked`를 절대 만들어내지 않고 그 레이어를 `unknown`/`conditional`로 반환한다. **이는 레이어 단위 보장이며, 아직 전체 경로(full-path) 단위의 보장은 아니다**: 모든 레이어가 여전히 주로 source 쪽만 검사하므로, ENI가 확인되지 않는 피어링/TGW/VPN/DX 경유 목적지나 ALB/NLB 대상(대상 자체의 SG는 `target-group` 이후 별도로 검사하지 않음)의 경우 경로 전체 결론이 전체 양방향 정책 표면보다 적은 근거로도 `allowed`로 보고될 수 있다 — `network_path.py`의 "Known structural gap" 문서 참조. **`fetch_live_topology`는 이제 실제 구현이다** — 캐시된 Aurora 토폴로지(`topology_nodes`/`topology_edges`, `class='infra'`)로부터 best-effort 후보 경로를 탐색한다(이 항목이 원래 기술했던 `NotImplementedError` 스텁이 아님), 다만 run 시점의 실시간 AWS/Kubernetes 재조회는 여전히 의도적으로 미구현이라 `web/app/api/network-paths/[id]/runs/route.ts`의 새 run 생성 경로(`POST`)는 여전히 `networkPathLiveTopologyCapabilityGate()`(`web/lib/network-path-gate.ts`)로 게이트되어 503(`status: "unimplemented"`)을 반환한다; 기존 체크 정의와 과거 run 히스토리는 계속 조회 가능하다. `LIVE_TOPOLOGY_IMPLEMENTED`는 그 별도의 실시간 재조회 경로가 실제로 추가될 때까지 `false`로 유지된다. Calico·Route 53·K8s Ingress→Service→EndpointSlice는 이제 (이미 가져온 데이터를 대상으로) 실제 평가기를 갖췄고, Cilium/Istio는 여전히 (추측하지 않고) 정상적으로 `unknown`으로 스텁 처리되어 있다. `resolve_identities()`는 여전히 저장된 체크 정의 자체의 필드에서 Pod/Node/ENI identity를 읽지만, `cluster`를 선언한 `pod`/`node` 소스는 그 identity를 정의의 필드를 이미 검증된 것으로 신뢰하는 대신 라이브 read-only K8s/EC2 조회(`resolve_live_identity`)로 추가 확인한다. 룰 인벤토리 행에도 자신의 `vpc_id`가 노출된다.
- 인벤토리 sync: 쿼터 안전 수집 — Steampipe 플러그인 rate limiter(env 조절), 내구성 freshness 원장(last_success_at·partial 상태·unknown_attribute_count 공개), 내용 보존형 partial 런, 인벤토리 MCP 도구의 타입별 freshness 노출. 선택적 호스트 가드는 STS·레지스트리 범위를 검증하고 일시적 식별자 조회 실패를 제한된 횟수로 재시도하며, 범위 거부 시 비정상 종료하고 동시에 진행된 재시작도 수집을 되살리지 못하게 합니다. NULL로 기록된 미확인 속성 범위는 healthy가 아닌 degraded로 공개하며, 수집 시각이 같아도 전체 키로 정렬하여 페이지 간 행 중복·누락을 방지합니다. CloudFront ID 정확 조회는 identity-only 한 행을 명시하여 반환하며, 미발견은 AWS에서의 부재 증거가 아닙니다. 빈 Steampipe 조회는 고정 버전의 계정별 식별 테이블에서 요청 계정과 일치하는 한 행을 확인하며, 확인 실패 시 마지막 정상 인벤토리를 보존하고 partial 상태를 유지합니다. 검증된 dev 프로필은 비밀 값이 아닌 선택적 `CI_STEAMPIPE_AWS_FILL_RATE_DEV` 변수로 전체 Plan의 refill rate만 덮어쓸 수 있으며, 미설정 시 tfvars 또는 기본값을 사용하고 Apply는 검토된 계획을 재사용합니다. (ADR-021) sync 결과·원장·계정 스냅샷의 개수는 실제 저장된 계정·리전·리소스 식별자를 기준으로 하며 마지막 행의 값을 보존합니다. hydrate 폴백의 미확인 속성 개수도 같은 저장 식별자 기준을 사용한다.
- 위 세 기능을 지원하는 신규 DB 마이그레이션 6건: `sg_rule_activity`(flow source/룰/룰 버전/일별 활동/스캔 run 테이블), `network_path_check`(check/run/step 결과 테이블), `network_path_runs_error`(`network_path_runs`에 nullable `error` 컬럼 추가 — 실패한 run이 그 이유를 남길 곳이 없었음), `sg_rule_inventory_vpc_id`(룰 인벤토리에 `vpc_id` 컬럼 추가 — 룰이 속한 VPC를 노출), `inventory_sync_freshness`(`inventory_sync_runs`에 run_token·last_success_at·last_success_row_count 추가, status CHECK에 'partial' 확장, `sql_reader.inventory_sync_runs` 뷰 재생성 — error/run_token 계속 제외), `inventory_sync_unknown_attrs`(테이블과 리더 뷰에 unknown_attribute_count 추가).

### Changed

- 구성 토폴로지 근거: EKS/ECS 후보는 독립적인 범위 확인과 활성 Pod 또는 RUNNING 태스크 근거를 요구합니다. Succeeded/Failed Pod와 STOPPED/DELETED 태스크는 재사용 IP를 점유하지 않으며 미확인 상태·참조 충돌은 확정하지 않습니다. 같은 리전·VPC의 여러 클러스터에서 같은 IP가 나오면 이름이 같아도 보류합니다. 읽을 수 없는 확인된 범위의 IP를 차단하며 EKS 범위 미확인이나 열거 제한 시 전체 소유권을 보류합니다. 저장된 계정 범위와 세대·취소 검증, 같은 계정의 이전 그래프 유지 안내를 보존하며 완전한 빈 결과는 교체합니다. 모든 인벤토리·이름 보강 조회는 로드마다 두 실행 경로를 공유하고 중요 타입은 각 경로에서 순차 페이지 조회(20 × 500행)를 수행하며 브라우저의 30초 제한을 유지합니다. 페이지마다 한 SQL 문으로 읽은 행·원장의 스냅샷 표시와 동일한 전역 수집 버전을 요구하고, 소유권 판단에 브라우저·DB 시계 비교를 쓰지 않습니다. 집계 수집 상태·조회 실패·계정별 미확인을 구분합니다. EKS는 정확한 호스트 범위에서만 조회하며 멤버·전체 범위의 미조회 사유를 표시합니다. 미연결 클러스터는 조회 실패 대신 cluster_not_connected로 구분하되 해당 범위의 소유권은 계속 보류하고 리전 메타데이터를 검증합니다. 인벤토리는 계정 범위를 사용하며 실제 행 상한은 설정값에서 계산하고 불완전한 첫 페이지를 전체 상한으로 표시하지 않습니다. 수집 시각 범위와 Refresh의 최신성 표시는 원본·허용된 최근 성공 시각을 사용자 시간대로 사용하므로 오래된 데이터를 다시 조회해도 새 데이터가 되지 않습니다. 캐시 대상 이름, 대상 그룹 전용 targetCapturedAt 및 SQL 투영 한계를 유지하며 AWS 변경이나 투영·권한 변경은 없습니다.
- 런타임 IAM 축소는 dev 프로필과 무관하게 main을 포함한 기존 활성 스택의 다음 Terraform apply에 적용됩니다. 웹 SSM 세 파라미터·런타임 조회/토큰 동작·자체 클러스터 태스크 제어·Claude 모델만 허용하며 알려진 리전(이후 opt-in 포함)을 읽기 조건에 포함합니다. 호스트 전용 계정 등록은 외부 계정을 HTTP 409로 거부하고 dev 호스트 모드는 검증된 프로필을 요구합니다.

- 보안 그룹 사용 분석 페이지를 `/inventory/security_group`에서 별도의 최상위 페이지 `/network/security-groups/usage`로 이전 — 내장된 `SgAnalysisSection` 컴포넌트 자체의 동작/IAM은 변경 없으나, 새 페이지 자체는 관계 그래프·고정 24시간 hits 요청·Rules 페이지 링크를 추가로 포함한다. 범용 inventory-type 페이지에서 분리되어 신규 SG Rules 페이지와 같은 `security-groups` 라우트 그룹에 위치한다.

### Fixed

- Tempo 쿼리 생성: 수집한 속성 범위와 HTTP 상태·서비스 이름 관련 네 가지 속성의 관측된 값 타입을 보존하고, 이전 캐시의 태그도 유효한 비한정 TraceQL 속성 문법으로 전달하며, AI 초안을 반환하기 전에 Grafana TraceQL 파서로 검사(오류 시 한 번 수정)한다. 개수·시간 제한은 유지하면서 스키마 조회의 stale-value 조기 종료를 사용하지 않고, 가상 내장 필드를 분리하며 범위가 있는 v2 태그 값 조회와 레거시 대체 경로를 지원한다. 생성된 사용자 속성·리터럴 타입·명시적 HTTP 상태 필터를 검증하고, 속성별 타입 표본의 제한을 표시하고, 잘림 정보만 있는 이전 캐시의 타입은 보수적으로 처리하며, 속성명 수집 제한과 타입 표본 제한을 구분한다. 정상적인 빈 관측은 1분의 짧은 캐시 TTL을 적용하고 Grafana·Tempo API를 통한 과거 조회 또는 내장 필터를 이용한 최근 조회를 안내하며, 불완전한 빈 결과는 재수집하고 트레이스 부재 대신 수집 실패를 알린다. Tempo 카탈로그는 수집 성공 여부만 의존하므로 해시에서 스키마 내용을 제외하되 카탈로그 버전·생성 플래그 변경은 계속 반영하고, 관리자 스키마 GET/POST 요약은 사용자 속성 개수와 수집·타입 제한을 표시한다. 확장 메타데이터 적용에는 Tempo 커넥터 Lambda 배포와 스키마 새로고침이 필요하고 게이트웨이 도구 설명 갱신에는 AgentCore 프로비저닝이 필요하며 [Tempo 쿼리 생성 런북](docs/runbooks/tempo-query-generation.md)에 절차를 설명한다.
- 트레이스 서비스 맵: 서비스 식별자는 데이터소스·계정·리전·환경·네임스페이스·클러스터별로 분리하고 비동기 span link와 식별 가능한 브로커/큐 관계를 보존한다. 동일한 큐 ARN은 같은 데이터소스·환경 안에서 호출자의 계정·리전을 넘어 연결하지만, writer·API·SQL/AI 읽기는 보존된 행도 destination ARN의 한정자에서만 계정·리전 claim을 재계산한다. 비-ARN·잘못된 ARN·누락 한정자는 null이며 호출자·레거시 폴백은 없다. 화면은 claim 값과 미검증 텔레메트리 고지를 함께 표시하며 AWS 큐 소유권이나 인벤토리 연결을 증명하지 않는다. DB 호스트 매칭에는 기존 계정 부재·`self` 분기에 신뢰된 설정 `HOST_ACCOUNT_ID`와 명시적 계정이 일치하는 새 분기를 추가한다. Tempo의 선행 0이 생략된/64비트 hex ID를 전체 OTLP 바이트와 연결하고, 0 부모 ID는 부재로 처리하되 0 trace/span ID는 거부한다. 실패·부분 수집·정상 빈 결과·오래된 데이터를 API·화면·AI 읽기 뷰에 표시하고, 수집 실패 시 이전 그래프를 보존하며 호출량을 신뢰도 확률로 표현하지 않는다. 수집 패널은 원본 상세를 접고 높이를 제한하며 원본 조회 구간과 노드·엣지 누락 및 인벤토리 미가용 정보를 표시한다. 메타데이터 부재는 수집 실패가 아닌 미확인으로 처리한다. 그래프 게시 시점은 설정된 수집 주기로, 인벤토리 원본 시점은 공유 인벤토리 임계값과 원본 작업 성공 근거로 각각 판단한다. projection 마이그레이션(`make migrate`)과 기존 Terraform 운영 절차를 통한 `inventory_read_mcp` 재배포가 필요하며 [적용·식별 계약](docs/runbooks/source-sync-observability.md)을 참고한다. 그래프 조회는 풀당 두 요청까지만 허용하고 연결 획득도 제한 시간에 포함하며 정규화·직렬화 전에 연결을 반환하고 행 한도·조회 실패를 수집 결과와 구분한다. 저장된 원본 시각·상태를 표시하고 레거시 단일 계정 행 시각은 표시용으로만 유지한다. 명시된 수집 투영·조회 인덱스 마이그레이션과 웹 환경설정을 별도로 적용해야 하며 [그래프 조회 계약](docs/runbooks/graph-read-contract.md)을 따른다. reader는 인벤토리 writer 활성화를 가정하지 않고 flow/infra 메타데이터를 지원한다. 빈 그래프 게시에는 명시적인 원본 수집 완료 근거가 필요하며 완료 표시가 없는 레거시 빈 응답은 미확인으로 남기고 이전 그래프를 보존한다. 연결된 producer는 응답 형태·한도·경고를 검증하여 완료 표시를 계산하며 Tempo 검색 ID에 대응하는 span을 받지 못하면 불완전한 결과로 유지한다. 한도·경고가 있어도 유효한 데이터가 있는 조회는 부분 스냅샷을 갱신하고, 미확인 빈 응답이나 누락·실패한 자식 데이터가 있으면 저장된 그래프를 보존한다. Tempo 검색 기본 한도는 20으로 고정하며 한도 도달은 부분 결과로 유지한다. 진단의 partial/unknown은 조회 오류 대신 불완전성 표시와 관측 건수를 보존한다. 이 계약을 적용하려면 검토된 배포 절차로 연결된 producer Lambda와 진단 worker를 갱신해야 한다.
- AI 진단 근거: 누락·실패·부분 관측을 정상 또는 개선으로 판정하지 않는다. 유효한 0·관측된 위반 테스트는 정규화된 평가기 계약을 검증한다. 현재 진단 수집기는 X-Ray `to_ref`만 제공하고 `to`와 `inventory.unencrypted` 집계는 제공하지 않으므로, 필요한 근거를 연결하기 전까지 운영 edge·암호화 불변식은 `unknown`으로 남는다. 보고서에 평가 범위와 미평가 판정을 저장하고 Intended vs Actual의 건수·사유를 결정론적으로 렌더링하며, 화면·내보내기에도 같은 범위를 표시한다. 평가 기록이 없는 과거 보고서는 평가 정보 없음으로 구분한다. 누락된 incident 신뢰도는 보수적으로 처리하며 PDF 렌더러의 외부 리소스 요청을 차단한다.
- FinOps 도구: Compute Optimizer 응답의 자원별 권장·절감액 필드를 실제 SDK 계약에 맞추고 미확인 절감액과 실제 0을 구분한다. 조회 누락·오류·통화 불일치가 있으면 완전한 합계를 만들지 않는다.
- ENI 구성 증거(`network-mcp`): 보안 그룹별 200행 제한과 잘림 표시 안에서 피어와 IPv6/ICMP 세부 정보를 보존하고, 확인된 서브넷 또는 VPC 기본 연결에서만 라우트 테이블을 선택하며, `local`을 임의로 만들지 않고 실제 조회된 라우트 타겟을 유지한다. 불완전한 증거를 `partial`/`unknown`으로 노출하고 SG 조회 실패·잘림·누락을 해당 그룹 ID에 귀속하며, 그룹별 완전성을 표시해 미평가 빈 배열과 규칙이 없다고 확인된 그룹을 구분하면서 성공한 조회의 증거를 보존한다. 최초 ENI SDK 조회 실패는 민감한 오류 세부 정보를 제거한 비성공 증거로 반환하며, 라이브 도구 카탈로그와 네트워크 프롬프트는 불완전한 증거만으로 부재나 연결 성공·실패를 단정하지 않도록 명시한다. 적용하려면 Terraform 운영자 절차로 `network-mcp` Lambda를 재배포하고, 네트워크 프롬프트를 위해 AgentCore Runtime을 재배포하며, v2 프로비저너로 Gateway 도구 설명을 갱신해야 한다.
- Explore 자연어→PromQL 생성이 데이터소스의 전체 캐시 메트릭 목록에 ADVISORY 앵커링됨: 없는 이름(예: 대상에 없는 recording rule ':node_memory_MemAvailable_bytes:sum')은 직전 답을 보여주고 근사 스키마 이름을 제안하는 1회 교정 재시도를 거치며, 그래도 남으면 해당 토큰을 명시한 **경고와 함께 초안을 반환**(캐시가 절단/오래된 경우 오탐 가능성을 문구에 명시) — 하드 오류가 아님: 토크나이저와 캐시 둘 다 틀릴 수 있고 런타임 권위는 커넥터; 프롬프트는 스키마에 없는 ':' 형식 recording-rule 이름을 금지하고 라벨 불일치 벡터 연산을 피하도록 보강. 한국어 요청도 올바른 메트릭을 프롬프트 상위로 배치(큐레이션된 한국어→메트릭 용어 사전 — '메모리 사용률'이 node_memory_*/container_memory_*를 앞으로; 종전엔 한국어 요청이 순위 용어 0개라 알파벳 앞부분이 프롬프트를 채웠음), Prometheus/Mimir 스키마 캐시가 알파벳 앞 500개에서 3000개 메트릭으로 확대(kube-prometheus 스택은 구 캡 너머의 node_*/kube_* 계열 전체가 빠졌음 — 구 캡 스냅샷으로 보이는 캐시는 백그라운드에서 재수집(쿨다운 제한), 크기 초과 스키마는 모든 캐시 기록 경로에서 저장 안 됨 대신 축소 저장), 미지 이름 전부의 raw 코어가 캐시에 있는 recording-rule 오기는 캐시가 절단돼도 교정(결과에 검토 메모 유지). ADR-018 §D(라이브·초안 전용 경로)로 기록, BASELINE 동시 갱신.

- EKS 비용 요청 기반 추정: 폴백의 RAM 비용이 사실상 모든 파드에서 $0.00이던 버그 수정(MiB 단위 메모리 요청을 바이트로 간주해 1e9로 나눔) — 메모리가 GiB 기준으로 반영되어 추정 파드 비용이 그만큼 상승.
- 라이브 메트릭 표시: ElastiCache `CacheHitRate`는 0–1 비율로 도착하므로 실제 백분율로 표시(0.92 → 0.9%가 아닌 92%), AWS/ES가 메가바이트로 보고하는 OpenSearch `FreeStorageSpace`를 바이트로 간주해 1e6으로 나누던 표시 오류(최신값 그리드에서 약 100만 배 과소표시) 수정; OpenSearch 쿼리가 소유 계정의 `ClientId`를 전송해 멤버 계정 도메인이 조용한 '데이터 불가' 대신 데이터를 반환.
- SG Rules & Usage(`sg_rule_activity_enabled`): Athena/Glue flow-log 매칭 경로가 이제 확신에 찬 오답을 내거나 모든 스캔을 영구 거부하는 대신 안전하게 강등된다. 계정/리전 스코핑은 Glue 파티션 키와 테이블 컬럼의 합집합에서 해석되며(`account-id` 같은 하이픈 별칭도 인식), Athena SQL 파티션 predicate는 진짜 date/timestamp 타입 카탈로그 컬럼에 대해 올바른 타입 리터럴(`DATE '...'`/`TIMESTAMP '...'`)을 사용하고(순수 문자열 리터럴을 쓰면 타입 오류로 매 스캔이 실패함), Glue `GetPartitions` 존재 확인은 — 미묘하게 다른 Expression 문법을 쓰므로 — 항상 식별자를 double-quote하고 순수 문자열 리터럴만 사용한다(타입 리터럴을 쓰면 Glue가 호출 자체를 거부할 위험이 있음); 양쪽 모두 2일 {D, D+1} 윈도우로 확장한다(`timestamp` 타입 키에는 half-open 범위)(Hive의 전달-시각 파티셔닝이 어떤 날의 플로우를 다음날 파티션 파일에 넣을 수 있음). `partition_projection` 전략은 두 시점에서 검증된다 — 저장 시점에는 단일 날짜 키가 `type=date`+`format=yyyy-MM-dd`를, Hive `year/month/day` 레이아웃이 세 키 모두 `type=integer`(month/day만 `digits=2` — Athena의 무-패딩 기본값이 이 모듈의 zero-padding된 쿼리 리터럴과 맞지 않기 때문)를 요구하고, 선언된 `range`가 존재해야 하며 이미 만료가 확인된 닫힌 리터럴 날짜 범위가 아니어야 한다; 스캔 시점에는 스캔 대상 날짜를 `NOW±N<unit>` 전체 문법으로 검사하고 경계를 확실히 해석할 수 없으면 거부한다 — 두 시점이 함께 "`status: valid`로 검증되지만 실제 스캔마다 오류나거나 거짓 0을 내는" 결함 부류를 끝까지 닫는다. 이 검사들이 도입되기 전에 검증된 소스는 다음 run에서 자동으로 self-heal(브로커 자체 응답 형식으로 재검증·저장)하며, 재검증 자체가 실패하면 stale 데이터로 스캔하는 대신 run을 거부한다(`awaiting_validation`). `observation_lag`(일자 경계 불확실성 윈도우)는 고정된 명목 주기가 아니라 마지막 성공한 스캔까지의 실제 간격에서 도출된다.
- Network Path Check(`network_path_check_enabled`): "데이터가 없거나 모호할 때 확신에 찬 판정을 만들어내지 않는다"는 레이어별 원칙이 이제 실제 평가기 전반에서 지켜진다. Calico 정책 평가는 실제 Calico v3 `Rule` 스키마를 따른다 — `action`은 필수 필드이며(누락되거나 인식되지 않는 action은 Allow로 가정하는 대신 확신 판정을 무효화함), 포트/프로토콜은 올바른 `source`/`destination` EntityRule에서 읽고(숫자형 IANA 프로토콜 값 포함), 이 어댑터가 모델링하지 않는 룰/정책 레벨 필드(negation, ICMP/HTTP 매처 등)는 계속 늘어나는 deny-list 대신 allowlist로 걸러내며, `order`는 — 이 어댑터가 여전히 정책 간 우선순위를 모델링하지 않으므로 — 보수적으로만 모델링돼 매칭되는 Allow와 Deny/Pass 룰이 공존하면 여전히 `unknown`으로 강등된다. SG/NACL/K8s NetworkPolicy 피어 매칭도 손상된 `peer_ip`를 누락된 것과 동일하게 처리하고, 해석되지 않은 `peer_sg_ids`(unknown)와 확정된 빈 `peer_sg_ids=[]`(확신 있는 비매치)를 구분하며, 해석 불가능한 named port나 identity/namespace 확인이 없는 `podSelector`/`ipBlock` 피어에 대해 더 이상 확신 있는 차단으로 판정하지 않는다. Route 53 해석은 CNAME/ALIAS 체인을 올바르게 따라가며(entry name뿐 아니라 매 hop에서 multi-record/weighted-set 모호성을 재검사), 타겟 없는 포인터와 순환을 탐지하고, 진짜 RFC 4592 closest encloser로부터 와일드카드를 합성하며, NS-without-SOA zone delegation을 어떤 조상에서든(조회 이름 자신 포함, payload에 SOA가 전혀 없는 경우까지) 확신에 찬 NXDOMAIN `blocked` 대신 `unknown`으로 인식한다. Ingress→Service→EndpointSlice 해석은 Kubernetes의 실제 host 우선순위(exact > 한-레이블 wildcard)와 path 우선순위(`Exact` > 가장 긴 `Prefix`)를 따르고 참조된 포트를 Service의 선언된 포트와 대조해 검증하며, host가 매칭되는 `ImplementationSpecific`-with-path 룰의 컨트롤러 정의 우선순위를 확신 있게 판단할 수 없을 때는 낮은 우선순위 매치로 넘어가는 대신 `unknown`으로 강등한다. `eval_vpn_or_dx`는 `aws_side_state`와 `route_present` 모두를 3-상태로 다룬다(`None` = 아직 조회 안 됨 → `unknown`, 확인된 down/부재 값과는 구분되어 → `blocked`). 라이브 identity 해석(`resolve_live_identity`)은 체크 정의가 지정한 모든 필드(계정 id, namespace/pod/node/cluster 이름, 리전)를 실제 라이브 AWS/K8s 호출에 쓰기 전에 안전한 문자셋과 레지스트리 기반 external-id 조회로 검증하며; EKS access-entry 등록 스크립트는 AWS 관리형 admin-view 정책 대신 최소 권한 Kubernetes RBAC 그룹을 부여하고 기존 그룹 멤버십을 대체하지 않고 병합하며; 대상 계정 CFN 템플릿(`infra/cfn/awsops-target-account-role.yaml`, ADR-011)은 이제 추가적인 선택 파라미터 `WorkerTaskRoleArn`을 받아 호스트 web task role뿐 아니라 두 워커 자신의 task role에서의 member-account 조회도 신뢰할 수 있게 하며, 적용에는 그 스택의 운영자 재배포가 필요하다(`docs/runbooks/onboard-target-account.md`).
- Direct Connect: AWS 부분 실패를 확신 있는 오답 대신 정직하게 강등 — `/api/dx`에 `degradedRegions` / `metricsDegradedRegions` / `gatewaysDegraded` / 게이트웨이 행 단위 `associationsAvailable` / `totals.gatewaysAssociationsUnknown` 추가. UI는 경고 배너, 영향받는 KPI 타일의 `+`/`≥` 하한 표기, association 조회 실패 시 빨간 "미할당" 대신 "판정 불가" 배지를 표시하고, CloudWatch 쿼리 단위 `StatusCode` 실패(PartialData/InternalError)도 메트릭 강등으로 집계. 성공 응답에서도 근거가 불완전하면 정상·이중화 판정을 보류하며, 관측된 디바이스 메타데이터 누락은 정보 가용성 검사에서 실패로 표시하되 네트워크 장애로 단정하지 않는다. 커넥션 상태 평가는 ConnectionState를 지원하는 `available`·`down`인 dedicated·hosted만 대상으로 하며 deleting·unknown·누락을 포함한 기타 상태는 제외·미평가로 고지한다. 전체 인벤토리의 정상으로 단정하지 않고 상태 근거 누락을 고지한다. API 다운 집계·범위를 명시한 KPI·배포된 커넥션 체크리스트가 같은 분류를 사용하며, 제외된 수명 주기 상태만으로 장애를 만들지 않는다. 제외 커넥션의 명시적 메트릭 0은 중요 기간 관측으로 유지하되 현재 배포 장애와 구분해 표시한다. 그래프 커넥션·로케이션 링크·LAG의 up 집계도 같은 긍정 근거를 사용하며 미확인·미평가 멤버를 별도로 표시한다. 로케이션 요약은 배포된 owned·hosted의 확인된 위치만 세고 기타 상태는 모두 제외하며 두 위치의 검증된 이중화와 미확인 위치를 함께 표시하며, owned 전용 SLA 수치는 별도로 유지한다. 미확인 위치로 SLA 티어를 높이지 않는다.
- PR 리뷰 파이프라인: chair 타임아웃 600→900s + fast-fail 1회 재시도, 코드 우선 3-pass diff 정렬(코드 → decisions/runbooks → docs 산문), 새니타이즈된 좁은 범위의 절단 파일 가드(검증 불가 부재 주장을 삭제 대신 MINOR로 하향). L2–L5의 각 항목에 Codex와 Claude의 완료된 검토를 모두 요구한다. Codex와 Claude 패널의 모든 렌즈에 1200초를 부여하고 전체 작업은 90분으로 제한하며 준비 작업 후 각 모델 단계 직전에 같은 OIDC 역할의 인증을 갱신한다. 패널·종합 판정에서 실패하거나 시간 초과된 CLI 출력은 완료된 검토로 집계하지 않고 강제 종료 유예를 유지한다. 생성 내용을 생략한 lockfile도 변경 메타데이터는 표시한다. SHA 고정 복구 라벨은 커밋을 선택하고, GitHub 보호 환경은 실행 전에 지정 리뷰어 승인을 요구한다. 정확한 환경·브랜치 신뢰 주체가 포괄 PR·저장소 신뢰를 대체한다. 자동 CI 코드는 신뢰된 기본 브랜치 커밋에서, 모델의 검토 맥락은 대상 기준 커밋에서 읽으며 오래된 HEAD의 판정은 게시하지 않는다.

## [0.9.0] - 2026-08-22

### Added

- Direct Connect 페이지에 구성도 + 복원력 평가 추가(aws-samples/sample-network-resilience-agent 참조, 앱의 React Flow 관례에 맞춤): 온프레미스 → DX 로케이션 → 커넥션/LAG → VIF → DX Gateway → TGW/VGW 계층 그래프(dagre 레이아웃, 상태 색상 — 다운 커넥션·BGP 다운 VIF는 빨강, 성능 저하 LAG·미연결 게이트웨이 링크는 주황/점선, 미연결 VIF는 점선), 노드 클릭 시 기존 사이드 상세 패널, AWS Direct Connect SLA 티어(최대 복원력 99.99% = 2개 로케이션 × 각 2개 이상 커넥션 · 높은 복원력 99.9% = 2개 이상 로케이션 · 단일 연결 95%)와 critical/warn 체크리스트(커넥션/VIF 상태·로케이션 이중화·로케이션당 이중 커넥션·미연결 DXGW·미연결 VIF)를 판정하는 복원력 카드 — 페이지가 이미 가진 데이터만 사용, 신규 AWS 호출 없음; 4개 언어 i18n.

## [0.8.0] - 2026-08-19

### Added

- 아이폰/아이패드 홈 화면 앱 설치(PWA) 지원: 웹 앱 manifest(standalone, 루트 스코프) + Apple 메타 태그(apple-touch-icon, apple-mobile-web-app-capable) + 생성 아이콘 4종(180 풀블리드 apple-touch, 192/512 라운드, 512 maskable). iOS는 manifest·아이콘을 인증 쿠키 없이 fetch하므로 Lambda@Edge 공개 allowlist에 등록(3자 lockstep 테스트로 manifest ↔ public/ 파일 ↔ edge allowlist 고정). 노치 기기 안전영역 처리(viewport-fit=cover + 모바일 셸 상/하/좌/우 env() 패딩, 커진 탭바만큼 스크롤 보정), 브라우저 theme-color meta가 런타임 테마(cobalt/teal/dark)를 추적(다크 화면 코발트 틴트 해소). Service Worker는 의도적으로 미도입 — 인증 쿠키 뒤 라이브 운영 데이터는 오프라인 캐시 이득이 없고 iOS 설치에 SW가 필요하지 않음.
- Network Firewall 룰 히트 테이블을 가독성·상호작용 중심으로 재구성: 수제 테이블을 공용 MetricTable로 교체(모든 문자열/숫자 컬럼 헤더 클릭 정렬, 텍스트 검색, 액션 원소 단위 facet, 문제만 토글), 행 클릭 시 표준 사이드 상세 패널에서 룰 상세(SID·룰 그룹·3-state 히트 근거·n/a 사유) 표시, 히트 카운트 그래프 2종 추가 — 액션 분포 도넛은 잘림 없는 액션별 전량 집계 사용(카드 배지와 수치 일치), 룰별 히트 Top 10 바는 top-100 SID 집계 잘림 시 명시 고지 — 도넛과 "룰 히트 없음" 빈 상태 모두 바 차트·조인 테이블과 동일하게 `alertCoverageComplete`를 존중해, 시간적으로 불완전한 구간을 확정치로 표시하지 않음. MetricTable에는 여기서 재사용하는 opt-in prop 3종 추가: 다중값 facet(원소 단위 매칭 — 'blocked' 필터가 'drop, blocked' 행도 포함), 렌더 단계 행 상한(검색·정렬은 전체 행에서 동작, idle 룰 보존), per-row 클래스 훅(idle 룰 디밍 복원).
- Network Firewall 페이지에 stateful 룰 히트 카운트 추가(2026-08 AWS 신기능 — 신규 API가 아니라 기존 Alert 로그 집계 방식임을 API 레퍼런스·최신 botocore·CloudWatch로 검증): Alert 로그 카드가 CloudWatch Logs 대상에서 SID 단위(signature/action은 SID로 미리 합산, 리전별 오버페치 + 100-SID join 컷오프 — 두 절단 모두 정직하게 표면화하고 정확한 값처럼 보이지 않게 표기)로 히트를 집계하고, 설정 stateful 룰 그룹에서 서버 측 파싱한 SID(sid/msg/action/noalert만 — 룰 본문은 여전히 미탑재)와 조인해 기간 내 매칭 0인 설정 룰(정책 사각지대/셰도우 룰)을 표면화 — 단, ALERT 로그가 선택 기간 전체를 커버한다는 추론(로그 그룹 생성 시각/보존기간 기반 — 증명은 아님)이 성립하고, 룰 그룹 자체의 lastModified가 range 시작보다 이전인 경우에만 — 별도로, 조회 범위 내 어느 정책이든 또는 어느 STATELESS 아닌 룰 그룹이든 lastModified가 range 시작 이후거나 `null`(모름, 안 바뀜이 아님)이면 계정 전체 귀속을 불신 처리하고(그 정책/그룹이 *지금* 참조·존재하는 것만이 아니라 — 제거·삭제·in-place 수정된 룰 그룹은 현재 토폴로지로는 열거할 수 없어서다), 로깅 구성 조회가 거부돼 접두사 발견(discovered)으로 찾은 ALERT 로그 대상이 하나라도 있어도 동일하게 처리한다(그 리전의 방화벽·룰 그룹 토폴로지를 확인할 수 없는데 그 히트는 다른 리전과 똑같이 sid로 전역 병합되기 때문). 두 range 시작 비교 모두 브라우저 시계가 아니라 토폴로지·로그 Insights 두 fetch 각각의 서버 생성 시각 중 더 이른 쪽을 기준으로 한다(두 fetch가 독립적으로 캐시되기 때문). `ruleHits` 쿼리 자체가 실패했거나, 어느 리전이든 로그 그룹이 청크 분할됐거나(`alertTopNPartial`), discovery가 unknown이면 조인 표는 생략되고 기존의 raw top-signatures fallback만 표시된다(그 fallback에는 pass/noalert 행이 나타나지 않음) — 위의 join-cutoff·리전별 상한 절단은 이와 다른, 더 약한 경우로 조인 표를 생략하지 않고 그대로 유지하며 해당 행만 `?`/`≥N`으로 표기한다. 그 외 경우, pass 룰과 noalert 룰은 둘 다 Alert 로그를 남기지 않으므로 n/a로 정직 표기, 미파악 SID(관리형 룰 그룹)는 별도 표시, 도메인 리스트 룰 그룹(AWS 내부 생성 SID로 파싱 불가)은 정책이 참조하는 경우 조용히 무시되지 않고 계정 전체 귀속을 오염시킨다. 알려진 미해결 잔여 위험(문서화만 됨): 방화벽이 range 도중 다른 정책으로 전환됐거나 방화벽 자체가 range 도중 삭제됐다면 위 검사를 모두 통과한다(정책/룰그룹과 달리 방화벽에는 API상 lastModified나 "정책 부착 시점" 같은 타임스탬프가 원천적으로 없음) — CloudTrail 감사 로그를 조인하면 닫을 수 있으나 아직 구현되지 않았다.
- `/inventory/security_group` 페이지에 보안 그룹 사용 분석 추가(`/api/sg`): 사용 유무 감지(ENI `Groups` 부착 + 다른 SG가 소스로 상호참조 → 미사용 정리 후보 표면화, 삭제 불가한 default SG는 제외), 룰 소스/목적지 식별(sg 참조는 이름으로, CIDR은 인벤토리 VPC 이름 매칭, `0.0.0.0/0`·`::/0` → 인터넷 전체, `pl-` → 관리형 프리픽스 리스트 이름), 행 클릭 시 SG별 트래픽 **히트 매칭** — VPC Flow Logs(CloudWatch Logs 대상, 기본 포맷 parse; ACCEPT 행만 인바운드 룰에 귀속, REJECT 행은 트래픽 상대로만 표시) 우선, Flow Logs 없으면 NFM 폴백(전 카테고리 top-contributor, 1h 상한)은 트래픽 상대 식별 전용 — NFM은 양방향 바이트 집계라 룰 귀속을 하지 않음(거짓 idle 신호 방지); ENI 없음·조회 실패·Insights 200행/ENI 50개 캡·ICMP type/code·스캔 범위 밖 참조 SG 등 근거가 불완전한 경우엔 hits를 확정 0이 아니라 확인 불가로 강등 — idle 룰 카운트는 실제 매칭 근거가 있는 룰만 반영; 위 인벤토리 표와 동일 리전으로 스코핑(계정은 호스트 고정); KPI 타일 + 부착 리소스 종류 도넛; read-only `ec2:DescribeSecurityGroups`/`DescribeManagedPrefixLists`/`DescribeFlowLogs` IAM(적용됨, terraform lockstep); 4개 언어 i18n.
- Network Firewall 페이지(`/network-firewall`, Network 그룹) 추가: 방화벽/정책/룰 그룹 인벤토리(리전 fan-out) + 선택 기간의 `AWS/NetworkFirewall` 트래픽 집계(수신/통과/드롭/거부 패킷·드롭율 — `(AZ, Engine, FirewallName)` 3차원 메트릭만 합산, `EndpointName` 포함 변형은 동시 발행되어 이중 집계됨; 수신 패킷/바이트는 추가로 Engine=Stateless만 합산 — Stateful 포워딩 트래픽은 동일 패킷의 재발행이라 드롭율 분모가 이중 집계됨), 분석 렌즈 5종 — 보호 설정 off(삭제/서브넷 변경/정책 변경), ALERT 로깅 갭(위협 가시성 없음; 로깅 구성 조회가 거부되면 “확인 불가”로 표시 — “미설정”과 구분, 태스크 롤만 거부되는 SCP류 환경 실측), stateless 기본 액션 `aws:pass`(스테이트풀 엔진 우회), 룰 그룹 용량(생성 후 변경 불가, 80% 이상 플래그)·미연결 룰 그룹(정리 후보), AZ별 엔드포인트/구성 동기화 상태; KPI 타일·타입/용량 차트·방화벽 점검 카드·섹션형 상세 패널이 있는 테이블 3종; 룰 본문(`RulesSource`)은 의도적으로 응답에서 제외; read-only IAM 권한(`network-firewall:List*`/`Describe*` 7개 명시적 액션 — 와일드카드 아님, 적용됨, terraform lockstep); 4개 언어 i18n. owner 모니터링 가이드에 따라 로그·감사 계층까지 포함: TLS 검사 메트릭, Alert 로그 Insights 카드(어떤 규칙(sid)이 무엇을 차단했는지 — Top 소스/목적지, CloudWatch Logs 대상만·로깅 조회 거부 시 접두사 발견 폴백; stateful 룰 히트 카운트는 위에서 별도 서술), Flow 로그 Insights 카드(Top talker·프로토콜 분포), CloudTrail 변경 감사 카드(누가 정책/룰을 바꿨는지, write 우선), 4개 언어 접이식 진단 가이드(지표/로그/보완 소스 + 목적별 우선순위).

## [0.7.0] - 2026-08-05

### Added

- Direct Connect 페이지(`/direct-connect`, Network 그룹) 추가: 커넥션/VIF/DX Gateway 인벤토리(리전 fan-out, 게이트웨이는 글로벌 1회 조회) + `AWS/DX` CloudWatch 분석 — 선택 기간 내 다운 감지(`ConnectionState`/`VirtualInterfaceBgpStatus` 최소값), VIF별 모니터링 수치(평균/피크 Bps, 평균 Pps, 퍼센트로 발행되는 `VirtualInterfaceUtilization*` 메트릭 기반 피크 사용률 — 없으면 피크 bps ÷ 대역폭 폴백(LAG 대역폭 포함), `BgpPrefixesAccepted`/`Advertised` 최신값 — 1G 미만 호스티드 커넥션은 VIF 레벨 Bps만 발행), 2026-07 신규 `ListVirtualInterfaceRoutes` API 기반 BGP 라우트 가시성(수신/광고 라우트의 AS 경로·커뮤니티·설치 시각, VIF당 200건 캡, 미지원 시 정직 강등), 단일 로케이션 단일 장애점을 표시하는 로케이션 이중화 렌즈(Resiliency Toolkit은 2개 이상 로케이션 권장); KPI 타일·VIF 타입/트래픽 차트·섹션형 상세 패널이 있는 테이블 4종; BGP 시크릿(`authKey`, `customerRouterConfig`)은 서버에서 제거되어 절대 응답에 실리지 않음; read-only `directconnect:Describe*`+`ListVirtualInterfaceRoutes` IAM 권한(적용됨, terraform lockstep); 4개 언어 i18n.

## [0.6.0] - 2026-08-03

### Added

- VPC 엔드포인트 페이지(`/vpc-endpoints`, Network 그룹) 추가: 전 리전 엔드포인트 인벤토리 + 분석 렌즈 3종 — `AWS/PrivateLinkEndpoints` BytesProcessed 기반 미사용 Interface 엔드포인트(유휴 엔드포인트도 ENI/AZ당 시간 과금, $0.0126/h 추정치 표기), 보안 시그널(full-access 정책, private DNS off), VPC별 S3/DynamoDB Gateway 커버리지 갭; KPI 타일·타입/서비스 차트·섹션형 상세 포함 facet 테이블; read-only `ec2:DescribeVpcEndpoints` IAM 권한; 4개 언어 i18n.
- aws-data 챗 라우트 추가(v1 패리티): 목록/카운트/구성 질문을 BFF 로컬 핸들러로 라우팅 — codegen 모델로 SQL 생성, 라이브 Steampipe 리스너에서 실행(단일 문장 SELECT 전용 가드, 200행 상한), 오류 시 1회 자기수정, SQL 프리뷰 status frame 스트리밍 후 행 기반 분석 스트리밍; 전 단계 fail-open — Steampipe 불가 시 일반 라우팅으로 degrade, SQL 2회 실패 시 no-live-data 고지와 함께 Bedrock 폴백.
- auto-collect 분석 챗 라우트 추가(v1 패리티): 레지스트리 기반 콜렉터 6종 — idle-scan, eks-optimize, db-optimize, msk-optimize, trace-analyze, incident — 라이브 컨텍스트 수집(Steampipe SQL, CloudWatch, CloudTrail; 누락 소스는 실패 대신 unavailable 표기) + 단계별 status frame과 함께 근거 기반 분석 스트리밍; 전체 수집 실패 시 고지와 함께 Bedrock 폴백.
- container·iac 챗 섹션 활성화: EKS/ECS/Istio 및 CFN/CDK/Terraform 질문이 비활성 안내 대신 해당 게이트웨이로 라우팅(9개 게이트웨이 전부 READY MCP 타겟 보유).
- EKS 플릿 노드 드릴다운 추가: `/eks/nodes` 행에서 개요와 동일한 리치 드릴다운(CPU/Memory 3분할, 노드 내 파드, ENI) 오픈 — 공유 `NodeDrilldownPanel`로 추출(개요도 동일 컴포넌트 재사용).

- `opencost_config` — read-only OpenCost 설치 설정(클러스터별 helm 버전/values)
- `prevention_insights` — ADR-032 Phase 4 교차-인시던트 사전예방 티어
- `eks_registrations` — EKS 런타임 등록(인앱 조회 온보딩; EventBridge 자동등록)
- `worker_jobs.requested_by` — 모든 enqueue에 서버 측에서 유도한 요청자 identity 기록. `GET /api/jobs`(`/[id]`)를
  호출자 본인 작업으로 범위 제한하는 데 사용(2026-07-22 pentest 리포트 후속 조치)
- `worker_jobs` 요청자별 idempotency — 기존 단일 글로벌 `UNIQUE(idempotency_key)`는 그대로 유지한 채,
  그 **옆에** 부분 유니크 인덱스 2개(요청자별 + 내부 enqueue용 NULL-요청자 버킷)를 **추가**(이 PR에서는
  기존 컬럼 제약을 삭제하지 않음). 이번 PR은 2단계 롤아웃 중 Phase 1이며, 옛 글로벌 제약 삭제는 이번
  배포가 안정적으로 확인된 뒤 별도 후속 PR로 의도적으로 미룸(round-5 리뷰: 두 단계를 한 PR에 같이
  실으면 `make deploy`의 migrate-then-roll-out 순서와 경합해 enqueue 장애가 확정적으로 발생)

### 보안

- 소유권 검증이 jobs 뿐 아니라 **진단·컴플라이언스 read 경로**에도 적용된다: `GET /api/diagnosis`(목록),
  `GET /api/diagnosis/[id]`, `GET /api/diagnosis/[id]/download`, `GET /api/compliance/runs`(목록),
  `GET /api/compliance/runs/[id]` 전부 owner-or-admin 게이트를 통과해야 한다. 이전에는 인증된 사용자
  누구나 **다른 사용자의 진단 리포트를 열람·다운로드**하고 다른 사용자의 CIS 컴플라이언스 실행 결과를
  읽을 수 있었다 (EN 섹션에만 있던 항목 — KO/EN 대칭 규약 위반이라 보충)
- `POST /api/jobs`에 인증 요구 + `GET /api/jobs`(`/[id]`)에 소유권 검증 추가. 범용 `report`/`compliance`
  잡 타입은 허용 목록에서 완전히 제거 — 해당 타입은 클라이언트가 넘긴 `report_id`/`run_id`/`requested_by`를
  소유권 검증 없이 신뢰하므로, 범용 라우트로 도달 가능한 상태는 cross-user IDOR 쓰기였음. 이제
  `requestedBy`를 서버에서 계산하는 `/api/diagnosis`, `/api/compliance/run`을 통해서만 enqueue 가능
- idempotency-key 충돌 조회(`lib/jobs.ts`)를 요청자 기준으로 범위 제한 — 예측 가능한 idempotency key(예:
  피해자 이메일에서 파생된 진단 리포트 키)를 알면 다른 사용자의 `job_id`/status를 조회하고 공격자의
  payload를 그 작업에 붙일 수 있었음
- `enqueueJob`이 위의 옛 글로벌 `UNIQUE(idempotency_key)` 제약이 던지는 `23505` unique_violation을
  이제 catch — 이 제약은 `ON CONFLICT`의 arbiter가 아니라서 Postgres가 별도로 계속 강제하며, catch 시
  동일한 요청자 범위 조회로 fallback한다: 동일 요청자의 재시도는 여전히 깨끗하게 dedupe되고, 진짜
  다른 요청자 간의 key 충돌은 opaque `500` 대신 깨끗한 `409`(`IdempotencyKeyCollisionError`)로 실패.
  이는 cross-user idempotency-key 충돌을 **완화**하는 중간 조치이며, 완전한 해결은 위 Phase 1/Phase 2
  노트에 언급된 옛 글로벌 제약 삭제 후속 PR이 나가야 함(PR #195 round-6 리뷰)
- `POST /api/jobs`가 클라이언트가 준 `idempotency_key`를 ledger에 쓰기 전에 `u:<요청자>:<key>`로
  네임스페이싱. Phase 1 동안에는 옛 글로벌 `UNIQUE(idempotency_key)`가 여전히 강제되므로, 그렇지
  않으면 인증된 공격자가 피해자의 결정적 진단 키(`report:<email>:<tier>:<model>:<scope>:<hour>` —
  이메일만 알면 추측 가능)를 이 라우트로 선점할 수 있었고, 그 결과 피해자 본인의
  `POST /api/diagnosis`가 `23505` → 요청자 범위 복구 조회 무소득 → `409` + `markReportFailed`로
  해당 hour 버킷 내내 진단 불가 상태가 됨. 네임스페이싱으로 선점이 구조적으로 불가능해지고(자기 키와만
  충돌 가능) Phase 2 제약 삭제와 무관하게 **이 PR 안에서** DoS가 닫힘. 서버에서 생성되는 키(진단,
  컴플라이언스)는 이미 요청자 신원에서 파생되므로 변경 없음(PR #195 round-7 리뷰)
- `GET /api/compliance/runs/[id]`가 목록 라우트·`GET /api/jobs/[id]`와 동일한 dual-key(`identity()` +
  raw `sub`) 소유권 검증을 쓰도록 변경 — 기존에는 `requested_by !==` 직접 비교라서, 레거시 sub-키 run이
  목록에는 보였지만 상세 라우트에서는 403이 나는 불일치가 있었음(PR #195 round-6 리뷰)
- `/api/eks/[cluster]/register`가 요청 본문이 크기 상한을 넘을 때 조용히 기본값으로 등록하지 않고 413을 반환
- 이전에는 무제한 JSON을 읽던 여러 라우트에 요청 본문 크기 상한(`readJsonBounded`) 적용
### Fixed

- aws-data 라우트 안정화(fix 4건): Steampipe statement timeout 35초 상향(콜드 멀티 리전 광역 스캔이 기존 15초 초과) + 챗 라우트 `maxDuration` 180초 상향(콜드 스캔 + 자기수정 1회 + 장문 분석 스트림이 60초 초과); codegen 응답의 모든 text 블록 읽기(선행 thinking 블록으로 SQL 파서가 빈 문자열 반환) + codegen `max_tokens` 1024·분석 `maxTokens` 8192 상향(전량 목록 답변 절단 해결); fallback 마커로 시작하는 assistant 턴을 codegen 히스토리에서 제외(오염된 히스토리); SQL 생성·시도별 실패 사유 로깅으로 fail-open이 원인을 숨기지 않도록 수정.
- aws-data 답변의 "데이터 없음" 오판 및 스트리밍 체감 수정: 분석 컨텍스트를 2k자 JSON 슬라이스에서 24k자 예산의 압축 TSV(표시/전체 건수 명시)로 전환, SSE 델타를 적응형 typewriter 버퍼로 방출.
- eks-optimize 콜렉터 수집 전면 실패 복구: Steampipe read 정책에 EKS 액션이 없어 `aws_eks_cluster`가 AccessDenied → 수집 0건 — read-only `eks:Describe*`/`eks:List*` 부여 + 전면 실패 시 leg별 수집 요약 로깅.
- Transit Gateway 조회 전 리전을 인벤토리에서 해석하도록 수정: 기본 리전 클라이언트가 타 리전 TGW에 대해 조용히 빈 결과 반환 — 상세·메트릭 경로가 리전별 클라이언트로 fan-out(리전별 degrade로 부분 결과 유지).

## [0.5.0] - 2026-08-02

**v2 라인**의 첫 릴리스입니다 (v1 1.x 라인과 독립적으로 0.5부터 시작).

### Added

- **플랫폼 — Terraform MSA·비공개 엣지·인증**
  - Terraform MSA로 스택 재구축(ADR-001): 단일 `terraform/foundation/` 루트, partial S3 backend, 모든 대형 기능에 기능 플래그 게이트(기본 false → `plan` = No changes) — CDK 폐기.
  - 완전 비공개 엣지 경로 제공: CloudFront(TLS) → VPC Origin `https-only:443` → 내부 ALB HTTPS:443(리전 ACM) → Fargate `awsops-v2-web`(arm64, 루트 경로 — basePath 없음); 공개 ALB 없음.
  - 엣지 인증(ADR-002): Cognito User Pool + Lambda@Edge RS256 JWKS 검증(iss/aud/token_use) + PKCE public client; 자체 `/login` 폼(BFF `InitiateAuth`가 12h `awsops_token` 발급); Hosted UI PKCE 플로우는 다크 폴백으로 보존.
  - web을 Next.js 14 thin-BFF로 운영 — API 라우트 80개, 무거운 작업은 인라인 실행 없이 큐잉.
  - 비동기 워커 백본 추가(ADR-009): `POST /api/jobs` → `worker_jobs` ledger + SQS → ESM(킬스위치) → 멱등 dispatcher Lambda → Step Functions `$.runtime` Choice → Lambda(짧음) 또는 `ecs:runTask.sync` Fargate(긺/OOM) → status_updater + 5분 reaper.
  - Makefile 배포 플로우 제공: `make configure`(대화형 TUI) / `deploy` / `agentcore` / `workers` / `migrate` / `upgrade`.
- **데이터 — Aurora·마이그레이션**
  - 모든 앱 상태를 Aurora Serverless v2(PG 17.9, 0.5–4 ACU, KMS CMK, RDS-관리 master secret)에 node-pg로 영속화 — v1 `data/*.json` 대체.
  - v2 DB 마이그레이션 프레임워크(`make migrate`): 충돌 없는 ULID 파일, advisory-lock, fail-loud, 버전 스탬프(`app_version` ledger); `make migrate-status`; `scripts/v2/upgrade.sh`(`make upgrade`): RDS 스냅샷 → migrate → 멱등 검증 → deploy(`CONFIRM=go` 아니면 PREVIEW). 이 라인의 마이그레이션: `opencost_config`, `prevention_insights`, `eks_registrations`.
  - flag-gated warm Steampipe Fargate(FDW) + sync Lambda → Aurora 인벤토리 파이프라인(`steampipe_enabled`); `backfill-*.mjs`로 v1 이력 백필.
- **인벤토리 — 리소스 41종**
  - Compute (6): EC2, Lambda, ECS Clusters, ECS Services, ECS Tasks, ECR.
  - Storage & DB (11): S3, EBS Volumes, EBS Snapshots, RDS, DynamoDB, ElastiCache, ElastiCache Replication Groups, OpenSearch, OpenSearch Serverless, MSK, Neptune.
  - Network (17): VPC, Subnet, Route Table, NAT Gateway, Internet Gateway, Transit Gateway, Security Group, Route53 Records, CloudFront, CloudFront VPC Origins, ALB, NLB, Target Group, ALB Listener Rules, API Gateway (HTTP), API GW Integrations, API GW Routes.
  - Security (6): IAM Roles, IAM Users, IAM Policies, WAF Web ACLs, CloudTrail Trails, S3 Public Access.
  - Monitoring (1): CloudWatch Alarms.
  - 전 타입 공통: 라이브 카운트 facet 필터, 상태 SegmentedControl, 타입 맞춤 하이라이트 KPI 카드, 분포 도넛 + Top-N 바, 섹션형 DetailPanel; Lambda EOL 런타임 배지; CloudTrail 이벤트 조회, 요약 + 일별 추세 API(최대 90일), 타입별 refresh(Steampipe → Aurora sync 트리거).
- **EKS 스위트**
  - 클러스터 필터 + 노드 드릴다운 개요; 노드/파드/디플로이먼트/서비스 플릿 페이지(서버측 라이브 집계, 클러스터별 실패는 `reachable:false`로 degrade).
  - K9s 스타일 읽기 전용 in-cluster 탐색기 + 오브젝트 단위 describe(secrets 제외).
  - OpenCost 컨테이너 비용: 클러스터별 저장 설정, 1-day allocation(KPI + 파드별 비용), 설치 번들 다운로드(values.yaml + install.sh, out-of-band 실행), 설치 상태 배지.
  - 클러스터 등록/해제 + Access Entry 상태·온보딩 가이드(Terraform이 Access Entry + AmazonEKSAdminViewPolicy 부여, read-only); 컨트롤플레인 + Container Insights 메트릭; 인스턴스 타입별 ENI IPv4 한도.
- **진단 계층 — 12개 서비스**
  - EC2, RDS, ElastiCache, OpenSearch, MSK(브로커 노드), DynamoDB, S3, EBS, Lambda, ALB, NLB, EKS(계층별: 컨트롤 플레인/노드/워크로드/애드온)의 기간 선택 CloudWatch 메트릭 테이블 제공.
  - 서비스별 접이식 진단 가이드를 UI 4개 언어 전부로 제공; Target Group 헬스 테이블 + TGW 상세 섹션 추가.
- **네트워크 도구**
  - Network Flow Monitor: 라이브 NFM top-contributors 조회(파드 수준 엔드포인트, 1시간 API 한도), End-to-End 홉 경로 시각화, 온보딩 인지형 메뉴 게이트.
  - DNS 쿼리 로그: Route53 Resolver + CoreDNS를 Logs Insights 집계로 분석(RCODE/타입/Top 도메인/NXDOMAIN/소스/방화벽; 지연 공백을 정직 표기하는 리졸버 비교).
  - IP 주소: ENI 기반 IP→리소스 조회(소유자 15+종 분류), 미사용 EIP/미부착 ENI 탐지, EKS 파드 IP 조인.
  - 토폴로지: read-only 그래프 API(flow/infra 클래스, `?from=` 서브그래프) + infra/resource/services 뷰; AWS 콘솔 스타일 VPC 리소스 맵.
- **AI**
  - AI 어시스턴트: 9개 챗 섹션(network/container/data/security/cost/monitoring/iac/ops/observability)에 대한 하이브리드 라우팅(정규식 fast-path + Haiku 분류기, ADR-003) + 교차도메인 자동 합성; SSE 스트리밍(스트리밍 중 마크다운 렌더); 대화 이력(검색, 개별/전체 삭제); 슬래시 메뉴·프리셋 칩·후속 질문 제안·세션 통계 바·플로팅 🤖 런처; Bedrock Sonnet 5 / Opus 4.8 / Haiku 4.5.
  - AgentCore(ADR-004): 9 섹션 게이트웨이(8 AWS 도메인 + external-obs) + 공유 Strands Runtime + Memory + Code Interpreter, boto3 멱등 프로비저닝 + SSM 설정 source of truth; 컨트롤플레인 상태 페이지.
  - AI 종합 진단(ADR-008): 15섹션 병렬 Bedrock 렌더(동시성 제한, 섹션별 타임아웃 격리, `partial` degrade), md/docx/pdf 산출물 S3 프록시 다운로드, Intent Engine(`architecture_intent`), 리포트 관리 UI.
  - AI 인사이트: Overview 대시보드용 캐시 인사이트 카드 + admin 게이트 재생성 enqueue(플래그 off 시 fail-closed, 중복 job dedup).
  - K8sGPT 클러스터별 read-only in-cluster 진단(GET 전용 Result 조회, admin + 클러스터 allowlist, `k8sgpt_enabled` 게이트).
  - Agent Space 커스터마이제이션: 라우팅 키워드·게이트웨이/모델/언어 선택이 가능한 스킬/에이전트 카탈로그 CRUD(admin).
- **비용**
  - 비용 개요: 1m/3m/6m/12m 기간 필터, 서비스별 상세, Cost Explorer 가용성 probe(1h 캐시, `?force=1`).
  - 컨테이너 비용: OpenCost 기반 EKS 파드별 비용(NFM 파드별 전송 비용 포함); 인벤토리의 ECS 태스크 Fargate 일간/월간 비용 추정 + ECS 클러스터 MTD 비용.
  - Bedrock 비용: `ai_usage_daily` 집계 기반 앱 토큰 비용 + 모델별 사용량 메트릭("All accounts"는 클라이언트 fan-out) — Bedrock 페이지.
- **보안·컴플라이언스**
  - 보안 findings: Public S3, 개방 보안그룹 ingress, 미암호화 EBS, MFA 미설정 IAM 사용자 — `inventory_resources`에서 BFF read-only 파생 + 재동기화 엔드포인트.
  - ECR 이미지 스캔 기반 컨테이너 이미지 CVE findings(v1 Trivy CVE 탭의 v2 네이티브 후속).
  - CIS 컴플라이언스: Powerpipe 벤치마크를 비동기 Fargate `compliance` job으로 실행 — `compliance_runs`/`compliance_results` 이력 + 정적 벤치마크 allowlist.
- **통합**
  - 외부 데이터소스 8종: Prometheus, Mimir, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog — 인스턴스 CRUD + 크리덴셜 저장(admin), SSRF 가드 연결 테스트, kind별 기본 인스턴스 지정, read-only 쿼리 실행, 자연어 쿼리 초안 생성(리뷰 전용 — 절대 자동 실행 안 함), 사전 정의 진단 시그널.
  - ADR-007 거버넌스 하의 통합 레지스트리: egress 커넥터 + ingress 웹훅 소스, kind slug 키의 단일 Secrets Manager secret, 스키마 introspect/캐시.
  - 멀티 어카운트(ADR-011): `GetCallerIdentity` anti-spoof 검증 포함 계정 CRUD, 계정별 리전 활성/비활성, STS AssumeRole read-only fan-out, 셸의 계정/스코프 셀렉터.
- **운영**
  - 비동기 작업 큐 UI: 작업 enqueue/목록 + 작업별 상태 조회.
  - 사용자별 자동 진단 스케줄 — 실행은 워커 `schedule_dispatcher` 담당.
  - SNS 기반 진단 완료 이메일 알림 + 구독자 관리(ADR-007 거버넌스 하 LIVE).
  - 인시던트 라이프사이클(flag 게이트, ADR-006 analysis-only): HMAC 서명 웹훅 수신(active/standby 시크릿 로테이션), 수동 트리거, 상세 뷰, 교차 인시던트 예방 인사이트.
  - 액션 프레임워크(킬스위치 게이트): integrations-write / mutating-actions 게이트 분기의 목록/상세/실행, 빈 액션 이름 fail-closed.
  - 운영 자가치유(ADR-015, 기본 off): Aurora 시크릿 회전 이벤트 → 자기 web 서비스 한정 `ecs:UpdateService force-new-deployment`.
- **UI/UX**
  - 4개 언어 UI(한국어/영어/중국어/일본어) + 언어 토글; 언어별 진단 가이드.
  - 3종 테마(Cobalt/Teal/Dark) + 테마 토글 + 테마 연동 차트 색상.
  - 사이드바 IA: 접이식 그룹 + 2단계 서브그룹 + attention split 포함 그룹별 개요 페이지; CommandPalette; 모바일 하단 탭 바 + 모바일 내비.
  - 재사용 UI 킷: 정렬형 DataTable, 섹션형 DetailPanel, StatCard / StatTile / Meter / StatePill / SegmentedControl, 크기 조절 패널.
  - 이중언어 CHANGELOG.md 기반 변경 이력 모달 + 사이드바 버전 표시.
- **관측성**
  - 모니터링 허브: EC2/RDS 플릿 탭 + 기간 선택 단일 리소스 시계열; CloudWatch 알람 인벤토리 페이지.
  - 챗/AgentCore 운영 텔레메트리: 게이트웨이별 호출량·성공률·평균 지연을 UI에 표시.

### Changed

- **BREAKING:** v1(CDK/EC2/Steampipe 모놀리식, `/awsops` basePath)은 ADR-016에 따라 폐기 —
  v2는 루트 경로에서 자체 인증·데이터 플레인으로 서비스.

### Security

- AWS 리소스 변경 + 자율 실행 동결(ADR-005); BFF는 시크릿을 프록시하지 않음; 인-클러스터 조회는
  GET 전용; 인증 토큰은 등록 API에서 쓰기 전용.

## [1.9.0] - 2026-05-27

### Added

- 이벤트 기반 사전 스케일링 — Phase 1+2 (ADR-010) ([#13](https://github.com/whchoi98/awsops/pull/13))
  - 신규 `/event-scaling` 관리자 페이지: 이벤트 등록 → 과거 CloudWatch 메트릭 수집(ASG/RDS/MSK/EBS/ALB) → Bedrock Sonnet 4.6 다단계 워밍업 플랜(`PLAN_JSON` 마커) → 자원 타입별 bash 스크립트 다운로드(KEDA/HPA, Aurora 리더, MSK 파티션 확장, ASG warm pool, EBS IOPS)
  - **검토-후-실행**: 스크립트는 운영자 검토용으로 다운로드만 제공 — 대시보드는 변경 작업을 직접 실행하지 않음
  - 신규 API 라우트 `/api/event-scaling` (GET/POST/PUT/DELETE, admin 전용)
  - 신규 SQL 쿼리 `event-scaling.ts` (CloudWatch GetMetricData 배치 + 자원 상태 쿼리)
  - 라이브러리 3개 추가: `event-scaling.ts` (데이터 모델 + JSON 영속화), `event-scaling-prompts.ts`, `event-scaling-scripts.ts`
- ADR-029 (Proposed): 변경 작업 프레임워크 — 향후 모든 쓰기 작업의 게이트 모델 (ADR-010 Phase 3 선행 조건)
- ADR-030 (Accepted): ECS Fargate + Aurora 앱 상태 + 이중 ECR
  - **Phase 1 기반** (본 릴리스): `AwsopsDataStack` CDK 스택 — Aurora Serverless v2 PostgreSQL 15.5(0.5–4 ACU, Writer + Reader, KMS 암호화, IAM 인증, Private Subnet) 프로비저닝, 7개 테이블 idempotent 스키마(`infra-cdk/data/schema.sql`), 앱 측 pg Pool(`src/lib/db.ts`) DSN/개별 환경변수 지원, 배포 스크립트 `scripts/13-deploy-aurora.sh` (deploy / schema / status / dsn 서브커맨드)
  - `cdk deploy AwsopsDataStack -c enableAurora=true` 컨텍스트 플래그 뒤로 가드 — 기본 off, 기존 단일 호스트 배포는 영향 없음
  - **Phase 1 이중 쓰기** (다음 릴리스): 7개 소스 파일이 기존 `data/*.json` 쓰기와 함께 Aurora 쓰기 추가, 7일 패리티 게이트 통과 전까지 읽기는 JSON 유지
- AI 코드 리뷰 워크플로 ([#12](https://github.com/whchoi98/awsops/pull/12)) — GitHub Actions에서 Claude를 호출해 PR 자동 리뷰
- 테스트 커버리지 분석 및 개선 계획 ([#11](https://github.com/whchoi98/awsops/pull/11)) — `docs/TEST-COVERAGE-PLAN.md`에 현재 갭과 우선순위 정리

### Fixed

- 좀비 연결 정리가 Steampipe FDW 행에서도 살아남도록 강화 — 풀이 아닌 전용 단명 `Client` 사용으로 풀 고갈 상태에서도 동작; Cost Explorer/IAM 요약 FDW 경로용 임계값을 90초로 단축
- 단일 어카운트 모드에서 CIS 벤치마크 `relation does not exist` 오류 — non-aggregator 환경에서 스키마 해석 수정
- 벤치마크 파라미터를 셸 호출 전 allowlist로 검증 (커맨드 인젝션 방지)
- 알림 진단에 `global.anthropic.claude-sonnet-4-6` 모델 ID 사용 (리전 ID로 4xx 반환되던 문제 해결)

### Infrastructure

- 신규 CDK 스택 `AwsopsDataStack` (`infra-cdk/lib/awsops-data-stack.ts`) — `enableAurora` 컨텍스트 플래그로 opt-in
- `infra-cdk/data/schema.sql`은 소스 관리 대상 (`.gitignore`에 negation 규칙 추가)
- CDK 스택 총 4개: `AwsopsStack`, `AwsopsCognitoStack`, `AwsopsAgentCoreStack`, `AwsopsDataStack`

### Documentation

- ADR-029(Proposed), ADR-030(Accepted) 신규 — ADR 29건 → 30건
- `docs/architecture.md` — Future: ECS Fargate + Aurora Migration 섹션, Aurora 데이터 계층 설명 추가

## [1.8.1] - 2026-04-23

### Added

- 알림 트리거 AI 자동 진단 파이프라인 (ADR-009): 외부 알림 소스에서 자동 근본 원인 분석 ([#10](https://github.com/whchoi98/awsops/pull/10))
  - 웹훅 엔드포인트(`/api/alert-webhook`): CloudWatch Alarm(SNS), Prometheus Alertmanager, Grafana, SQS, Generic 지원
  - 알림 상관 분석 엔진: 30초 버퍼링, 시간/서비스/리소스 매칭, 중복 제거, 심각도 에스컬레이션
  - 조사 오케스트레이터: 알림 컨텍스트 기반 컬렉터/데이터소스 자동 선택, 변경 감지(CloudTrail + K8s Rollout)
  - Bedrock Sonnet 근본 원인 분석 (타임라인, 대응 조치, 예방 방안)
  - `AlertContext`로 컬렉터 쿼리를 발화 알림의 서비스/리소스/네임스페이스(±10분)로 스코프 제한
  - Slack 알림 (Block Kit, 심각도별 채널 라우팅, 웹훅·Bot 모드 스레드 업데이트, 해결 상태 포함)
  - 지식 베이스: 월간 요약 영구 저장(`data/alert-diagnosis/summary-YYYY-MM.json`), 과거 인시던트 유사도 검색
  - SQS 백그라운드 폴러, 알림 설정 관리 페이지(`/alert-settings`)
  - HMAC-SHA256 웹훅 인증 + Rate Limiting
  - `GET /api/alert-webhook`으로 활성 인시던트 조회, 헤더 배지 + 홈 카드에서 30초 주기 폴링
- 문서 확장:
  - ADR 18건 신규(011-028): 데이터소스, SNS, 리포트, Bedrock 모델, 캐시 워머, Cognito, SSE, HMAC, adminEmails, CDK 분리, 멀티 라우트, i18n, Code Interpreter, CloudFront
  - 런북 5건 신규: 알림 파이프라인, 캐시 워머, Cognito 인증, 배포 플로우, 멀티 어카운트
  - 모듈 CLAUDE.md 11개 신규: docs/, runbooks/, decisions/, agent/, scripts/, tests/, infra-cdk/, ai-diagnosis/, alert-settings/, k8s/, collectors/
  - Web 가이드: `monitoring/ai-diagnosis.md`, `monitoring/alerts.md` 페이지 신규 (KO+EN), intro/FAQ 업데이트
- `LICENSE` 파일 (MIT)

### Fixed

- 리포트 다운로드 버튼이 S3 presigned URL 대신 프록시 URL 사용 (STS 세션 만료 해결)
- SNS SubscribeURL SSRF 방지, 알림 설정 admin 인증, PromQL/LogQL 인젝션 방지
- 상관 분석: 재시도 제한, 타이머 정리, dedup map 제한, Rate Limit 강화
- 컬렉터 동적 import를 `webpackInclude` 매직 코멘트로 코드 파일로 제한 (CLAUDE.md 포함 시 빌드 실패 방지)
- 알림 진단에 `global.anthropic.claude-sonnet-4-6` 모델 ID 사용
- 사이드바의 중복된 AI 진단 메뉴 항목 제거
- 미사용 `batchTopics` 변수 제거; env var 치환 수정
- `reportBucket` config 동적 읽기 복원; 30분 stale timeout
- `setup-alert-pipeline`에서 SNS→SQS 큐 + DLQ + SNS 구독 자동 생성
- SNS 이메일 알림 마크다운 → 평문 변환

### Security

- `.gitignore`에 `.env` + `.env.*` 추적; `.env.example`은 allowlist

## [1.8.0] - 2026-04-07

### Added

- 7종 외부 관측성 플랫폼 연동: Prometheus, Loki, Tempo, ClickHouse, Jaeger, Dynatrace, Datadog ([#10](https://github.com/whchoi98/awsops/pull/10))
- 데이터소스 관리 페이지(`/datasources`) — CRUD, 연결 테스트, 인증 설정
- 데이터소스 Explore 페이지(`/datasources/explore`) — 직접 쿼리 실행 + AI 쿼리 생성 (자연어 → PromQL/LogQL/TraceQL/SQL)
- 멀티 데이터소스 AI 상관 분석: `datasource` 라우트로 외부 메트릭과 AWS 리소스 교차 분석
- AI 라우팅 10개 → 11개로 확장 (외부 플랫폼 쿼리용 `datasource` 라우트 추가)
- EKS Access Entry 상태 표시 및 kubeconfig 등록 ([#11](https://github.com/whchoi98/awsops/pull/11))
- EKS Service Resources 탭 — 클릭 네비게이션, 노드 ENI 트래픽 메트릭
- AI 종합 진단 — 15섹션 Bedrock Opus 분석 ([#13](https://github.com/whchoi98/awsops/pull/13))
- 진단 리포트 DOCX, Markdown, 브라우저 Print-to-PDF 내보내기
- 자동 진단 스케줄러 (weekly/biweekly/monthly)
- 인쇄용 리포트 페이지(`/ai-diagnosis/report`) — A4 페이지 브레이크
- SSRF 방지: allowlist 기반 사설 네트워크 접근 제어 + 심층 방어 URL 검증
- 멀티 라우트 합성에 Converse Stream API 적용 (실시간 SSE 스트리밍)
- AgentCore 게이트웨이 응답에 타이핑 효과 시뮬레이션 추가
- 좀비 PostgreSQL 연결 자동 정리 (5분 이상 실행 쿼리 종료)
- 사이드바 앱 버전 표시 (package.json에서 자동 읽기)

### Fixed

- Steampipe 내부 FDW 연결(`client_addr IS NULL`)을 좀비 정리 대상에서 제외
- CloudWatch FDW의 느린 API 호출로 인한 pg 풀 고갈 방지를 위해 캐시 워머에서 모니터링 쿼리 제거
- 모든 모니터링 메트릭 쿼리에 시간 범위 필터 추가 (무제한 쿼리 실행 방지)
- AI 채팅 버블이 SSE 스트리밍 중 폭이 점프하는 현상 수정 ([#8](https://github.com/whchoi98/awsops/pull/8))
- EKS 페이지 SQL Injection 방지: nodeName sanitize + ENI ID 정규식 검증
- warningEvents 쿼리에 `involved_object_kind`, `involved_object_name`, `count` 컬럼 추가
- 벤치마크 라우트 `errorFile` 변수 미선언 수정
- Sidebar `ClipboardCheck` 아이콘 import 누락 수정

### Security

- SSRF 심층 방어: `datasource-client.ts`에 URL 검증 추가 (AI route 포함 모든 outbound fetch 보호)
- 데이터소스 쿼리 및 AI 쿼리 생성 액션에 관리자 전용 접근 적용
- IPv6 사설/링크로컬 주소 차단 추가 (`fc00::/7`, `fe80::/10`)
- Tempo/Jaeger trace ID URL 삽입에 정규식 캡처 그룹 사용
- 리포트 라우트에서 계정 ID 하드코딩된 S3 버킷 제거, `config.reportBucket`에서 읽기

## [1.7.0] - 2026-03-24

### Added

- Steampipe Aggregator 패턴 기반 멀티 어카운트 지원 (`aws` = 전체 통합, `aws_{id}` = 개별 계정)
- 계정 관리 페이지(`/accounts`) — 추가/삭제/테스트 기능 (관리자 전용, `adminEmails` 설정)
- `AccountSelector` 드롭다운 및 `AccountBadge` 컴포넌트 (계정별 네비게이션)
- `buildSearchPath(accountId)` 계정별 쿼리 스코핑 및 `runCostQueriesPerAccount()` 비용 데이터 병합
- 25개 전체 SQL 쿼리 파일에 `account_id` 컬럼 추가
- 교차 계정 IAM 역할 설정 스크립트 (`scripts/11-setup-multi-account.sh`)
- `InvokeModelWithResponseStreamCommand` 기반 실시간 Bedrock 스트리밍 (SSE 청크 이벤트)
- 대시보드 쿼리 백그라운드 캐시 프리워밍 (`cache-warmer.ts`, 4분 주기)
- 대시보드/모니터링/AgentCore 페이지에 캐시 워머 상태 바 표시
- 사이드바에 고객 로고 설정 (`customerLogo`, `customerName`, `customerLogoBg`)

### Changed

- 35개 전체 페이지에 `useAccountContext()` 통합 (멀티 어카운트 인식)
- DataTable에서 멀티 어카운트 데이터 감지 시 Account 컬럼 자동 추가
- 캐시 키 형식을 `sp:{accountId}:{sql}`로 변경 (계정별 캐시 분리)
- `config.json`의 `accounts[]` 배열로 코드 수정 없이 계정 관리
- 배포 스크립트 11단계로 확장 (Step 11: 멀티 어카운트 설정)

### Fixed

- `RESET search_path` 실패 시 커넥션 파괴로 풀 고갈 방지

### Security

- **CRITICAL**: AssumeRole 감사 로그 (JSON 구조화, CloudWatch 추적 가능)
- **CRITICAL**: 교차 계정 AssumeRole에 ExternalId 필수화 (Confused Deputy 방지)
- **HIGH**: 관리자 엔드포인트 Rate Limiting (5 req/min/user, HTTP 429)
- **HIGH**: Alias/Region 입력 검증 강화 (64자 제한, 정규식 패턴)
- **HIGH**: `execSync`를 `execFileSync`로 교체 (Shell Injection 방지) ([#6](https://github.com/whchoi98/awsops/pull/6))

## [1.6.0] - 2026-03-21

### Added

- 한국어/영어 전환 다국어(i18n) 지원 (React Context + localStorage)
- `translations/en.json`, `ko.json`에 500+ 번역 키
- AI 응답이 언어 설정에 따라 한국어/영어로 출력
- Bedrock 모니터링 페이지(`/bedrock`) — 모델별 사용량 대시보드 (CloudWatch + AWSops 토큰 추적)
- Account Total vs AWSops 사용량 비교 차트
- AI 채팅에 토큰 비용 표시 (입력/출력 토큰, USD 비용)
- ECS 컨테이너 비용 페이지(`/container-cost`) — Fargate 가격 + Container Insights 메트릭
- EKS 컨테이너 비용 페이지(`/eks-container-cost`) — OpenCost API + Request 기반 폴백
- OpenCost 설치 스크립트(`06f-setup-opencost.sh`) — Prometheus + OpenCost (EKS)
- AgentCore Memory Store 대화 이력 영구 저장 (365일 보관, 사용자별 분리)
- AI Assistant 하단에 대화 이력 토글 패널

### Changed

- Bedrock 대시보드 기본 시간 범위를 24시간에서 7일로 변경
- Bedrock 가격 맵에 교차 리전 모델 ID 추가

## [1.5.2] - 2026-03-15

### Added

- EBS 페이지(`/ebs`) — 볼륨/스냅샷, 암호화 상태, EC2 어태치먼트 매핑, Idle 볼륨 감지
- MSK 페이지(`/msk`) — Kafka 클러스터, 브로커 노드 메트릭 테이블 (CPU/Memory/Network), KRaft 컨트롤러
- OpenSearch 페이지(`/opensearch`) — 도메인, 암호화 (N2N/At-Rest), VPC 구성, 클러스터 메트릭
- Resource Inventory 페이지(`/inventory`) — 18종 리소스 수량 추이, 멀티라인 차트, 비용 영향 추정 ([#1](https://github.com/whchoi98/awsops/pull/1))
- MSK/RDS/ElastiCache/OpenSearch CloudWatch 메트릭 테이블 (프로그레스 바 + 수치)
- ElastiCache Valkey 엔진 지원 (엔진별 색상 배지)
- 설치 시 Cost Explorer MSP/Direct Payer 자동 판별
- Cost 쿼리 실패 시 마지막 스냅샷 데이터 폴백 표시
- AgentCore 설정을 `data/config.json`으로 외부화 (하드코딩 ARN 제거)
- 응답 내용 키워드 매칭으로 MCP 도구 사용 추론 → AI 채팅에 배지 표시
- AgentCore Memory 자동 저장 (질문/요약/라우트/도구/응답시간)

### Changed

- 대시보드에 EBS/MSK/OpenSearch 카드 추가 (Network & Storage 행, 9열)
- pg Pool max 3 → 5, 배치 크기 3 → 5로 확대
- 멀티 라우트 실패 시 Bedrock Direct 폴백 추가, 타임아웃 60초 → 90초로 확대
- Sign Out 버튼을 Header에서 Sidebar 상단(로고 옆)으로 이동

### Fixed

- HttpOnly 쿠키 로그아웃을 서버 사이드 API(`POST /api/auth`)로 변경 (클라이언트 삭제 불가 수정)

## [1.4.0] - 2026-03-13

### Added

- 멀티 라우트 AI 분류 — 복합 질문 시 1-3개 Gateway 병렬 호출 + Bedrock 응답 합성
- AgentCore 대시보드 페이지(`/agentcore`) — Runtime 상태, 8 Gateway 카드, 125 도구 목록
- AgentCore 상태 API(`/api/agentcore`) — Runtime/Gateway 상태 조회
- CloudFront 페이지(`/cloudfront-cdn`) — Distribution, Origins, Aliases, WAF, Protocol
- WAF 페이지(`/waf`) — Web ACL 목록, Rules, IP Sets
- ECR 페이지(`/ecr`) — Repository, Scan 설정, Encryption, Tag Mutability
- Header에 Sign Out 버튼 (쿠키 삭제 → Cognito 재인증)
- S3 Bucket TreeMap 시각화 (리전별, Public/Versioned/Standard 색상 구분)
- S3 IAM Roles 섹션 (S3 접근 가능 역할 표시)
- RDS Security Groups 인바운드 규칙 및 체이닝 리소스 표시
- RDS CloudWatch 메트릭 — CPU, Memory, Connections, IOPS, Storage 미니 차트
- ElastiCache Security Groups 및 CloudWatch 메트릭
- Monitoring 인스턴스 상세 메트릭 뷰 (전체 화면 차트, 날짜 범위 필터 1h/6h/24h/7d/30d)
- Resource Topology 재설계 — Infrastructure Graph/Map 전환 + Kubernetes 4컬럼 리소스 맵
- VPC Resource Map — AWS 콘솔 스타일 4컬럼 레이아웃, 클릭 하이라이트
- EKS 노드 카드에 CPU/Memory 프로그레스 바 및 ENI 상세 뷰
- Cost Explorer 기간/서비스 필터, Projected 월말 비용, MoM 변화율

### Changed

- 대시보드 레이아웃 18 카드(6x3)로 재설계, 사이드바 메뉴와 1:1 매핑
- CIS Compliance 기준을 v4.0.0으로 갱신
- AI Assistant 헤더를 EC2/VPC 페이지와 동일 스타일로 통일 (ONLINE 배지)

### Fixed

- 8개 페이지에서 PieChart/BarChart Steampipe bigint 문자열 → `Number()` 변환
- Cost 쿼리 `COALESCE(unblended, blended, 0)` — blended_cost null 계정 지원
- 멀티 라우트 빌드 TypeScript implicit any 타입 오류

## [1.3.0] - 2026-03-12

### Added

- 대시보드 18개 StatsCards (6x3 레이아웃), 사이드바 메뉴와 1:1 매핑, 카드별 sub-metrics
- CIS Compliance Pass Rate 표시 (alarm/skip/error 세부 분류)
- Monthly Cost sub-metrics — 일평균, 전월 대비, MoM 변화율
- AI Assistant SSE 스트리밍 (실시간 진행 상태 표시)
- AI 채팅에 응답 시간, 클립보드 복사, 연관 추천 질문 기능
- EC2 메모리/네트워크 정보 (`aws_ec2_instance_type` JOIN)
- EC2 다중 필터 — 텍스트 검색 + State + Instance Type + VPC 드롭다운
- K8s Overview 노드 카드에 CPU/Memory 사용량 프로그레스 바
- K8s 노드 상세 뷰 — ENI 카드, ENI별 트래픽, Pod 테이블
- EKS Explorer — Status/Node 필터, 페이지네이션 (25/50/100/200), 클러스터 선택기
- VPC Route Table 탭 (Associations, Routes, target/state 상세)
- TGW Route Tables 및 Attachment 상세 뷰

### Changed

- 사이드바 글씨 크기 확대 (`text-sm` → `text-[15px]`), 아이콘 16px → 18px
- StatsCard 긴 값 자동 축소, `h-full` 카드 높이 통일

### Fixed

- RDS/ElastiCache 메트릭 차트 겹침 — 직접 Recharts 렌더링으로 해결
- Monitoring EC2 상세 차트 크기 — 전용 Recharts 컴포넌트로 수정
- K8s `parseMiB` const hoisting 문제 — 컴포넌트 밖 함수로 이동
- AgentCore `bedrock-agentcore:*` 권한 추가 및 `<tool_call>` 태그 정리
- Bedrock 리전 us-east-1 → ap-northeast-2 변경 (global.* inference)
- Cognito custom domain `SupportedIdentityProviders` 및 콜백 URL 경로 수정

## [1.2.0] - 2026-03-11

### Added

- Infra Gateway에서 Network Gateway(17 도구) 분리 — VPC, TGW, VPN, ENI, Firewall, Reachability, Flow Logs
- Infra Gateway에서 Container Gateway(24 도구) 분리 — EKS, ECS, Istio
- AI 테스트 스크립트 `scripts/test-ai-routes.py` — 대화형 메뉴, 104개 질문, 9 카테고리, 내용 검증
- 테스트 가이드 `docs/AI_TEST_GUIDE.md` — 사용법, 출력 해석, 트러블슈팅

### Changed

- **BREAKING:** Infra Gateway(41 도구) → Network(17) + Container(24) 분리 (Container 54% 속도 개선)
- Gateway 7개 → 8개, 라우트 9개 → 10개로 확장
- Bedrock 리전을 ap-northeast-2로 변경 (global.* inference profile, ~20% 지연 감소)
- 벤치마크 라우트 Steampipe 비밀번호를 하드코딩에서 동적 조회로 변경

### Fixed

- AgentCore IAM 역할에 `bedrock-agentcore:*` 누락으로 Gateway 호출 실패
- EKS access entry `arn:aws:sts::` → `arn:aws:iam::` 형식 변환
- K8s PVC `capacity`/`access_modes` JSONB 직렬화 오류 (`::text` 캐스팅)
- AgentCore 응답에 `<tool_call>` 태그 노출 (regex 제거)
- Cognito custom domain `SupportedIdentityProviders` 및 콜백 URL 경로

## [1.1.0] - 2026-03-07

### Added

- 단일 게이트웨이를 7개 역할 기반 AgentCore Gateway로 교체 (Network/IaC/Data/Security/Monitoring/Cost/Ops)
- MCP 도구 타겟으로 19개 Lambda 함수 추가 (총 125 도구)
- `agent.py`에서 `payload.gateway` 파라미터 기반 동적 게이트웨이 라우팅
- `route.ts`에 9단계 우선순위 키워드 기반 라우팅
- 게이트웨이별 전문가 역할 시스템 프롬프트
- Gateway Target 자동 생성 스크립트 `create_targets.py`
- 16개 Lambda 소스 파일 `agent/lambda/`에 버전 관리

### Changed

- **BREAKING:** 단일 게이트웨이(29 도구) → 7개 전문 게이트웨이(125 도구)로 전환 (도구 선택 정확도 향상)
- `network-mcp` 1개 도구(693B) → 15개 도구(17KB)로 재작성
- `steampipe-query` boto3 키워드 폴백에서 pg8000 실제 SQL로 업그레이드
- 레거시 게이트웨이(`awsops-gateway-g0ihtogknw`) 삭제

## [1.0.1] - 2026-03-07

### Added

- CDK 인프라 스택(`awsops-stack.ts`) — VPC, EC2, ALB, CloudFront
- Cognito User Pool + OAuth2 Authorization Code 인증 흐름
- Lambda@Edge(Python 3.12, us-east-1) CloudFront JWT 인증
- AgentCore Runtime (Strands 에이전트, arm64 Docker, ECR)
- AgentCore Gateway (MCP 프로토콜) 및 Code Interpreter
- 4개 하위 단계 AgentCore 스크립트: Runtime(6a), Gateway(6b), Tools(6c), Interpreter(6d)
- Claude Code 프로젝트 스캐폴딩 (자동 동기화 hooks + 모듈 문서)
- Git commit-msg 훅 (Co-Authored-By 자동 제거)

### Fixed

- CloudFront CachePolicy TTL=0 거부 — managed `CACHING_DISABLED`로 해결
- ALB 보안 그룹 규칙 제한 (CloudFront prefix list 120+ IP) — 포트 범위로 통합
- EC2 UserData Steampipe 설치를 ec2-user 대신 root로 실행
- Steampipe 수신 모드 `local` → `network` 변경 (VPC Lambda 접근 허용)
- Gateway Target API 구조를 `mcp.lambda` + `credentialProviderConfigurations`로 수정
- Code Interpreter 이름에 하이픈 사용 불가 — 언더스코어로 변경
- Lambda에서 psycopg2 호환 불가 — pg8000(순수 Python)으로 전환

## [1.0.0] - 2026-03-07

### Added

- AWSops 대시보드 21개 페이지 + 5개 API 라우트
- Next.js 14 (App Router) + Tailwind CSS 다크 네이비 테마
- Steampipe 내장 PostgreSQL 연동 (380+ AWS 테이블, 60+ K8s 테이블)
- Recharts 메트릭 시각화 및 React Flow 네트워크 토폴로지
- Powerpipe CIS v1.5~v4.0 벤치마크
- AI 라우팅: Code Interpreter, AgentCore, Steampipe+Bedrock, Bedrock Direct
- Bedrock Claude Sonnet/Opus 4.6 통합

[Unreleased]: https://github.com/whchoi98/awsops/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/whchoi98/awsops/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/whchoi98/awsops/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/whchoi98/awsops/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/whchoi98/awsops/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/whchoi98/awsops/releases/tag/v0.5.0
[1.8.1]: https://github.com/whchoi98/awsops/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/whchoi98/awsops/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/whchoi98/awsops/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/whchoi98/awsops/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/whchoi98/awsops/compare/v1.4.0...v1.5.2
[1.4.0]: https://github.com/whchoi98/awsops/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/whchoi98/awsops/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/whchoi98/awsops/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/whchoi98/awsops/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/whchoi98/awsops/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/whchoi98/awsops/releases/tag/v1.0.0
