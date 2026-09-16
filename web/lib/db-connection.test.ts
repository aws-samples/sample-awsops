import { createServer, type Server, type Socket } from 'node:net';
import type { Pool, PoolConfig } from 'pg';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

// Real pg sockets: these servers stop at different protocol boundaries.
// Removing the observer must fail the phase assertions below.
const sockets = new Set<Socket>();
const servers: Server[] = [];
let pool: Pool | undefined;
let warning: MockInstance<typeof console.warn>;

async function localPool(onSocket: (socket: Socket) => void) {
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    onSocket(socket);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  vi.resetModules();
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { getPool } = await import('./db');
  pool = getPool();
  const options = (pool as Pool & { options: PoolConfig }).options;
  Object.assign(options, {
    host: '127.0.0.1', port: (server.address() as { port: number }).port,
    connectionTimeoutMillis: 500, password: async () => 'local-test-only',
  });
  return pool;
}

function failures() {
  return warning.mock.calls.map(([line]) => JSON.parse(String(line)))
    .filter(event => event.evt === 'db_connection_failed');
}

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  vi.restoreAllMocks();
});

describe('DB physical connection diagnostics', () => {
  it('distinguishes waiting for the PostgreSQL SSL response from IAM credentials', async () => {
    const connection = await localPool(() => {});
    await expect(connection.query('SELECT 1')).rejects.toThrow(/timeout/);
    expect(failures()).toEqual([expect.objectContaining({
      phase: 'tls_negotiation', milestones_ms: { tcp_connected: expect.any(Number) },
      elapsed_ms: expect.any(Number),
    })]);
  });

  it('does not mistake pg sslconnect for completion of the TLS handshake', async () => {
    const connection = await localPool(socket => socket.once('data', () => socket.write('S')));
    await expect(connection.query('SELECT 1')).rejects.toThrow(/timeout/);
    expect(failures()).toEqual([expect.objectContaining({ phase: 'tls_handshake' })]);
    expect(failures()[0].milestones_ms).not.toHaveProperty('tls_connected');
  });
});
