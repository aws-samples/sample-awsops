// Explicit credential-source selection; independent of AWS/pg for offline tests.
export function sqlReaderConfiguration(env) {
  const mode = env.SQL_READER_SYNC_MODE || (env.AURORA_SECRET_ARN ? null : 'terraform');
  const arn = env.SQL_READER_SECRET_ARN?.trim() || '';
  if (!mode) throw new Error('Env-backed migration requires SQL_READER_SYNC_MODE=secret, disabled, or terraform explicitly');
  if (!['secret', 'disabled', 'terraform'].includes(mode)) throw new Error('Invalid SQL_READER_SYNC_MODE');
  if (mode === 'secret') {
    if (!arn) throw new Error('SQL_READER_SYNC_MODE=secret requires SQL_READER_SECRET_ARN');
    return { mode, arn };
  }
  if (arn) throw new Error('Conflicting SQL-reader settings: SQL_READER_SECRET_ARN requires secret mode');
  return { mode };
}
