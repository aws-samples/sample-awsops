import { NextResponse } from 'next/server';
import { verifyUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const user = await verifyUser(req.headers.get('cookie'));
  if (!user) return NextResponse.json({ message: 'unauthenticated' }, { status: 401 });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      let n = 0;
      const send = (data: string) => {
        try { controller.enqueue(encoder.encode(data)); } catch { clearInterval(timer); }
      };
      send(': connected\n\n');
      send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      timer = setInterval(() => {
        send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      }, 15000);
      const close = () => {
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', close);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
