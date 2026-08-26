# AWSops v2 — P1a: Terraform 기반 인프라 + Private 엣지 + Spine 구현 계획

> **에이전트 작업자용:** 필수 SUB-SKILL: 이 계획은 superpowers:subagent-driven-development(권장) 또는 superpowers:executing-plans로 Task 단위 실행한다. Step은 체크박스(`- [ ]`)로 진행 추적.

**목표:** v2 인프라 spine을 세운다 — 완전히 새로운 VPC를, **오직 private 엣지(CloudFront → VPC Origin → internal ALB → ECS Fargate)** 를 통해서만 도달 가능하게 만들고, 헬스 엔드포인트와 SSE 스트림을 end-to-end로 제공함을 증명한다. 전부 Terraform + 원격 상태로 구성.

**아키텍처:** `bootstrap` 루트 모듈이 S3 원격 상태 백엔드(S3 네이티브 상태 락)를 만든다. 이어서 `foundation` 루트 모듈이 네트워크(VPC/서브넷/NAT), 일회용 "spine" Fargate 서비스(약 40줄 Node SSE/헬스 서버), **internal** ALB, 그리고 **VPC Origin**을 통해 internal ALB에 도달하는 CloudFront 배포를 구축한다 (internet-facing LB 없음, CloudFront prefix-list 꼼수 없음). spine 컨테이너는 엣지 경로 검증용일 뿐이며 P1d에서 실제 Next.js 이미지로 교체된다.

**기술 스택:** Terraform `>= 1.15`, AWS provider `~> 6.0` (6.47+; CloudFront VPC origin은 5.73+/6.x에 존재, S3 네이티브 상태 락은 TF 1.10+), ECS Fargate (ARM64), CloudFront, ACM (us-east-1), Route53, Node 20 (spine 컨테이너), Docker buildx (linux/arm64).

**범위 밖 (후속 sub-plan):** Cognito/Lambda@Edge 인증(P1b), Aurora(P1c), CI/CD + 실제 앱 이미지(P1d), `make configure` TUI + EKS 모듈(P1e), AgentCore provisioner(P1f). P1a는 spine을 **인증 없이** 배포한다 — P1a 동안에는 의도적으로 공개 상태이며, 실제 데이터를 서빙하기 전 P1b에서 잠근다.

---

## 사전 조건 (Prerequisites)

시작 전에 확인 (이건 구축 Step이 아니라 환경 전제):

- VPC/ECS/CloudFront/ACM/Route53/S3/ECR/IAM을 생성할 수 있는 **호스트 계정**의 admin 수준 AWS 자격 증명.
- Terraform `>= 1.15`, Docker + `buildx` 로컬 설치.
- 상위 도메인(`example.com`)의 Route53 **public hosted zone**이 존재해야 함. 확인:
  ```bash
  aws route53 list-hosted-zones-by-name --dns-name example.com \
    --query "HostedZones[0].{Name:Name,Id:Id}" --output table
  ```
  기대값: `example.com.` 와 `/hostedzone/ZXXXX` Id가 표시되는 행.
- v2 서브도메인은 **`v2.example.com`** (v1 `awsops.*` 및 dev `awsops-dev.example.com`와 구분). 아직 resolve되면 안 됨:
  ```bash
  dig +short v2.example.com
  ```
  기대값: 빈 출력.
- 리전: `ap-northeast-2` (주). CloudFront ACM 인증서는 `us-east-1`.
- VPC CIDR `10.20.0.0/16` — v1과 겹치지 않도록 선택. 만약 v1이 이미 `10.20.0.0/16`을 쓰면 Task 3에서 `var.vpc_cidr`를 일관되게 변경.

---

## 파일 구조 (File Structure)

