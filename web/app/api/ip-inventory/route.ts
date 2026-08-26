import { verifyUser } from '@/lib/auth';
import { listEnis, listEips, podIpMap } from '@/lib/ip-inventory';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// IP 인벤토리: ENI 전량 + EIP + EKS 파드 IP 조인. 파드 맵은 best-effort (실패해도 ENI/EIP는 산다).
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  try {
    const [enis, eips, podsByIp] = await Promise.all([
      listEnis(),
      listEips().catch(() => []),
      podIpMap().catch(() => ({})),
    ]);
    const summary = {
      eniTotal: enis.length,
      eniInUse: enis.filter((e) => e.status === 'in-use').length,
      eniAvailable: enis.filter((e) => e.status === 'available').length,
      publicIps: enis.filter((e) => e.publicIp).length,
      privateIps: enis.reduce((s, e) => s + e.privateIps.length, 0),
      eipTotal: eips.length,
      eipUnused: eips.filter((e) => e.unused).length,
    };
    return Response.json({ summary, enis, eips, podsByIp });
  } catch (e) {
    return Response.json({ status: 'error', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
