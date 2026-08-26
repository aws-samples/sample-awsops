import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class { send = (...a: unknown[]) => send(...a); },
  InvokeCommand: class { constructor(public input: any) {} },
}));

import { invokeMcpLambdaTool, KNOWN_MCP_LAMBDA_KINDS } from './mcp-lambda-invoke';

const lambdaReturn = (body: unknown, statusCode = 200) => ({
  Payload: Buffer.from(JSON.stringify({ statusCode, body: JSON.stringify(body) })),
});

beforeEach(() => send.mockReset());

describe('invokeMcpLambdaTool', () => {
  it('passes the inline conn_config in the Lambda payload to ${PROJECT}-agent-${kind}-mcp', async () => {
    send.mockResolvedValueOnce(lambdaReturn({ rows: [] }));
    await invokeMcpLambdaTool({
      kind: 'prometheus',
      tool: 'prometheus_query',
      args: { query: 'up' },
      connConfig: { endpoint: 'http://p:9090', authType: 'bearer', token: 't' },
    });
    const input = send.mock.calls[0][0].input;
    expect(input.FunctionName).toBe('awsops-v2-agent-prometheus-mcp');
    const payload = JSON.parse(Buffer.from(input.Payload).toString('utf8'));
    expect(payload.tool_name).toBe('prometheus_query');
    expect(payload.arguments).toEqual({ query: 'up' });
    expect(payload.conn_config).toEqual({ endpoint: 'http://p:9090', authType: 'bearer', token: 't' }); // FLAT blob
  });

  it('omits conn_config when none is given (Lambda falls back to its slug/env map)', async () => {
    send.mockResolvedValueOnce(lambdaReturn({ ok: true }));
    await invokeMcpLambdaTool({ kind: 'notion', tool: 'notion_search', args: { q: 'x' } });
    const payload = JSON.parse(Buffer.from(send.mock.calls[0][0].input.Payload).toString('utf8'));
    expect(payload.conn_config).toBeUndefined();
  });

  it('rejects an unknown kind with no Lambda call', async () => {
    await expect(invokeMcpLambdaTool({ kind: 'evil', tool: 't' })).rejects.toThrow(/unknown/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('throws on a connector error envelope (statusCode >= 400)', async () => {
    send.mockResolvedValueOnce(lambdaReturn({ error: 'bad query' }, 400));
    await expect(invokeMcpLambdaTool({ kind: 'prometheus', tool: 'q' })).rejects.toThrow(/bad query/);
  });

  it('KNOWN_MCP_LAMBDA_KINDS includes the datasource kinds and notion', () => {
    for (const k of ['prometheus', 'loki', 'tempo', 'mimir', 'clickhouse', 'notion']) {
      expect(KNOWN_MCP_LAMBDA_KINDS as readonly string[]).toContain(k);
    }
  });
});
