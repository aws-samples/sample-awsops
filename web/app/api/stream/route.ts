export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let n = 0;
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      send(': connected\n\n');
      send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      const timer = setInterval(() => {
        send(`data: ${JSON.stringify({ tick: ++n, ts: Date.now() })}\n\n`);
      }, 15000);
      const close = () => {
        clearInterval(timer);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', close);
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
