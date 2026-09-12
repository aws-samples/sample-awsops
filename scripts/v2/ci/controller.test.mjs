// Exercise the actual CLI across process boundaries. Only the Terraform/AWS/git
// executables are substituted; an unexpected command fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./deploy-dev.mjs', import.meta.url));
const sha = 'a'.repeat(40), web = `sha256:${'b'.repeat(64)}`, migration = `sha256:${'c'.repeat(64)}`;

function fixture(scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), 'awsops-controller-'));
  const bin = join(root, 'bin'); mkdirSync(bin);
  mkdirSync(join(root, 'terraform/foundation'), { recursive: true });
  writeFileSync(join(root, 'terraform/foundation/backend.hcl'), 'backend');
  writeFileSync(join(root, 'terraform/foundation/terraform.tfvars'), 'dev config');
  writeFileSync(join(root, 'terraform/foundation/.terraform.lock.hcl'), 'locked providers');
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'CHANGELOG.md'), 'fixture changelog');
  const base = {
    sha, web, migration, account: '123456789012', ...scenario,
    out: {
      ecr_web_uri: '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-dev-web',
      ecs_cluster_name: 'awsops-dev', ecs_service_name: 'awsops-dev-web',
      cognito_client_id: 'exampleclient',
      deployment_config: {
        project: 'awsops-dev', region: 'ap-northeast-2',
        smoke_email: scenario.noIdentity ? null : 'smoke@example.invalid',
        task_definition: 'web-revision', web_template: 'web-template', migration_task_definition: 'migration-template',
        network: {}, certificates: [{ arn: 'cert', region: 'us-east-1' }],
        dns: { zone: 'example.invalid', nameservers: ['ns.example.invalid'], validation: [], target: null },
      },
    },
  };
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(base));
  writeFileSync(join(bin, 'fake.mjs'), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
const s=JSON.parse(readFileSync('scenario.json')), command=basename(process.argv[1]), args=process.argv.slice(2);
appendFileSync('trace.jsonl',JSON.stringify({command,args})+'\\n');
const emit=value=>console.log(JSON.stringify(value));
if(command==='git') { console.log(s.sha); }
else if(command==='terraform') {
  const [_,action,...rest]=args;
  if(action==='plan') writeFileSync('terraform/foundation/.build/ci/tfplan','exact binary plan');
  else if(action==='show' && rest.includes('.build/ci/tfplan')) emit({
    resource_changes:s.changes??[], variables:{project:{value:'awsops-dev'},region:{value:'ap-northeast-2'},ci_deployment_enabled:{value:true},remediation_enabled:{value:s.frozen??false},integrations_write_enabled:{value:s.externalWrites??false}}
  });
  else if(action==='show') emit({values:{root_module:{resources:s.resources??[]}}});
  else if(action==='apply') {
    if(readFileSync('terraform/foundation/.build/ci/tfplan','utf8')!=='exact binary plan') process.exit(12);
    writeFileSync('applied','yes');
  }
  else if(action==='output') emit(Object.fromEntries(Object.entries({...s.out,agent_sql_reader_secret_arn:s.rotateReader?(existsSync('applied')?'new-reader-secret':'old-reader-secret'):''}).map(([k,value])=>[k,{value}])));
  else process.exit(13);
} else if(command==='aws') {
  const [service,action]=args;
  if(s.transientRead===action&&!args.includes('migration-task')&&!existsSync('transient-seen')) {
    writeFileSync('transient-seen','yes');console.error('ThrottlingException: retry');process.exit(254);
  }
  if(s.permanentRead===action&&!args.includes('migration-task')) {console.error('AccessDeniedException');process.exit(254);}
   if(service==='sts'&&action==='get-caller-identity') emit({Account:s.account});
   else if(service==='ecr'&&action==='describe-repositories') emit({repositories:[{repositoryName:'awsops-dev-web',repositoryUri:s.out.ecr_web_uri}]});
   else if(service==='secretsmanager'&&action==='get-secret-value') {
     if(s.secretFailure) process.exit(16);
     emit({SecretString:JSON.stringify({username:'smoke@example.invalid',password:'secret-test-password'})});
   }
   else if(service==='ecr'&&action==='get-login-password') console.log('fake-registry-password');
   else if(service==='ecr'&&action==='batch-get-image') {
     const digest=args.some(a=>a.includes('migration-'))?s.migration:s.web;
     emit({images:[{imageId:{imageDigest:s.registryMismatch?'sha256:'+'d'.repeat(64):digest}}]});
   }
  else if(action==='describe-task-definition') emit({taskDefinition:{family:args.includes('migration-template')?'migration':'web',runtimePlatform:{cpuArchitecture:'ARM64'},containerDefinitions:[{name:args.includes('migration-template')?'migration':'web'}]}});
  else if(action==='register-task-definition') emit({taskDefinition:{taskDefinitionArn:'registered'}});
  else if(action==='run-task') {
    const request=JSON.parse(readFileSync('terraform/foundation/.build/ci/run-task.json'));
    const definition=JSON.parse(readFileSync('terraform/foundation/.build/ci/task-definition.json'));
    appendFileSync('trace.jsonl',JSON.stringify({command:'migration-input',args:[request.clientToken],environment:definition.containerDefinitions[0].environment})+'\\n');
    emit({tasks:[{taskArn:'migration-task'}]});
  }
  else if(action==='describe-tasks'&&args.includes('migration-task')) {
    if(s.tamperPlan&&!existsSync('applied')) writeFileSync('terraform/foundation/.build/ci/tfplan','tampered');
    emit({tasks:[{lastStatus:'STOPPED',stopCode:'EssentialContainerExited',containers:[{name:'migration',exitCode:s.migrationFailure||(s.reconcileFailure&&existsSync('applied'))?1:0,imageDigest:s.migration}]}]});
  }
  else if(action==='deregister-task-definition') emit({});
  else if(action==='describe-services') emit({services:[{desiredCount:1,runningCount:1,pendingCount:0,deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:'web-revision'}]}]});
  else if(action==='list-tasks') emit({taskArns:['web-task']});
  else if(action==='describe-tasks') emit({tasks:[{lastStatus:'RUNNING',taskDefinitionArn:'web-revision',containers:[{name:'web',imageDigest:s.web,healthStatus:'HEALTHY'}]}]});
  else if(action==='describe-certificate') emit({Certificate:{Status:'PENDING_VALIDATION'}});
  else process.exit(14);
} else if(command==='docker') {
  if(args[0]==='login') process.exit(0);
  if(args[0]!=='buildx'||args[1]!=='build') process.exit(15);
  if(s.buildFailure) {console.error('immutable tag already exists');process.exit(1);}
  const tag=args[args.indexOf('--tag')+1];
  const metadata=args[args.indexOf('--metadata-file')+1];
  if(metadata&&metadata!==args[0]) writeFileSync(metadata,JSON.stringify({'containerimage.digest':tag.includes(':migration-')?s.migration:s.web}));
} else process.exit(15);
`, { mode: 0o700 });
  for (const command of ['terraform', 'aws', 'git', 'docker']) symlinkSync('fake.mjs', join(bin, command));
  writeFileSync(join(root, 'fetch.mjs'), `
