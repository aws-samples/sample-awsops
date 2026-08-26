# AWSops v2 — P1b: Cognito + Lambda@Edge Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** Put Cognito Hosted-UI authentication in front of the v2 edge — unauthenticated requests to `https://awsops-v2.example.com/` get 302-redirected to Cognito login; after login a JWT cookie (`awsops_token`) is set and the dashboard loads. Implemented in Terraform (Cognito) + a Python Lambda@Edge (us-east-1) attached to the CloudFront distribution's viewer-request.

**Architecture:** Ports v1's working auth (`scripts/05-setup-cognito.sh`, ADR-020) to Terraform + **root paths** (v2 dropped the `/awsops` basePath). Cognito User Pool + App Client (with secret) + Hosted-UI domain live in `ap-northeast-2`. The Lambda@Edge function (`python3.12`, **us-east-1**, no env vars → config inlined via `templatefile`) runs on viewer-request: passes the `/_callback` OAuth exchange, validates the `awsops_token` cookie's JWT `exp`, else redirects to the Cognito Hosted-UI `/login`.

**Tech Stack:** Terraform `>= 1.15`, AWS provider `~> 6.0` (+ `hashicorp/archive` for zipping the function), Cognito, Lambda@Edge (python3.12, us-east-1 via the `aws.use1` alias already in `providers.tf`), CloudFront.

**Builds on P1a:** the `foundation` module (`terraform/foundation/`) with the CloudFront distribution `aws_cloudfront_distribution.main` + `data.aws_route53_zone.main` + the `aws.use1` provider alias. Domain `awsops-v2.example.com`.

---

## ⚠️ Security note (carry-forward, must track)

The ported v1 function **decodes the JWT and checks `exp` only — it does NOT verify the RS256 signature** against Cognito's JWKS. This means a forged unsigned token with a future `exp` would pass. v1 ships this way; we port it for parity to get auth working, but **this is a real gap**. Hardening (fetch `https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/jwks.json`, verify signature) is a **required P1b follow-up before the real app serves sensitive data (P1d)** — tracked here and in the spec §6 risks. Do not close P1b as "secure" without it.

---

## File Structure

```
terraform/foundation/
  auth.tf                       # Cognito user pool + client(secret) + domain + admin user + Lambda@Edge + role
  edge-lambda/
    cognito_edge.py.tftpl       # Python Lambda@Edge source (templated — Cognito config injected at apply)
  edge.tf                       # (MODIFY) add lambda_function_association(viewer-request) to behaviors
  variables.tf                  # (MODIFY) add cognito_domain_prefix, admin_email, admin_password
```

`auth.tf` owns all auth resources; `edge.tf` only gains the association. The function source is a `.tftpl` so the Cognito IDs/secret are injected at apply (Lambda@Edge forbids env vars).

---

## Task B1: Cognito User Pool + App Client + Domain + Admin user

**Files:**
- Create: `terraform/foundation/auth.tf`
- Modify: `terraform/foundation/variables.tf`

- [ ] **Step 1: add variables to `variables.tf`**

```hcl
variable "cognito_domain_prefix" {
  type        = string
  description = "Globally-unique Cognito Hosted-UI domain prefix (no 'aws', no symbols). Override if taken."
  default     = "awsops-v2-auth"
}

variable "admin_email" {
  type        = string
  description = "Initial Cognito admin user email"
}

variable "admin_password" {
  type        = string
  description = "Initial admin permanent password (>=8, upper+lower+number)"
  sensitive   = true
}
```

- [ ] **Step 2: write `auth.tf` — Cognito resources**

```hcl
resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project}-pool"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]
  mfa_configuration        = "OFF"

  password_policy {
    minimum_length    = 8
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false # ADR-020 known issue: symbols-required caused failures
  }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}

resource "aws_cognito_user_pool_client" "main" {
  name                                 = "${var.project}-client"
  user_pool_id                         = aws_cognito_user_pool.main.id
  generate_secret                      = true
  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true
  # v2 root paths (no /awsops basePath)
  callback_urls = ["https://${var.domain_name}/_callback"]
  logout_urls   = ["https://${var.domain_name}/"]
}

resource "aws_cognito_user" "admin" {
  user_pool_id   = aws_cognito_user_pool.main.id
  username       = var.admin_email
  password       = var.admin_password
  attributes = {
    email          = var.admin_email
    email_verified = true
  }
}
```