```
terraform/
  bootstrap/
    main.tf            # S3 상태 버킷 (S3 네이티브 락; local state)
    variables.tf       # region, project, 버킷 이름
    outputs.tf         # 버킷명 (foundation/backend.tf에 입력)
  foundation/
    backend.tf         # partial s3 backend (backend.hcl로 주입 — OSS-portable)
    providers.tf       # aws (ap-northeast-2) + aws.use1 (us-east-1) alias
    variables.tf       # domain, vpc_cidr, azs, image_tag 등
    network.tf         # VPC, public 2 + private 2 서브넷, IGW, NAT, route
    workload.tf        # ECR repo, ECS cluster, task def(spine), internal ALB, TG, service, SG
    edge.tf            # ACM(us-east-1) + DNS 검증, CloudFront VPC Origin, distribution, Route53 alias
    outputs.tf         # cloudfront domain, alb arn, ecr uri, distribution id 등
    terraform.tfvars.example
    backend.hcl.example   # partial backend 설정 예시 (실제 backend.hcl은 gitignored)
spine/
  server.js            # 약 40줄 Node http 서버: /awsops/healthz + /awsops/api/stream (SSE)
  Dockerfile           # node:20-alpine, arm64
```

각 파일은 단일 책임: `network.tf`=연결성, `workload.tf`=컴퓨트+LB, `edge.tf`=CloudFront/ACM/DNS 엣지. 셋은 하나의 Terraform state를 공유한다(spine은 단일 배포 단위). 후속 sub-plan(Aurora, AI)은 `terraform/` 아래 각자의 루트 모듈 + state key를 가진다.

---

## Task 1: 원격 상태 백엔드 (bootstrap 모듈)

**파일:**
- 생성: `terraform/bootstrap/main.tf`
- 생성: `terraform/bootstrap/variables.tf`
- 생성: `terraform/bootstrap/outputs.tf`

- [ ] **Step 1: `variables.tf` 작성**

```hcl
variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally-unique S3 bucket for Terraform state. Override per account."
  default     = "awsops-v2-tfstate"
}
```

- [ ] **Step 2: `main.tf` 작성**

```hcl
terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "bootstrap"
    }
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.state_bucket_name
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
```

- [ ] **Step 3: `outputs.tf` 작성**

```hcl
output "state_bucket" {
  value = aws_s3_bucket.state.id
}
```

- [ ] **Step 4: init + validate**

실행:
```bash
cd terraform/bootstrap && terraform init && terraform fmt && terraform validate
```
기대값: `Success! The configuration is valid.`

- [ ] **Step 5: plan + apply**

실행:
```bash
terraform plan -out tfplan && terraform apply tfplan
```
기대값: 4개 리소스 생성(`aws_s3_bucket.state`, versioning, encryption, public_access_block). 버킷명이 글로벌하게 충돌하면 `-var state_bucket_name=awsops-v2-tfstate-<account-id>`로 재실행하고, 선택한 이름을 Task 2용으로 기록.

- [ ] **Step 6: 검증**

실행:
```bash
aws s3api head-bucket --bucket "$(terraform output -raw state_bucket)" && echo "BUCKET_OK"
```
기대값: `BUCKET_OK`.

- [ ] **Step 7: 커밋**

```bash
git add terraform/bootstrap
git commit -m "feat(v2-p1a): terraform remote-state backend (S3 + native locking)"
```

---

## Task 2: foundation 스켈레톤 — backend + providers + variables

**파일:**
- 생성: `terraform/foundation/backend.tf`
- 생성: `terraform/foundation/providers.tf`
- 생성: `terraform/foundation/variables.tf`
- 생성: `terraform/foundation/terraform.tfvars.example`
- 생성: `terraform/foundation/backend.hcl.example`

- [ ] **Step 1: `backend.tf` 작성** (partial backend — 버킷명을 박지 않고 `backend.hcl`로 주입; OSS-portable)

```hcl
terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Partial backend: OSS-portable, 버킷명을 박지 않음. init 시
  # `-backend-config=backend.hcl`로 주입 (make configure가 생성).
  backend "s3" {}
}
```

- [ ] **Step 2: `providers.tf` 작성** (`use1` alias는 필수 — CloudFront 인증서는 us-east-1이어야 함)

```hcl
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "foundation"
    }
  }
}

provider "aws" {
  alias  = "use1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
      Module    = "foundation"
    }
  }
}
```

- [ ] **Step 3: `variables.tf` 작성**

