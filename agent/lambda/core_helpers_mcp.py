"""
Core Helpers MCP Lambda — read-only v2 variant of aws_core_mcp.

Exposes ONLY the two static, zero-dependency helpers:
  - prompt_understanding   : returns the AWS solution-design guide (static text)
  - suggest_aws_commands   : maps a natural-language query to suggested READ CLI commands (static)

The v1 `call_aws` tool (arbitrary AWS-CLI execution = a mutation vector) is intentionally ABSENT —
not gated, not present — per AWSops's read-only / do-not-enable invariant. No boto3, no cross_account.

핵심 헬퍼 MCP 람다 — aws_core_mcp의 읽기 전용 v2 변형. 정적 2개 도구만 노출(call_aws 영구 제외).
"""
import json


PROMPT_UNDERSTANDING = """# AWS Solution Design Guide

## Analysis Framework
1. Decompose query into: technical requirements, business objectives, constraints
2. Map requirements to AWS services
3. Synthesize recommendations using serverless-first architecture

## Service Mapping
- Compute: Lambda, ECS/EKS, EC2, App Runner
- Storage: DynamoDB, Aurora, S3, ElastiCache, Neptune
- AI/ML: Bedrock, SageMaker
- Data: Redshift, Athena, Glue, Kinesis
- Frontend: Amplify, CloudFront, AppSync, API Gateway
- Security: Cognito, IAM, KMS, WAF
- DevOps: Terraform, CloudFormation, CodePipeline
- Monitoring: CloudWatch, X-Ray, CloudTrail

## Design Principles
- Serverless-first with managed services
- Pay-per-use pricing models
- Built-in security (encryption at rest/transit, least privilege)
- Multi-AZ for high availability
- Infrastructure as Code (Terraform preferred)

## Available MCP Tools (read-only)
- search_documentation: Search AWS docs
- read_documentation: Read specific doc page
- list_regions / get_regional_availability: Region info
- query_flow_logs: VPC flow log analysis
- describe_network: SG, NACL, route tables
- check_reachability: static ENI<->EC2 connectivity (describe-only)
- suggest_aws_commands: Get CLI command suggestions
"""


def suggest_aws_commands(query):
    """Suggest AWS CLI commands based on a natural-language query (static pattern match)."""
    suggestions = []
    q = query.lower()
    # READ-ONLY only — no mutating verbs (start/stop/invoke/delete/...). This module advertises itself
    # as read-only, so suggesting a mutating command would contradict that even though it never executes.
    patterns = [
        ("ec2", "instance", "aws ec2 describe-instances"),
        ("s3", "bucket", "aws s3api list-buckets"),
        ("s3", "object", "aws s3api list-objects-v2 --bucket <name>"),
        ("vpc", "", "aws ec2 describe-vpcs"),
        ("subnet", "", "aws ec2 describe-subnets"),
        ("security group", "", "aws ec2 describe-security-groups"),
        ("lambda", "function", "aws lambda list-functions"),
        ("iam", "role", "aws iam list-roles"),
        ("iam", "user", "aws iam list-users"),
        ("iam", "policy", "aws iam list-policies --scope Local"),
        ("rds", "instance", "aws rds describe-db-instances"),
        ("ecs", "cluster", "aws ecs list-clusters"),
        ("ecs", "service", "aws ecs list-services --cluster <name>"),
        ("cloudformation", "stack", "aws cloudformation list-stacks"),
        ("cloudwatch", "alarm", "aws cloudwatch describe-alarms"),
        ("cloudwatch", "metric", "aws cloudwatch list-metrics"),
        ("cloudtrail", "event", "aws cloudtrail lookup-events"),
        ("route table", "", "aws ec2 describe-route-tables"),
        ("nat gateway", "", "aws ec2 describe-nat-gateways"),
        ("elb", "load balancer", "aws elbv2 describe-load-balancers"),
        ("target group", "", "aws elbv2 describe-target-groups"),
        ("cost", "", "aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-02-01 --granularity MONTHLY --metrics BlendedCost"),
    ]
    # Match only when the service term is present AND (no keyword, or the keyword is also present) — so
    # the keyword genuinely narrows (e.g. "ec2 instances" → describe-instances, not every ec2 command).
    for svc, kw, cmd in patterns:
        if svc in q and (not kw or kw in q):
            suggestions.append(cmd)
    if not suggestions:
        suggestions = [
            "aws ec2 describe-instances",
            "aws s3api list-buckets",
            "aws iam list-roles",
        ]
    return suggestions[:10]


def _resolve_tool_name(params, context):
    """Same resolution as cross_account.resolve_tool_name, inlined to keep this Lambda's
    stated no-boto3/no-cross_account dependency footprint (see module docstring)."""
    tool_name = (params.get("tool_name") or "") if isinstance(params, dict) else ""
    if not tool_name and context is not None:
        client_context = getattr(context, "client_context", None)
        custom = getattr(client_context, "custom", None) or {}
        tool_name = custom.get("bedrockAgentCoreToolName", "")
    return tool_name.rsplit("___", 1)[-1] if tool_name else ""


def lambda_handler(event, context):
    """Entry point. Read-only: only prompt_understanding + suggest_aws_commands are valid tools."""
    params = event if isinstance(event, dict) else json.loads(event)
    tool_name = _resolve_tool_name(params, context)
    arguments = params.get("arguments", params)
    # cross-account parity: accept-and-ignore (these tools make no AWS calls).
    if isinstance(arguments, dict):
        arguments.pop("target_account_id", None)

    # Infer only between the two SAFE tools when tool_name is omitted.
    if not tool_name:
        tool_name = "suggest_aws_commands" if isinstance(arguments, dict) and "query" in arguments else "prompt_understanding"

    if tool_name == "prompt_understanding":
        return {"statusCode": 200, "body": PROMPT_UNDERSTANDING}

    if tool_name == "suggest_aws_commands":
        query = arguments.get("query", "") if isinstance(arguments, dict) else ""
        return {"statusCode": 200, "body": json.dumps({"suggestions": suggest_aws_commands(query), "query": query})}

    # Any other tool (including the dropped `call_aws`) is unknown by design.
    return {"statusCode": 400, "body": json.dumps({"error": "Unknown tool: " + str(tool_name)})}
