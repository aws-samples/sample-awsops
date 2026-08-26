# AWSops v2 — P1e: EKS Onboarding (Access Entry + configure TUI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **Long/shared-infra applies: controller runs them via saved-tfplan (`-auto-approve` is gated); EKS Access Entry apply is fast.**

**Goal:** Add EKS multi-select to `make configure` → tfvars, and have Terraform grant the v2 **web task role** (`awsops-v2-task`) a read-only **Access Entry** (AmazonEKSViewPolicy) on each onboarded host-account cluster, plus the IAM `eks:DescribeCluster`/`ListClusters` it needs to build a kubeconfig. Cluster connection info is exposed via `terraform output` for P3 to consume.

**Architecture:** Host-account EKS clusters are already `API_AND_CONFIG_MAP` (Access Entry capable). `configure.mjs` discovers clusters via `eks:ListClusters`, preflights each cluster's auth mode (CONFIG_MAP-only → handoff list), and writes `onboard_eks_clusters = [...]` to `terraform.tfvars`. A new `terraform/foundation/eks.tf` iterates that list with `for_each`: `aws_eks_access_entry` + `aws_eks_access_policy_association` (cluster-scope View) bound to the web task role, plus a task-role IAM policy. **Out of scope (3-AI cross-review decision):** OpenCost (→ P3, as a UI-button + ADR-029 mutating action), multi-account (host only), web code (P3 consumes the outputs). config.json/feature flags not created here.

**Tech Stack:** Terraform `aws_eks_access_entry` / `aws_eks_access_policy_association` / `aws_eks_cluster` data source, AWS CLI `eks`, Node `@inquirer/prompts`.

**Builds on P1d:** `aws_iam_role.task` (web task role, `${var.project}-task`) exists in `terraform/foundation/workload.tf`. `configure.mjs` already writes `terraform.tfvars` (domain/VPC) — this extends it.

---

## File Structure

```
terraform/foundation/
  eks.tf                 # NEW — onboard_eks_clusters var, access entry + policy assoc + task-role EKS IAM, outputs
scripts/v2/configure.mjs # MODIFY — EKS discovery + preflight + multi-select → onboard_eks_clusters tfvars
```

(No new files elsewhere. `variables.tf`/`outputs.tf` are left alone — the EKS var + outputs live in `eks.tf` to keep the feature self-contained.)

---

## Task E1: EKS Access Entry Terraform (`eks.tf`)

**Files:** Create `terraform/foundation/eks.tf`.

- [ ] **Step 1: write `terraform/foundation/eks.tf`**
```hcl
variable "onboard_eks_clusters" {
  type        = list(string)
  description = "Host-account EKS cluster names to grant the web task role read access (Access Entry). Written by `make configure`."
  default     = []
}

# Look up each onboarded cluster (validates existence + exposes endpoint/CA for P3 kubeconfig).
data "aws_eks_cluster" "onboard" {
  for_each = toset(var.onboard_eks_clusters)
  name     = each.value
}

# Access Entry: register the web task role as a STANDARD principal on each cluster.
resource "aws_eks_access_entry" "web" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  type          = "STANDARD"
}

# Bind the AWS-managed read-only View policy at cluster scope.
resource "aws_eks_access_policy_association" "web_view" {
  for_each      = toset(var.onboard_eks_clusters)
  cluster_name  = each.value
  principal_arn = aws_iam_role.task.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.web]
}

# IAM the web task role needs to discover clusters + build a kubeconfig (P3 consumes this).
resource "aws_iam_role_policy" "task_eks" {
  count = length(var.onboard_eks_clusters) > 0 ? 1 : 0
  name  = "${var.project}-task-eks-read"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["eks:DescribeCluster", "eks:ListClusters", "eks:DescribeAccessEntry"]
      Resource = "*"
    }]
  })
}

output "onboarded_eks_clusters" {
  description = "Onboarded EKS clusters → endpoint/ARN (for P3 dashboard kubeconfig registration)."
  value = {
    for k, c in data.aws_eks_cluster.onboard : k => {
      endpoint                   = c.endpoint
      arn                        = c.arn
      certificate_authority_data = c.certificate_authority[0].data
    }
  }
}
```