```hcl
variable "region" {
  type    = string
  default = "ap-northeast-2"
}

variable "project" {
  type    = string
  default = "awsops-v2"
}

variable "domain_name" {
  type        = string
  description = "Public FQDN served by CloudFront, e.g. v2.example.com"
}

variable "hosted_zone_name" {
  type        = string
  description = "Route53 public hosted zone, e.g. example.com"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "azs" {
  type        = list(string)
  description = "Two AZs for subnets"
  default     = ["ap-northeast-2a", "ap-northeast-2c"]
}

variable "image_tag" {
  type        = string
  description = "Spine image tag in ECR"
  default     = "spine-latest"
}
```

- [ ] **Step 4: `terraform.tfvars.example` + `backend.hcl.example` 작성**

`terraform.tfvars.example`:
```hcl
domain_name      = "v2.example.com"
hosted_zone_name = "example.com"
# vpc_cidr       = "10.20.0.0/16"   # 오버라이드하려면 주석 해제
```

`backend.hcl.example` (OSS-portable — 고객이 자기 버킷명으로 복사):
```hcl
bucket       = "awsops-v2-tfstate"   # Task 1에서 만든 전역 유일 버킷명
key          = "foundation/terraform.tfstate"
region       = "ap-northeast-2"
encrypt      = true
use_lockfile = true                  # TF 1.10+ S3 네이티브 락 (DynamoDB 불필요)
```

- [ ] **Step 5: 원격 backend로 init**

실행:
```bash
cd terraform/foundation
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl     # bucket을 Task 1에서 만든 값으로 수정
terraform init -backend-config=backend.hcl
```
기대값: `Successfully configured the backend "s3"! ... Terraform has been successfully initialized!`

- [ ] **Step 6: validate**

실행: `terraform fmt && terraform validate`
기대값: `Success! The configuration is valid.` (아직 리소스 없음 — providers/vars만)

- [ ] **Step 7: 커밋** (`.gitignore`가 실제 tfvars를 제외해야 함)

```bash
printf '%s\n' 'terraform/**/.terraform/*' 'terraform/**/terraform.tfvars' 'terraform/**/backend.hcl' 'terraform/**/*.tfplan' 'terraform/**/*.tfstate' 'terraform/**/*.tfstate.backup' >> .gitignore
git add terraform/foundation/backend.tf terraform/foundation/providers.tf terraform/foundation/variables.tf terraform/foundation/terraform.tfvars.example terraform/foundation/backend.hcl.example .gitignore
git commit -m "feat(v2-p1a): foundation skeleton (partial s3 backend, dual-region providers, vars)"
```

---

## Task 3: 네트워크 — 신규 VPC 생성 또는 기존 VPC 재사용

**파일:**
- 수정: `terraform/foundation/variables.tf` (네트워킹 변수 추가)
- 생성: `terraform/foundation/network.tf`

`make configure`(P1e)는 이 변수들로 "새 VPC 생성 vs 기존 VPC 선택"을 운영자에게 묻는다(`ec2:DescribeVpcs`로 후보 나열). **이 선택 UX는 v1 `scripts/00-deploy-infra.sh`를 그대로 미러한다** — 1=새 VPC(CIDR 입력) / 2=기존 선택 → `describe-vpcs` 나열 → private=`MapPublicIpOnLaunch=false` 분류 → NAT/IGW 확인·경고 → CIDR 도출. (CDK의 `useExistingVpc`/`vpcId`/`vpcCidr` 컨텍스트 = TF의 `create_network`/`existing_vpc_id`/`existing_private_subnet_ids`.) P1a에서는 tfvars로 직접 지정. **기존 VPC 재사용 시 NAT 신규 비용·`ec2:Create*` 권한이 불필요.**

- [ ] **Step 1: `variables.tf`에 네트워킹 변수 추가**

```hcl
variable "create_network" {
  type        = bool
  description = "true=새 VPC/서브넷/NAT 생성; false=기존 VPC 재사용(existing_* 지정)"
  default     = true
}

variable "existing_vpc_id" {
  type        = string
  description = "create_network=false일 때 사용할 기존 VPC ID"
  default     = ""
}

variable "existing_private_subnet_ids" {
  type        = list(string)
  description = "create_network=false일 때 ALB/Fargate가 쓸 기존 private 서브넷 (≥2 AZ, NAT egress 필요)"
  default     = []
}
```

- [ ] **Step 2: `network.tf` 작성 (조건부 생성 + locals)**