import { readFileSync, appendFileSync } from 'node:fs';
const s=JSON.parse(readFileSync('scenario.json'));
const delay=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...args)=>delay(callback,Math.min(ms,5),...args);
globalThis.fetch=async (url, options) => {
  if(url!=='https://cognito-idp.ap-northeast-2.amazonaws.com/' ||
     options.headers.authorization || options.headers['X-Amz-Target']!=='AWSCognitoIdentityProviderService.InitiateAuth')
    throw new Error('Unexpected authenticated/network request');
  const body=JSON.parse(options.body);
  if(body.ClientId!=='exampleclient'||body.AuthFlow!=='USER_PASSWORD_AUTH'||
     body.AuthParameters.USERNAME!=='smoke@example.invalid') throw new Error('Wrong identity preflight');
  if(s.secretIdentity && body.AuthParameters.PASSWORD!=='secret-test-password') throw new Error('Wrong secret credentials');
  appendFileSync('trace.jsonl',JSON.stringify({command:'cognito-unsigned',args:['InitiateAuth']})+'\\n');
  return {ok:!s.authFailure,status:s.authFailure?400:200,json:async()=>s.authFailure
    ? {__type:'NotAuthorizedException'} : s.challenge ? {ChallengeName:'NEW_PASSWORD_REQUIRED'}
    : {AuthenticationResult:{IdToken:'example-id-token',AccessToken:'example-access-token'}}};
};
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: sha,
    GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    WEB_DIGEST: web, MIGRATION_DIGEST: migration, IMAGE_SHA: '', GITHUB_STEP_SUMMARY: join(root, 'summary'),
    GITHUB_OUTPUT: join(root, 'output'), AWS_DEV_ACCOUNT_ID: '123456789012',
    TF_VAR_demo_password: 'example-test-password', SMOKE_SECRET_ARN: '',
    NODE_OPTIONS: `--import=${join(root, 'fetch.mjs')}` };
  return {
    root, env,
    run: phase => spawnSync(process.execPath, [script, phase], { cwd: root, env, encoding: 'utf8', timeout: 10000 }),
    trace: () => readFileSync(join(root, 'trace.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('new dev core saves and applies only the pre-DNS stage with desired count zero', () => {
  const f = fixture();
  try {
    const result = f.run('core'); assert.equal(result.status, 0, result.stderr);
    const variables = JSON.parse(readFileSync(join(f.root, 'terraform/foundation/.build/ci/variables.tfvars.json')));
    assert.equal(variables.defer_edge_until_dns, true);
    assert.equal(variables.web_desired_count, 0);
    assert.equal(variables.defer_dns_validation_records, true);
    const calls = f.trace().filter(t => t.command === 'terraform');
    assert.equal(calls.filter(t => t.args.includes('plan')).length, 1);
    assert.ok(calls.find(t => t.args.includes('apply')).args.includes('.build/ci/tfplan'));
  } finally { f.cleanup(); }
});
test('existing edge and deployed revision survive the next core stage', () => {
  const f = fixture({ resources: [
    { address: 'aws_cloudfront_distribution.main[0]', type: 'aws_cloudfront_distribution' },
    { address: 'aws_ecs_task_definition.migration[0]', type: 'aws_ecs_task_definition', name: 'migration' },
    { address: 'aws_ecs_service.web', type: 'aws_ecs_service', name: 'web', values: { name: 'awsops-dev-web', desired_count: 2, task_definition: 'old-revision' } },
  ] });
  try {
    const result = f.run('core'); assert.equal(result.status, 0, result.stderr);
    const variables = JSON.parse(readFileSync(join(f.root, 'terraform/foundation/.build/ci/variables.tfvars.json')));
    assert.equal(variables.defer_edge_until_dns, false);
    assert.equal(variables.web_desired_count, 2);
    assert.equal(variables.web_task_definition_arn, 'old-revision');
    assert.ok(f.trace().some(t => t.args.includes('describe-repositories')));
    assert.ok(!f.trace().some(t => t.args.includes('plan') || t.args.includes('apply')));
  } finally { f.cleanup(); }
});

test('an existing stack without the migration template fails before any root apply', () => {
  const f = fixture({ resources: [
    { address: 'aws_ecs_service.web', type: 'aws_ecs_service', name: 'web', values: { name: 'awsops-dev-web', desired_count: 1 } },
  ] });
  try {
    const result = f.run('core');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /migration.*prerequisite|prerequisite.*migration/i);
    assert.ok(!f.trace().some(t => t.args.includes('plan') || t.args.includes('apply')));
  } finally { f.cleanup(); }
});
test('DNS writes or destructive plans are rejected before any apply', () => {
  for (const [type, actions] of [['aws_route53_record', ['create']], ['aws_cloudfront_distribution', ['delete']]]) {
    const f = fixture({ changes: [{ address: `${type}.main`, type, change: { actions } }] });
    try {
      assert.notEqual(f.run('core').status, 0);
      assert.ok(!f.trace().some(t => t.args.includes('apply')));
    } finally { f.cleanup(); }
  }
});
test('migration failure stops before apply of the already-guarded service plan', () => {
  const f = fixture({ migrationFailure: true });
  try {
    const result = f.run('release'); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Migration failed/);
    const trace = f.trace();
    assert.equal(trace.filter(t => t.args.includes('register-task-definition')).length, 1);
    assert.ok(trace.some(t => t.args.includes('plan')));
    assert.ok(!trace.some(t => t.args.includes('apply')));
    assert.ok(trace.findIndex(t => t.args.includes('plan')) < trace.findIndex(t => t.args.includes('run-task')));
    assert.ok(trace.some(t => t.args.includes('deregister-task-definition')));
  } finally { f.cleanup(); }
});
test('successful migration precedes the exact-digest service rollout; pending cert reports awaiting_dns', () => {
  const f = fixture();
  try {
    const release = f.run('release'); assert.equal(release.status, 0, release.stderr);
    const trace = f.trace();
    const plan = trace.findIndex(t => t.args.includes('plan'));
    const migration = trace.findIndex(t => t.args.includes('run-task'));
    const apply = trace.findIndex(t => t.args.includes('apply'));
    assert.ok(plan < migration && migration < apply);
    assert.equal(trace.filter(t => t.args.includes('plan')).length, 1);
    assert.ok(trace.findLastIndex(t => t.args.includes('run-task')) > apply);
    const edge = f.run('edge'); assert.equal(edge.status, 0, edge.stderr);
    assert.match(edge.stdout, /deployment_status=awaiting_dns/);
    assert.doesNotMatch(readFileSync(join(f.root, 'summary'), 'utf8'), /status: \*\*deployed/);
  } finally { f.cleanup(); }
});

