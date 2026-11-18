import { graphDiagnostic } from '../graph-state';
import { getPool } from '../db';
import { rebuildServiceTopology } from './read-published';
export async function publishHost() {
  if (!process.env.AURORA_ENDPOINT || process.env.AURORA_USER !== 'awsops_worker') {
    console.error('[service-topology] publisher_database_configuration_required');
    throw new Error('publisher_database_configuration_required');
  }
  const pool = getPool();
  try {
    return await rebuildServiceTopology(pool);
  } catch (error) {
    console.error('[service-topology] publication failed', graphDiagnostic('graph_state', error));
    throw error;
  } finally {
    await pool.end();
  }
}