- [ ] **Step 3: add admin creds to `terraform.tfvars`** (gitignored; `make configure` will prompt these in P1e)

Append to `terraform/foundation/terraform.tfvars`:
```hcl
admin_email    = "ojs0106@gmail.com"
admin_password = "ChangeMe-123"   # pick a real one; >=8 upper+lower+number
```

- [ ] **Step 4: validate + apply**

```bash
cd terraform/foundation && terraform fmt && terraform validate && terraform plan -out tfplan && terraform apply tfplan
```
Expected: user pool, domain, client, admin user created. NO vpc/subnet/nat changes.

- [ ] **Step 5: verify**

```bash
POOL=$(terraform output -raw cognito_user_pool_id 2>/dev/null || aws cognito-idp list-user-pools --max-results 20 --region ap-northeast-2 --query "UserPools[?Name=='awsops-v2-pool'].Id" --output text)
aws cognito-idp describe-user-pool-domain --domain awsops-v2-auth --region ap-northeast-2 --query 'DomainDescription.Status' --output text
```
Expected: domain status `ACTIVE`. (Hosted UI: `https://awsops-v2-auth.auth.ap-northeast-2.amazoncognito.com`.)

- [ ] **Step 6: add Cognito outputs to `outputs.tf` + commit**

Append to `outputs.tf`:
```hcl
output "cognito_user_pool_id" { value = aws_cognito_user_pool.main.id }
output "cognito_client_id"    { value = aws_cognito_user_pool_client.main.id }
output "cognito_hosted_ui"    { value = "https://${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com" }
```
```bash
git add terraform/foundation/auth.tf terraform/foundation/variables.tf terraform/foundation/outputs.tf
git commit -m "feat(v2-p1b): Cognito user pool + client + domain + admin user"
```

---

## Task B2: Lambda@Edge function (Python, us-east-1)

**Files:**
- Create: `terraform/foundation/edge-lambda/cognito_edge.py.tftpl`
- Modify: `terraform/foundation/auth.tf` (append Lambda + role + archive)
- Modify: `terraform/foundation/backend.tf` (add `archive` provider)

- [ ] **Step 1: add the `archive` provider to `backend.tf`** (inside `required_providers`)

```hcl
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
```
(Then `terraform init` to install it.)

- [ ] **Step 2: write `edge-lambda/cognito_edge.py.tftpl`** (ported from v1, adapted to ROOT paths)