test('a rejected service plan cannot advance the database', () => {
  const f = fixture({ changes: [{ address: 'aws_rds_cluster.aurora', type: 'aws_rds_cluster', change: { actions: ['delete', 'create'] } }] });
  try {
    assert.notEqual(f.run('release').status, 0);
    assert.ok(!f.trace().some(t => t.args.includes('run-task') || t.args.includes('apply')));
  } finally { f.cleanup(); }
});

test('the exact pre-migration plan is rechecked after migration and before apply', () => {
  const f = fixture({ tamperPlan: true });
  try {
    const result = f.run('release');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /plan.*changed/i);
    assert.ok(!f.trace().some(t => t.args.includes('apply')));
  } finally { f.cleanup(); }
});

test('verification retries transient AWS reads but fails permanent permission errors', () => {
  for (const action of ['describe-services', 'list-tasks', 'describe-tasks']) {
    const f = fixture({ transientRead: action });
    try {
      const result = f.run('release');
      assert.equal(result.status, 0, result.stderr);
      assert.ok(f.trace().filter(t => t.args.includes(action) && !t.args.includes('migration-task')).length >= 2);
    } finally { f.cleanup(); }
  }
  const f = fixture({ permanentRead: 'describe-services' });
  try {
    assert.notEqual(f.run('release').status, 0);
    assert.equal(f.trace().filter(t => t.args.includes('describe-services')).length, 1);
  } finally { f.cleanup(); }
});

