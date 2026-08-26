"""
Cross-account credential helper for AWSops Lambda functions.
Uses STS AssumeRole with 50-minute TTL credential caching.
크로스 어카운트 자격증명 헬퍼. STS AssumeRole + 50분 캐싱.
"""
import boto3
import os
import time
import re
import logging
import json
import functools

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_ARN_PATTERN = re.compile(r'^arn:aws:iam::\d{12}:role/[\w+=,.@-]+$')
_credential_cache = {}  # {role_arn: (credentials_dict, timestamp)}
_CACHE_TTL = 3000  # 50 minutes
_MAX_CACHE = 50
_EXTERNAL_ID = os.environ.get('AWSOPS_EXTERNAL_ID', '')


@functools.lru_cache(maxsize=1)
def _host_account_id():
    """The account this Lambda runs in.

    Prefer AWSOPS_HOST_ACCOUNT_ID (no network call); fall back to STS
    GetCallerIdentity (always permitted). Cached for the warm container.
    """
    env = os.environ.get('AWSOPS_HOST_ACCOUNT_ID', '').strip()
    if env:
        return env
    try:
        return boto3.client('sts').get_caller_identity()['Account']
    except Exception as e:  # network / permission edge — fall through to cross-account
        logger.warning(json.dumps({'event': 'host_account_lookup_failed', 'error': str(e)}))
        return None


def get_role_arn(account_id):
    """Cross-account read-only role ARN for a *different* account.

    Returns None when account_id is empty or equals the host account this
    Lambda already runs in — same-account access uses the Lambda's own
    execution role directly (no AssumeRole). v2 is single-account; a
    self-assume of AWSopsReadOnlyRole would fail because that role lives only
    in onboarded *target* accounts, never the host account.
    """
    if not account_id:
        return None
    if str(account_id).strip() == (_host_account_id() or ''):
        return None
    role_name = os.environ.get('AWSOPS_ROLE_NAME', 'AWSopsReadOnlyRole')
    return f'arn:aws:iam::{account_id}:role/{role_name}'


def _assume_role(role_arn, session_suffix=None):
    """Assume role with credential caching."""
    if not _ARN_PATTERN.match(role_arn):
        raise ValueError(f'Invalid role ARN: {role_arn}')

    cached = _credential_cache.get(role_arn)
    if cached and (time.time() - cached[1]) < _CACHE_TTL:
        return cached[0]

    session_name = f'awsops-lambda-{session_suffix}' if session_suffix else 'awsops-lambda'
    sts = boto3.client('sts')
    assume_params = {
        'RoleArn': role_arn,
        'RoleSessionName': session_name,
        'DurationSeconds': 3600,
    }
    if _EXTERNAL_ID:
        assume_params['ExternalId'] = _EXTERNAL_ID
    resp = sts.assume_role(**assume_params)
    # Audit log for cross-account access / 크로스 어카운트 접근 감사 로그
    logger.info(json.dumps({
        'event': 'assume_role',
        'role_arn': role_arn,
        'session_name': session_name,
        'expiration': resp['Credentials']['Expiration'].isoformat(),
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }))
    creds = {
        'aws_access_key_id': resp['Credentials']['AccessKeyId'],
        'aws_secret_access_key': resp['Credentials']['SecretAccessKey'],
        'aws_session_token': resp['Credentials']['SessionToken'],
    }
    if len(_credential_cache) >= _MAX_CACHE:
        oldest_key = min(_credential_cache, key=lambda k: _credential_cache[k][1])
        del _credential_cache[oldest_key]
    _credential_cache[role_arn] = (creds, time.time())
    return creds


def get_client(service, region='ap-northeast-2', role_arn=None, session_suffix=None):
    """Create boto3 client, optionally assuming a cross-account role.

    Args:
        service: AWS service name (e.g., 'ec2', 'iam')
        region: AWS region
        role_arn: Full IAM Role ARN (arn:aws:iam::XXXX:role/RoleName)
        session_suffix: Optional suffix for AssumeRole session name (defaults to service name)
    """
    if not role_arn:
        return boto3.client(service, region_name=region)

    creds = _assume_role(role_arn, session_suffix or service)
    return boto3.client(service, region_name=region, **creds)


def get_credentials(target_account_id, session_suffix=None):
    """Return botocore Credentials for sigv4 signing (e.g. OpenSearch _search).

    Host account (target is the host, or None/blank) → the Lambda's own creds via the default
    provider chain. A real *other* onboarded account → Credentials from the assumed-role response.
    Mirrors get_role_arn's host short-circuit so the host path is never a self-assume.
    """
    role_arn = get_role_arn(target_account_id) if target_account_id else None
    if role_arn is None:
        return boto3.Session().get_credentials()
    from botocore.credentials import Credentials
    creds = _assume_role(role_arn, session_suffix or 'sigv4')
    return Credentials(
        access_key=creds['aws_access_key_id'],
        secret_key=creds['aws_secret_access_key'],
        token=creds['aws_session_token'],
    )


def get_resource(service, region='ap-northeast-2', role_arn=None):
    """Create boto3 resource (for DynamoDB), optionally cross-account."""
    if not role_arn:
        return boto3.resource(service, region_name=region)

    creds = _assume_role(role_arn, service)
    return boto3.resource(service, region_name=region, **creds)


def resolve_tool_name(params, context, default=''):
    """Resolve the MCP tool name for a Lambda invocation.

    AgentCore Gateway invokes the target Lambda directly (no MCP envelope) and
    passes the tool name via context.client_context.custom['bedrockAgentCoreToolName']
    as '<target-name>___<tool-name>' — never in the event body. A BFF direct-invoke
    (e.g. the datasource explorer) instead puts 'tool_name' in the event. Event wins
    when present; client_context is the Gateway-path fallback.
    """
    tool_name = (params.get('tool_name') or '') if isinstance(params, dict) else ''
    if not tool_name and context is not None:
        client_context = getattr(context, 'client_context', None)
        custom = getattr(client_context, 'custom', None) or {}
        tool_name = custom.get('bedrockAgentCoreToolName', '')
    return tool_name.rsplit('___', 1)[-1] if tool_name else default
