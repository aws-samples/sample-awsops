import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyUser = vi.fn();
const listThreads = vi.fn();
const getThread = vi.fn();
const deleteThread = vi.fn();
const deleteAllThreads = vi.fn();
vi.mock('@/lib/auth', () => ({ verifyUser: (...a: unknown[]) => verifyUser(...a) }));
vi.mock('@/lib/chat-store', () => ({
  listThreads: (...a: unknown[]) => listThreads(...a),
  getThread: (...a: unknown[]) => getThread(...a),
  deleteThread: (...a: unknown[]) => deleteThread(...a),
  deleteAllThreads: (...a: unknown[]) => deleteAllThreads(...a),
}));

const req = (url: string, method = 'GET') => new Request(url, { method, headers: { cookie: 'awsops_token=t' } });

describe('threads API', () => {
  it('DELETE all: does not disclose database errors', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    deleteAllThreads.mockRejectedValue(new Error('private database hostname and SQL detail'));
    const { DELETE } = await import('./route');
    const res = await DELETE(req('http://x/api/chat/threads', 'DELETE'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ status: 'error', message: 'Unable to delete chat history' });
    expect(deleteAllThreads).toHaveBeenCalledWith('u1');
  });
  beforeEach(() => { verifyUser.mockReset(); listThreads.mockReset(); getThread.mockReset(); deleteThread.mockReset(); deleteAllThreads.mockReset(); });

  it('GET list: 401 without auth', async () => {
    verifyUser.mockResolvedValue(null);
    const { GET } = await import('./route');
    expect((await GET(req('http://x/api/chat/threads'))).status).toBe(401);
  });

  it('GET list: returns user-scoped threads', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    listThreads.mockResolvedValue([{ id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }]);
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/chat/threads'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [{ id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }] });
    expect(listThreads).toHaveBeenCalledWith('u1');
  });

  it('GET [id]: 404 for a foreign/missing thread', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    getThread.mockResolvedValue(null);
    const { GET } = await import('./[id]/route');
    const res = await GET(req('http://x/api/chat/threads/tX'), { params: Promise.resolve({ id: 'tX' }) });
    expect(res.status).toBe(404);
  });

  it('GET [id]: returns thread + messages', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    getThread.mockResolvedValue({ thread: { id: 't1', title: 'T', sessionId: 's', updatedAt: 'now' }, messages: [] });
    const { GET } = await import('./[id]/route');
    const res = await GET(req('http://x/api/chat/threads/t1'), { params: Promise.resolve({ id: 't1' }) });
    expect(res.status).toBe(200);
    expect(getThread).toHaveBeenCalledWith('u1', 't1');
  });

  it('DELETE [id]: 404 when nothing deleted, 200 when deleted', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    const { DELETE } = await import('./[id]/route');
    deleteThread.mockResolvedValue(false);
    expect((await DELETE(req('http://x/api/chat/threads/t1', 'DELETE'), { params: Promise.resolve({ id: 't1' }) })).status).toBe(404);
    deleteThread.mockResolvedValue(true);
    expect((await DELETE(req('http://x/api/chat/threads/t1', 'DELETE'), { params: Promise.resolve({ id: 't1' }) })).status).toBe(200);
  });

  it('GET list: DB failure degrades to empty list (not 500)', async () => {
    verifyUser.mockResolvedValue({ sub: 'u1' });
    listThreads.mockRejectedValue(new Error('db down'));
    const { GET } = await import('./route');
    const res = await GET(req('http://x/api/chat/threads'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [] });
  });
});
