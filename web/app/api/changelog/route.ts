import { verifyUser } from '@/lib/auth';
import { getChangelog } from '@/lib/changelog';

export const dynamic = 'force-dynamic';

// 사이드바 버전 칩 + 변경 이력 모달 데이터 — 저장소 CHANGELOG.md와 항상 일치
// (배포 이미지에 함께 실리는 파일을 읽으므로 배포된 커밋 = 표시되는 버전).
export async function GET(request: Request) {
  if (!(await verifyUser(request.headers.get('cookie')))) {
    return Response.json({ status: 'error', message: 'unauthenticated' }, { status: 401 });
  }
  return Response.json(await getChangelog());
}