test('each attempt builds its own tags and checks locally produced digests against ECR', () => {
  for (const scenario of [{}, { registryMismatch: true }, { buildFailure: true }]) {
    const f = fixture(scenario);
    try {
      const result = f.run('images');
      assert.equal(result.status, scenario.registryMismatch || scenario.buildFailure ? 1 : 0, result.stderr);
      const trace = f.trace();
      const build = trace.findIndex(t => t.command === 'docker' && t.args.includes('build'));
      assert.ok(build >= 0);
      const lookup = trace.findIndex(t => t.args.includes('batch-get-image'));
      assert.ok(lookup < 0 || build < lookup);
      const calls = trace.filter(t => t.command === 'docker' && t.args.includes('build'));
      assert.ok(calls.every(t => t.args.some(arg => arg.endsWith('-123-1')) && t.args.includes('--metadata-file')));
    } finally { f.cleanup(); }
  }
});

test('post-apply migration reconciles the new SQL-reader secret and cannot false-pass', () => {
  const f = fixture({ rotateReader: true });
  try {
    const result = f.run('release'); assert.equal(result.status, 0, result.stderr);
    const inputs = f.trace().filter(t => t.command === 'migration-input');
    assert.equal(inputs.length, 2);
    assert.notEqual(inputs[0].args[0], inputs[1].args[0]);
    assert.ok(inputs[1].environment.some(v => v.name === 'SQL_READER_SECRET_ARN' && v.value === 'new-reader-secret'));
    assert.ok(inputs[1].environment.some(v => v.name === 'SQL_READER_SYNC_MODE' && v.value === 'secret'));
  } finally { f.cleanup(); }
  const broken = fixture({ reconcileFailure: true });
  try { assert.notEqual(broken.run('release').status, 0); }
  finally { broken.cleanup(); }
});

