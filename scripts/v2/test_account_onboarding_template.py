import json
import subprocess
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_intrinsic(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    if suffix == "Ref":
        return {"Ref": value}
    if suffix == "GetAtt" and isinstance(value, str):
        value = value.split(".", 1)
    return {f"Fn::{suffix}": value}


CloudFormationLoader.add_multi_constructor("!", construct_intrinsic)


def deployment_contract(template):
    template.pop("Description", None)
    for section in ("Parameters", "Outputs"):
        for entry in template[section].values():
            entry.pop("Description", None)
    return template


def test_browser_template_matches_canonical_deployment_contract():
    canonical = yaml.load(
        (ROOT / "infra/cfn/awsops-target-account-role.yaml").read_text(),
        Loader=CloudFormationLoader,
    )
    program = """
const fs = require('node:fs');
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('lib/account-onboarding.ts', 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;
const compiledModule = {exports: {}};
new Function('exports', 'module', compiled)(compiledModule.exports, compiledModule);
const guide = compiledModule.exports.buildAccountOnboarding({
  accountId: '222222222222', region: 'ap-northeast-2', externalId: 'example-external-id',
  firstParty: false, profile: '',
}, {
  hostAccountId: '111111111111', hostTaskRoleArn: 'arn:aws:iam::111111111111:role/task',
  region: 'ap-northeast-2', registrationEnabled: true,
});
process.stdout.write(guide.script.split("<<'AWSOPS_TEMPLATE'\\n")[1].split('\\nAWSOPS_TEMPLATE')[0]);
"""
    generated = json.loads(subprocess.run(
        ["node", "-e", program], cwd=ROOT / "web", check=True,
        capture_output=True, text=True, timeout=30,
    ).stdout)
    assert deployment_contract(generated) == deployment_contract(canonical)