```hcl
# 모든 네트워크 리소스는 create_network=true일 때만 생성. false면 기존 VPC 재사용.
resource "aws_vpc" "main" {
  count                = var.create_network ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "igw" {
  count  = var.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  tags   = { Name = "${var.project}-igw" }
}

resource "aws_subnet" "public" {
  count                   = var.create_network ? 2 : 0
  vpc_id                  = aws_vpc.main[0].id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)       # 10.20.0.0/24, 10.20.1.0/24
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = var.create_network ? 2 : 0
  vpc_id            = aws_vpc.main[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)        # 10.20.10.0/24, 10.20.11.0/24
  availability_zone = var.azs[count.index]
  tags              = { Name = "${var.project}-private-${count.index}" }
}

resource "aws_eip" "nat" {
  count  = var.create_network ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.project}-nat-eip" }
}

resource "aws_nat_gateway" "nat" {
  count         = var.create_network ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.project}-nat" }
  depends_on    = [aws_internet_gateway.igw]
}

resource "aws_route_table" "public" {
  count  = var.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw[0].id
  }
  tags = { Name = "${var.project}-public-rt" }
}

resource "aws_route_table" "private" {
  count  = var.create_network ? 1 : 0
  vpc_id = aws_vpc.main[0].id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.nat[0].id
  }
  tags = { Name = "${var.project}-private-rt" }
}

resource "aws_route_table_association" "public" {
  count          = var.create_network ? 2 : 0
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table_association" "private" {
  count          = var.create_network ? 2 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}

# 기존 VPC 재사용 시 CIDR을 조회(SG 규칙용). create_network=true면 미사용.
data "aws_vpc" "existing" {
  count = var.create_network ? 0 : 1
  id    = var.existing_vpc_id
}

# 다운스트림(workload/edge)은 항상 이 locals를 참조 — 생성/기존 분기를 흡수.
locals {
  vpc_id             = var.create_network ? aws_vpc.main[0].id : var.existing_vpc_id
  private_subnet_ids = var.create_network ? aws_subnet.private[*].id : var.existing_private_subnet_ids
  vpc_cidr           = var.create_network ? var.vpc_cidr : data.aws_vpc.existing[0].cidr_block
}
```

- [ ] **Step 3: validate**

실행: `terraform fmt && terraform validate`
기대값: `Success! The configuration is valid.`

- [ ] **Step 4: plan + apply**

P1a 기본은 새 VPC 생성(`create_network=true`). 기존 VPC 재사용을 검증하려면 tfvars에 `create_network=false`, `existing_vpc_id`, `existing_private_subnet_ids`를 지정.

실행: `terraform plan -out tfplan && terraform apply tfplan`
기대값:
- `create_network=true`(기본): 약 13개 리소스 생성(VPC, IGW, public 2 + private 2 서브넷, EIP, NAT, route table 2, association 4).
- `create_network=false`(기존 재사용): **네트워크 리소스 0개** 생성(locals만 기존 ID/CIDR로 해석). NAT 신규 비용·`ec2:Create*` 권한 불필요.

- [ ] **Step 5: 검증**

- `create_network=true`:
```bash
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=awsops-v2-vpc" \
  --query 'Vpcs[0].CidrBlock' --output text
```
기대값: `10.20.0.0/16`.
- `create_network=false`: `terraform console <<<'local.vpc_id'` / `local.private_subnet_ids`가 지정한 기존 값으로 해석되는지 확인. (기존 private 서브넷은 NAT egress가 있어야 Fargate가 ECR pull 가능 — v1 `00-deploy-infra.sh`도 NAT 개수를 확인·경고한다.)

- [ ] **Step 6: 커밋**

```bash
git add terraform/foundation/network.tf terraform/foundation/variables.tf
git commit -m "feat(v2-p1a): network — create new VPC/NAT or reuse existing (create_network flag)"
```

---

## Task 4: spine 컨테이너 (Node SSE/헬스 서버) + ECR repo

**파일:**
- 생성: `spine/server.js`
- 생성: `spine/Dockerfile`
- 생성: `terraform/foundation/workload.tf` (이 Task에선 ECR repo만)

- [ ] **Step 1: `spine/server.js` 작성**

