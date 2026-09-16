# 실행 완료: 테스트 클러스터 3개의 수집 용량 확보

사용자가 워커 3대 증설과 nginx 순차 재배치를 승인하고, 기존 수집 경로는
유지한 채 계속 진행하도록 지시했다. 수집기 통합/일괄 교체안은 취소했다.

2026-09-16 10:48 UTC 최종 확인: 세 node group 모두 5대 ACTIVE/Ready,
기존 nginx desired/Available 각각 180. 노드 수집기·Beyla도 각 클러스터 5/5 Ready.
iptables 18개, ipvs 17개, nftables 16개의 nginx 파드를 한 개씩 순차 재배치했다.
각 노드에 수집기 재기동을 위한 최소 파드 슬롯 2개를 확보했고, cordon은 모두 해제했다.
실행 로그는 `rebalance-ekscluster01-*.json`에 있다.

## 정확한 대상과 비용 영향

계정 `061525506239`, 리전 `ap-northeast-2`, 프로필 `samples-atomoh`.

| 클러스터 | managed node group | 변경 전 min/max/desired | 변경 후 min/max/desired | 신규 워커 |
|---|---|---|---|---|
| ekscluster01-iptables | ng-iptables | 4/4/4 | 4/5/5 | m6g.xlarge 1대 |
| ekscluster01-ipvs | ng-ipvs | 4/4/4 | 4/5/5 | m6g.xlarge 1대 |
| ekscluster01-nftables | ng-nftables | 4/4/4 | 4/5/5 | m6g.xlarge 1대 |

총 EC2 워커 3대와 해당 노드의 기존 템플릿 디스크 사용료가 추가된다.
기존 launch template, 서브넷, AMI, IAM 역할, 보안 그룹은 그대로 사용한다.
원래 노드당 파드 한도는 58개다. CPU/메모리 request를 낮추는 것만으로 파드
개수 한도를 해결할 수는 없다.

## 실행 순서

1. AssumeRole 신원을 재검증하고 원래 node group 설정이 위와 동일한지 재확인한다.
2. 아래 각 node group 설정을 적용한다.
3. 각 클러스터에서 새 노드가 Ready이고 기존 애플리케이션 가용성이 유지됨을 확인한다.
4. 수집 DaemonSet이 Pending인 기존 노드만 하나씩 처리한다.
   - 현재 노드가 원래 schedulable인지 확인한다.
   - 해당 노드를 일시 cordon한다. 기존 실행 파드는 유지된다.
   - `conntrack-test/nginx-backend` Deployment 소유임이 검증된 nginx 파드만
     하나씩 `policy/v1 Eviction`으로 재배치한다.
   - nginx desired replicas는 **180으로 유지**한다. 한 개를 옮긴 후 다시
     180개 Available인 것을 확인하기 전 다음 파드를 옮기지 않는다.
   - 해당 노드의 `telemetry-node`, `telemetry-beyla`가 Ready가 될 최소한의
     자리만 확보한다.
   - 원래 schedulable이었던 노드는 반드시 uncordon한다. 실패 시에도 복구한다.
   - 데이터베이스, StatefulSet, 기존 CloudWatch/Prometheus 파드는 재배치 대상으로
     선택하지 않는다.
5. Pending 상태의 nftables 수집기 DNS/API 설정 교체가 실제 완료되었는지 확인한다.
   DNS 문제가 지속되면 수집기 경로만 추가 진단한다.
6. 8개 클러스터 모두 노드 수집기·Beyla 전체 Ready, 클러스터 수집기 1/1을 확인한다.
7. 저장소별 실제 데이터와 클러스터 라벨을 조회해 라우팅과 중복 방지 조건을 재검증한다.
8. 운영 보고서와 실제 배치 snapshot을 갱신한다.

증설 명령:

```bash
aws eks update-nodegroup-config \
  --cluster-name ekscluster01-iptables --nodegroup-name ng-iptables \
  --scaling-config minSize=4,maxSize=5,desiredSize=5 \
  --profile samples-atomoh --region ap-northeast-2

aws eks update-nodegroup-config \
  --cluster-name ekscluster01-ipvs --nodegroup-name ng-ipvs \
  --scaling-config minSize=4,maxSize=5,desiredSize=5 \
  --profile samples-atomoh --region ap-northeast-2

aws eks update-nodegroup-config \
  --cluster-name ekscluster01-nftables --nodegroup-name ng-nftables \
  --scaling-config minSize=4,maxSize=5,desiredSize=5 \
  --profile samples-atomoh --region ap-northeast-2
```

## 중지 조건

- 역할/계정 불일치.
- nginx desired replicas가 180에서 바뀌었거나 다른 사용자의 작업이 겹치는 경우.
- 한 개 재배치 후 원래 가용 복제본 수가 회복되지 않는 경우.
- 새 노드 미준비, eviction 거부, 새 수집기에서 지속적인 OOM/전송 손실 발생.

증설 취소 시 무조건 4대로 축소하면 수집기가 다시 파드 한도에 걸릴 수 있다.
후속 용량 설계와 안전한 축소 절차를 먼저 검토해야 한다.