test('missing or mismatched account pin fails before Terraform or deployment writes', () => {
  for (const account of ['', '999999999999']) {
    const f = fixture();
    try {
      f.env.AWS_DEV_ACCOUNT_ID = account;
      const result = f.run('core');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /account/i);
      assert.ok(!f.trace().some(t => t.command === 'terraform' || t.args.includes('register-task-definition')));
    } finally { f.cleanup(); }
  }
});

test('a frozen remediation plan fails before apply', () => {
  const f = fixture({ frozen: true });
  try {
    const result = f.run('core');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /frozen|remediation/i);
    assert.ok(!f.trace().some(t => t.args.includes('apply')));
  } finally { f.cleanup(); }
});

test('pending DNS cannot conceal a missing, rejected or challenged smoke identity', () => {
  for (const scenario of [{ noIdentity: true }, { authFailure: true }, { challenge: true }]) {
    const f = fixture(scenario);
    try {
      const result = f.run('edge');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /smoke identity/i);
      assert.doesNotMatch(result.stdout, /awaiting_dns|deployed/);
      assert.ok(!f.trace().some(t => t.args.includes('plan') || t.args.includes('apply')));
    } finally { f.cleanup(); }
  }
});

test('pending DNS requires successful unsigned Cognito sign-in first', () => {
  const f = fixture();
  try {
    const result = f.run('edge');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment_status=awaiting_dns/);
    const calls = f.trace();
    assert.ok(calls.some(t => t.command === 'cognito-unsigned'));
    assert.ok(calls.findIndex(t => t.command === 'cognito-unsigned') <
      calls.findIndex(t => t.args.includes('describe-certificate')));
  } finally { f.cleanup(); }
});

test('dedicated smoke secrets work without a demo user; secret failures are explicit and private', () => {
  for (const secretFailure of [false, true]) {
    const f = fixture({ noIdentity: true, secretIdentity: true, secretFailure });
    try {
      f.env.SMOKE_SECRET_ARN = 'example-smoke-secret';
      f.env.TF_VAR_demo_password = '';
      const result = f.run('edge');
      assert.equal(result.status, secretFailure ? 1 : 0, result.stderr);
      assert.ok(f.trace().some(t => t.args.includes('get-secret-value')));
      if (secretFailure) {
        assert.match(result.stderr, /Smoke identity credentials could not be read/);
        assert.doesNotMatch(result.stdout, /awaiting_dns/);
      } else {
        assert.ok(f.trace().some(t => t.command === 'cognito-unsigned'));
        assert.match(result.stdout, /awaiting_dns/);
      }
      assert.doesNotMatch(result.stdout + result.stderr, /secret-test-password|example-id-token|example-access-token/);
    } finally { f.cleanup(); }
  }
});