```js
const http = require('http');
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/awsops/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.url === '/awsops/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let n = 0;
    const timer = setInterval(() => {
      n += 1;
      res.write(`data: tick ${n}\n\n`);
      if (n >= 10) {
        clearInterval(timer);
        res.end('data: done\n\n');
      }
    }, 1000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log(`spine listening on ${PORT}`));
```

- [ ] **Step 2: `spine/Dockerfile` 작성**

```dockerfile
FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: spine 로컬 스모크 테스트 (server.js가 틀리면 먼저 실패)**

실행:
```bash
node spine/server.js &
sleep 1
curl -s localhost:3000/awsops/healthz; echo
curl -sN localhost:3000/awsops/api/stream | head -3
kill %1
```
기대값: `ok`, 이어서 `data: tick 1`, `data: tick 2`, `data: tick 3` (초당 1개씩).

- [ ] **Step 4: `workload.tf`에 ECR repo 추가**

```hcl
resource "aws_ecr_repository" "spine" {
  name                 = "${var.project}-spine"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  force_delete = true   # spine은 일회용; P1d에서 실제 이미지로 교체
}
```

- [ ] **Step 5: ECR repo만 apply**

실행: `terraform apply -target=aws_ecr_repository.spine`
기대값: 1개 리소스 생성. URI 캡처:
```bash
ECR_URI=$(aws ecr describe-repositories --repository-names awsops-v2-spine \
  --query 'repositories[0].repositoryUri' --output text); echo "$ECR_URI"
```

- [ ] **Step 6: build (arm64) + push**

실행:
```bash
aws ecr get-login-password --region ap-northeast-2 \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"
docker buildx build --platform linux/arm64 -t "$ECR_URI:spine-latest" spine --push
```
기대값: `pushing manifest ... done`.

- [ ] **Step 7: 이미지 존재 검증**

실행:
```bash
aws ecr describe-images --repository-name awsops-v2-spine \
  --query 'imageDetails[?contains(imageTags,`spine-latest`)].imageTags' --output text
