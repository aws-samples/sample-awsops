# Dependency and runtime refresh

The owner authorized source, lockfile, runtime configuration updates and local
verification on 2026-11-04. AWS deployment, Terraform apply and image publication
are outside this change.

Preserve ADR-005's read-only posture, default-off feature gates, gateway identity
and AWS_IAM authentication, arm64 workloads, ownership checks, release provenance
and migration ordering. CDK was decommissioned; do not reintroduce it.

## Implementation

- [x] Refresh JavaScript dependencies in `web/`, `scripts/v2/` and `docs-site/`,
  regenerate npm lockfiles, update the web and migration container Node runtime,
  and resolve verified framework compatibility problems.
- [x] Refresh Python dependencies and AgentCore SDKs, verify real dependency
  resolution and transport/runtime contracts, update Python containers and
  hash-locked provisioner/layer dependencies. Keep governed connector ceilings
  and frozen substrate inactive.
- [x] Refresh Terraform CLI/provider locks, supported Lambda runtime and layer
  metadata, ECS platform configuration and CI runtime versions consistently.
  Use isolated backend-disabled Terraform validation and mock tests.
- [x] Run web tests/build, documentation build, agent/provisioner/worker tests,
  offline CI contracts and relevant PostgreSQL integration checks when their
  required tools are available. Finish compatible documentation security
  dependency remediation and repeat its affected checks after approval.
- [x] Review the integrated diff and document selected versions, compatibility
  holds and verification evidence.

## Version selection

Use registry-published stable releases and officially supported managed runtimes.
At discovery, Lambda Python 3.15 is preview, so Python 3.14 is the target for
regional/edge functions and Python workloads. Node 26 is the current LTS container
target; Terraform 1.17.1 is the current stable CLI. Verify provider and package
versions directly before locking. Do not force an incompatible major upgrade
merely to satisfy a version number.

Retain security-sensitive CI Python 3.12 where repository contracts explicitly
require it; test the new workload runtime separately. A retained dependency must
have a concrete compatibility reason.

## Evidence

Versions were checked against npm/PyPI metadata, signed Terraform release/provider
checksums, AWS runtime documentation and the Python standalone publisher.

| Component | Selected version/configuration |
| --- | --- |
| Web and migration containers | Node 26.13.0, arm64 |
| Web framework | Next.js 16.4.5, React 19.3.1 |
| Web tooling | TypeScript 6.0.3, Vitest 5.1.0, Vite 8.3.5 |
| JavaScript AWS SDK | 3.1161.0 |
| Documentation | Docusaurus 3.10.2, Faster 3.10.2, Mermaid 12.3.0 |
| Documentation security overrides | Tinypool 2.2.0, serialize-javascript 7.1.4 |
| Terraform | CLI 1.17.1; AWS 6.71.0, archive 2.8.1, random 3.9.1 |
| Lambda and layers | Python 3.14 for 31 functions and two layers |
| Agent and worker images | Python 3.14 on Debian Bookworm, arm64 |
| Inventory Python | 3.14.10 standalone, publisher release 20261026, verified SHA256 |
| Agent SDKs | Strands 1.63.0, tools 0.8.12, AgentCore 1.25.3, starter toolkit 0.3.14 |
| Python AWS SDK | boto3/botocore 1.43.123 |
| Database driver | JavaScript pg 8.23.1, Python pg8000 1.31.6 |
| Fargate | Existing `LATEST`; latest Linux platform remains 1.4.0 |

Compatibility holds are deliberate:

- TypeScript 7.0.2 removes the JavaScript compiler API used by Next.js and the
  database type-check fixtures. Both JavaScript projects retain 6.0.3.
- Tailwind stays on the latest v3 maintenance release, 3.4.19. A v4 CSS/plugin
  and visual migration is a separate change.
- `@lezer/lr` 1.4.10 satisfies the exact peer contract of the current TraceQL parser.
- MCP 1.30.0 retains the transport/session and HTTPX/SigV4 contracts; MCP 2
  removes those APIs. Its own redirect loop is also disabled with
  `max_redirects=0`, verified against the real SDK rather than only helper stubs.
- Frozen `mcp-clickhouse` remains exactly 0.4.1. Current releases require
  FastMCP 4/MCP 2; no frozen connector is enabled.
