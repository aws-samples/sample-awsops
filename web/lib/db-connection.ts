import { Client, type ClientConfig } from 'pg';
import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

// pg 8.13.1's pool timeout covers TCP, TLS, the async password provider and
// PostgreSQL authentication. Observe one physical connection without changing
// its timeout, credentials, TLS settings or error propagation.
export class ObservedDbClient extends Client {
  constructor(config: ClientConfig = {}) {
    const started = performance.now();
    let phase = 'dns_tcp_connect';
    let finished = false;
    const milestones: Record<string, number> = {};
    const mark = (milestone: string, nextPhase: string) => {
      if (finished) return;
      milestones[milestone] = Math.round(performance.now() - started);
      phase = nextPhase;
    };
    const password = config.password;
    super({
      ...config,
      password: typeof password === 'function' ? async () => {
        mark('token_started', 'iam_token');
        const token = await password();
        mark('token_ready', 'postgres_authentication');
        return token;
      } : password,
    });

    // pg exposes these events on its internal Connection, not on Client.
    // Keep the version-sensitive access here and exercise it with real sockets.
    const connection = (this as unknown as {
      connection: EventEmitter & { stream: Socket };
    }).connection;
    connection.stream.once('lookup', (error: Error | null) => {
      if (!error) mark('dns_resolved', 'tcp_connect');
    });
    connection.once('connect', () => {
      mark('tcp_connected', config.ssl ? 'tls_negotiation' : 'postgres_startup');
    });
    connection.once('sslconnect', () => {
      // pg emits sslconnect immediately after tls.connect(), BEFORE the TLS
      // handshake. Only the TLSSocket's secureConnect proves TLS completed.
      mark('ssl_accepted', 'tls_handshake');
      connection.stream.once('secureConnect', () => {
        mark('tls_connected', 'postgres_startup');
      });
    });
    for (const event of [
      'authenticationCleartextPassword', 'authenticationMD5Password', 'authenticationSASL',
    ]) {
      connection.once(event, () => mark('password_requested', 'postgres_authentication'));
    }
    connection.once('authenticationOk', () => mark('authenticated', 'postgres_startup'));
    this.once('connect', () => { finished = true; });

    const failed = () => {
      if (finished) return;
      finished = true;
      // Only fixed phase labels and elapsed times: no endpoint, user, token,
      // credentials, SQL, or raw errors can enter this diagnostic event.
      console.warn(JSON.stringify({
        evt: 'db_connection_failed',
        phase,
        elapsed_ms: Math.round(performance.now() - started),
        milestones_ms: milestones,
      }));
    };
    connection.once('error', failed);
    connection.once('errorMessage', failed);
    // pg-pool destroys the socket at its deadline; that can emit end without
    // an error event. Observe it before Client invokes the pool's callback.
    connection.once('end', failed);
  }
}
