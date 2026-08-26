---
sidebar_position: 2
title: Troubleshooting FAQ
description: Problems that occur while using the AWSops dashboard and how to fix them (access, auth, data, AI diagnosis)
---

# Troubleshooting FAQ

Problems that may occur while using the AWSops dashboard and how to fix them. AWSops is a Next.js thin-BFF running on ECS Fargate; all live AWS queries go through AgentCore MCP tools, and state is persisted in Aurora (PostgreSQL). Most issues fall into one of three buckets: the access path (edge), authentication (Cognito), or data connectivity (Aurora / permissions).

## The site returns 504 or won't load

If CloudFront fails to respond or returns 504 Gateway Timeout, the connection has broken somewhere along the edge path (CloudFront → VPC Origin → internal ALB → Fargate). AWSops has no public ALB, so check in this order.

1. **Fargate task state** — Verify the ECS service task is RUNNING and healthy in the target group. If the task is cycling through UNHEALTHY, see "ECS task cycles through UNHEALTHY" below.
2. **TLS end-to-end** — The CloudFront → ALB hop must be TLS with no break. The VPC Origin must be `https-only` (443), and the origin domain must be set to the **public FQDN** (e.g. `awsops.example.com`) so SNI matches the ALB certificate.
3. **ALB certificate / listener** — The internal ALB must listen on HTTPS:443 with a **regional ACM certificate** (CloudFront's cert is in us-east-1, but the ALB uses a regional ACM cert).
4. **ALB security group** — The single most common cause of 504. The ALB SG must allow 443 from the **CloudFront managed security group** `CloudFront-VPCOrigins-Service-SG`. Allowing only the VPC CIDR blocks the traffic and produces a 504.

:::tip
A 504 is almost always because the **ALB SG does not allow the CloudFront managed SG**. A VPC-CIDR-only rule does not work. Check that 443 inbound from `CloudFront-VPCOrigins-Service-SG` is allowed first.
:::

:::info
A VPC Origin's protocol cannot be changed in place. To change the `https-only` setting, Terraform needs `create_before_destroy` + a resource replace (`-replace`).
:::

## I can't log in

AWSops uses a self-hosted login form (`/login`). If you hit a protected page while unauthenticated, the edge (Lambda@Edge) redirects you to `/login` automatically.

1. **Use the login form** — Enter your username and password at `/login`. The BFF (`POST /api/auth/login`) calls Cognito `InitiateAuth(USER_PASSWORD_AUTH)` and, on success, issues an `awsops_token` cookie (id_token, valid 12 hours).
2. **Credential errors** — Login is rejected if the username/password is wrong or the user does not exist in the Cognito User Pool. Ask an administrator to reset the password or create the user.
3. **Check cookies** — If login succeeds but you keep getting bounced to `/login`, verify the `awsops_token` cookie was set. It is HttpOnly (not readable from JavaScript), so check Browser DevTools → Application → Cookies. If it has expired (12 hours), just log in again.
4. **Log out and back in** — If your session is in a bad state, log out (clears the cookie → `/login`) and log in again. There is no separate Hosted UI `/logout` round-trip.

:::info
The edge performs **full RS256 JWKS signature verification** (including iss/aud/token_use), not just an expiry check. Forged tokens or tokens minted by a different User Pool are rejected. The Cognito Hosted UI PKCE flow (`/_callback`) is retained only as a dark fallback; normal login uses the `/login` form.
:::

## I get a 403 on admin screens (settings / customization)

Admin features are protected by an additional **server-side admin gate**, independent of login. One of the following must be true to pass:

- The logged-in user belongs to the Cognito **admins group**, or
- The user's email is in the SSM **admin-email allowlist**.

If both are empty, every user is denied with a fail-closed 403 (the safe default). Adding the user to the admins group or registering the email in the SSM allowlist resolves it.

## Data is not showing up

Empty data usually comes from one of three causes: (a) not connected to Aurora (app state), (b) insufficient live-AWS-query permissions, or (c) inventory sync never ran.

1. **Check session / auth** — First confirm your login session is valid. An expired token causes API calls to be rejected, which can make the screen look empty (see "I can't log in" above).
2. **Check Aurora connectivity** — App state (chat threads, diagnosis reports, the job queue, etc.) all lives in Aurora. Use the `/api/db` health check to confirm the DB ping is healthy. A failure points to the DB itself or a network/secret problem.
3. **Live AWS query permissions** — Real-time AWS data (EC2/IAM, etc.) is read through AgentCore MCP tools (read-only). If only certain sections are empty, that service's `Describe*`/`List*` permissions may be blocked (SCP/IAM). Cost data needs **Cost Explorer permissions**; metrics need **CloudWatch permissions**.
4. **Inventory sync** — If an inventory page's table is empty, the inventory sync (`steampipe_enabled` flag, default OFF) may not have run. Inventory sync is a separate batch sync feature and is independent of live queries (MCP).

:::tip
If only **specific pages** are empty → it's most likely a **AWS API permission** issue (SCP/IAM) for that service. If **every page** is empty → it's most likely a **session expiry** or **Aurora connectivity** issue.
:::

## Some data is missing due to SCP blocking

When SCP (Service Control Policy) or an IAM boundary blocks specific AWS APIs, only that data is partially missing.

| Blocked API example | Impact |
|---------------------|--------|
| `iam:ListMFADevices` | Cannot query MFA status |
| `ce:GetCostAndUsage` | Cannot query Cost data |
| `cloudwatch:GetMetricData` | Cannot query metrics/graphs |

Because AWSops is read-only, blocked APIs simply render as empty for that item while everything else works. If you need the missing data, add read permission for that API. When a partial query is possible without permission changes, asking the AI assistant returns whatever data is available.

## Pages load slowly

The AWSops web app runs on ECS Fargate from a **prebuilt standalone image**. Unlike the legacy setup that ran `npm run dev` on a host, no build step is injected at runtime. If a specific page is still slow, check the following.

1. **Heavy work goes to the async worker** — Long/large/OOM-risk work (e.g. AI comprehensive diagnosis, report export) is not run inline by the web app — it is enqueued to the async worker queue. The screen shows the job status and fills in the result once it completes. Not responding instantly is normal.
2. **Live AWS query latency** — AWS APIs such as Cost Explorer or CloudWatch can be slow (tens of seconds). In that case the screen is fine but the data takes time to populate.
3. **Rolling deploy** — Right after a deploy (ECS rolling via `make deploy`), responses can be briefly slow. Things normalize once the roll completes and `/api/health` stabilizes.

## ECS task cycles through UNHEALTHY (operators)

If a Fargate task keeps going UNHEALTHY after a deploy and the circuit breaker rolls it back, it's almost always one of these three.

1. **Missing `HOSTNAME=0.0.0.0` runtime env** — When deploying Next.js standalone in a container, you must set `HOSTNAME=0.0.0.0` in the task definition's `environment`. An image ENV is not enough — ECS overwrites HOSTNAME with the ENI IP, so the app binds neither 0.0.0.0 nor loopback and the health check fails.
2. **Health check path mismatch** — The container and target-group health check path must exactly match the app's `/api/health`. A mismatch produces a circuit-breaker loop.
3. **Fargate worker Dockerfile must use `CMD` (not ENTRYPOINT)** — The Fargate worker image must use `CMD`. With an exec-form `ENTRYPOINT`, the Step Functions `containerOverrides.command` is appended to ENTRYPOINT, doubling argv and breaking argparse.

:::tip
The most common cause is not setting `HOSTNAME=0.0.0.0` as a **task-definition runtime env (not an image ENV)**. If the health check fails immediately, check this first.
:::

## ECS task fails at startup with ResourceInitializationError (operators)

If a task fails to even start with `ResourceInitializationError`, it's a permissions problem on the `secrets` valueFrom that injects the Aurora secret.

ECS `secrets` valueFrom (such as the Aurora secret) needs **execution-role** permissions — not the task role. Verify the execution role has `secretsmanager:GetSecretValue` for that secret.

## AI comprehensive diagnosis fails or stalls

AI diagnosis is not run inline by the web app — it's a read-only report generated in the background by the **async worker tier** (base = 8 sections / deep = 15 sections). So "no response yet" does not necessarily mean "failed."

1. **Check the job status first** — Requesting a diagnosis enqueues a job that the worker processes. Watch the job status on the report screen (queued → running → succeeded/failed). `running` means it's progressing normally.
2. **If it ended as `failed`** — When the worker fails, the status is recorded as failed. Re-requesting the same diagnosis retries it (jobs are idempotent on `job_id`).
3. **deep + Opus model** — Selecting the Opus model for a deep diagnosis (15 sections) applies a cost gate and takes longer. For a faster result, use base diagnosis with the default Sonnet.
4. **Data permissions** — Diagnosis reads live AWS data, so sections backed by a blocked API (Cost/CloudWatch, etc.) may render empty (see "SCP blocking" above). That is a data-availability issue, not a diagnosis failure.

:::info
Stale jobs are reconciled automatically by the reaper (every 5 minutes). A job whose worker died without updating status is eventually cleaned up as failed — if a job never reaches `succeeded` after a long wait, retry it.
:::

## The AI assistant gives odd answers or permission errors

The AI assistant reads live AWS data with read-only tools (about 120) and persists conversations in Aurora.

1. **Read-only by design** — AWSops never changes AWS resources. A request to "modify/delete a resource" being refused — or answered only as diagnosis/guidance — is expected behavior (permanent read-only posture).
2. **Permission errors** — If a particular query fails with AccessDenied, read permission for that service is blocked. The blocked scope is excluded from the answer and the assistant responds with whatever data it can read.
3. **Conversation disappeared** — Conversations are persisted in Aurora and can be reopened from the sidebar. If you don't see them, the session (login) likely changed or expired.

## A datasource (Prometheus/Loki, etc.) won't connect

The read-only connectors on `/datasources` (Prometheus · Loki · Tempo · ClickHouse · Mimir, etc.) query external observability backends through connector Lambdas.

1. **Endpoint reachability** — The connector must be able to reach the endpoint over the network. Private endpoints need a VPC path.
2. **SSRF guard** — Connector input is SSRF-protected. Connections to internal addresses such as metadata/IMDS are blocked. Pointing at an internal address may be rejected.
3. **Credentials** — Backends that require authentication use credentials stored in Secrets Manager. On 401/403, verify the secret is correct.
4. **Response size** — Connector input is size-bounded (bound applied before parsing). Excessively large payloads are rejected.

## Notifications aren't reaching external destinations (Slack/tickets)

External record/ticket/message writes are an optional feature governed by policy, and may be flag-OFF by default.

1. **Feature enablement** — External writes are gated on governance (destination allowlist · secrets · DLP/redaction · human-gate · flag). If disabled, no message is sent.
2. **Destination allowlist** — If the target (channel/endpoint) is not on the allowlist, the send is blocked.
3. **Credentials** — External service tokens/webhooks are stored in Secrets Manager. An expired or mistyped value makes the send fail.

:::info
An external write is the creation of a **data record (message/ticket)**, not an AWS-resource change. AWS-resource mutation and autonomous execution remain permanently frozen.
:::
