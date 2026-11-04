import { DescribeSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { customMcpSecretName } from './custom-mcp-policy';

let client: SecretsManagerClient | undefined;
/** Metadata only. Custom secrets are provisioned by the controller, never by this product. */
export async function currentCustomMcpSecretVersion(id: number): Promise<string> {
  const SecretId = customMcpSecretName(id);
  client ??= new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-northeast-2', maxAttempts: 2 });
  const result = await client.send(new DescribeSecretCommand({ SecretId }), {
    abortSignal: AbortSignal.timeout(5000),
  });
  const versions = Object.entries(result.VersionIdsToStages ?? {})
    .filter(([, stages]) => stages.includes('AWSCURRENT')).map(([version]) => version);
  if (versions.length !== 1 || !/^[A-Za-z0-9-]{32,64}$/.test(versions[0])) {
    throw new Error('custom MCP secret requires exactly one current version');
  }
  return versions[0];
}
