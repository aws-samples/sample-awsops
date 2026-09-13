// Runtime tasks have no Terraform state. Partial runtime settings must never
// silently fall back to a different database or skip reader synchronization.
export function hasRuntimeDatabaseConfig(env) {
  return ['AURORA_SECRET_ARN', 'AURORA_ENDPOINT', 'AURORA_DATABASE']
    .some(key => env[key] !== undefined);
}

export function sqlReaderConfiguration(env) {
  const runtime = hasRuntimeDatabaseConfig(env);
  const mode = env.SQL_READER_SYNC_MODE || (runtime ? '' : 'terraform');
  const arn = env.SQL_READER_SECRET_ARN?.trim() || '';
  if (!['secret', 'disabled', 'terraform'].includes(mode)) {
    throw new Error('SQL_READER_SYNC_MODE must explicitly select secret or disabled for runtime tasks');
  }
  if (runtime && mode === 'terraform') {
    throw new Error('SQL_READER_SYNC_MODE=terraform is unavailable in runtime environment mode');
  }
  if (mode === 'secret') {
    if (!arn) throw new Error('SQL_READER_SYNC_MODE=secret requires SQL_READER_SECRET_ARN');
    return { mode, arn };
  }
  if (arn) throw new Error('Conflicting SQL_READER settings: an ARN requires secret mode');
  return { mode };
}