```
기대값: `spine-latest`.

- [ ] **Step 8: 커밋**

```bash
git add spine terraform/foundation/workload.tf
git commit -m "feat(v2-p1a): spine Node SSE/health container + ECR repo"
```

---

## Task 5: 워크로드 — ECS cluster, task def, internal ALB, service

**파일:**
- 수정: `terraform/foundation/workload.tf` (Task 4의 ECR repo 뒤에 append)

- [ ] **Step 1: ECS cluster + IAM + log group + task definition append**

```hcl
resource "aws_ecs_cluster" "main" {
  name = "${var.project}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.project}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.project}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_cloudwatch_log_group" "spine" {
  name              = "/ecs/${var.project}-spine"
  retention_in_days = 30
}

resource "aws_ecs_task_definition" "spine" {
  family                   = "${var.project}-spine"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "spine"
      image     = "${aws_ecr_repository.spine.repository_url}:${var.image_tag}"
      essential = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment = [{ name = "PORT", value = "3000" }]
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O - http://127.0.0.1:3000/awsops/healthz || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.spine.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "spine"
        }
      }
    }
  ])
}
```

- [ ] **Step 2: SG append — internal ALB(VPC CIDR에서) + service(ALB에서)**

```hcl
# Internal ALB SG. ALB는 internet-facing이 아님; CloudFront는 VPC Origin을 통해
# 도달하며, 그 관리형 ENI는 우리 private 서브넷에 있으므로 VPC CIDR 인바운드 허용이
# 올바른(그리고 사설) 소스다. GA SG 메커니즘이 Step 7 검증에서 확인되면 전용
# VPC-origin SG로 좁히는 것을 후속 작업으로 한다.
resource "aws_security_group" "alb" {
  name        = "${var.project}-alb-sg"
  description = "Internal ALB - reachable from within the VPC (CloudFront VPC Origin ENIs)"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTP from within VPC (incl. CloudFront VPC Origin ENIs)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [local.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "service" {
  name        = "${var.project}-service-sg"
  description = "Spine Fargate tasks"
  vpc_id      = local.vpc_id

  ingress {
    description     = "ALB to Fargate"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

- [ ] **Step 3: internal ALB + target group + listener append**

```hcl
resource "aws_lb" "internal" {
  name               = "${var.project}-alb"
  internal           = true                       # 핵심: private LB, internet-facing 아님
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = local.private_subnet_ids
}

resource "aws_lb_target_group" "spine" {
  name        = "${var.project}-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"                              # Fargate awsvpc에 필요

  health_check {
    path                = "/awsops/healthz"
    matcher             = "200-399"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  deregistration_delay = 30
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.spine.arn
  }
}
```

- [ ] **Step 4: ECS service append**

```hcl
resource "aws_ecs_service" "spine" {
  name            = "${var.project}-spine"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.spine.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.spine.arn
    container_name   = "spine"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
}
```

- [ ] **Step 5: validate**

실행: `terraform fmt && terraform validate`
기대값: `Success! The configuration is valid.`

- [ ] **Step 6: plan + apply**

실행: `terraform plan -out tfplan && terraform apply tfplan`
기대값: cluster, IAM role 2 + attachment, log group, task def, SG 2, ALB, target group, listener, service 생성.

- [ ] **Step 7: internal ALB 뒤에서 task가 healthy인지 검증**

실행 (task가 RUNNING + target HEALTHY 될 때까지 약 90초 대기):
```bash
aws ecs wait services-stable --cluster awsops-v2 --services awsops-v2-spine
TG_ARN=$(aws elbv2 describe-target-groups --names awsops-v2-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG_ARN" \
  --query 'TargetHealthDescriptions[0].TargetHealth.State' --output text
```
기대값: `healthy`. (ALB는 internal이라 아직 노트북에서 직접 curl 불가 — Task 6에서 CloudFront를 통해 확인.)

- [ ] **Step 8: 커밋**

```bash
git add terraform/foundation/workload.tf
git commit -m "feat(v2-p1a): ECS Fargate spine service behind internal ALB"
```

---

## Task 6: 엣지 — ACM 인증서, CloudFront VPC Origin, distribution, DNS

**파일:**
- 생성: `terraform/foundation/edge.tf`
- 생성: `terraform/foundation/outputs.tf`

- [ ] **Step 1: `edge.tf`에 ACM 인증서(us-east-1) + DNS 검증 작성**

```hcl
data "aws_route53_zone" "main" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "cf" {
  provider          = aws.use1
  domain_name       = var.domain_name
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "cf_validation" {
  for_each = {
    for dvo in aws_acm_certificate.cf.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "cf" {
  provider                = aws.use1
  certificate_arn         = aws_acm_certificate.cf.arn
  validation_record_fqdns = [for r in aws_route53_record.cf_validation : r.fqdn]
}
```

- [ ] **Step 2: CloudFront VPC Origin + 관리형 정책 data source append**

```hcl
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# CloudFront VPC Origin — internal ALB를 internet-facing 없이 도달하게 함.
# aws provider 6.x (또는 5.73+)에 존재.
resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "${var.project}-alb-origin"
    arn                    = aws_lb.internal.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}
```

- [ ] **Step 3: CloudFront distribution + Route53 alias append**

```hcl
resource "aws_cloudfront_distribution" "main" {
  enabled         = true
  comment         = "AWSops v2 spine — ${var.domain_name}"
  aliases         = [var.domain_name]
  price_class     = "PriceClass_200"

  origin {
    domain_name = aws_lb.internal.dns_name
    origin_id   = "alb-vpc-origin"
    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb-vpc-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  ordered_cache_behavior {
    path_pattern             = "/awsops/_next/static/*"
    target_origin_id         = "alb-vpc-origin"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cf.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "alias" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.domain_name
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.main.domain_name
    zone_id                = aws_cloudfront_distribution.main.hosted_zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 4: `outputs.tf` 작성**

```hcl
output "cloudfront_domain" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "public_url" {
  value = "https://${var.domain_name}"
}

output "alb_arn" {
  value = aws_lb.internal.arn
}

output "ecr_uri" {
  value = aws_ecr_repository.spine.repository_url
}
```

- [ ] **Step 5: validate**

실행: `terraform fmt && terraform validate`
기대값: `Success! The configuration is valid.`

> `terraform validate`가 `aws_cloudfront_vpc_origin` 또는 `vpc_origin_config` 블록을 거부하면 provider가 너무 낮은 것(이 기능은 5.73+/6.x에 존재). `terraform init -upgrade` 후 `terraform version`이 aws provider `>= 6.47`인지 확인. 이 계획에서 가장 가능성 높은 스키마-버전 실패 지점.

- [ ] **Step 6: plan + apply**

실행: `terraform plan -out tfplan && terraform apply tfplan`
기대값: ACM 인증서 + 검증 레코드 + 검증, VPC origin, distribution, Route53 alias 생성. distribution + ACM 검증은 5~10분 소요 가능.

- [ ] **Step 7: 전체 엣지를 통한 헬스 검증**

실행 (apply 후 CloudFront + DNS 전파에 수 분 소요 가능):
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://v2.example.com/awsops/healthz
```
기대값: `200`. `502`/`503`이면 VPC origin → internal ALB 경로 실패 — Task 7 참조.

- [ ] **Step 8: 커밋**

```bash
git add terraform/foundation/edge.tf terraform/foundation/outputs.tf
git commit -m "feat(v2-p1a): private edge — CloudFront VPC Origin to internal ALB + ACM + DNS"
```

---

## Task 7: CloudFront를 통한 SSE end-to-end 검증 (P1a 수용 게이트)

**파일:** 없음 (검증 + 문서화 Task)

- [ ] **Step 1: 헬스 엔드포인트 확인**

실행:
```bash
curl -s https://v2.example.com/awsops/healthz; echo
```
기대값: `ok`.

- [ ] **Step 2: SSE가 (버퍼링 없이) 점진적으로 스트리밍되는지 확인**

실행:
```bash
curl -N -s https://v2.example.com/awsops/api/stream
```
기대값: 10줄이 **초당 1개씩** 도착(`data: tick 1` … `data: tick 10`), 이어서 `data: done`. 10줄이 약 10초 후 한꺼번에 오면 CloudFront/ALB가 버퍼링 중 — 기록할 것; ADR-021 SSE를 막으므로 P1d에서 실제 앱 출시 전 해결해야 함.

- [ ] **Step 3: time-to-first-byte 및 이벤트 간격 측정**

실행:
```bash
curl -N -s -w "\nTTFB=%{time_starttransfer}s TOTAL=%{time_total}s\n" https://v2.example.com/awsops/api/stream | tail -3
```
기대값: `TTFB` < 2s, `TOTAL` ≈ 10s (연결이 전체 시간 동안 열려 스트리밍됨 = CloudFront origin read-timeout으로 조기 절단되지 않음을 증명).

- [ ] **Step 4: SSE가 버퍼링/타임아웃되면 — 문서화된 완화책 적용 후 재테스트**

완화책(순서대로 하나 적용 → Step 2 재실행 → 스트리밍되면 중단):
1. **Origin keepalive:** spine은 이미 1초마다 이벤트 전송; CloudFront 기본 origin read timeout(30s)을 간격이 초과하지 않는지 확인. 실제 앱은 최소 20초마다 heartbeat 주석(`: keepalive\n\n`) 전송 필요 — P1d용으로 기록.
2. **ALB idle timeout:** 60s 기본값에서 상향. `aws_lb.internal`에 추가:
   ```hcl
   idle_timeout = 300
   ```
   이후 `terraform apply` + 재테스트.
3. **엣지 응답 버퍼링 비활성:** 기본 behavior에 `Managed-CachingDisabled` 정책이 붙어 있는지 확인(Task 6 Step 3에서 붙음). SSE 경로는 캐싱 OFF여야 함.

- [ ] **Step 5: ALB가 진짜 private인지 확인 (negative test)**

실행:
```bash
ALB_DNS=$(aws elbv2 describe-load-balancers --names awsops-v2-alb --query 'LoadBalancers[0].DNSName' --output text)
echo "ALB scheme: $(aws elbv2 describe-load-balancers --names awsops-v2-alb --query 'LoadBalancers[0].Scheme' --output text)"
curl -s -m 5 -o /dev/null -w "%{http_code}\n" "http://$ALB_DNS/awsops/healthz" || echo "UNREACHABLE_AS_EXPECTED"
```
기대값: scheme `internal`, 그리고 노트북에서 직접 curl은 `UNREACHABLE_AS_EXPECTED` 출력(internal ALB는 public IP 없음). 엣지가 사설임을 증명.

- [ ] **Step 6: 결과를 기록하고 검증 노트 커밋**

`terraform/foundation/VERIFY.md` 생성:
```markdown
# P1a 검증 (실제 값 기입)
- 날짜:
- `https://v2.example.com/awsops/healthz` -> 200: [yes/no]
- SSE 점진 스트리밍(1/s): [yes/no]
- TTFB: __s, total: __s
- ALB scheme internal + 노트북 unreachable: [yes/no]
- 적용한 SSE 완화책(있으면): [none / idle_timeout=300 / ...]
- P1d 노트: 실제 앱은 SSE heartbeat을 <=20s마다 보내야 함
```

```bash
git add terraform/foundation/VERIFY.md
git commit -m "test(v2-p1a): verify private edge serves health + SSE end-to-end"
```

---

## Task 8: teardown 리허설 (spine이 재현/폐기 가능함을 증명)

**파일:** 없음

- [ ] **Step 1: 깨끗한 재-apply가 no-op인지 확인 (멱등성)**

실행: `terraform plan`
기대값: `No changes. Your infrastructure matches the configuration.`

- [ ] **Step 2: (선택, teardown 검증 시에만) destroy + 재-apply**

> P1b를 위해 spine을 띄워둘 거면 건너뜀. 실행하면 폐기 가능성을 증명.
```bash
terraform destroy            # 'yes' 입력
terraform apply              # 처음부터 재구축
```
기대값: destroy는 foundation 리소스를 모두 제거(원격 상태 백엔드는 별도 모듈이라 유지), 재-apply는 재생성, CloudFront 재전파 후 `curl https://v2.example.com/awsops/healthz`가 다시 `ok` 반환.

- [ ] **Step 3: 최종 커밋 (계획 완료 마커)**

```bash
git commit --allow-empty -m "chore(v2-p1a): foundation spine complete — edge verified, ready for P1b auth"
```

---

## Self-Review (셀프 리뷰)

**스펙 커버리지 (설계 스펙 §2.1, §8, §9-P1의 P1a 슬라이스):**
- Internal ALB + CloudFront VPC Origin (스펙 §2.1) → Task 5~6. ✓
- ALB SG = VPC 소스, prefix-list 아님 (스펙 §2.1 "완전 사설") → Task 5 Step 2 (좁히기는 후속 작업으로 문서화). ✓
- SSE-over-VPC-Origin 검증 (스펙 §2.1, §9-P1 완료기준, §11 위험) → Task 7. ✓
- Terraform 원격 상태 + 멀티 모듈 레이아웃 (스펙 §8) → Task 1~2. ✓
- 새 도메인, v1과 병렬 (스펙 §1, §8 완전 분리 병렬) → `v2.example.com`, 별도 VPC `10.20.0.0/16`. ✓
- Steampipe 사이드카 / web 컨테이너 상세 → **P1d로 연기** (실제 이미지); P1a는 spine 대역. 목표/범위밖에 문서화. ✓
- Aurora, Cognito, CI/CD, make configure, EKS 모듈, AgentCore provisioner → **명시적으로 P1b~P1f로 연기** (스코프 체크). ✓

**플레이스홀더 스캔:** "TBD/TODO/edge case 처리" 없음. 스키마-버전 주의(Task 6 Step 5)와 SSE 완화책(Task 7 Step 4)은 구체적·조건부·정확한 명령 — 플레이스홀더 아님.

**타입/이름 일관성:** 파일 간 참조하는 리소스 이름 일관: `aws_lb.internal`, `aws_ecr_repository.spine`, `aws_security_group.alb`/`.service`, `aws_lb_target_group.spine`, `aws_cloudfront_vpc_origin.alb`, cluster/service `awsops-v2`/`awsops-v2-spine`, 헬스 경로 `/awsops/healthz`, SSE 경로 `/awsops/api/stream`, 이미지 태그 `spine-latest` (= `var.image_tag` 기본값). 헬스체크 matcher `200-399`는 dev 스택 선례와 일치.

---

## Execution Handoff (실행 인계)

(저장 후 writing-plans 플로우가 채움)
