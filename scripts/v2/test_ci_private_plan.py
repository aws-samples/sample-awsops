"""Offline private-plan contracts: real crypto/archive/file checks, fake CLI network."""
import base64
import copy
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).parent))
import ci_tf_assets as assets
import ci_plan_inspect as legacy

SHA, ACCOUNT, REPO, REGION = 'a' * 40, '111122223333', 'example/awsops', 'ap-northeast-2'
BUCKET, KEY = 'private-backend-fixture', 'offline-ci-authentication-key'
ROLE = f'arn:aws:iam::{ACCOUNT}:role/path/fixture-deployer'
KEY_ID = '12345678-1234-1234-1234-123456789012'
KEY_ARN = f'arn:aws:kms:{REGION}:{ACCOUNT}:key/{KEY_ID}'
NOW = 1789380000

def digest(data):
    return hashlib.sha256(data).hexdigest()

def zip_bytes(entries):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries:
            archive.writestr(name, data)
    return stream.getvalue()

class Fixture:
    def __init__(self, case):
        self.case = case
        self.context = dict(repository=REPO, branch='dev', commit=SHA, run_id=23, attempt=1, scope='full')
        self.run = dict(id=23, run_attempt=1, path='.github/workflows/terraform.yml',
                        event='workflow_dispatch', status='in_progress', conclusion=None,
                        head_branch='dev', head_sha=SHA, created_at='2026-09-14T09:58:00Z',
                        repository={'id': 10, 'full_name': REPO}, head_repository={'id': 10, 'full_name': REPO})
        self.jobs = [dict(id=1, run_id=23, run_attempt=1, head_sha=SHA, name='Plan', status='completed', conclusion='success'),
                     dict(id=2, run_id=23, run_attempt=1, head_sha=SHA, name='Publish private plan', status='in_progress', conclusion=None)]
        self.branch = self.checkout = SHA
        self.owner, self.algorithm, self.versioning, self.public = ACCOUNT, 'aws:kms', 'Enabled', False
        self.default_key = None
        self.key_metadata = dict(Arn=KEY_ARN, KeyId=KEY_ID, AWSAccountId=ACCOUNT,
                                 Enabled=True, KeyState='Enabled', KeyUsage='ENCRYPT_DECRYPT',
                                 KeySpec='SYMMETRIC_DEFAULT')
        self.objects, self.calls, self.downloaded = {}, [], []
        self.artifact_changes, self.put_changes, self.get_changes = {}, {}, {}
        self.extra_artifacts, self.extra_entries = [], []
        self.incomplete = False
        self.real_render = False
        self.plan = b'opaque plan with SYNTHETIC_PRIVATE_VALUE'
        self.pack()

    def pack(self, commit=SHA, changed_plan=False):
        root = self.case.root / 'producer'
        (root / '.build').mkdir(parents=True, exist_ok=True)
        (root / 'tfplan').write_bytes(self.plan)
        body = b'exact signed Lambda bytes'
        (root / '.build/function.zip').write_bytes(body)
        projection = {'planned_values': {'root_module': {'resources': [{'values': {
            'filename': '.build/function.zip',
            'source_code_hash': base64.b64encode(hashlib.sha256(body).digest()).decode()}}]}}}
        with mock.patch.object(assets, 'load_plan', return_value=projection):
            assets.bundle_assets(root, root / 'tfassets.tar.gz', commit, 'full')
        if changed_plan:
            (root / 'tfplan').write_bytes(b'changed plan')
        entries = []
        for source, name in [('tfplan', 'tfplan.enc'), ('tfassets.tar.gz', 'tfassets.enc')]:
            out = root / name
            out.unlink(missing_ok=True)
            legacy.crypt(root / source, out, env={'PATH': os.environ['PATH'], 'TF_PLAN_ENC_KEY': KEY})
            entries.append((name, out.read_bytes()))
        self.zip = zip_bytes(entries)

    def completed(self, reference):
        self.run.update(status='completed', conclusion='success')
        self.jobs[1].update(status='completed', conclusion='success')
        self.zip = zip_bytes([('reference.json', Path(reference).read_bytes())])

    def artifact(self):
        result = dict(id=91, name='tfplan-1', expired=False, size_in_bytes=len(self.zip),
                      digest='sha256:' + digest(self.zip), created_at='2026-09-14T09:59:30Z',
                      expires_at='2026-09-19T09:59:30Z', workflow_run=dict(id=23, repository_id=10,
                      head_repository_id=10, head_branch='dev', head_sha=SHA))
        return {**result, **self.artifact_changes}

    def __call__(self, args, output, *, env, cwd=None, limit=None, timeout=None):
        self.calls.append((args, dict(env)))
        value = None
        flag = lambda key: args[args.index(key) + 1]
        if args[0] == 'gh':
            self.case.assertEqual(args[1:4], ['api', '--hostname', 'github.com'])
            url = args[4]
            if url.endswith('/git/ref/heads/' + self.run['head_branch']):
                value = {'object': {'sha': self.branch}}
            elif url.endswith('/jobs?per_page=100'):
                value = {'total_count': len(self.jobs) + int(self.incomplete), 'jobs': self.jobs}
            elif url.endswith('/artifacts?per_page=100'):
                listed = [self.artifact(), *self.extra_artifacts]
                value = {'total_count': len(listed) + int(self.incomplete), 'artifacts': listed}
            elif url.endswith('/artifacts/91/zip'):
                value = self.zip
            elif url in (f'repos/{REPO}/actions/runs/23',
                          f"repos/{REPO}/actions/runs/23/attempts/{self.run['run_attempt']}"):
                value = self.run
            else:
                raise AssertionError('unexpected GitHub route')
        elif args[0] == 'aws':
            for key in ['TF_PLAN_ENC_KEY', 'GITHUB_OUTPUT', 'AWS_ENDPOINT_URL', 'TF_LOG', 'GH_TOKEN']:
                self.case.assertNotIn(key, env)
            self.case.assertEqual(env.get('AWS_SESSION_TOKEN'), 'synthetic-session')
            self.case.assertEqual(env.get('AWS_MAX_ATTEMPTS'), '1')
            service = next(x for x in ['sts', 's3api', 'kms'] if x in args)
            op = args[args.index(service) + 1]
            self.case.assertEqual(flag('--region'), REGION)
            self.case.assertEqual(flag('--endpoint-url'), f'https://{"s3" if service == "s3api" else service}.{REGION}.amazonaws.com')
            if service == 'sts':
                value = {'Account': self.owner, 'Arn': f'arn:aws:sts::{self.owner}:assumed-role/fixture-deployer/session'}
            elif service == 'kms':
                self.case.assertEqual(op, 'describe-key')
                self.case.assertEqual(flag('--key-id'), self.default_key or 'alias/aws/s3')
                value = {'KeyMetadata': self.key_metadata}
            else:
                self.case.assertEqual(flag('--bucket'), BUCKET)
                self.case.assertEqual(flag('--expected-bucket-owner'), ACCOUNT)
                if op == 'get-bucket-location':
                    value = {'LocationConstraint': REGION}
                elif op == 'get-public-access-block':
                    value = {'PublicAccessBlockConfiguration': {x: not self.public for x in
                        ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']}}
                elif op == 'get-bucket-versioning':
                    value = {'Status': self.versioning}
                elif op == 'get-bucket-ownership-controls':
                    value = {'OwnershipControls': {'Rules': [{'ObjectOwnership': 'BucketOwnerEnforced'}]}}
                elif op == 'get-bucket-policy-status':
                    value = {'PolicyStatus': {'IsPublic': self.public}}
                elif op == 'get-bucket-encryption':
                    value = {'ServerSideEncryptionConfiguration': {'Rules': [{
                        'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': self.algorithm,
                            **({'KMSMasterKeyID': self.default_key} if self.default_key is not None else {})},
                        'BucketKeyEnabled': True}]}}
                elif op == 'put-object':
                    self.case.assertEqual(flag('--if-none-match'), '*')
                    self.case.assertEqual(flag('--server-side-encryption'), 'aws:kms')
                    body = Path(flag('--body')).read_bytes()
                    checksum = base64.b64encode(hashlib.sha256(body).digest()).decode()
                    self.case.assertEqual(flag('--checksum-sha256'), checksum)
                    key = flag('--key')
                    self.case.assertTrue(key.startswith(f'ci/tfplans/{REPO}/dev/{SHA}/23/1/'))
                    if key in self.objects:
                        raise self.case.module.PrivatePlanError('object_already_exists')
                    version = 'version-' + str(len(self.objects) + 1)
                    self.objects[key] = (version, body)
                    value = {'VersionId': version, 'ServerSideEncryption': 'aws:kms',
                             'SSEKMSKeyId': KEY_ARN, 'ChecksumSHA256': checksum, **self.put_changes}
                elif op in ['head-object', 'get-object']:
                    key = flag('--key')
                    version, body = self.objects[key]
                    value = {'VersionId': version, 'ContentLength': len(body), 'ServerSideEncryption': 'aws:kms',
                             'SSEKMSKeyId': KEY_ARN, **self.get_changes}
                    if op == 'get-object':
                        self.case.assertEqual(flag('--version-id'), version)
                        self.case.assertEqual(flag('--range'), f'bytes=0-{len(body)-1}')
                        self.downloaded.append(key)
                        Path(args[-1]).write_bytes(body)
                        os.chmod(args[-1], 0o600)
                        value['ContentRange'] = f'bytes 0-{len(body)-1}/{len(body)}'
                else:
                    raise AssertionError('unexpected AWS operation')
        elif args[0] == 'git':
            self.case.assertEqual(args[-2:], ['rev-parse', 'HEAD'])
            value = self.checkout + '\n'
        elif args[0] == 'terraform':
            self.case.assertEqual(args[1], 'show')
            self.case.assertEqual(Path(args[-1]).read_bytes(), self.plan)
            safe_aws = {'AWS_EC2_METADATA_DISABLED', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE'}
            self.case.assertFalse(any((k.startswith('AWS_') and k not in safe_aws)
                or k.startswith(('TF_LOG', 'TF_CLI_ARGS', 'GITHUB_'))
                or k.endswith('_TOKEN') or k == 'TF_PLAN_ENC_KEY' for k in env))
            self.case.assertEqual(env.get('AWS_EC2_METADATA_DISABLED'), 'true')
            self.case.assertEqual(env.get('AWS_CONFIG_FILE'), '/dev/null')
            if self.real_render:
                return self.case.module.run_command(args, output, env=env, cwd=cwd, limit=limit, timeout=timeout)
            value = b'PRIVATE_RENDERED_PLAN'
        else:
            raise AssertionError('unexpected executable')
        data = value if isinstance(value, bytes) else value.encode() if isinstance(value, str) else json.dumps(value).encode()
        Path(output).write_bytes(data)
        os.chmod(output, 0o600)

class PrivatePlanTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(Path(__file__).with_name('ci_private_plan.py').is_file(), 'Private S3 plan helper is not implemented')
        self.module = importlib.import_module('ci_private_plan')
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.foundation = self.root / 'checkout/terraform/foundation'
        self.foundation.mkdir(parents=True)
        (self.foundation / '.terraform').mkdir()
        self.backend = self.root / 'backend.hcl'
        self.backend.write_text(f'bucket="{BUCKET}"\nkey="dev/terraform.tfstate"\nregion="{REGION}"\nencrypt=true\nuse_lockfile=true\n')
        patch = mock.patch.dict(os.environ, {'TF_PLAN_ENC_KEY': KEY, 'GITHUB_EVENT_NAME': 'workflow_dispatch'})
        patch.start()
        self.addCleanup(patch.stop)
        self.env = dict(PATH=os.environ['PATH'], HOME=str(self.root), GITHUB_ACTIONS='true', GITHUB_REPOSITORY=REPO,
                        GITHUB_EVENT_NAME='workflow_dispatch', GITHUB_REF='refs/heads/dev', GITHUB_SHA=SHA,
                        GITHUB_RUN_ID='23', GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish',
                        GITHUB_WORKFLOW_REF=f'{REPO}/.github/workflows/terraform.yml@refs/heads/dev',
                        GH_TOKEN='synthetic-gh-token', TF_PLAN_ENC_KEY=KEY, AWS_ACCESS_KEY_ID='synthetic-access',
                        AWS_SECRET_ACCESS_KEY='synthetic-secret', AWS_SESSION_TOKEN='synthetic-session',
                        AWS_ACCOUNT_ID_DEV=ACCOUNT,
                        AWS_ENDPOINT_URL='https://untrusted.invalid', TF_LOG='TRACE', TF_CLI_ARGS='-unsafe', GITHUB_OUTPUT='/untrusted')
        self.fake = Fixture(self)

    def invoke(self, mode, **kw):
        return self.module.execute(mode, repository=REPO, branch='dev', commit=SHA, run_id='23', scope='full',
                                   env=self.env, transport=self.fake, now=lambda: NOW, **kw)

    def policy(self):
        return self.invoke('policy', backend=self.backend, role_arn=ROLE, destination=self.root / 'policy')

    def publish(self):
        p = self.policy()
        return self.invoke('publish', store=p['store_file'], foundation=self.foundation, destination=self.root / 'reference')

    def ready(self):
        r = self.publish()
        self.fake.completed(r['reference_file'])
        return r

    def inspect(self, **kw):
        env = {k: v for k, v in self.env.items() if not k.startswith('GITHUB_') and k != 'TF_PLAN_ENC_KEY'}
        env['GITHUB_ACTIONS'] = 'false'
        with mock.patch.dict(os.environ, {'TF_PLAN_ENC_KEY': '', 'GITHUB_ACTIONS': 'false'}):
            return self.module.execute('inspect', repository=REPO, branch='dev', commit=SHA, run_id='23', scope='full',
                env=env, transport=self.fake, now=lambda: NOW, foundation=self.foundation,
                destination=self.root / 'review', profile='samples', **kw)

    def assert_public_safe(self, *values):
        text = json.dumps(values)
        private = [BUCKET, ACCOUNT, ROLE, REGION, KEY_ARN, KEY_ID, 'dev/terraform.tfstate', KEY, 'SYNTHETIC_PRIVATE_VALUE']
        private += [self.env[key] for key in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
                                             'AWS_SESSION_TOKEN', 'GH_TOKEN') if self.env.get(key)]
        hashes = [digest(value.encode()) for value in private] + [digest(self.fake.plan)]
        store = self.root / 'policy/store.json'
        if store.exists():
            hashes.append(json.loads(store.read_text())['backend_sha256'])
        hashes += [digest(body) for key, (_, body) in self.fake.objects.items() if '/manifest-' not in key]
        for value in private + hashes:
            self.assertNotIn(value, text)

    def test_publish_reference_is_private_and_attempt_bound(self):
        r = self.publish()
        raw = Path(r['reference_file']).read_text()
        reference = json.loads(raw)
        self.assertEqual(reference['context'], self.fake.context)
        self.assertEqual(set(reference), {'schema', 'storage', 'context', 'manifest'})
        self.assertEqual(set(reference['manifest']), {'sha256', 'bytes'})
        self.assertEqual(len(self.fake.objects), 3)
        self.assert_public_safe(reference, r)

    def test_inspection_needs_no_ci_key_or_assets(self):
        r = self.ready()
        result = self.inspect(backend=self.backend)
        receipt = json.loads(Path(result['receipt_file']).read_text())
        self.assertEqual(receipt['plan_sha256'], digest(self.fake.plan))
        self.assertEqual(receipt['status'], 'inspected_not_approved')
        self.assert_public_safe(result)
        self.assertEqual({p.name for p in (self.root / 'review').iterdir()}, {'plan.txt', 'plan.json', 'receipt.json'})
        self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in (self.root / 'review').iterdir()))
        self.assertEqual((self.root / 'review').stat().st_mode & 0o777, 0o700)
        self.assertFalse(any('/assets-' in key for key in self.fake.downloaded))
        self.assertFalse((self.foundation / '.build').exists())

    def test_restore_uses_reviewed_hash_and_existing_asset_authentication(self):
        self.ready()
        inspected = self.inspect(backend=self.backend)
        reviewed = json.loads(Path(inspected['receipt_file']).read_text())['plan_sha256']
        self.fake.calls.clear()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24')
        with self.assertRaises(self.module.PrivatePlanError):
            self.invoke('restore', backend=self.backend, foundation=self.foundation, reviewed_plan_sha256='0' * 64)
        self.assertFalse((self.foundation / 'tfplan').exists())
        result = self.invoke('restore', backend=self.backend, foundation=self.foundation, reviewed_plan_sha256=reviewed)
        self.assert_public_safe(result)
        self.assertTrue(result['assets_verified'])
        self.assertEqual((self.foundation / 'tfplan').read_bytes(), self.fake.plan)
        self.assertEqual((self.foundation / '.build/function.zip').read_bytes(), b'exact signed Lambda bytes')
        self.assertFalse(any(args[0] == 'terraform' for args, _ in self.fake.calls))

    def test_restore_preserves_authenticated_file_modes_inside_private_build_root(self):
        import tarfile
        expected = {
            '.build/deferred/entrypoint.sh': (0o755, b'#!/bin/sh\nexit 0\n'),
            '.build/deferred/settings.txt': (0o644, b'deferred archive input\n'),
        }
        producer = self.root / 'producer'
        for name, (mode, content) in expected.items():
            path = producer / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            path.chmod(mode)
        self.fake.pack()
        with tarfile.open(producer / 'tfassets.tar.gz', 'r:gz') as archive:
            manifest = json.load(archive.extractfile(assets.MANIFEST))
            for name, (mode, _) in expected.items():
                self.assertEqual(manifest['files'][name]['mode'], mode)
                self.assertEqual(archive.getmember(name).mode, mode)
        published = self.ready()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24')
        restored = self.invoke('restore', backend=self.backend, foundation=self.foundation,
                                reviewed_plan_sha256=digest(self.fake.plan))
        self.assertTrue(restored['assets_verified'])
        for name, (mode, content) in expected.items():
            self.assertEqual(stat.S_IMODE((self.foundation / name).stat().st_mode), mode)
            self.assertEqual((self.foundation / name).read_bytes(), content)
        self.assertEqual(stat.S_IMODE((self.foundation / '.build').stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.foundation / 'tfplan').stat().st_mode), 0o600)

    def reset_policy(self):
        shutil.rmtree(self.root / 'policy', ignore_errors=True)

    def test_backend_rejects_unknown_duplicate_expression_and_reserved_state_fields(self):
        original = self.backend.read_text()
        variants = [original + 'bucket="other"\n', original + 'endpoint="https://bad.invalid"\n',
                    original + 'profile="samples"\n', original.replace('encrypt=true', 'encrypt=false'),
                    original.replace(BUCKET, '${var.bucket}'), original.replace('dev/terraform.tfstate', 'ci/tfplans/state'),
                    original.replace('use_lockfile=true', 'use_lockfile=1')]
        for body in variants:
            self.backend.write_text(body)
            with self.assertRaises(self.module.PrivatePlanError):
                self.policy()
            self.assertFalse((self.root / 'policy').exists())
        self.assertFalse(self.fake.objects)

    def test_session_policy_cannot_read_state_mutate_infrastructure_or_delete_artifacts(self):
        import fnmatch
        result = self.policy()
        policy = json.loads(Path(result['session_policy_file']).read_text())
        def allowed(action, resource):
            return any(any(fnmatch.fnmatchcase(action, a) for a in s['Action'])
                       and any(fnmatch.fnmatchcase(resource, r) for r in
                         (s['Resource'] if isinstance(s['Resource'], list) else [s['Resource']])) for s in policy['Statement'])
        key = f'arn:aws:s3:::{BUCKET}/ci/tfplans/{REPO}/dev/{SHA}/23/1/file'
        self.assertTrue(allowed('s3:PutObject', key))
        self.assertTrue(allowed('s3:GetObjectVersion', key))
        self.assertFalse(allowed('s3:GetObject', f'arn:aws:s3:::{BUCKET}/dev/terraform.tfstate'))
        self.assertFalse(allowed('s3:DeleteObject', key))
        self.assertFalse(allowed('ecs:UpdateService', '*'))
        kms = next(s for s in policy['Statement'] if 'kms:Decrypt' in s['Action'])
        self.assertEqual(kms['Condition']['StringEquals']['kms:ViaService'], f's3.{REGION}.amazonaws.com')
        self.assertLessEqual(len(json.dumps(policy, separators=(',', ':'))), 2048)
        self.assertFalse(any(args[0] == 'aws' for args, _ in self.fake.calls))

    def test_failed_or_duplicate_plan_and_wrong_attempt_cannot_publish(self):
        original = copy.deepcopy(self.fake.jobs)
        for kind in ['failed', 'duplicate', 'incomplete', 'attempt', 'wrong_job', 'wrong_event']:
            self.fake.jobs = copy.deepcopy(original)
            self.fake.incomplete = False
            self.env.update(GITHUB_RUN_ATTEMPT='1', GITHUB_JOB='publish', GITHUB_EVENT_NAME='workflow_dispatch')
            if kind == 'failed': self.fake.jobs[0]['conclusion'] = 'failure'
            if kind == 'duplicate': self.fake.jobs.append(copy.deepcopy(self.fake.jobs[0]))
            if kind == 'incomplete': self.fake.incomplete = True
            if kind == 'attempt': self.env['GITHUB_RUN_ATTEMPT'] = '2'
            if kind == 'wrong_job': self.env['GITHUB_JOB'] = 'plan'
            if kind == 'wrong_event': self.env['GITHUB_EVENT_NAME'] = 'pull_request'
            with self.assertRaises(self.module.PrivatePlanError): self.publish()
            self.assertFalse(self.fake.objects)
            self.reset_policy()

    def test_boolean_attempt_metadata_is_not_an_integer_job_identity(self):
        self.fake.jobs[1]['run_attempt'] = True
        with self.assertRaises(self.module.PrivatePlanError): self.policy()
        self.assertFalse((self.root / 'policy').exists())

    def test_wrong_signed_commit_changed_plan_or_wrong_key_prevent_s3_writes(self):
        for commit, changed in [('b' * 40, False), (SHA, True)]:
            self.fake.pack(commit, changed)
            with self.assertRaises(self.module.PrivatePlanError): self.publish()
            self.assertFalse(self.fake.objects)
            self.reset_policy()
        self.fake.pack()
        self.env['TF_PLAN_ENC_KEY'] = 'wrong-fixture-key'
        with self.assertRaises(self.module.PrivatePlanError): self.publish()
        self.assertFalse(self.fake.objects)

    def test_bucket_owner_privacy_versioning_and_kms_posture_fail_closed(self):
        for field, bad in [('owner', '999999999999'), ('public', True), ('algorithm', 'AES256'), ('versioning', 'Suspended')]:
            previous = getattr(self.fake, field)
            setattr(self.fake, field, bad)
            with self.assertRaises(self.module.PrivatePlanError): self.publish()
            self.assertFalse(self.fake.objects)
            setattr(self.fake, field, previous)
            self.reset_policy()

    def test_uncertain_upload_versions_checksums_or_conflicts_never_emit_reference(self):
        for changes in [{'VersionId': 'null'}, {'VersionId': ''}, {'ChecksumSHA256': 'wrong'}]:
            self.fake.put_changes = changes
            with self.assertRaises(self.module.PrivatePlanError): self.publish()
            self.assertFalse((self.root / 'reference').exists())
            self.fake.objects.clear()
            self.reset_policy()

    def test_completed_run_publisher_artifact_expiry_digest_and_uniqueness_are_required(self):
        self.ready()
        for kind in ['failed_run', 'failed_publisher', 'expired', 'age', 'digest', 'duplicate', 'incomplete']:
            self.fake.run['conclusion'] = 'success'
            self.fake.jobs[1]['conclusion'] = 'success'
            self.fake.artifact_changes, self.fake.extra_artifacts = {}, []
            self.fake.incomplete = False
            if kind == 'failed_run': self.fake.run['conclusion'] = 'failure'
            if kind == 'failed_publisher': self.fake.jobs[1]['conclusion'] = 'failure'
            if kind == 'expired': self.fake.artifact_changes['expired'] = True
            if kind == 'age': self.fake.artifact_changes['created_at'] = '2026-09-01T00:00:00Z'
            if kind == 'digest': self.fake.artifact_changes['digest'] = 'sha256:' + '0' * 64
            if kind == 'duplicate': self.fake.extra_artifacts = [self.fake.artifact()]
            if kind == 'incomplete': self.fake.incomplete = True
            with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
            self.assertFalse((self.root / 'review').exists())

    def test_foreign_or_moved_sources_and_wrong_checkout_never_render(self):
        self.ready()
        for key, value in [('repository', {'id': 20, 'full_name': 'other/repo'}),
                           ('head_sha', 'b' * 40), ('event', 'push')]:
            previous = self.fake.run[key]
            self.fake.run[key] = value
            with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
            self.fake.run[key] = previous
        self.fake.branch = 'b' * 40
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.fake.branch, self.fake.checkout = SHA, 'b' * 40
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertFalse(any(args[0] == 'terraform' for args, _ in self.fake.calls))

    def test_inspection_requires_valid_backend_before_any_command(self):
        self.ready()
        self.fake.calls.clear()
        invalid = self.root / 'invalid.hcl'
        invalid.write_text('bucket="unvalidated"\n')
        for backend in [None, self.root / 'missing.hcl', invalid]:
            with self.subTest(backend=backend), self.assertRaises(self.module.PrivatePlanError):
                self.inspect(backend=backend)
            self.assertFalse(self.fake.calls)
            self.assertFalse((self.root / 'review').exists())
        self.assertEqual(self.inspect(backend=self.backend)['status'], 'inspected')
        self.assertFalse(any('list-buckets' in args for args, _ in self.fake.calls))
        self.assertTrue(any('--profile' in args and 'samples' in args for args, _ in self.fake.calls if args[0] == 'aws'))

    def test_cli_requires_backend_before_execution(self):
        args = ['inspect', '--repository', REPO, '--branch', 'dev', '--commit', SHA,
                '--run-id', '23', '--scope', 'full', '--profile', 'samples',
                '--foundation', str(self.foundation), '--destination', str(self.root / 'review')]
        with mock.patch.object(self.module, 'execute') as execute, mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(self.module.main(args), 1)
        execute.assert_not_called()

    def test_all_cli_results_exclude_private_values_and_hashes(self):
        execute = self.module.execute
        active_env = self.env
        common = ['--repository', REPO, '--branch', 'dev', '--commit', SHA, '--run-id', '23', '--scope', 'full']
        def cli(mode, extra):
            output, errors = io.StringIO(), io.StringIO()
            def controlled(**args):
                return execute(**args, env=active_env, transport=self.fake, now=lambda: NOW)
            with mock.patch.object(self.module, 'execute', side_effect=controlled), \
                    mock.patch('sys.stdout', output), mock.patch('sys.stderr', errors):
                self.assertEqual(self.module.main([mode, *common, *extra]), 0, errors.getvalue())
            self.assert_public_safe(output.getvalue())
            self.assertNotRegex(output.getvalue(), r'\b[a-f0-9]{64}\b')
            return json.loads(output.getvalue())
        policy = cli('policy', ['--backend', str(self.backend), '--role-arn', ROLE,
                                '--destination', str(self.root / 'policy')])
        published = cli('publish', ['--store', policy['store_file'], '--foundation', str(self.foundation),
                                    '--destination', str(self.root / 'reference')])
        self.fake.completed(published['reference_file'])
        active_env = {k: v for k, v in self.env.items() if not k.startswith('GITHUB_') and k != 'TF_PLAN_ENC_KEY'}
        active_env['GITHUB_ACTIONS'] = 'false'
        inspected = cli('inspect', ['--backend', str(self.backend), '--profile', 'samples',
                                    '--foundation', str(self.foundation), '--destination', str(self.root / 'review')])
        receipt = json.loads(Path(inspected['receipt_file']).read_text())
        self.assertEqual(receipt['plan_sha256'], digest(self.fake.plan))
        self.assertEqual(receipt['backend_sha256'], json.loads(Path(policy['store_file']).read_text())['backend_sha256'])
        active_env = self.env | {'GITHUB_JOB': 'apply', 'GITHUB_RUN_ID': '24'}
        cli('restore', ['--backend', str(self.backend), '--foundation', str(self.foundation),
                        '--reviewed-plan-sha256', receipt['plan_sha256']])

    def test_zip_links_paths_duplicates_and_extra_files_do_not_become_references(self):
        result = self.ready()
        reference = Path(result['reference_file']).read_bytes()
        link = zipfile.ZipInfo('reference.json')
        link.create_system, link.external_attr = 3, (stat.S_IFLNK | 0o777) << 16
        for entries in [[('../reference.json', reference)], [(link, reference)],
                        [('reference.json', reference), ('reference.json', reference)],
                        [('reference.json', reference), ('extra', b'private')]]:
            with __import__('warnings').catch_warnings():
                __import__('warnings').simplefilter('ignore', UserWarning)
                self.fake.zip = zip_bytes(entries)
            with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertFalse((self.root / 'review').exists())

    def change_manifest(self, change):
        old = next(key for key in self.fake.objects if '/manifest-' in key)
        version, data = self.fake.objects[old]
        manifest = json.loads(data)
        change(manifest)
        data = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
        key = old.rsplit('/', 1)[0] + '/manifest-' + digest(data) + '.json'
        self.fake.objects[key] = (version, data)
        reference = json.loads(Path(self.root / 'reference/reference.json').read_text())
        reference['manifest'] = {'sha256': digest(data), 'bytes': len(data)}
        self.fake.zip = zip_bytes([('reference.json', json.dumps(reference).encode())])

    def test_inspection_rejects_unsafe_asset_metadata_without_downloading_assets(self):
        self.ready()
        self.change_manifest(lambda m: m['objects']['assets'].update(key='../escape'))
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertFalse(any(args[0] == 'terraform' for args, _ in self.fake.calls))
        self.assertFalse(any('/assets-' in key for key in self.fake.downloaded))

    def test_reference_extra_identifiers_boolean_context_and_manifest_binding_are_rejected(self):
        result = self.ready()
        base = json.loads(Path(result['reference_file']).read_text())
        for change in [lambda r: r.update(bucket=BUCKET), lambda r: r['context'].update(attempt=True),
                       lambda r: r.update(region=REGION), lambda r: r.update(bucket_sha256=digest(BUCKET.encode())),
                       lambda r: r.update(backend_sha256='0' * 64),
                       lambda r: r.update(plan_sha256=digest(self.fake.plan))]:
            reference = copy.deepcopy(base)
            change(reference)
            self.fake.zip = zip_bytes([('reference.json', json.dumps(reference).encode())])
            with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertFalse((self.root / 'review').exists())

    def test_private_manifest_must_match_exact_operator_backend_and_caller(self):
        self.ready()
        for field, value in [('key', 'other/state'), ('region', 'us-east-1'), ('bucket', 'other-backend-fixture'),
                             ('workspace_key_prefix', 'other'), ('account', '999999999999'),
                             ('kms_key_id', f'arn:aws:kms:{REGION}:{ACCOUNT}:key/11111111-1111-1111-1111-111111111111')]:
            def change(manifest):
                if field == 'account':
                    manifest['account'] = value
                else:
                    manifest['backend'][field] = value
                manifest['backend_sha256'] = self.module.binding(manifest['backend'], manifest['account'])
            self.change_manifest(change)
            with self.subTest(field=field), self.assertRaises(self.module.PrivatePlanError):
                self.inspect(backend=self.backend)
            self.assertFalse(any('/plan-' in key or '/assets-' in key for key in self.fake.downloaded))
        self.assertFalse((self.root / 'review').exists())

    def test_changed_bytes_or_missing_versions_are_rejected(self):
        self.ready()
        for key, original in list(self.fake.objects.items()):
            if '/assets-' in key: continue
            version, data = original
            self.fake.objects[key] = (version, data + b'tampered')
            with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
            self.fake.objects[key] = original
            if '/plan-' in key:
                self.fake.objects[key] = (version, bytes([body_byte ^ 1 for body_byte in data[:1]]) + data[1:])
                with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
                self.assertFalse(any(args[0] == 'terraform' for args, _ in self.fake.calls))
                self.fake.objects[key] = original
        self.fake.get_changes = {'VersionId': 'null'}
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertFalse((self.root / 'review').exists())

    def test_existing_destinations_symlinks_wrong_backend_and_ci_inspection_fail(self):
        self.ready()
        (self.root / 'review').mkdir()
        (self.root / 'review/keep').write_text('keep')
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        self.assertEqual((self.root / 'review/keep').read_text(), 'keep')
        shutil.rmtree(self.root / 'review')
        (self.root / 'review').symlink_to(self.foundation, target_is_directory=True)
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        (self.root / 'review').unlink()
        self.backend.write_text(self.backend.read_text().replace('dev/terraform.tfstate', 'other/state'))
        with self.assertRaises(self.module.PrivatePlanError): self.inspect(backend=self.backend)
        with self.assertRaises(self.module.PrivatePlanError):
            self.invoke('inspect', backend=self.backend, foundation=self.foundation, destination=self.root / 'review', profile='samples')

    def test_cleanup_failure_cannot_report_success_or_leave_public_reference(self):
        real = self.module.cleanup_owned
        def failing(path):
            if Path(path).name.startswith('.private-plan-'):
                real(path)
                raise OSError('SYNTHETIC_PRIVATE_VALUE')
            real(path)
        with mock.patch.object(self.module, 'cleanup_owned', side_effect=failing):
            with self.assertRaisesRegex(self.module.PrivatePlanError, 'cleanup_failed'): self.policy()
        self.assertFalse((self.root / 'policy').exists())

    def test_cli_errors_and_bounded_command_never_print_private_values(self):
        output, errors = io.StringIO(), io.StringIO()
        with mock.patch('sys.stdout', output), mock.patch('sys.stderr', errors):
            self.assertEqual(self.module.main(['--unrecognized', 'SYNTHETIC_PRIVATE_VALUE']), 1)
        self.assertNotIn('SYNTHETIC_PRIVATE_VALUE', output.getvalue() + errors.getvalue())
        target = self.root / 'bounded'
        with self.assertRaises(self.module.PrivatePlanError):
            self.module.run_command([sys.executable, '-c', "print('x'*100000)"], target,
                                    env={'PATH': os.environ['PATH']}, limit=100, timeout=5)
        self.assertLessEqual(target.stat().st_size, 100)

    def test_restore_does_not_use_a_different_ambient_authentication_key(self):
        result = self.ready()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24', TF_PLAN_ENC_KEY='wrong-key')
        with self.assertRaises(self.module.PrivatePlanError):
            self.invoke('restore', backend=self.backend, foundation=self.foundation,
                        reviewed_plan_sha256=digest(self.fake.plan))
        self.assertFalse((self.foundation / 'tfplan').exists())

    def test_asset_tar_links_cannot_be_published_even_in_a_digest_valid_encrypted_handoff(self):
        import tarfile
        source = self.root / 'producer'
        with tarfile.open(source / 'tfassets.tar.gz', 'r:gz') as original:
            members = [(m, original.extractfile(m).read()) for m in original]
        bad = source / 'unsafe.tar.gz'
        with tarfile.open(bad, 'w:gz') as archive:
            for member, content in members:
                archive.addfile(member, io.BytesIO(content))
            link = tarfile.TarInfo('.build/link')
            link.type, link.linkname = tarfile.SYMTYPE, '../../private'
            archive.addfile(link)
        encoded = source / 'unsafe.enc'
        legacy.crypt(bad, encoded, env={'PATH': os.environ['PATH'], 'TF_PLAN_ENC_KEY': KEY})
        self.fake.zip = zip_bytes([('tfplan.enc', (source / 'tfplan.enc').read_bytes()), ('tfassets.enc', encoded.read_bytes())])
        with self.assertRaises(self.module.PrivatePlanError): self.publish()
        self.assertFalse(self.fake.objects)

    def test_wrong_store_permissions_and_workspace_never_publish(self):
        p = self.policy()
        Path(p['store_file']).chmod(0o644)
        with self.assertRaises(self.module.PrivatePlanError):
            self.invoke('publish', store=p['store_file'], foundation=self.foundation,
                        destination=self.root / 'reference')
        self.assertFalse(self.fake.objects)
        Path(p['store_file']).chmod(0o600)
        (self.foundation / '.terraform/environment').write_text('other')
        with self.assertRaises(self.module.PrivatePlanError):
            self.invoke('publish', store=p['store_file'], foundation=self.foundation,
                        destination=self.root / 'reference')
        self.assertFalse(self.fake.objects)

    def test_real_provider_free_plan_renders_after_source_asset_is_removed_without_key(self):
        environment = {k: v for k, v in os.environ.items() if not k.startswith(('AWS_', 'TF_VAR_', 'TF_LOG', 'TF_CLI_ARGS'))}
        environment.update(CHECKPOINT_DISABLE='1', AWS_EC2_METADATA_DISABLED='true',
                           AWS_CONFIG_FILE='/dev/null', AWS_SHARED_CREDENTIALS_FILE='/dev/null')
        (self.foundation / 'asset.txt').write_text('private source content')
        (self.foundation / 'main.tf').write_text('resource "terraform_data" "sample" { input = file("asset.txt") }\n')
        for args in [['init', '-backend=false', '-input=false', '-no-color'],
                     ['plan', '-input=false', '-no-color', '-out=fixture.tfplan']]:
            subprocess.run(['terraform', *args], cwd=self.foundation, env=environment,
                           check=True, capture_output=True, timeout=60)
        self.fake.plan = (self.foundation / 'fixture.tfplan').read_bytes()
        self.fake.pack()
        self.ready()
        (self.foundation / 'asset.txt').unlink()
        self.fake.real_render = True
        inspected = self.inspect(backend=self.backend)
        document = json.loads((self.root / 'review/plan.json').read_text())
        self.assertEqual(document['planned_values']['root_module']['resources'][0]['values']['input'], 'private source content')
        self.assertEqual(json.loads(Path(inspected['receipt_file']).read_text())['plan_sha256'], digest(self.fake.plan))
        self.assertFalse((self.foundation / '.build').exists())
        self.assertFalse(any('/assets-' in key for key in self.fake.downloaded))

    def test_publisher_only_rerun_cannot_use_the_previous_attempt_handoff(self):
        self.fake.run['run_attempt'] = 2
        for job in self.fake.jobs:
            job['run_attempt'] = 2
        self.env['GITHUB_RUN_ATTEMPT'] = '2'
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'artifact_not_unique'):
            self.publish()
        self.assertFalse(self.fake.objects)

    def test_static_workspace_prefix_is_supported_only_with_default_workspace(self):
        self.backend.write_text(self.backend.read_text() + 'workspace_key_prefix="env:"\n')
        result = self.policy()
        store = json.loads(Path(result['store_file']).read_text())
        self.assertEqual(store['backend']['workspace_key_prefix'], 'env:')
        self.assertEqual(store['backend']['workspace'], 'default')
        self.reset_policy()
        self.env['TF_WORKSPACE'] = 'production'
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'workspace_not_default'):
            self.policy()

    def test_dev_policy_requires_independent_configured_account_and_role_match(self):
        for value in [None, '', 'invalid', '999999999999']:
            if value is None: self.env.pop('AWS_ACCOUNT_ID_DEV', None)
            else: self.env['AWS_ACCOUNT_ID_DEV'] = value
            with self.assertRaises(self.module.PrivatePlanError): self.policy()
            self.assertFalse((self.root / 'policy').exists())
        self.assertFalse(any(args[0] == 'aws' for args, _ in self.fake.calls))

    def test_every_dev_family_branch_pins_policy_and_ci_caller_but_not_local_inspection(self):
        from ci_runtime_policy import DEV_TARGETS
        for branch in DEV_TARGETS:
            self.env.update(GITHUB_REF=f'refs/heads/{branch}',
                            GITHUB_WORKFLOW_REF=f'{REPO}/.github/workflows/terraform.yml@refs/heads/{branch}')
            self.fake.run['head_branch'] = branch
            for configured in [None, '', 'invalid', '999999999999', ACCOUNT]:
                with self.subTest(branch=branch, configured=configured):
                    self.env.pop('AWS_ACCOUNT_ID_DEV', None)
                    if configured is not None:
                        self.env['AWS_ACCOUNT_ID_DEV'] = configured
                    op = self.module.Operation(self.root, self.env, self.fake, lambda: NOW,
                                               REPO, branch, SHA, '23', 'full')
                    if configured == ACCOUNT:
                        files = op.policy(self.backend, ROLE)
                        self.assertEqual(json.loads(files['store.json'])['account'], ACCOUNT)
                    else:
                        with self.assertRaisesRegex(self.module.PrivatePlanError, 'configured_dev_account_'):
                            op.policy(self.backend, ROLE)
                    op.backend = self.module.parse_backend(self.backend, {})
                    if configured == ACCOUNT:
                        self.fake.owner = '999999999999'
                        with self.assertRaisesRegex(self.module.PrivatePlanError, '^caller_mismatch$'):
                            op.caller()
                        self.fake.owner = ACCOUNT
                        self.assertEqual(op.caller(), ACCOUNT)
                    else:
                        wanted = '^caller_mismatch$' if configured == '999999999999' else 'configured_dev_account_'
                        with self.assertRaisesRegex(self.module.PrivatePlanError, wanted):
                            op.caller()
            local = {**self.env, 'GITHUB_ACTIONS': 'false'}
            local.pop('AWS_ACCOUNT_ID_DEV')
            op.env, op.profile = local, 'samples'
            self.assertEqual(op.caller(), ACCOUNT)

    def test_bucket_key_forms_resolve_independently_of_the_static_state_key(self):
        forms = [None, 'alias/aws/s3', 'alias/fixture', f'arn:aws:kms:{REGION}:{ACCOUNT}:alias/fixture',
                 KEY_ID, KEY_ARN, 'mrk-' + 'a' * 32]
        state_key = f'arn:aws:kms:{REGION}:{ACCOUNT}:key/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        backend = self.module.parse_backend(self.backend, {})
        backend['kms_key_id'] = state_key
        for form in forms:
            with self.subTest(form=form):
                self.fake.default_key = form
                key_id = form if form and form.startswith('mrk-') else KEY_ID
                expected = f'arn:aws:kms:{REGION}:{ACCOUNT}:key/{key_id}'
                self.fake.key_metadata.update(Arn=expected, KeyId=key_id)
                op = self.module.Operation(self.root, self.env, self.fake, lambda: NOW,
                                           REPO, 'dev', SHA, '23', 'full')
                op.backend, op.account = backend, ACCOUNT
                op.posture()
                self.assertEqual(op.encryption, (expected, True))
                self.assertEqual(op.backend['kms_key_id'], state_key)
                if form is not None:
                    self.assertEqual(self.module.validate_backend({**backend, 'kms_key_id': form})['kms_key_id'], form)
        policy = self.module.session_policy(backend, ACCOUNT, self.fake.context)
        describe = next(s for s in policy['Statement'] if 'kms:DescribeKey' in s['Action'])
        self.assertEqual(describe['Resource'], f'arn:aws:kms:{REGION}:{ACCOUNT}:key/*')
        self.assertEqual(describe['Condition']['StringEquals']['kms:CallerAccount'], ACCOUNT)
        self.assertNotIn('kms:ViaService', json.dumps(describe))
        self.assertNotIn('EncryptionContext', json.dumps(describe))
        self.assertLessEqual(len(self.module.canonical(policy)), 2048)

    def test_bucket_key_rejects_foreign_disabled_asymmetric_or_non_encryption_keys(self):
        original = dict(self.fake.key_metadata)
        for changes in [{'Arn': KEY_ARN.replace(ACCOUNT, '999999999999')},
                        {'AWSAccountId': '999999999999'}, {'Arn': KEY_ARN.replace(REGION, 'us-east-1')},
                        {'Arn': f'arn:aws:kms:{REGION}:{ACCOUNT}:alias/fixture'},
                        {'Enabled': False}, {'KeyState': 'PendingDeletion'},
                        {'KeySpec': 'RSA_2048'}, {'KeyUsage': 'SIGN_VERIFY'}, {'KeyId': 'wrong'}]:
            with self.subTest(changes=changes):
                self.fake.key_metadata = {**original, **changes}
                op = self.module.Operation(self.root, self.env, self.fake, lambda: NOW,
                                           REPO, 'dev', SHA, '23', 'full')
                op.backend, op.account = self.module.parse_backend(self.backend, {}), ACCOUNT
                with self.assertRaisesRegex(self.module.PrivatePlanError, 'bucket_key_'):
                    op.posture()
        self.assertFalse(self.fake.objects)

    def test_accepted_put_lost_response_recovers_same_attempt_via_pinned_bytes(self):
        p = self.policy()
        puts = []
        def transport(args, output, **kwargs):
            self.fake(args, output, **kwargs)
            if 'put-object' in args:
                puts.append(args)
                if len(puts) == 1:
                    raise self.module.PrivatePlanError('command_timeout')
        with mock.patch.object(self.module.time, 'sleep'):
            r = self.module.execute('publish', repository=REPO, branch='dev', commit=SHA, run_id='23',
                scope='full', env=self.env, transport=transport, now=lambda: NOW,
                store=p['store_file'], foundation=self.foundation, destination=self.root / 'reference')
        reference = json.loads(Path(r['reference_file']).read_text())
        self.assertEqual(reference['context'], self.fake.context)
        self.assertEqual(len(self.fake.objects), 3)
        gets = [args for args, _ in self.fake.calls if 'get-object' in args]
        self.assertEqual(len(gets), 1)
        key = gets[0][gets[0].index('--key') + 1]
        self.assertEqual(gets[0][gets[0].index('--version-id') + 1], self.fake.objects[key][0])
        self.assert_public_safe(r, reference)

    def test_conditional_upload_retries_are_bounded_and_keep_the_same_body_and_key(self):
        for successful in [True, False]:
            op = self.module.Operation(self.root, self.env, self.fake, lambda: NOW,
                                       REPO, 'dev', SHA, '23', 'full')
            op.ctx, op.account = self.fake.context, ACCOUNT
            op.backend, op.encryption = self.module.parse_backend(self.backend, {}), (KEY_ARN, True)
            calls = []
            def transport(args, output, **kwargs):
                calls.append(args)
                if len(calls) <= 2 or not successful:
                    raise self.module.PrivatePlanError('object_put_retryable')
                self.fake(args, output, **kwargs)
            op.transport = transport
            with mock.patch.object(self.module.time, 'sleep'):
                if successful:
                    entry = op.upload('plan', self.fake.plan)
                    self.assertEqual(entry['sha256'], digest(self.fake.plan))
                else:
                    with self.assertRaisesRegex(self.module.PrivatePlanError, '^object_upload_retry_exhausted$'):
                        op.upload('plan', self.fake.plan)
            self.assertEqual(len(calls), 3)
            self.assertEqual(len({tuple(args) for args in calls}), 1)
            self.fake.objects.clear()
            for p in self.root.glob('command-*'):
                p.unlink()

    def test_412_never_accepts_wrong_bytes_version_or_encryption(self):
        expected = self.fake.plan
        key = self.module.prefix(self.fake.context) + f'plan-{digest(expected)}.bin'
        for body, changes in [(b'x' * len(expected), {}), (expected, {'VersionId': 'null'}),
                              (expected, {'ServerSideEncryption': 'AES256'}),
                              (expected, {'SSEKMSKeyId': KEY_ARN.replace(ACCOUNT, '999999999999')})]:
            self.fake.objects[key] = ('existing-version', body)
            self.fake.get_changes = changes
            op = self.module.Operation(self.root, self.env, self.fake, lambda: NOW,
                                       REPO, 'dev', SHA, '23', 'full')
            op.ctx, op.account = self.fake.context, ACCOUNT
            op.backend, op.encryption = self.module.parse_backend(self.backend, {}), (KEY_ARN, True)
            with self.assertRaisesRegex(self.module.PrivatePlanError, 'object_(metadata|digest|version)_'):
                op.upload('plan', expected)
            self.assertEqual(self.fake.objects[key], ('existing-version', body))
            for p in self.root.glob('command-*'):
                p.unlink()

    def test_412_recovery_rejects_a_get_response_for_a_different_version(self):
        key = self.module.prefix(self.fake.context) + f'plan-{digest(self.fake.plan)}.bin'
        self.fake.objects[key] = ('existing-version', self.fake.plan)
        def transport(args, output, **kwargs):
            self.fake(args, output, **kwargs)
            if 'get-object' in args:
                self.assertEqual(args[args.index('--version-id') + 1], 'existing-version')
                value = json.loads(Path(output).read_text())
                value['VersionId'] = 'other-version'
                Path(output).write_text(json.dumps(value))
        op = self.module.Operation(self.root, self.env, transport, lambda: NOW, REPO, 'dev', SHA, '23', 'full')
        op.ctx, op.account = self.fake.context, ACCOUNT
        op.backend, op.encryption = self.module.parse_backend(self.backend, {}), (KEY_ARN, True)
        with self.assertRaisesRegex(self.module.PrivatePlanError, '^object_response_mismatch$'):
            op.upload('plan', self.fake.plan)

    def test_closed_command_pipes_do_not_hide_a_process_timeout(self):
        code = 'import os,time; os.close(1); os.close(2); time.sleep(10)'
        with self.assertRaisesRegex(self.module.PrivatePlanError, '^command_timeout$'):
            self.module.run_command([sys.executable, '-c', code], self.root / 'closed-pipes',
                                    env={'PATH': os.environ['PATH']}, timeout=0.1)

    def test_exact_put_and_kms_error_categories_never_parse_other_tools_or_operations(self):
        for service, verb, code, envelope, wanted in [
            ('s3api', 'put-object', 'PreconditionFailed', 'PutObject', 'object_already_exists'),
            ('s3api', 'put-object', 'SlowDown', 'PutObject', 'object_put_retryable'),
            ('s3api', 'put-object', 'ConditionalRequestConflict', 'PutObject', 'object_put_retryable'),
            ('kms', 'describe-key', 'AccessDeniedException', 'DescribeKey', 'kms_access_denied'),
            ('kms', 'describe-key', 'NotFoundException', 'DescribeKey', 'kms_key_missing'),
            ('kms', 'describe-key', 'AccessDeniedException', 'GetObject', 'command_failed'),
        ]:
            text = f'An error occurred ({code}) when calling the {envelope} operation: PRIVATE'.encode()
            self.assertEqual(self.module.command_error(['aws', service, verb], text), wanted)
            for exe in ['gh', 'git', 'terraform']:
                self.assertEqual(self.module.command_error([exe, service, verb], text), 'command_failed')

    def test_main_policy_does_not_require_dev_account_or_step_only_role_environment(self):
        self.env.pop('AWS_ACCOUNT_ID_DEV')
        self.env.update(GITHUB_REF='refs/heads/main',
                        GITHUB_WORKFLOW_REF=f'{REPO}/.github/workflows/terraform.yml@refs/heads/main')
        self.fake.run['head_branch'] = 'main'
        result = self.module.execute('policy', repository=REPO, branch='main', commit=SHA,
            run_id='23', scope='full', env=self.env, transport=self.fake, now=lambda: NOW,
            backend=self.backend, role_arn=ROLE, destination=self.root / 'policy')
        self.assertEqual(json.loads(Path(result['store_file']).read_text())['context']['branch'], 'main')
        self.assertNotIn('CI_ROLE_ARN', self.env)

    def test_branch_move_during_upload_cannot_emit_a_reference(self):
        original = self.fake
        def move_after_upload(args, output, **kwargs):
            original(args, output, **kwargs)
            if args[0] == 'aws' and 'put-object' in args and len(original.objects) == 3:
                original.branch = 'b' * 40
        policy = self.policy()
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'branch_moved'):
            self.module.execute('publish', repository=REPO, branch='dev', commit=SHA, run_id='23', scope='full',
                env=self.env, transport=move_after_upload, now=lambda: NOW,
                store=policy['store_file'], foundation=self.foundation, destination=self.root / 'reference')
        self.assertEqual(len(original.objects), 3)
        self.assertFalse((self.root / 'reference').exists())

    def test_new_source_attempt_during_restore_cannot_install_the_old_plan(self):
        result = self.ready()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24')
        original = self.fake
        def rerun_after_download(args, output, **kwargs):
            original(args, output, **kwargs)
            if args[0] == 'aws' and 'get-object' in args and any('/assets-' in x for x in args):
                original.run['run_attempt'] = 2
                for job in original.jobs: job['run_attempt'] = 2
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'attempt_mismatch'):
            self.module.execute('restore', repository=REPO, branch='dev', commit=SHA, run_id='23', scope='full',
                env=self.env, transport=rerun_after_download, now=lambda: NOW,
                backend=self.backend, foundation=self.foundation, reviewed_plan_sha256=digest(self.fake.plan))

    def test_reviewed_hash_is_checked_against_private_manifest_before_plan_download(self):
        self.ready()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24')
        self.change_manifest(lambda m: m['objects']['plan'].update(
            sha256='0' * 64, key=self.module.prefix(self.fake.context) + 'plan-' + '0' * 64 + '.bin'))
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'reviewed_hash_mismatch'):
            self.invoke('restore', backend=self.backend, foundation=self.foundation,
                        reviewed_plan_sha256=digest(self.fake.plan))
        self.assertTrue(any('/manifest-' in key for key in self.fake.downloaded))
        self.assertFalse(any('/plan-' in key or '/assets-' in key for key in self.fake.downloaded))
        self.assertFalse((self.foundation / 'tfplan').exists())

    def test_ci_scratch_is_current_run_attempt_scoped_and_local_inspection_stays_random(self):
        real = self.fake
        seen = []
        def observe(args, output, **kw):
            path = Path(kw['env']['TMPDIR'])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
            seen.append(path)
            return real(args, output, **kw)
        self.fake = observe
        result = self.publish()
        self.assertTrue(all(p.name.startswith('.private-plan-23-1-') for p in seen))
        real.completed(result['reference_file'])
        seen.clear()
        self.env.update(GITHUB_JOB='apply', GITHUB_RUN_ID='24', GITHUB_RUN_ATTEMPT='3')
        foreign = [self.foundation.parent / name for name in
                   ['.private-plan-25-3-other-run', '.private-plan-24-4-other-attempt']]
        for path in foreign:
            path.mkdir(mode=0o700)
            (path / 'keep').write_text('other operation')
        self.invoke('restore', backend=self.backend, foundation=self.foundation,
                    reviewed_plan_sha256=digest(real.plan))
        self.assertTrue(all(p.parent == self.foundation.parent and p.name.startswith('.private-plan-24-3-') for p in seen))
        self.assertTrue(all(not p.exists() for p in seen))
        self.assertTrue(all((p / 'keep').read_text() == 'other operation' for p in foreign))
        seen.clear()
        self.inspect(backend=self.backend)
        self.assertTrue(all(p.name.startswith('.private-plan-') and not p.name.startswith('.private-plan-24-3-') for p in seen))

    def test_invalid_ci_scratch_identity_fails_before_commands_or_files(self):
        for name in ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']:
            for value in ['', '0', '../other', '1\n', '01']:
                with self.subTest(name=name, value=value), mock.patch.dict(self.env, {name: value}):
                    with self.assertRaisesRegex(self.module.PrivatePlanError, 'invalid_ci_context'):
                        self.policy()
                self.assertFalse(self.fake.calls)
                self.assertFalse(list(self.root.glob('.private-plan-*')))

    def test_s3_error_taxonomy_requires_exact_aws_verb_and_exception_envelope(self):
        tool = self.root / 'tools'
        tool.mkdir()
        body = f'#!{sys.executable}\nimport os,sys\nsys.stderr.write(os.environ["ERROR_FIXTURE"])\nsys.exit(1)\n'
        for name in ['aws', 'gh', 'git', 'terraform']:
            path = tool / name
            path.write_text(body)
            path.chmod(0o700)
        cases = [
            ('aws', 'get-bucket-ownership-controls', 'OwnershipControlsNotFoundError', 'GetBucketOwnershipControls', 'bucket_ownership_missing'),
            ('aws', 'get-public-access-block', 'NoSuchPublicAccessBlockConfiguration', 'GetPublicAccessBlock', 'bucket_public_access_block_missing'),
            ('aws', 'get-bucket-encryption', 'ServerSideEncryptionConfigurationNotFoundError', 'GetBucketEncryption', 'bucket_encryption_missing'),
            ('aws', 'get-bucket-policy-status', 'NoSuchBucketPolicy', 'GetBucketPolicyStatus', 'no_bucket_policy'),
            ('aws', 'get-bucket-versioning', 'AccessDenied', 'GetBucketVersioning', 's3_access_denied'),
            ('aws', 'get-object', 'AccessDeniedException', 'GetObject', 's3_access_denied'),
            ('aws', 'head-object', 'NoSuchBucketPolicy', 'GetBucketPolicyStatus', 'command_failed'),
            *[(name, 'get-bucket-policy-status', 'NoSuchBucketPolicy', 'GetBucketPolicyStatus', 'command_failed')
              for name in ['gh', 'git', 'terraform']],
        ]
        for index, (exe, verb, code, operation, wanted) in enumerate(cases):
            message = f'An error occurred ({code}) when calling the {operation} operation: SYNTHETIC_PRIVATE_VALUE\n'
            with self.subTest(exe=exe, verb=verb):
                with self.assertRaisesRegex(self.module.PrivatePlanError, '^' + wanted + '$'):
                    self.module.run_command([exe, '--region', REGION, '--profile', 's3api', 's3api', verb],
                        self.root / f'error-{index}', env={'PATH': str(tool), 'ERROR_FIXTURE': message}, timeout=5)
        message = 'x' * 70000 + '\nAn error occurred (AccessDenied) when calling the GetObject operation: PRIVATE\n'
        with self.assertRaisesRegex(self.module.PrivatePlanError, '^s3_access_denied$'):
            self.module.run_command(['aws', 's3api', 'get-object'], self.root / 'long-error',
                env={'PATH': str(tool), 'ERROR_FIXTURE': message}, timeout=5)

    def test_artifact_clock_skew_is_bounded_without_extending_expiry(self):
        self.ready()
        original_created = self.fake.run['created_at']
        for subject, offset in [('artifact', 60), ('artifact', 61), ('run', 60), ('run', 61)]:
            future = '2026-09-14T10:01:' + ('00Z' if offset == 60 else '01Z')
            self.fake.run['created_at'] = future if subject == 'run' else original_created
            self.fake.artifact_changes = {
                'created_at': future,
                'expires_at': '2026-09-19T10:01:00Z',
            }
            if offset == 60:
                self.assertEqual(self.inspect(backend=self.backend)['status'], 'inspected')
                shutil.rmtree(self.root / 'review')
            else:
                with self.assertRaisesRegex(self.module.PrivatePlanError,
                                             'source_expired' if subject == 'run' else 'artifact_expired'):
                    self.inspect(backend=self.backend)
        self.fake.run['created_at'] = original_created
        self.fake.artifact_changes = {'expires_at': '2026-09-14T10:00:00Z'}
        with self.assertRaisesRegex(self.module.PrivatePlanError, 'artifact_expired'):
            self.inspect(backend=self.backend)
        self.assertFalse((self.foundation / 'tfplan').exists())
