# P1a verification — private edge + spine (served at ROOT `/`)

- **Date:** 2026-05-31
- **Public URL:** https://awsops-v2.example.com (reuses mgmt-vpc, create_network=false)
- v2 drops the v1 `/awsops` basePath — spine is served at **root `/`**.
- `https://awsops-v2.example.com/` → **200 `AWSops v2 spine — ok (root)`** ✓
- `https://awsops-v2.example.com/healthz` → **200 `ok`** ✓
- Old `https://awsops-v2.example.com/awsops/healthz` → **404** ✓ (path moved cleanly to root)
- **SSE streamed incrementally (1/s, not buffered):** yes ✓ — `https://awsops-v2.example.com/api/stream` delivered `tick 1` @08:58:16, `tick 2` @08:58:17, `tick 3` @08:58:18 (one per second), through `tick 10`, then `done`. TTFB ~25ms, total ~10s.
- **ALB scheme `internal` + only reachable via CloudFront VPC Origin:** yes ✓ (`internal-awsops-v2-alb-...`, no internet-facing scheme).
- **Target health:** healthy ✓ (TG health check now on `/healthz`).
- **terraform apply:** 1 added, 3 changed, 1 destroyed — ECS task def replaced (new `/healthz` health check, revision :2), ECS service updated, target group health-check path → `/healthz`, CloudFront static behavior `path_pattern` → `/_next/static/*`. **No vpc/subnet/nat changes.** ✓

## Edge architecture proven
CloudFront (TLS, viewer cert `awsops-v2.example.com` us-east-1)
→ VPC Origin **https-only:443** (`vo_6O65HL…`)
→ Internal ALB **HTTPS:443** (regional ACM cert, `ELBSecurityPolicy-TLS13-1-2-2021-06`)
→ HTTP → Fargate spine:3000 (target healthy)

Cache behaviors: `default_cache_behavior` (CachingDisabled) covers `/`, `/healthz`, `/api/stream` and everything else; `ordered_cache_behavior` `/_next/static/*` (CachingOptimized) for future static assets.

## Root-cause fixes (504 → 200)
1. **CF→ALB must be TLS end-to-end**: VPC Origin `https-only` + distribution origin `domain_name = var.domain_name` (public FQDN drives TLS SNI to match the ALB cert). HTTP-only/ALB-DNS-name did not work.
2. **ALB SG must allow 443 from the CloudFront VPC Origin managed SG** (`CloudFront-VPCOrigins-Service-SG`), not just the VPC CIDR. CIDR-only → persistent 504. (Matches `AWS-Demo-Platform/infra/alb-internal`.)
3. VPC Origin `origin_protocol_policy` cannot be updated in-place while attached → recreated via `create_before_destroy` + distinct name.

## P1d note (carry-forward)
The real Next.js app must send an SSE heartbeat (`: keepalive\n\n`) at least every ~20s to stay within CloudFront's 60s origin read timeout on idle streams.

## P1b auth — verified e2e (2026-05-31)
- Unauthenticated `https://awsops-v2.example.com/` → **302 → Cognito Hosted UI login** ✓
- Login as `admin@awsops.local` → `/_callback` exchanges code↔token → sets `awsops_token` cookie → redirects `/` → **authenticated spine page `AWSops v2 spine — ok (root)` loads** ✓ (confirmed in browser)
- `/_callback` with no code → 400 ✓
- Cognito: pool `ap-northeast-2_EXAMPLE01`, Hosted-UI domain `a-ops-v2-auth-123456789012` (no 'aws' — reserved word), Lambda@Edge `awsops-v2-cognito-auth:1` (us-east-1) on viewer-request of both cache behaviors.
- ⚠️ **TODO before P1d real data:** verify JWT RS256 signature against Cognito JWKS (`/<poolId>/.well-known/jwks.json`) — currently `exp`-only (ported v1 behavior).