- [ ] **Step 2: validate (no apply yet — apply is E3 with a real cluster list)**
```bash
cd terraform/foundation
terraform fmt && terraform validate
```
Expected: `Success! The configuration is valid.` With `onboard_eks_clusters = []` (default), `for_each` over an empty set creates nothing — so this is a safe no-op until E3 sets the list.

- [ ] **Step 3: commit**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/eks.tf
git commit -m "feat(v2-p1e): EKS Access Entry + View policy + task-role EKS IAM (for_each onboard_eks_clusters)"
```

---

## Task E2: EKS multi-select in `configure.mjs`

**Files:** Modify `scripts/v2/configure.mjs`.

- [ ] **Step 1: add EKS helpers** — after the existing `describeNatGatewayIds` function (around line 94), add:
```js
/** List EKS cluster names in REGION. */
function listEksClusters() {
  const data = awsJson(['eks', 'list-clusters', '--region', REGION]);
  return data.clusters || [];
}

/** Cluster authentication mode (API / API_AND_CONFIG_MAP / CONFIG_MAP). */
function eksAuthMode(name) {
  try {
    const d = awsJson(['eks', 'describe-cluster', '--name', name, '--region', REGION]);
    return (d.cluster && d.cluster.accessConfig && d.cluster.accessConfig.authenticationMode) || 'CONFIG_MAP';
  } catch {
    return 'UNKNOWN';
  }
}
```

- [ ] **Step 2: add the EKS selection flow** — in `main()`, immediately AFTER the `if (vpcMode === 'new') { ... }` block (around line 302, before `const cfg = {`), add:
```js
  // EKS onboarding (optional). Access Entry requires an API-capable auth mode.
  let onboardEksClusters = [];
  console.log('');
  console.log(`Discovering EKS clusters in ${REGION}...`);
  const eksClusters = listEksClusters();
  if (eksClusters.length === 0) {
    console.log('  No EKS clusters found. Skipping EKS onboarding.');
  } else {
    const usable = [];
    const handoff = [];
    for (const name of eksClusters) {
      const mode = eksAuthMode(name);
      (mode.startsWith('API') ? usable : handoff).push({ name, mode });
    }
    if (handoff.length > 0) {
      console.log('');
      console.log('  These clusters are CONFIG_MAP-only (Access Entry unavailable).');
      console.log('  Switch them to API_AND_CONFIG_MAP, or grant access manually:');
      handoff.forEach((c) => console.log(`    - ${c.name} (${c.mode})`));
    }
    if (usable.length > 0) {
      onboardEksClusters = await checkbox({
        message: 'Select EKS clusters to grant the dashboard read access (Access Entry):',
        choices: usable.map((c) => ({ name: `${c.name}  (${c.mode})`, value: c.name })),
      });
    }
  }
```

- [ ] **Step 3: thread `onboardEksClusters` into `cfg`** — in the `const cfg = { ... }` object (around line 304), add the field:
```js
    onboardEksClusters,
```
(Add it after `existingPrivateSubnetIds,`.)

- [ ] **Step 4: write it to tfvars** — in `buildTfvars(cfg)` (around line 113), before the final `return`, add:
```js
  if (cfg.onboardEksClusters && cfg.onboardEksClusters.length > 0) {
    lines.push(`onboard_eks_clusters = ${hclStringList(cfg.onboardEksClusters)}`);
  }
```

- [ ] **Step 5: show it in the summary** — in the Summary block (around line 331, after the VPC lines), add:
```js
  console.log(
    `  EKS onboard      : ${cfg.onboardEksClusters.length ? cfg.onboardEksClusters.join(', ') : '(none)'}`,
  );
```

- [ ] **Step 6: syntax check + commit**
```bash
cd /home/atomoh/awsops
node --check scripts/v2/configure.mjs && echo "syntax OK"
git add scripts/v2/configure.mjs
git commit -m "feat(v2-p1e): configure.mjs — EKS discovery + auth-mode preflight + multi-select to onboard_eks_clusters"
```
Expected: `syntax OK`. (Full interactive run is exercised in E3 via a real tfvars value; the TUI itself isn't unit-testable without a TTY.)

---

## Task E3: onboard one cluster + apply + verify

**Files:** Modify `terraform/foundation/terraform.tfvars` (gitignored — operator input).

- [ ] **Step 1: add a cluster to tfvars** (simulates the `make configure` selection; `fsi-demo-cluster` is API_AND_CONFIG_MAP)
```bash
cd /home/atomoh/awsops/terraform/foundation
grep -q '^onboard_eks_clusters' terraform.tfvars || echo 'onboard_eks_clusters = ["fsi-demo-cluster"]' >> terraform.tfvars
tail -3 terraform.tfvars
```

- [ ] **Step 2: plan + apply** (Access Entry create is fast; controller runs the saved plan)
```bash
cd terraform/foundation
terraform plan -out tfplan -no-color 2>&1 | grep -E "^  # |^Plan:|must be replaced" | head
```
Expected plan: add `data.aws_eks_cluster.onboard["fsi-demo-cluster"]` (read), `aws_eks_access_entry.web[...]`, `aws_eks_access_policy_association.web_view[...]`, `aws_iam_role_policy.task_eks[0]`, + the output. NO changes to web/ECS/ALB/edge/Aurora. Then:
```bash
terraform apply tfplan
cd /home/atomoh/awsops
```

- [ ] **Step 3: verify the Access Entry exists** (the web task role is now bound to the cluster)
```bash
aws eks list-access-entries --cluster-name fsi-demo-cluster --region ap-northeast-2 \
  --query "accessEntries[?contains(@, 'awsops-v2-task')]" --output text
aws eks list-associated-access-policies --cluster-name fsi-demo-cluster \
  --principal-arn arn:aws:iam::123456789012:role/awsops-v2-task --region ap-northeast-2 \
  --query 'associatedAccessPolicies[].policyArn' --output text
terraform -chdir=terraform/foundation output onboarded_eks_clusters
```
Expected: the task-role ARN listed as an access entry; `AmazonEKSViewPolicy` associated; the output map shows `fsi-demo-cluster` → endpoint/arn/CA.

- [ ] **Step 4: commit + update memory**
```bash
cd /home/atomoh/awsops
git add terraform/foundation/eks.tf  # if any fmt drift; tfvars is gitignored
git commit -m "feat(v2-p1e): onboard fsi-demo-cluster (web task role Access Entry verified)" --allow-empty
```
Then update `/home/atomoh/.claude/projects/-home-atomoh-awsops/memory/awsops-v2-effort.md`: mark **P1e DONE** (EKS Access Entry + configure TUI; host-account; OpenCost deferred to P3 per 3-AI review). Add a **P3 backlog** note: "OpenCost install = UI button → ADR-029 mutating action (SQS+SFN worker / ECS one-shot, not raw Lambda) — user's idea, 3-AI-endorsed."

---

## Self-Review

**Spec coverage (§8.1 EKS onboarding):** auto-discovery (`eks:ListClusters`) → E2 Step1-2 ✓; TUI multi-select → tfvars → E2 Step2-4 ✓; `terraform apply` Access Entry + AccessPolicy → E1 + E3 ✓; preflight handoff for non-API clusters → E2 Step2 ✓; kubeconfig info for dashboard → E1 output (P3 consumes) ✓. **Deferred by 3-AI decision:** OpenCost (P3), multi-account assume-role (host only), web auto-registration (P3). config.json/flags not in scope.

**Placeholder scan:** none — all HCL/JS is concrete. `AmazonEKSViewPolicy` ARN and the task-role ARN are real (verified). `fsi-demo-cluster` is a real API_AND_CONFIG_MAP cluster.

**Type/name consistency:** `var.onboard_eks_clusters` (list(string)) ← `configure.mjs` `hclStringList(cfg.onboardEksClusters)`; `aws_iam_role.task` (P1d) is the principal; `aws_eks_access_entry.web` / `aws_eks_access_policy_association.web_view` consistent; output `onboarded_eks_clusters`. `data.aws_eks_cluster.onboard[*].certificate_authority[0].data` is the correct attribute.

**Note:** `for_each` over an empty default list = zero resources, so E1 is a safe no-op merge; E3's tfvars value is what activates it. Cluster auth mode is `API_AND_CONFIG_MAP` (verified) so Access Entry works without flipping the cluster.

## Execution Handoff
Subagent-driven for E1/E2 (code+validate). E3 apply is fast (Access Entry, not CloudFront/SG) — controller runs `terraform apply tfplan` (saved plan; `-auto-approve` is gated). Then verify + memory.