```python
import json, base64, urllib.request, urllib.parse, time

CONFIG = {
    'CLIENT_ID': '${client_id}',
    'CLIENT_SECRET': '${client_secret}',
    'COGNITO_DOMAIN': '${cognito_domain}',
    'CALLBACK_PATH': '/_callback',
}

def lambda_handler(event, context):
    request = event['Records'][0]['cf']['request']
    uri = request.get('uri', '')
    headers = request.get('headers', {})

    # OAuth2 callback: exchange code -> tokens, set cookie
    if uri == CONFIG['CALLBACK_PATH']:
        return handle_callback(request, headers)

    # Validate session cookie (exp only — see SECURITY NOTE in the plan)
    cookies = parse_cookies(headers)
    id_token = cookies.get('awsops_token', '')
    if id_token:
        try:
            payload = decode_jwt_payload(id_token)
            if payload.get('exp', 0) > time.time():
                return request
        except Exception:
            pass

    # Unauthenticated -> redirect to Cognito Hosted UI
    host = headers.get('host', [{}])[0].get('value', '')
    cb = f'https://{host}{CONFIG["CALLBACK_PATH"]}'
    url = (f'https://{CONFIG["COGNITO_DOMAIN"]}/login?'
           f'client_id={CONFIG["CLIENT_ID"]}&response_type=code&'
           f'scope=openid+email+profile&redirect_uri={urllib.parse.quote(cb)}')
    return {
        'status': '302', 'statusDescription': 'Found',
        'headers': {
            'location': [{'key': 'Location', 'value': url}],
            'cache-control': [{'key': 'Cache-Control', 'value': 'no-cache'}],
        },
    }

def handle_callback(request, headers):
    params = dict(urllib.parse.parse_qsl(request.get('querystring', '')))
    code = params.get('code', '')
    if not code:
        return {'status': '400', 'statusDescription': 'Bad Request', 'body': 'Missing authorization code'}
    host = headers.get('host', [{}])[0].get('value', '')
    cb = f'https://{host}{CONFIG["CALLBACK_PATH"]}'
    auth = base64.b64encode(f'{CONFIG["CLIENT_ID"]}:{CONFIG["CLIENT_SECRET"]}'.encode()).decode()
    data = urllib.parse.urlencode({
        'grant_type': 'authorization_code', 'code': code,
        'redirect_uri': cb, 'client_id': CONFIG['CLIENT_ID'],
    }).encode()
    req = urllib.request.Request(
        f'https://{CONFIG["COGNITO_DOMAIN"]}/oauth2/token', data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': f'Basic {auth}'})
    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except Exception as e:
        return {'status': '500', 'statusDescription': 'Server Error', 'body': str(e)}
    return {
        'status': '302', 'statusDescription': 'Found',
        'headers': {
            'location': [{'key': 'Location', 'value': f'https://{host}/'}],
            'set-cookie': [{'key': 'Set-Cookie',
                'value': f'awsops_token={tokens.get("id_token","")};Path=/;Secure;HttpOnly;SameSite=Lax;Max-Age=3600'}],
            'cache-control': [{'key': 'Cache-Control', 'value': 'no-cache'}],
        },
    }

def parse_cookies(headers):
    cookies = {}
    for c in headers.get('cookie', []):
        for p in c.get('value', '').split(';'):
            if '=' in p:
                k, v = p.strip().split('=', 1)
                cookies[k] = v
    return cookies

def decode_jwt_payload(token):
    p = token.split('.')[1]
    p += '=' * (4 - len(p) % 4)
    return json.loads(base64.urlsafe_b64decode(p))
```

> Note: Python f-strings use single braces `{host}` which `templatefile` leaves untouched; only `${client_id}` / `${client_secret}` / `${cognito_domain}` are substituted.

- [ ] **Step 3: append Lambda@Edge + role + archive to `auth.tf`**

```hcl
data "aws_iam_policy_document" "edge_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "edge" {
  name               = "${var.project}-edge-auth"
  assume_role_policy = data.aws_iam_policy_document.edge_assume.json
}

resource "aws_iam_role_policy_attachment" "edge_basic" {
  role       = aws_iam_role.edge.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

locals {
  edge_src = templatefile("${path.module}/edge-lambda/cognito_edge.py.tftpl", {
    client_id      = aws_cognito_user_pool_client.main.id
    client_secret  = aws_cognito_user_pool_client.main.client_secret
    cognito_domain = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.region}.amazoncognito.com"
  })
}

data "archive_file" "edge" {
  type        = "zip"
  output_path = "${path.module}/.build/cognito_edge.zip"
  source {
    content  = local.edge_src
    filename = "cognito_edge.py"
  }
}

resource "aws_lambda_function" "edge" {
  provider         = aws.use1 # Lambda@Edge MUST be us-east-1
  function_name    = "${var.project}-cognito-auth"
  runtime          = "python3.12"
  handler          = "cognito_edge.lambda_handler"
  role             = aws_iam_role.edge.arn
  filename         = data.archive_file.edge.output_path
  source_code_hash = data.archive_file.edge.output_base64sha256
  timeout          = 5
  memory_size      = 128
  publish          = true # versioned ARN required for Lambda@Edge
}
```

- [ ] **Step 4: init (for archive provider) + validate + apply**

```bash
cd terraform/foundation
terraform init -backend-config=backend.hcl     # installs hashicorp/archive
terraform fmt && terraform validate && terraform plan -out tfplan && terraform apply tfplan
```
Expected: edge role + Lambda function (us-east-1) + published version created.

- [ ] **Step 5: verify + add `.build/` to .gitignore + commit**

```bash
aws lambda get-function --function-name awsops-v2-cognito-auth --region us-east-1 --query 'Configuration.{Runtime:Runtime,Version:Version}' --output json
grep -q 'terraform/\*\*/.build' .gitignore || printf '%s\n' 'terraform/**/.build/' >> .gitignore
git add terraform/foundation/auth.tf terraform/foundation/edge-lambda/cognito_edge.py.tftpl terraform/foundation/backend.tf .gitignore
git commit -m "feat(v2-p1b): Lambda@Edge cognito auth function (python3.12, us-east-1)"
```

