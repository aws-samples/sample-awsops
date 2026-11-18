import { getPool } from '../db';
import { rebuildServiceTopology } from './read-published';
export async function publishHost() {
  if (!process.env.AURORA_ENDPOINT || process.env.AURORA_USER !== 'awsops_worker')
    throw new Error('publisher_database_configuration_required');
  const pool = getPool();
  try {
    return await rebuildServiceTopology(pool);
  } finally {
    await pool.end();
  }
}
