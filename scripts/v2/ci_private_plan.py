"""Private versioned S3 plans: bounded CLI transport, no approval or apply operation."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile

import ci_plan_context
import ci_plan_inspect as legacy
import ci_tf_assets as assets
from ci_runtime_policy import DEV_TARGETS

META_LIMIT = 2 * 1024 * 1024
SMALL_LIMIT = 16 * 1024
PLAN_LIMIT = 64 * 1024 * 1024
ASSET_LIMIT = 136 * 1024 * 1024
ZIP_LIMIT = PLAN_LIMIT + ASSET_LIMIT + 1024 * 1024
RENDER_LIMIT = 32 * 1024 * 1024
HASH = re.compile(r'[a-f0-9]{64}')
REGION = re.compile(r'(?:af|ap|ca|eu|il|me|mx|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-[1-9][0-9]*')
BUCKET = re.compile(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]')
KEY_ID = r'(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})'
STORAGE = 's3-private-plan'
BACKEND_KEYS = {'bucket', 'key', 'region', 'encrypt', 'use_lockfile',
                'kms_key_id', 'workspace_key_prefix', 'workspace'}
AWS_OPERATIONS = {'sts': {'get-caller-identity'}, 'kms': {'describe-key'}, 's3api': {
    'get-bucket-location', 'get-public-access-block', 'get-bucket-versioning',
    'get-bucket-ownership-controls', 'get-bucket-policy-status', 'get-bucket-encryption',
    'head-object', 'get-object', 'put-object'}}


class PrivatePlanError(ValueError):
    """Fixed categories only, never provider output or private input values."""


def require(ok, category):
    if not ok:
        raise PrivatePlanError(category)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def exact(value, fields):
    return isinstance(value, dict) and set(value) == set(fields)


def positive(value, limit=10**20):
    return type(value) is int and 0 < value <= limit


def hashed(value):
    return isinstance(value, str) and HASH.fullmatch(value) is not None


def parse_json(value):
    return json.loads(value, object_pairs_hook=assets.unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(PrivatePlanError('invalid_json')))


def private_read(path, limit, *, protected=False):
    path = legacy.real_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'invalid_file')
        if protected:
            require(info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600, 'private_mode_required')
        data = stream.read(limit + 1)
        require(len(data) <= limit, 'output_limit')
        return data


def private_write(path, data):
    legacy.private_write(path, data)


def cleanup_owned(path):
    shutil.rmtree(path)


@contextmanager
def scratch(parent, env, *, ci):
    prefix = '.private-plan-'
    if ci:
        ids = [env.get(key) for key in ('GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT')]
        require(all(isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,19}', value)
                    for value in ids), 'invalid_ci_context')
        prefix += '-'.join(ids) + '-'
    path = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    failed = False
    try:
        yield path
    except BaseException:
        failed = True
        raise
    finally:
        try:
            cleanup_owned(path)
        except OSError:
            if not failed:
                raise PrivatePlanError('cleanup_failed') from None


def command_error(args, error):
    """Recognize only the first AWS exception envelope for the invoked known verb."""
    index = 1
    while index < len(args) and args[index].startswith('--'):
        flag = args[index]
        if flag == '--no-cli-pager':
            index += 1
        elif flag in {'--region', '--endpoint-url', '--profile', '--output',
                      '--cli-connect-timeout', '--cli-read-timeout'}:
            index += 2
        else:
            return 'command_failed'
    if (not args or args[0] != 'aws' or len(args) <= index + 1
            or args[index] not in {'s3api', 'kms'}
            or args[index + 1] not in AWS_OPERATIONS[args[index]]):
        return 'command_failed'
    match = re.search(rb'(?m)^An error occurred \(([A-Za-z0-9]+)\) when calling the ([A-Za-z0-9]+) operation:', error)
    if not match:
        return None
    code, operation = (value.decode('ascii') for value in match.groups())
    verb = args[index + 1]
    if operation != ''.join(word.title() for word in verb.split('-')):
        return 'command_failed'
    if args[index] == 'kms':
        return {'AccessDeniedException': 'kms_access_denied', 'AccessDenied': 'kms_access_denied',
                'NotFoundException': 'kms_key_missing'}.get(code, 'command_failed')
    if code in {'AccessDenied', 'AccessDeniedException'}:
        return 's3_access_denied'
    if verb == 'put-object':
        if code == 'PreconditionFailed':
            return 'object_already_exists'
        if code in {'SlowDown', 'InternalError', 'ServiceUnavailable', 'RequestTimeout',
                    'ConditionalRequestConflict', 'ThrottlingException'}:
            return 'object_put_retryable'
    return {
        ('get-bucket-ownership-controls', 'OwnershipControlsNotFoundError'): 'bucket_ownership_missing',
        ('get-public-access-block', 'NoSuchPublicAccessBlockConfiguration'): 'bucket_public_access_block_missing',
        ('get-public-access-block', 'NoSuchPublicAccessBlock'): 'bucket_public_access_block_missing',
        ('get-bucket-encryption', 'ServerSideEncryptionConfigurationNotFoundError'): 'bucket_encryption_missing',
        ('get-bucket-policy-status', 'NoSuchBucketPolicy'): 'no_bucket_policy',
    }.get((verb, code), 'command_failed')


def run_command(args, output, *, cwd=None, env=None, limit=META_LIMIT, timeout=120):
    """Bound stdout and stderr while keeping all provider diagnostics private."""
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    process = None
    error = bytearray()
    category = None
    end = time.monotonic() + timeout
    try:
        written = 0
        with os.fdopen(fd, 'wb') as target, selectors.DefaultSelector() as selector:
            process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            selector.register(process.stdout, selectors.EVENT_READ, 'out')
            selector.register(process.stderr, selectors.EVENT_READ, 'err')
            while selector.get_map():
                require(time.monotonic() < end, 'command_timeout')
                for key, _ in selector.select(0.1):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fileobj)
                    elif key.data == 'out':
                        target.write(data[:max(0, limit - written)])
                        written += len(data)
                        require(written <= limit, 'output_limit')
                    else:
                        error.extend(data)
                        if category is None:
                            category = command_error(args, error)
                        del error[:-65536]
            code = process.wait(timeout=max(0.01, end - time.monotonic()))
        if code:
            raise PrivatePlanError(category or 'command_failed')
    except subprocess.TimeoutExpired:
        raise PrivatePlanError('command_timeout') from None
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stdout.close()
            process.stderr.close()


def key_identifier(value, region, account=None, *, canonical_only=False):
    if not isinstance(value, str) or len(value) > 512:
        return False
    owner = re.escape(account) if account else r'[0-9]{12}'
    arn = rf'arn:aws:kms:{re.escape(region)}:{owner}:'
    if canonical_only:
        return re.fullmatch(arn + 'key/' + KEY_ID, value) is not None
    alias = r'alias/[A-Za-z0-9/_-]{1,256}'
    return re.fullmatch(rf'(?:{KEY_ID}|{alias}|{arn}(?:key/{KEY_ID}|{alias}))', value) is not None


def validate_backend(value):
    require(exact(value, BACKEND_KEYS), 'invalid_backend')
    bucket, key, region = value['bucket'], value['key'], value['region']
    require(isinstance(bucket, str) and BUCKET.fullmatch(bucket) and '..' not in bucket
            and not re.fullmatch(r'[0-9.]+', bucket), 'invalid_backend')
    require(isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9_./-]{1,512}', key)
            and all(p not in ('', '.', '..') for p in key.split('/'))
            and not key.startswith('ci/tfplans/') and key != 'ci/tfplans', 'reserved_or_invalid_state_key')
    require(isinstance(region, str) and REGION.fullmatch(region) and value['encrypt'] is True
            and type(value['use_lockfile']) is bool and value['workspace'] == 'default', 'invalid_backend')
    workspace_prefix = value['workspace_key_prefix']
    require(isinstance(workspace_prefix, str) and len(workspace_prefix) <= 512
            and not any(ord(c) < 32 for c in workspace_prefix)
            and '${' not in workspace_prefix and '%{' not in workspace_prefix
            and workspace_prefix != 'ci/tfplans'
            and not workspace_prefix.startswith('ci/tfplans/'), 'invalid_workspace_prefix')
    kms = value['kms_key_id']
    require(kms is None or key_identifier(kms, region), 'invalid_backend_key')
    return value


def parse_backend(path, env):
    require(env.get('TF_WORKSPACE', 'default') in ('', 'default'), 'workspace_not_default')
    values = {}
    for line in private_read(path, SMALL_LIMIT).decode().splitlines():
        if not line.strip() or line.lstrip().startswith(('#', '//')):
            continue
        match = re.fullmatch(r'\s*([a-z_]+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)\s*(?:(?:#|//).*)?', line)
        require(match is not None, 'invalid_backend')
        key, raw = match.groups()
        require(key in BACKEND_KEYS - {'workspace'} and key not in values, 'invalid_backend')
        value = parse_json(raw)
        require(not isinstance(value, str) or '${' not in value and '%{' not in value
                and not any(ord(c) < 32 for c in value), 'invalid_backend')
        values[key] = value
    require({'bucket', 'key', 'region', 'encrypt'} <= set(values), 'invalid_backend')
    return validate_backend({'use_lockfile': False, 'kms_key_id': None,
                             'workspace_key_prefix': 'env:', 'workspace': 'default', **values})


def binding(backend, account):
    return digest(canonical({'account': account, 'backend': backend}))


def context(repository, branch, commit, run_id, scope, attempt):
    legacy.validate_identity(repository, branch, commit, run_id)
    require(scope in assets.SCOPES and positive(attempt, 1000000), 'invalid_context')
    return dict(repository=repository, branch=branch, commit=commit,
                run_id=int(run_id), attempt=attempt, scope=scope)


def prefix(ctx):
    return f"ci/tfplans/{ctx['repository']}/{ctx['branch']}/{ctx['commit']}/{ctx['run_id']}/{ctx['attempt']}/"


def timestamp(value):
    require(isinstance(value, str), 'invalid_timestamp')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    require(parsed.tzinfo is not None, 'invalid_timestamp')
    return parsed.timestamp()


def valid_version(value):
    return isinstance(value, str) and value != 'null' and re.fullmatch(r'[A-Za-z0-9+/_=.~-]{1,1024}', value)


def role_identity(arn):
    match = re.fullmatch(r'arn:aws:iam::([0-9]{12}):role/(?:[!-~]+/)?([A-Za-z0-9+=,.@_-]{1,64})', arn or '')
    require(match is not None, 'invalid_role')
    return match.groups()


def require_ci_key(env):
    value = env.get('TF_PLAN_ENC_KEY', '')
    require(isinstance(value, str) and bool(value.strip()), 'key_required')
    # The reused asset verifier reads the process's CI key. An injected command
    # environment must not silently verify against a different ambient key.
    require(hmac.compare_digest(value.encode(), assets.authentication_key()), 'key_context_mismatch')


def session_policy(backend, account, ctx):
    bucket = 'arn:aws:s3:::' + backend['bucket']
    objects = bucket + '/' + prefix(ctx) + '*'
    result = {'Version': '2012-10-17', 'Statement': [
        {'Effect': 'Allow', 'Action': ['s3:GetBucketLocation', 's3:GetBucketVersioning',
            's3:GetEncryptionConfiguration', 's3:GetBucketPublicAccessBlock',
            's3:GetBucketOwnershipControls', 's3:GetBucketPolicyStatus'], 'Resource': bucket,
         'Condition': {'StringEquals': {'aws:ResourceAccount': account}}},
        {'Effect': 'Allow', 'Action': ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'], 'Resource': objects,
         'Condition': {'StringEquals': {'aws:ResourceAccount': account}}},
        {'Effect': 'Allow', 'Action': ['kms:GenerateDataKey', 'kms:Decrypt'],
         'Resource': f"arn:aws:kms:{backend['region']}:{account}:key/*",
         'Condition': {'StringEquals': {'kms:ViaService': f"s3.{backend['region']}.amazonaws.com",
                                        'kms:CallerAccount': account},
                       'StringLike': {'kms:EncryptionContext:aws:s3:arn': [bucket, objects]}}},
        {'Effect': 'Allow', 'Action': ['kms:DescribeKey'],
         'Resource': f"arn:aws:kms:{backend['region']}:{account}:key/*",
         'Condition': {'StringEquals': {'kms:CallerAccount': account,
                                        'aws:RequestedRegion': backend['region']}}},
    ]}
    require(len(canonical(result)) <= 2048, 'session_policy_too_large')
    return result

class Operation:
    def __init__(self, work, env, transport, now, repository, branch, commit, run_id, scope, profile=None):
        self.work, self.env, self.transport, self.now = work, env, transport, now
        self.identity = (repository, branch, commit, run_id, scope)
        self.ctx = None
        self.profile = profile
        self.counter = 0
        self.account = None
        self.backend = None
        self.encryption = None

    def temporary(self, suffix='json'):
        self.counter += 1
        return self.work / f'command-{self.counter}.{suffix}'

    def child_env(self, kind):
        keys = ['PATH', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'SYSTEMROOT']
        if kind == 'github':
            keys += ['HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN']
        elif kind == 'aws':
            keys += ['HOME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
                     'AWS_SECURITY_TOKEN', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE']
        result = {k: self.env[k] for k in keys if k in self.env}
        result.update(TMPDIR=str(self.work), TMP=str(self.work), TEMP=str(self.work))
        if kind == 'aws':
            result.update(AWS_IGNORE_CONFIGURED_ENDPOINT_URLS='true', AWS_EC2_METADATA_DISABLED='true',
                          AWS_MAX_ATTEMPTS='1', AWS_PAGER='', AWS_CLI_AUTO_PROMPT='off')
        if kind == 'render':
            result.update(AWS_EC2_METADATA_DISABLED='true', AWS_CONFIG_FILE='/dev/null',
                          AWS_SHARED_CREDENTIALS_FILE='/dev/null', TF_IN_AUTOMATION='1', CHECKPOINT_DISABLE='1')
        return result

    def command(self, args, kind, *, limit=META_LIMIT, cwd=None, env_extra=None, timeout=120):
        output = self.temporary('out')
        self.transport(args, output, env={**self.child_env(kind), **(env_extra or {})},
                       limit=limit, timeout=timeout, cwd=cwd)
        data = private_read(output, limit, protected=True)
        return data

    def gh(self, path, *, binary=False, limit=META_LIMIT):
        raw = self.command(['gh', 'api', '--hostname', 'github.com', path], 'github', limit=limit)
        return raw if binary else parse_json(raw)

    def ci_context(self, publishing):
        repo, branch, commit, run_id, scope = self.identity
        expected = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': repo,
                    'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/' + branch,
                    'GITHUB_SHA': commit,
                    'GITHUB_WORKFLOW_REF': f'{repo}/.github/workflows/terraform.yml@refs/heads/{branch}'}
        if publishing:
            expected.update(GITHUB_JOB='publish', GITHUB_RUN_ID=str(run_id))
        require(all(self.env.get(k) == v for k, v in expected.items()), 'invalid_ci_context')
        require(self.env.get('TF_WORKSPACE', 'default') in ('', 'default'), 'workspace_not_default')
        if branch in DEV_TARGETS:
            value = self.env.get('AWS_ACCOUNT_ID_DEV')
            require(isinstance(value, str) and re.fullmatch(r'[0-9]{12}', value), 'configured_dev_account_required')

    def source(self, publishing=False):
        repo, branch, commit, run_id, scope = self.identity
        legacy.validate_identity(repo, branch, commit, run_id)
        require(scope in assets.SCOPES, 'invalid_context')
        run = self.gh(f'repos/{repo}/actions/runs/{run_id}')
        require(isinstance(run, dict) and type(run.get('id')) is int and run['id'] == int(run_id)
                and positive(run.get('run_attempt'), 1000000), 'run_mismatch')
        if publishing:
            self.ci_context(True)
            require(str(run['run_attempt']) == self.env.get('GITHUB_RUN_ATTEMPT')
                    and run.get('status') == 'in_progress' and run.get('conclusion') is None, 'run_not_publishing')
            # Reuse the finished-run helper's immutable identity checks only.
            # Real publisher lifecycle/jobs are enforced here; consumers use real completed status.
            candidate = {**run, 'status': 'completed', 'conclusion': 'success'}
            ci_plan_context.validate_run(candidate, repo, branch, commit)
        else:
            ci_plan_context.validate_run(run, repo, branch, commit)
        self.ctx = context(repo, branch, commit, run_id, scope, run['run_attempt'])
        require(-60 <= self.now() - timestamp(run.get('created_at')) <= 5 * 86400, 'source_expired')
        attempt = self.ctx['attempt']
        bound = self.gh(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}')
        require(type(bound.get('id')) is int and type(bound.get('run_attempt')) is int
                and bound.get('id') == run['id'] and bound.get('run_attempt') == attempt
                and all(bound.get(k) == run.get(k) for k in ['head_sha', 'head_branch', 'event', 'status', 'conclusion', 'path']),
                'attempt_mismatch')
        ci_plan_context.validate_run({**bound, 'status': 'completed', 'conclusion': 'success'}
                                     if publishing else bound, repo, branch, commit)
        jobs = self.gh(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100')
        rows = jobs.get('jobs')
        require(isinstance(rows, list) and len(rows) <= 100 and type(jobs.get('total_count')) is int
                and jobs['total_count'] == len(rows), 'jobs_incomplete')
        for name, wanted in [('Plan', 'completed'), ('Publish private plan', 'in_progress' if publishing else 'completed')]:
            selected = [r for r in rows if isinstance(r, dict) and r.get('name') == name]
            require(len(selected) == 1, 'publisher_or_plan_job_missing')
            job = selected[0]
            require(positive(job.get('id')) and type(job.get('run_id')) is int
                    and type(job.get('run_attempt')) is int
                    and job.get('run_id') == run['id'] and job.get('run_attempt') == attempt
                    and job.get('head_sha') == commit and job.get('status') == wanted
                    and job.get('conclusion') == (None if wanted == 'in_progress' else 'success'), 'job_not_successful')
        self.branch_current()
        return run

    def branch_current(self):
        repo, branch, commit, _, _ = self.identity
        response = self.gh(f'repos/{repo}/git/ref/heads/{branch}')
        require(response.get('object', {}).get('sha') == commit, 'branch_moved')

    def revalidate_source(self):
        original = self.ctx
        self.source(False)
        require(self.same_context(original), 'attempt_mismatch')

    def artifact(self, run, encrypted):
        ctx = self.ctx
        listing = self.gh(f"repos/{ctx['repository']}/actions/runs/{ctx['run_id']}/artifacts?per_page=100")
        rows = listing.get('artifacts')
        require(isinstance(rows, list) and len(rows) <= 100 and type(listing.get('total_count')) is int
                and listing['total_count'] == len(rows), 'artifact_listing_incomplete')
        selected = [r for r in rows if isinstance(r, dict) and r.get('name') == f"tfplan-{ctx['attempt']}"]
        require(len(selected) == 1, 'artifact_not_unique')
        item = selected[0]
        require(positive(item.get('id')) and item.get('expired') is False
                and positive(item.get('size_in_bytes'), ZIP_LIMIT if encrypted else SMALL_LIMIT * 2)
                and isinstance(item.get('digest'), str) and re.fullmatch(r'sha256:[a-f0-9]{64}', item['digest']), 'artifact_invalid')
        created, expiry = timestamp(item.get('created_at')), timestamp(item.get('expires_at'))
        require(timestamp(run['created_at']) <= created <= self.now() + 60
                and self.now() < expiry and self.now() - created <= 5 * 86400
                and 0 < expiry - created <= 5 * 86400 + 60, 'artifact_expired')
        wr = item.get('workflow_run', {})
        require(wr.get('id') == ctx['run_id'] and wr.get('head_sha') == ctx['commit']
                and wr.get('head_branch') == ctx['branch']
                and positive(run['repository'].get('id')) and positive(run['head_repository'].get('id'))
                and wr.get('repository_id') == run['repository']['id']
                and wr.get('head_repository_id') == run['head_repository']['id'], 'artifact_source_mismatch')
        data = self.gh(f"repos/{ctx['repository']}/actions/artifacts/{item['id']}/zip", binary=True,
                       limit=ZIP_LIMIT if encrypted else SMALL_LIMIT * 2)
        require(len(data) == item['size_in_bytes'] and 'sha256:' + digest(data) == item['digest'], 'artifact_digest_mismatch')
        path = self.temporary('zip')
        private_write(path, data)
        limits = {'tfplan.enc': PLAN_LIMIT + 1024, 'tfassets.enc': ASSET_LIMIT} if encrypted else {'reference.json': SMALL_LIMIT}
        result = {}
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            require(len(members) == len(limits) and {x.filename for x in members} == set(limits), 'unsafe_zip')
            for member in members:
                require(not member.is_dir() and not member.flag_bits & 1
                        and stat.S_IFMT(member.external_attr >> 16) in (0, stat.S_IFREG)
                        and 0 < member.file_size <= limits[member.filename]
                        and member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'unsafe_zip')
                with archive.open(member) as stream:
                    content = stream.read(limits[member.filename] + 1)
                require(len(content) == member.file_size, 'unsafe_zip')
                result[member.filename] = content
        return result

    def aws(self, service, operation, *args):
        require(operation in AWS_OPERATIONS.get(service, set()), 'forbidden_operation')
        require(self.backend is not None, 'backend_required')
        region = self.backend['region']
        endpoint = f"https://{ {'s3api': 's3', 'sts': 'sts', 'kms': 'kms'}[service]}.{region}.amazonaws.com"
        cmd = ['aws', '--region', region, '--endpoint-url', endpoint, '--no-cli-pager',
               '--cli-connect-timeout', '5', '--cli-read-timeout', '60']
        if self.profile:
            cmd += ['--profile', self.profile]
        cmd += [service, operation, '--output', 'json', *map(str, args)]
        return parse_json(self.command(cmd, 'aws', timeout=180))

    def caller(self, expected_account=None, expected_role=None):
        if self.env.get('GITHUB_ACTIONS') == 'true' and self.identity[1] in DEV_TARGETS:
            configured = self.env.get('AWS_ACCOUNT_ID_DEV')
            require(isinstance(configured, str) and re.fullmatch(r'[0-9]{12}', configured)
                    and (expected_account is None or configured == expected_account), 'configured_dev_account_mismatch')
            expected_account = configured
        value = self.aws('sts', 'get-caller-identity')
        account = value.get('Account')
        require(isinstance(account, str) and re.fullmatch(r'[0-9]{12}', account)
                and (expected_account is None or account == expected_account), 'caller_mismatch')
        if expected_role:
            pattern = rf'arn:aws:sts::{account}:assumed-role/{re.escape(expected_role)}/[A-Za-z0-9+=,.@_-]{{2,64}}'
            require(isinstance(value.get('Arn'), str) and re.fullmatch(pattern, value['Arn']), 'caller_role_mismatch')
        self.account = account
        return account

    def bucket_call(self, operation, *args):
        return self.aws('s3api', operation, '--bucket', self.backend['bucket'],
                        '--expected-bucket-owner', self.account, *args)

    def posture(self):
        require((self.bucket_call('get-bucket-location').get('LocationConstraint') or 'us-east-1') == self.backend['region'], 'bucket_region_mismatch')
        pab = self.bucket_call('get-public-access-block').get('PublicAccessBlockConfiguration', {})
        require(all(pab.get(k) is True for k in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']), 'bucket_not_private')
        require(self.bucket_call('get-bucket-versioning').get('Status') == 'Enabled', 'bucket_not_versioned')
        own = self.bucket_call('get-bucket-ownership-controls').get('OwnershipControls', {}).get('Rules')
        require(isinstance(own, list) and len(own) == 1 and own[0].get('ObjectOwnership') == 'BucketOwnerEnforced', 'bucket_ownership_invalid')
        try:
            require(self.bucket_call('get-bucket-policy-status').get('PolicyStatus', {}).get('IsPublic') is False, 'bucket_not_private')
        except PrivatePlanError as error:
            if str(error) != 'no_bucket_policy':
                raise
        rules = self.bucket_call('get-bucket-encryption').get('ServerSideEncryptionConfiguration', {}).get('Rules')
        require(isinstance(rules, list) and len(rules) == 1, 'bucket_encryption_invalid')
        rule = rules[0]
        encryption = rule.get('ApplyServerSideEncryptionByDefault', {})
        require(encryption.get('SSEAlgorithm') == 'aws:kms', 'bucket_not_sse_kms')
        key = encryption.get('KMSMasterKeyID')
        key = 'alias/aws/s3' if key is None else key
        require(key_identifier(key, self.backend['region'], self.account), 'bucket_key_invalid')
        metadata = self.aws('kms', 'describe-key', '--key-id', key).get('KeyMetadata', {})
        arn = metadata.get('Arn')
        require(key_identifier(arn, self.backend['region'], self.account, canonical_only=True)
                and metadata.get('AWSAccountId') == self.account
                and metadata.get('KeyId') == arn.rsplit('/', 1)[-1], 'bucket_key_invalid')
        if ':key/' in key or re.fullmatch(KEY_ID, key):
            require(key in (arn, metadata['KeyId']), 'bucket_key_invalid')
        require(metadata.get('Enabled') is True and metadata.get('KeyState') == 'Enabled'
                and metadata.get('KeyUsage') == 'ENCRYPT_DECRYPT'
                and metadata.get('KeySpec') == 'SYMMETRIC_DEFAULT', 'bucket_key_unusable')
        require(type(rule.get('BucketKeyEnabled', False)) is bool, 'bucket_encryption_invalid')
        self.encryption = (arn, rule.get('BucketKeyEnabled', False))

    def upload(self, kind, data):
        require(0 < len(data) <= (PLAN_LIMIT if kind == 'plan' else ASSET_LIMIT if kind == 'assets' else SMALL_LIMIT), 'object_too_large')
        name = f'{kind}-{digest(data)}' + {'plan': '.bin', 'assets': '.tar.gz', 'manifest': '.json'}[kind]
        key = prefix(self.ctx) + name
        path = self.temporary('body')
        private_write(path, data)
        checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
        options = ['--key', key, '--body', str(path), '--server-side-encryption', 'aws:kms',
                   '--if-none-match', '*', '--checksum-sha256', checksum,
                   '--bucket-key-enabled' if self.encryption[1] else '--no-bucket-key-enabled']
        if self.encryption[0]:
            options += ['--ssekms-key-id', self.encryption[0]]
        entry = {'key': key, 'bytes': len(data), 'sha256': digest(data)}
        for attempt in range(3):
            try:
                response = self.bucket_call('put-object', *options)
                break
            except PrivatePlanError as error:
                if str(error) == 'object_already_exists':
                    version = self.bucket_call('head-object', '--key', key).get('VersionId')
                    require(valid_version(version), 'object_version_missing')
                    entry['version_id'] = version
                    self.download(entry, kind, expected_key=self.encryption[0])
                    return entry
                if str(error) not in {'object_put_retryable', 'command_timeout', 'command_failed'}:
                    raise
                require(attempt < 2, 'object_upload_retry_exhausted')
                time.sleep(0.1 * (attempt + 1))
        require(valid_version(response.get('VersionId')) and response.get('ServerSideEncryption') == 'aws:kms'
                and response.get('SSEKMSKeyId') == self.encryption[0]
                and response.get('ChecksumSHA256') == checksum, 'upload_unconfirmed')
        return {**entry, 'version_id': response['VersionId']}

    def check_entry(self, entry, kind):
        limit = PLAN_LIMIT if kind == 'plan' else ASSET_LIMIT if kind == 'assets' else SMALL_LIMIT
        require(exact(entry, ['key', 'version_id', 'bytes', 'sha256']) and positive(entry['bytes'], limit)
                and hashed(entry['sha256']), 'manifest_object_invalid')
        suffix = {'plan': '.bin', 'assets': '.tar.gz', 'manifest': '.json'}[kind]
        require(entry['key'] == prefix(self.ctx) + f"{kind}-{entry['sha256']}{suffix}", 'object_path_invalid')
        version = entry['version_id']
        require(version is None and kind == 'manifest' or valid_version(version), 'object_version_missing')
        return limit

    def download(self, entry, kind, *, expected_key=None):
        limit = self.check_entry(entry, kind)
        version = entry['version_id']
        args = ['--key', entry['key']]
        if version is not None:
            args += ['--version-id', version]
        head = self.bucket_call('head-object', *args)
        require(type(head.get('ContentLength')) is int and head['ContentLength'] == entry['bytes']
                and head.get('ServerSideEncryption') == 'aws:kms' and valid_version(head.get('VersionId'))
                and key_identifier(head.get('SSEKMSKeyId'), self.backend['region'], self.account, canonical_only=True)
                and (expected_key is None or head['SSEKMSKeyId'] == expected_key)
                and (version is None or head['VersionId'] == version), 'object_metadata_mismatch')
        version = head['VersionId']
        path = self.temporary('body')
        private_write(path, b'')
        response = self.bucket_call('get-object', '--key', entry['key'], '--version-id', version,
                                    '--range', f"bytes=0-{entry['bytes']-1}", str(path))
        require(response.get('VersionId') == version and type(response.get('ContentLength')) is int
                and response['ContentLength'] == entry['bytes'] and response.get('ServerSideEncryption') == 'aws:kms'
                and response.get('SSEKMSKeyId') == head['SSEKMSKeyId']
                and response.get('ContentRange') == f"bytes 0-{entry['bytes']-1}/{entry['bytes']}", 'object_response_mismatch')
        data = private_read(path, limit, protected=True)
        require(len(data) == entry['bytes'] and digest(data) == entry['sha256'], 'object_digest_mismatch')
        return data

    def checkout(self, foundation, rendering=False):
        foundation = legacy.real_path(foundation)
        require(foundation.is_dir(), 'invalid_checkout')
        require(self.env.get('TF_WORKSPACE', 'default') in ('', 'default'), 'workspace_not_default')
        workspace = foundation / '.terraform/environment'
        if workspace.exists():
            require(private_read(workspace, 128).decode().strip() == 'default', 'workspace_not_default')
        value = self.command(['git', '-C', str(foundation), 'rev-parse', 'HEAD'], 'render', limit=128)
        require(value.decode().strip() == self.identity[2], 'checkout_mismatch')
        if rendering:
            provider_dir = legacy.real_path(foundation / '.terraform')
            require(provider_dir.is_dir(), 'provider_schemas_missing')
        return foundation

    def same_context(self, value):
        return (exact(value, self.ctx.keys()) and type(value.get('run_id')) is int
                and type(value.get('attempt')) is int and value == self.ctx)

    def policy(self, backend, role_arn):
        self.source(True)
        store_backend = parse_backend(backend, self.env)
        workspace = Path(backend).parent / '.terraform/environment'
        if workspace.exists():
            require(private_read(workspace, 128).decode().strip() == 'default', 'workspace_not_default')
        account, _ = role_identity(role_arn)
        if self.identity[1] in DEV_TARGETS:
            require(account == self.env['AWS_ACCOUNT_ID_DEV'], 'configured_dev_account_mismatch')
        key = store_backend['kms_key_id']
        require(key is None or key_identifier(key, store_backend['region'], account), 'backend_key_mismatch')
        store = {'schema': 1, 'context': self.ctx, 'backend': store_backend, 'account': account,
                 'role_arn': role_arn, 'backend_sha256': binding(store_backend, account)}
        return {'store.json': canonical(store),
                'session-policy.json': canonical(session_policy(store_backend, account, self.ctx))}

    def publish(self, store, foundation):
        run = self.source(True)
        self.checkout(foundation)
        require_ci_key(self.env)
        config = parse_json(private_read(store, SMALL_LIMIT, protected=True))
        require(exact(config, ['schema', 'context', 'backend', 'account', 'role_arn', 'backend_sha256'])
                and type(config['schema']) is int and config['schema'] == 1
                and self.same_context(config['context']), 'store_mismatch')
        account, role = role_identity(config['role_arn'])
        self.backend = validate_backend(config['backend'])
        require(config['account'] == account and config['backend_sha256'] == binding(self.backend, account), 'store_mismatch')
        encrypted = self.artifact(run, True)
        restored = self.work / 'verified'
        restored.mkdir(mode=0o700)
        for name, target in [('tfplan.enc', 'tfplan'), ('tfassets.enc', 'tfassets.tar.gz')]:
            path = self.work / name
            private_write(path, encrypted[name])
            legacy.crypt(path, restored / target, decrypt=True, env=self.env)
        plan = private_read(restored / 'tfplan', PLAN_LIMIT, protected=True)
        archive = private_read(restored / 'tfassets.tar.gz', ASSET_LIMIT, protected=True)
        # Preserve the established authenticated tar/member/mode/content/context checks.
        try:
            assets.restore_assets(restored, restored / 'tfassets.tar.gz', self.ctx['commit'], self.ctx['scope'])
        except (ValueError, OSError):
            raise PrivatePlanError('asset_verification_failed') from None
        self.caller(account, role)
        self.posture()
        self.branch_current()
        objects = {'plan': self.upload('plan', plan), 'assets': self.upload('assets', archive)}
        manifest = canonical({'schema': 1, 'context': self.ctx, 'backend': self.backend,
                              'account': self.account, 'backend_sha256': config['backend_sha256'],
                              'objects': objects})
        manifest_entry = self.upload('manifest', manifest)
        # A completed upload cannot bless a moved branch, cancelled run or newer
        # attempt. Unreferenced private objects are deliberately not deleted.
        self.source(True)
        reference = {'schema': 1, 'storage': STORAGE, 'context': self.ctx,
                     'manifest': {'sha256': manifest_entry['sha256'], 'bytes': manifest_entry['bytes']}}
        return reference

    def receive(self, backend, reviewed=None):
        expected_backend = self.backend = validate_backend(backend)
        run = self.source(False)
        reference = parse_json(self.artifact(run, False)['reference.json'])
        require(exact(reference, ['schema', 'storage', 'context', 'manifest'])
                and type(reference['schema']) is int and reference['schema'] == 1
                and reference['storage'] == STORAGE and self.same_context(reference['context'])
                and exact(reference['manifest'], ['sha256', 'bytes'])
                and hashed(reference['manifest']['sha256']) and positive(reference['manifest']['bytes'], SMALL_LIMIT),
                'invalid_reference')
        self.caller()
        self.posture()
        descriptor = {**reference['manifest'], 'version_id': None,
                      'key': prefix(self.ctx) + 'manifest-' + reference['manifest']['sha256'] + '.json'}
        manifest = parse_json(self.download(descriptor, 'manifest'))
        require(exact(manifest, ['schema', 'context', 'backend', 'account', 'backend_sha256', 'objects'])
                and type(manifest['schema']) is int and manifest['schema'] == 1
                and self.same_context(manifest['context']) and manifest['account'] == self.account
                and exact(manifest['objects'], ['plan', 'assets']), 'invalid_manifest')
        actual_backend = validate_backend(manifest['backend'])
        require(expected_backend == actual_backend
                and manifest['backend_sha256'] == binding(actual_backend, self.account), 'backend_binding_mismatch')
        self.backend = actual_backend
        for kind in ('plan', 'assets'):
            self.check_entry(manifest['objects'][kind], kind)
        if reviewed is not None:
            require(hashed(reviewed) and reviewed == manifest['objects']['plan']['sha256'], 'reviewed_hash_mismatch')
        return reference, manifest


def finish_files(destination, files):
    destination.mkdir(mode=0o700)
    try:
        for name, value in files.items():
            private_write(destination / name, value)
    except BaseException:
        cleanup_owned(destination)
        raise


def execute(mode, *, repository, branch, commit, run_id, scope, backend=None, role_arn=None,
            store=None, foundation=None, destination=None, reviewed_plan_sha256=None,
            profile=None, env=None, transport=None, now=None):
    env = os.environ if env is None else env
    created = None
    created_plan = None
    try:
        legacy.validate_identity(repository, branch, commit, run_id)
        require(scope in assets.SCOPES and mode in ['policy', 'publish', 'restore', 'inspect'], 'invalid_arguments')
        if profile is not None:
            require(mode == 'inspect' and isinstance(profile, str) and re.fullmatch(r'[A-Za-z0-9_@.-]{1,128}', profile), 'invalid_profile')
        if mode == 'inspect':
            require(env.get('GITHUB_ACTIONS') != 'true', 'local_inspection_only')
            require(profile is not None, 'profile_required')
        else:
            require(profile is None, 'invalid_profile')
        operator_backend = None
        if mode in ('restore', 'inspect'):
            require(backend is not None, 'backend_required')
            operator_backend = parse_backend(backend, env)  # Validate before any command or network request.
        if mode == 'restore':
            require(backend is not None and foundation is not None and hashed(reviewed_plan_sha256), 'invalid_arguments')
            foundation = legacy.real_path(foundation)
            require(foundation.is_dir() and not (foundation / 'tfplan').exists()
                    and not (foundation / 'tfplan').is_symlink(), 'plan_destination_not_new')
            parent = foundation.parent
        else:
            require(destination is not None, 'invalid_arguments')
            destination = legacy.new_destination(destination)
            parent = destination.parent
        with scratch(parent, env, ci=mode != 'inspect') as work:
            op = Operation(work, env, transport or run_command, now or time.time,
                           repository, branch, commit, run_id, scope, profile)
            if mode == 'policy':
                require(backend is not None and role_arn is not None, 'invalid_arguments')
                files = op.policy(backend, role_arn)
                finish_files(destination, files)
                created = destination
                result = {'status': 'policy_ready', 'store_file': str(destination / 'store.json'),
                          'session_policy_file': str(destination / 'session-policy.json')}
            elif mode == 'publish':
                require(store is not None and foundation is not None, 'invalid_arguments')
                reference = op.publish(store, foundation)
                finish_files(destination, {'reference.json': canonical(reference)})
                created = destination
                result = {'status': 'published', 'reference_file': str(destination / 'reference.json')}
            else:
                if mode == 'restore':
                    op.ci_context(False)
                    require_ci_key(env)
                foundation = op.checkout(foundation, mode == 'inspect')
                reference, manifest = op.receive(operator_backend, reviewed_plan_sha256 if mode == 'restore' else None)
                plan = op.download(manifest['objects']['plan'], 'plan')
                path = work / 'tfplan'
                private_write(path, plan)
                if mode == 'inspect':
                    outputs = {}
                    for option, name in [('-no-color', 'plan.txt'), ('-json', 'plan.json')]:
                        outputs[name] = op.command(['terraform', 'show', option, str(path)], 'render', cwd=foundation,
                            env_extra={'TF_DATA_DIR': str(foundation / '.terraform')}, limit=RENDER_LIMIT)
                    outputs['receipt.json'] = canonical({'schema': 1, 'context': op.ctx,
                        'plan_sha256': manifest['objects']['plan']['sha256'], 'backend_sha256': manifest['backend_sha256'],
                        'status': 'inspected_not_approved'})
                    op.revalidate_source()
                    finish_files(destination, outputs)
                    created = destination
                    result = {'status': 'inspected', 'receipt_file': str(destination / 'receipt.json')}
                else:
                    bundle = work / 'tfassets.tar.gz'
                    private_write(bundle, op.download(manifest['objects']['assets'], 'assets'))
                    try:
                        assets.restore_assets(work, bundle, commit, scope)
                    except (ValueError, OSError):
                        raise PrivatePlanError('asset_verification_failed') from None
                    op.revalidate_source()
                    private_write(foundation / 'tfplan', plan)
                    created_plan = foundation / 'tfplan'
                    try:
                        assets.restore_assets(foundation, bundle, commit, scope)
                    except (ValueError, OSError):
                        raise PrivatePlanError('asset_verification_failed') from None
                    (foundation / '.build').chmod(0o700)
                    result = {'status': 'restored', 'plan_file': str(foundation / 'tfplan'), 'assets_verified': True}
        return result
    except BaseException as error:
        if created_plan is not None:
            created_plan.unlink(missing_ok=True)
        if created is not None:
            try:
                cleanup_owned(created)
            except OSError:
                pass
        if isinstance(error, (KeyboardInterrupt, SystemExit, PrivatePlanError)):
            raise
        raise PrivatePlanError('verification_failed') from None


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PrivatePlanError('invalid_arguments')


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        commands = parser.add_subparsers(dest='mode', required=True, parser_class=Parser)
        for mode in ['policy', 'publish', 'restore', 'inspect']:
            p = commands.add_parser(mode)
            for name in ['repository', 'branch', 'commit', 'run-id', 'scope']:
                p.add_argument('--' + name, required=True)
            if mode in ['policy', 'restore', 'inspect']:
                p.add_argument('--backend', type=Path, required=True)
            if mode == 'policy':
                p.add_argument('--role-arn', required=True)
            if mode == 'publish':
                p.add_argument('--store', type=Path, required=True)
            if mode != 'policy':
                p.add_argument('--foundation', type=Path, required=True)
            if mode != 'restore':
                p.add_argument('--destination', type=Path, required=True)
            if mode == 'restore':
                p.add_argument('--reviewed-plan-sha256', required=True)
            if mode == 'inspect':
                p.add_argument('--profile', required=True)
        result = execute(**vars(parser.parse_args(argv)))
        print(json.dumps(result, sort_keys=True))
        return 0
    except PrivatePlanError as error:
        category = str(error)
        if not re.fullmatch('[a-z_]{1,64}', category):
            category = 'verification_failed'
        print(f'Private plan operation refused ({category}).', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