---

## Task B3: Attach Lambda@Edge to CloudFront viewer-request

**Files:** Modify `terraform/foundation/edge.tf`

- [ ] **Step 1: add `lambda_function_association` to BOTH cache behaviors**

In `aws_cloudfront_distribution.main`, add to `default_cache_behavior` AND to `ordered_cache_behavior`:
```hcl
    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge.qualified_arn
      include_body = false
    }
```
(`qualified_arn` is the versioned ARN Lambda@Edge requires.)

- [ ] **Step 2: validate + apply (SLOW — Lambda@Edge replicates to edge POPs)**

```bash
cd terraform/foundation && terraform fmt && terraform validate && terraform plan -out tfplan && terraform apply tfplan
```
Expected: distribution updated. **Lambda@Edge replication + CloudFront deploy take 5–15+ min.** Be patient.

- [ ] **Step 3: verify unauthenticated redirect**

```bash
for i in $(seq 1 20); do
  loc=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 15 https://awsops-v2.example.com/)
  echo "attempt $i: $loc"; echo "$loc" | grep -q '302' && echo "$loc" | grep -qi 'amazoncognito.com/login' && break; sleep 30
done
```
Expected: eventually **`302`** with a `Location` to `https://awsops-v2-auth.auth.ap-northeast-2.amazoncognito.com/login?client_id=...`. (The `/healthz` ALB target health check is origin-direct, unaffected — ECS target stays healthy.)

- [ ] **Step 4: commit**

```bash
git add terraform/foundation/edge.tf
git commit -m "feat(v2-p1b): attach Cognito Lambda@Edge to CloudFront viewer-request"
```

---

## Task B4: End-to-end login verification (manual, browser)

**Files:** none (verification + VERIFY note)

- [ ] **Step 1: browser login flow**
  1. Open `https://awsops-v2.example.com/` → should redirect to the Cognito Hosted UI login.
  2. Log in with `admin_email` / `admin_password`.
  3. Cognito redirects to `https://awsops-v2.example.com/_callback?code=...` → the Lambda exchanges the code, sets `awsops_token`, redirects to `/`.
  4. The spine page (`AWSops v2 spine — ok (root)`) loads (now authenticated).

- [ ] **Step 2: confirm cookie gating**
  - In a fresh/incognito session, `/` redirects to login (302). After login, reload `/` → loads without redirect (cookie present, `exp` valid).

- [ ] **Step 3: record in `VERIFY.md` + commit**
  Append a "P1b auth" section to `terraform/foundation/VERIFY.md` with the actual results (redirect to Cognito ✓, login → cookie → dashboard ✓) and a TODO line for the JWT-signature-verification hardening (see Security note).
  ```bash
  git add terraform/foundation/VERIFY.md
  git commit -m "test(v2-p1b): verify Cognito Hosted-UI auth end-to-end"
  ```

---

## Self-Review

**Spec coverage (design §6 auth, ADR-020 parity):** Cognito User Pool/client/domain (B1), Lambda@Edge viewer-request auth (B2), CloudFront attach (B3), e2e verify (B4). ✓ Root-path adaptation (`/_callback`, redirect to `/`) reflects the basePath-drop decision. ✓

**Placeholder scan:** none. `admin_password` default `ChangeMe-123` in the tfvars step is a real-format placeholder the operator replaces (gitignored file) — flagged inline, not a code placeholder.

**Type/name consistency:** `aws_cognito_user_pool.main`, `aws_cognito_user_pool_client.main`, `aws_cognito_user_pool_domain.main`, `aws_lambda_function.edge` (+ `.qualified_arn`), `aws_iam_role.edge`, function name `awsops-v2-cognito-auth`, cookie `awsops_token`, callback `/_callback`. Consistent across tasks.

**Known gap (tracked):** JWT signature NOT verified (exp-only) — port parity with v1; hardening required before P1d real-data serving (see Security note).

---

## Execution Handoff
Subagent-driven, auto plan+apply (operator's standing choice). B1 (Cognito) is fast; B2 adds the archive provider + Lambda; **B3 is slow (Lambda@Edge replication 5–15+ min)**; B4 is a manual browser login.
