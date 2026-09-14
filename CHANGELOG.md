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
- Deployment dependency readiness: authenticated probes verify the actual web-role account and fresh AgentCore SSM reads, then require a nonce-bound runtime response proving curated inventory access, a known fresh CloudFront record and a bounded model call. With an explicit private runtime configuration, the smoke utility checks collection and owned Lambda/Fargate completion. Every dev Deploy Web release requires controller-generated full runtime evidence; health, login or enqueue acknowledgement alone cannot pass. The owned synchronous CloudFront probe must succeed with zero unknowns and a fresh post-marker record plus nonce-bound SSM/runtime/model proof; its durable post-marker success survives later scheduled attempts. Other catalog types require last success within thirty minutes, with current degradation disclosed and completeness unknown. Both owned Lambda and Fargate jobs must succeed. Manual collect-runtime separates existing-web preparation from full verification. The billed probe is restricted to administrators or deployment-verifiers, with one in-flight call and a per-process cooldown. Readiness uses the dedicated CI_READINESS_ENABLED_DEV override, not the runtime profile: empty preserves explicit tfvars/default false and true/false explicitly opt in/out on dev. A reviewed apply with AgentCore enabled creates only deployment-verifiers; membership additionally requires create_demo_user. Group removal does not immediately revoke existing 12-hour ID-token claims. Disabled AgentCore sets a web-only blank runtime SSM path respected by the status BFF; the incident bridge remains unchanged. No administrator or IAM role is granted. Manual development audits separately report scoped runtime/collector status, schedule metrics and SQL-reader counts/timestamps under restricted sessions, without claiming full readiness or complete collection. Collector code verification uses the configured archive fingerprint, so stale provider observations do not reject a correct rollout or bless unconfigured code. Explicit full-dev readiness plans also publish a bounded advisory view of recognized changes without private plan values; unknown changes still require private inspection.