- Security-sensitive CI/provisioner and image-codec Python stays on 3.12 as
  required by the existing release contracts. Workloads are tested on 3.14.10.

Next.js uses `proxy.ts` with the existing body-size ceiling. Production builds
retain Webpack and strict application type checks, with test fixtures excluded
through `tsconfig.build.json`. S3 download responses copy SDK byte arrays into
an owned `Uint8Array`. Vite uses its Oxc JSX configuration. Docusaurus keeps all
four locales; truncation comments use its accepted MDX syntax and TypeScript
configuration preserves project-relative aliases without deprecated `baseUrl`.

Verification completed:

- Web production build, including application type checks.
- Web suite: 355 files and 5,421 tests passed; 3 files/256 tests retain their
  existing optional skips.
- Documentation TypeScript check, all four locale builds and deterministic
  presentation provenance verification, repeated after the security update.
  Actual Chromium rendered all 48 Mermaid diagrams across 12 pages in the four
  locales, with no JavaScript page errors. Browser requests were restricted to
  the temporary loopback static server; the browser and server were stopped.
- Required Node CI fixtures: 333 passed, no skips.
- Required disposable PostgreSQL suites: 73 passed, no skips.
- Offline deployment smoke contracts: 161 passed, no skips.
- Python release/image/read/deploy/workflow contracts: 125 passed and
  369 subtests passed.
- Terraform: both roots validate, formatting passes and 25 isolated provider
  mock plans pass. Runtime/asset/runner tests: 37 passed and 63 subtests passed.
- Python 3.14.10 agent suite: 1,024 passed and 400 subtests passed, 18 existing skips.
  Worker suite: 1,694 passed, 106 existing skips. Inventory suite: 256 passed.
  Provisioner/assets: 124 passed and 67 subtests passed.
  Incident suites: 119 passed; frozen remediation suites: 57 passed.
- Real MCP SigV4 handshake/list-tools, redirect denial and actual AgentCore
  `/invocations` streaming with disabled readiness; no live AWS/model calls.
- Exact combined Python 3.12 CI requirements and Python 3.14 workload closures
  install and pass `pip check`; provisioner/layer hash-locked installs verify.
- Independent integrated code/IaC security review and a focused documentation
  compatibility follow-up found no remaining findings. Generated context
  checksums, size/secret checks, npm manifest/lock consistency and diff checks pass.
- Repository structure checks: all nine groups passed, zero failed.
- Docker review-codec confinement checks: 17 passed; owned temporary containers
  and the sandbox image were removed after verification.

Full workload Docker images have not been built or published. No real Terraform
backend, saved deployment plan, AWS mutation or live readiness claim is included.

The owner separately approved npm security auditing, including `scripts/v2`,
and documentation installation/update registry requests on 2026-11-04.
The web and operations-script audits report zero vulnerabilities. The initial
documentation audit reports 33 affected package entries (17 critical, three
high, four moderate and nine low), including propagated dependency findings.
After installing Tinypool 2.2.0, serialize-javascript 7.1.4 and compatible
transitive updates, the final documentation audit has zero critical/high
findings, 18 moderate entries and three low entries. These are propagated
package reports rooted in exactly two remaining dependency advisories,
minimatch and deepmerge; they do not represent 21 distinct vulnerabilities.
The documentation manifest, lockfile and installed packages agree. Tinypool's
worker contracts were verified on Node 26.13.0 with actual tasks. Independent
review of the final dependency graph and Mermaid/Docusaurus contracts found
no additional implementation findings.

A bare minimatch 11 override is incompatible with serve-handler 6.1.7, which
requires a callable module export. Docusaurus's local static server passes
boolean clean-URL/directory-listing settings and no glob configuration; production
publishes static files to GitHub Pages. Retain and disclose this moderate
dependency advisory rather than break local serving or claim a clean audit.
Deepmerge 4.3.1 is the latest available upstream release and retains a low
prototype-poisoning advisory. Its only locked dependent, `@svgr/plugin-svgo`
8.1.0, declares the package but does not import or call it in the installed
implementation. No active untrusted-input merge path was found in that SVG
toolchain; the metadata advisory remains reportable.
