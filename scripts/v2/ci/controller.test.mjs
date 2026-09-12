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
  const base = {
    sha, web, migration, ...scenario,
    out: {
      ecr_web_uri: '123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/awsops-dev-web',
      ecs_cluster_name: 'awsops-dev', ecs_service_name: 'awsops-dev-web',
      deployment_config: {
        task_definition: 'web-revision', web_template: 'web-template', migration_task_definition: 'migration-template',
        network: {}, certificates: [{ arn: 'cert', region: 'us-east-1' }],
        dns: { zone: 'example.invalid', nameservers: ['ns.example.invalid'], validation: [], target: null },
      },
    },
  };
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(base));
  writeFileSync(join(bin, 'fake.mjs'), `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const s=JSON.parse(readFileSync('scenario.json')), command=basename(process.argv[1]), args=process.argv.slice(2);
appendFileSync('trace.jsonl',JSON.stringify({command,args})+'\\n');
const emit=value=>console.log(JSON.stringify(value));
if(command==='git') { console.log(s.sha); }
else if(command==='terraform') {
  const [_,action,...rest]=args;
  if(action==='plan') writeFileSync('terraform/foundation/.build/ci/tfplan','exact binary plan');
  else if(action==='show' && rest.includes('.build/ci/tfplan')) emit({
    variables:{project:{value:'awsops-dev'},region:{value:'ap-northeast-2'},ci_deployment_enabled:{value:true}},
    resource_changes:s.changes??[]
  });
  else if(action==='show') emit({values:{root_module:{resources:s.resources??[]}}});
  else if(action==='apply') {
    if(readFileSync('terraform/foundation/.build/ci/tfplan','utf8')!=='exact binary plan') process.exit(12);
  }
  else if(action==='output') emit(Object.fromEntries(Object.entries(s.out).map(([k,value])=>[k,{value}])));
  else process.exit(13);
} else if(command==='aws') {
  const [service,action]=args;
  if(service==='ecr'&&action==='batch-get-image') emit({images:[{imageId:{imageDigest:args.some(a=>a.includes('migration-'))?s.migration:s.web}}]});
  else if(action==='describe-task-definition') emit({taskDefinition:{family:args.includes('migration-template')?'migration':'web',runtimePlatform:{cpuArchitecture:'ARM64'},containerDefinitions:[{name:args.includes('migration-template')?'migration':'web'}]}});
  else if(action==='register-task-definition') emit({taskDefinition:{taskDefinitionArn:'registered'}});
  else if(action==='run-task') emit({tasks:[{taskArn:'migration-task'}]});
  else if(action==='describe-tasks'&&args.includes('migration-task')) emit({tasks:[{lastStatus:'STOPPED',stopCode:'EssentialContainerExited',containers:[{name:'migration',exitCode:s.migrationFailure?1:0,imageDigest:s.migration}]}]});
  else if(action==='deregister-task-definition') emit({});
  else if(action==='describe-services') emit({services:[{desiredCount:1,runningCount:1,pendingCount:0,deployments:[{status:'PRIMARY',rolloutState:'COMPLETED',taskDefinition:'web-revision'}]}]});
  else if(action==='list-tasks') emit({taskArns:['web-task']});
  else if(action==='describe-tasks') emit({tasks:[{lastStatus:'RUNNING',taskDefinitionArn:'web-revision',containers:[{name:'web',imageDigest:s.web,healthStatus:'HEALTHY'}]}]});
  else if(action==='describe-certificate') emit({Certificate:{Status:'PENDING_VALIDATION'}});
  else process.exit(14);
} else process.exit(15);
`, { mode: 0o700 });
  for (const command of ['terraform', 'aws', 'git']) symlinkSync('fake.mjs', join(bin, command));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SHA: sha,
    GITHUB_REF: 'refs/heads/dev', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
    WEB_DIGEST: web, MIGRATION_DIGEST: migration, IMAGE_SHA: '', GITHUB_STEP_SUMMARY: join(root, 'summary'),
    GITHUB_OUTPUT: join(root, 'output') };
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
    assert.equal(variables.edge_enabled, false);
    assert.equal(variables.web_desired_count, 0);
    assert.equal(variables.dns_validation_records_enabled, false);
    const calls = f.trace().filter(t => t.command === 'terraform');
    assert.equal(calls.filter(t => t.args.includes('plan')).length, 1);
    assert.ok(calls.find(t => t.args.includes('apply')).args.includes('.build/ci/tfplan'));
  } finally { f.cleanup(); }
});
test('existing edge and deployed revision survive the next core stage', () => {
  const f = fixture({ resources: [
    { address: 'aws_cloudfront_distribution.main[0]', type: 'aws_cloudfront_distribution' },
    { address: 'aws_ecs_service.web', type: 'aws_ecs_service', name: 'web', values: { name: 'awsops-dev-web', desired_count: 2, task_definition: 'old-revision' } },
  ] });
  try {
    const result = f.run('core'); assert.equal(result.status, 0, result.stderr);
    const variables = JSON.parse(readFileSync(join(f.root, 'terraform/foundation/.build/ci/variables.tfvars.json')));
    assert.equal(variables.edge_enabled, true);
    assert.equal(variables.web_desired_count, 2);
    assert.equal(variables.web_task_definition_arn, 'old-revision');
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
test('migration failure stops before web revision registration and service plan', () => {
  const f = fixture({ migrationFailure: true });
  try {
    const result = f.run('release'); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Migration failed/);
    const trace = f.trace();
    assert.equal(trace.filter(t => t.args.includes('register-task-definition')).length, 1);
    assert.ok(!trace.some(t => t.args.includes('apply') || t.args.includes('plan')));
    assert.ok(trace.some(t => t.args.includes('deregister-task-definition')));
  } finally { f.cleanup(); }
});
test('successful migration precedes the exact-digest service rollout; pending cert reports awaiting_dns', () => {
  const f = fixture();
  try {
    const release = f.run('release'); assert.equal(release.status, 0, release.stderr);
    const trace = f.trace();
    assert.ok(trace.findIndex(t => t.args.includes('run-task')) < trace.findIndex(t => t.args.includes('plan')));
    const edge = f.run('edge'); assert.equal(edge.status, 0, edge.stderr);
    assert.match(edge.stdout, /deployment_status=awaiting_dns/);
    assert.doesNotMatch(readFileSync(join(f.root, 'summary'), 'utf8'), /status: \*\*deployed/);
  } finally { f.cleanup(); }
});
