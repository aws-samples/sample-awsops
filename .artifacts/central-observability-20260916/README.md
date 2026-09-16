# samples 중앙 관측 수집 — 2026-09-16

> Private operator execution record for the named samples environment. This directory
> contains account-specific identifiers and dated evidence, not portable sample defaults.
> It is not wired into the application, tools, CI, or automatic deployment. Review and
> obtain operator authorization before rerunning any provisioning helper. Private keys,
> passwords and kubeconfig credentials are intentionally excluded. Reassess this directory
> before making the repository public.

## 현재 결과

**8개 클러스터의 중앙 수집 연결과 24개 신호 경로 검증을 완료했다.**

최종 점검: 2026-09-16 10:48 UTC. 클러스터 수집기 8/8, 노드 수집기 32/32,
Beyla 32/32 Ready. 중앙 저장소 6개와 게이트웨이도 모두 Ready다.

`platform-cluster/central-observability`에 Prometheus, Mimir, Loki, Tempo, Jaeger,
ClickHouse와 OpenTelemetry 수집 게이트웨이를 설치했다. 마지막 확인 시 저장소 6개와
게이트웨이 모두 Ready였다. 각 클러스터에는 수집 설정과 인증서를 배치했다.

기존 CloudWatch와 로컬 Prometheus는 유지했다. 새 중앙 저장소끼리만 중복 저장되지
않도록 **클러스터 × 신호당 목적지 하나**를 지정했다. 기존 로컬 저장소에서 중앙
저장소로의 데이터 복제나 과거 데이터 이관은 하지 않았다. 컨테이너 로그는 설치 시점
이후 신규 로그를 읽는다.

사용자 승인 후 `ekscluster01-iptables`, `ekscluster01-ipvs`,
`ekscluster01-nftables`의 워커를 각각 4→5대로 증설했다. nginx는 클러스터마다
desired/Available 180개를 유지·복구하며 순차 재배치했고, 노드당 최소 파드
슬롯 2개를 확보했다. 최종적으로 cordon된 노드는 없다.

nftables의 신규 수집기에 설정한 VPC DNS/동일 EKS API endpoint 경로도 실제
적용돼 메트릭·로그·트레이스가 모두 도착한다. 기존 클러스터 DNS, 기존
CloudWatch·로컬 Prometheus 수집 경로는 변경하지 않았다.

**수집기 통합·일괄 교체안은 사용자 지시에 따라 취소했다.** 새로 추가한
`telemetry-node`, `telemetry-cluster`, `telemetry-beyla`는 각각 유지한다.

## 신호별 중앙 목적지

| 소스 클러스터 | 메트릭 | 로그 | 트레이스 |
|---|---|---|---|
| GPU01 | Prometheus | ClickHouse | Tempo |
| appmesh-lattice-mig | Prometheus | Loki | Jaeger |
| ekscluster01-iptables | Prometheus | Loki | Tempo |
| ekscluster01-ipvs | Mimir | Loki | Jaeger |
| ekscluster01-nftables | Mimir | ClickHouse | ClickHouse |
| eksworkshop | Mimir | ClickHouse | Tempo |
| gpu-cluster-01 | Mimir | ClickHouse | Jaeger |
| platform-cluster | Prometheus | Loki | ClickHouse |

정식 라우팅 원본은 `routes.json`과 중앙 `telemetry-gateway` ConfigMap이다.
각 routing connector의 조건은 서로 배타적이며 `action: move`, 출력 pipeline 1개를
사용한다. 소스 수집기의 중앙 exporter도 하나다. 신뢰할 수 없는 클러스터 라벨은
소스 resource processor가 설정된 실제 클러스터 이름으로 덮어쓴다.

이는 중앙 저장소 간 fan-out 중복을 방지하는 구성이다. 전송 재시도를 포함한
분산 시스템 전체의 exactly-once 보장을 의미하지는 않는다.

## 실제 검증

`verification.json`, `jaeger-verification.json`, `collector-status.json`,
`preservation.json`, `routing-verification.json`, `smoke-verification.json`에
실행 시각과 질의 결과를 저장했다.

| 클러스터 | 클러스터 수집기 Ready | 노드 수집기 Ready | Beyla Ready |
|---|---:|---:|---:|
| GPU01 | 1/1 | 2/2 | 2/2 |
| appmesh-lattice-mig | 1/1 | 2/2 | 2/2 |
| ekscluster01-iptables | 1/1 | 5/5 | 5/5 |
| ekscluster01-ipvs | 1/1 | 5/5 | 5/5 |
| ekscluster01-nftables | 1/1 | 5/5 | 5/5 |
| eksworkshop | 1/1 | 8/8 | 8/8 |
| gpu-cluster-01 | 1/1 | 2/2 | 2/2 |
| platform-cluster | 1/1 | 3/3 | 3/3 |

Ready는 컨테이너 상태이며, 실제 데이터 유입과 별도로 확인했다.

- Prometheus: GPU01, appmesh-lattice-mig, iptables, platform-cluster 메트릭 확인.
- Mimir: ipvs, nftables, eksworkshop, gpu-cluster-01 메트릭 확인.
- Loki: appmesh-lattice-mig, iptables, ipvs, platform-cluster 로그 확인.
- ClickHouse: GPU01·nftables·eksworkshop 로그, platform-cluster·nftables 트레이스 확인.
- Tempo: iptables·eksworkshop의 실제 클러스터 태그를 가진 트레이스 확인.
- Jaeger: appmesh-lattice-mig, ipvs, gpu-cluster-01의 실제 트레이스 resource
  `k8s.cluster.name`을 조회하여 각각 일치하는 것을 확인.
- 기존 CloudWatch/Prometheus 50개 워크로드의 컨테이너 이미지와 복제본 수는
  수집 전 인벤토리와 동일했다. platform-cluster의 새 Prometheus 확인 1개는 별도다.
- 별도로 `telemetry.validation=true`, 고유 validation ID가 붙은 테스트 메트릭·
  트레이스 및 명확히 표시된 컨테이너 로그를 8개 클러스터에서 보냈다.
  24개 경로 모두 지정 저장소에서 확인됐고, 해당 신호의 다른 중앙 저장소에서는
  발견되지 않았다. 결과: `smoke-verification.json`, `passed: true`.
- 테스트와 업무 신호를 구분한다. GPU01 앱 트레이스 및 gpu-cluster-01 로그처럼
  평소 트래픽이 적은 경로도 이 명시적인 테스트로 연결을 검증했다.
- GPU01에는 현재 GPU DCGM exporter 파드가 0개다. CPU 시스템 노드 2개는 수집되지만
  GPU exporter 메트릭은 생성되지 않는다. 해당 스크랩의 연결 거부 경고는 남아 있으며,
  실제 GPU 워크로드/Exporter 가동 이후 GPU 지표가 생성된다.

검증 Job은 별도 `telemetry-check-20260916` 네임스페이스에서 실행했고 완료 후
600초 TTL로 자동 정리된다. 테스트 데이터는 저장소의 일반 7일 보존 정책을 따른다.

초기 단일 저장소가 EKS Auto Mode의 underutilized consolidation으로 이동하며
일시 중단되는 것이 확인돼, 새 중앙 저장소 7개에만 `minAvailable: 1` PDB를 추가했다.
이는 자발적 재배치를 제한한다. 단일 복제본 구성에 HA를 제공하지 않으며, 계획된
유지보수 시 해당 PDB의 처리가 필요하다.

## 배치 구조와 보존

- 계정 `061525506239`, 리전 `ap-northeast-2`.
- 모든 AWS 작업은 `samples-atomoh`, 실제 신원
  `arn:aws:sts::061525506239:assumed-role/atomoh/atomoh-vscode` 확인 후 수행.
- 소스 네임스페이스 `telemetry-system`.
  - `telemetry-node` DaemonSet: kubelet 노드/파드/컨테이너/볼륨 메트릭,
    `/var/log/pods` 읽기 전용 로그 수집, 영속적인 로그 offset·전송 큐.
  - `telemetry-cluster` Deployment 1개: Kubernetes 객체 메트릭,
    Prometheus annotation 기반 스크랩, 로컬 OTLP 수신.
  - `telemetry-beyla` DaemonSet: eBPF 기반 HTTP/DB/지원 프로토콜 계측.
    모든 언어·프로토콜의 애플리케이션 내부 business span을 보장하지 않는다.
    초기 일부 언어 주입 오류가 관측됐으며, 최종 감사 시 eksworkshop의 최근
    수집기 오류는 없었다. iptables·ipvs Beyla에서 확인된 OOM은 메모리 한도를
    768Mi에서 1536Mi로 조정했다. 중앙 Jaeger도 기존 볼륨과 경로를 유지하고
    메모리 한도만 1Gi→2Gi로 조정했다.
- 중앙 보존기간 7일. Prometheus는 추가로 35GB TSDB 크기 제한.
- 암호화 gp3 PVC, `reclaimPolicy: Retain`:
  Prometheus 40Gi, Mimir 40Gi, Loki 50Gi, Tempo 30Gi, Jaeger 30Gi,
  ClickHouse 60Gi, 게이트웨이 큐 10Gi. 총 260Gi.
- 중앙 메트릭 저장은 Prometheus remote-write 및 Mimir remote-write.
  Loki는 native OTLP, Tempo·Jaeger는 OTLP, ClickHouse는 `otel.otel_logs`/
  `otel.otel_traces`를 사용한다.
- 호스트 로그 재수집 루프를 피하기 위해 `telemetry-system` 자신의 컨테이너 로그는
  제외했다. 기존 앱 배포 이미지나 복제본은 변경하지 않았다.

## 사설 연결과 인증

중앙 OTLP에는 internal NLB 하나만 사용하며 포트는 4317이다. 저장소 쿼리 서비스는
모두 ClusterIP다.

- PrivateLink 서비스: `vpce-svc-0ac371f4606926e0f`
- workloads VPC endpoint: `vpce-0ad17229cc37f9137` — Available 확인.
- GPU VPC endpoint: `vpce-007fa965fdf435fba` — Available 확인.
- 서비스 연결 허용 principal: `arn:aws:iam::061525506239:role/atomoh`.
- 소스 endpoint 보안 그룹은 해당 VPC CIDR의 TCP 4317만 허용.
- 전송은 클러스터별 client certificate를 사용하는 mTLS.
- 자격 증명은 환경 변수/매니페스트에 넣지 않고 마운트 Secret으로 제공.
- Secrets Manager:
  `/ops/central-observability/pki`,
  `/ops/central-observability/clickhouse`.
- 발급된 server/client 인증서 유효기간 365일, CA 1825일. 만료 전 갱신 필요.
- GPU API 허용 목록은 원래 `43.202.231.74/32` 그대로 유지됐다. 기존 관리
  NAT를 사용하는 VSCode 호스트의 임시 SSM 터널로 관리했다.
- VPC peering, 라우팅 테이블, 기존 클러스터 보안 그룹은 변경하지 않았다.

## 버전

| 구성 요소 | 버전 |
|---|---|
| OpenTelemetry Collector Contrib | 0.161.0 |
| Prometheus | 3.14.0 |
| Mimir | 3.2.1 |
| Loki | 3.7.7 |
| Tempo | 2.10.8 |
| Jaeger | 2.21.0 |
| ClickHouse | 26.8.5.13 LTS |
| Beyla | 3.35.0 |

중앙 워크로드는 arm64로 배치했다. 소스 에이전트는 각 노드 아키텍처를 따르는
multi-architecture 이미지다.

## 파일 및 조회

- `deployed/`: API에서 읽어 저장한 **실제 배치 상태**. Secret 본문 제외.
- `build.py`: 중앙 저장소·게이트웨이·PDB 구성 생성기.
- `deployed/`가 최종 배치 기준이다. 초기 `collectors-*.yaml`, 중복 생성된
  `central.yaml`/PDB YAML 및 취소된 통합안은 이 Git 기록에 포함하지 않는다.
  원본은 운영자 로컬 작업 디렉터리에 그대로 보관했다.
- 원시 `inventory-*.json`도 로컬 자료다. `snapshot.py`로 원래의 보존 비교를
  재실행하려면 해당 사전 인벤토리가 필요하다. 작업 후 인벤토리를 사전 자료로
  다시 생성하여 비교하지 말 것. 이 기록에는 당시 결과 `preservation.json`을 포함했다.
- `network.py`: 이번 전용 NLB의 PrivateLink 구성. 대상 ARN 고정.
- `prepare_credentials.py`: Secrets Manager 자격 증명 재사용/Secret 마운트 준비.
- `verify.py`, `verify-jaeger.py`, `status.py`, `snapshot.py`: 읽기 전용 검증.
- `verify-routing.py`: 실제 배치 ConfigMap의 24개 단일 목적지 경로 검증.
- `smoke.py`, `smoke-run.json`, `smoke-verification.json`: 표시된 테스트 신호의
  실제 저장소 도착 및 다른 저장소 미도착 검증.
- `rebalance.py`, `rebalance-*.json`: 승인된 nginx 순차 재배치와 가용성 복구 기록.
- `pending-capacity-plan.md`: 승인·완료된 용량 확보 범위와 실행 기록.

조회 예시(별도 터미널에서 실행):

```bash
aws sts get-caller-identity --profile samples-atomoh
aws eks update-kubeconfig --profile samples-atomoh --region ap-northeast-2 \
  --name platform-cluster --alias platform-cluster \
  --kubeconfig /tmp/awsops-central-telemetry.bOV102/kubeconfig

kubectl --kubeconfig /tmp/awsops-central-telemetry.bOV102/kubeconfig \
  --context platform-cluster -n central-observability \
  port-forward svc/prometheus 19090:9090
```

다른 서비스의 쿼리 포트: Mimir 9009(`/prometheus/api/v1/query`),
Loki 3100, Tempo 3200, Jaeger 16686(`/api/v3/*`), ClickHouse 8123.
ClickHouse 사용자 `telemetry`의 암호는 위 Secrets Manager에서 관리한다.

## 승인 및 완료 기록

초기에 자동 승인 검토가 일부 변경을 거부했으며, 이후 다음과 같이 처리했다.

1. GPU API allowlist에 관리 IP `/32` 추가 — 기존 허용 관리망의 SSM 터널로
   대체하여 이 변경은 더 이상 필요하지 않다.
2. 테스트 managed node group 3개를 각각 4→5대로 확장 — 사용자 명시 승인 후
   완료했다. 각 `min/max/desired = 4/5/5`, `ACTIVE`, 노드 5개 Ready.
3. 8개 클러스터의 독립 Beyla DaemonSet을 노드 수집기와 일괄 통합 교체 —
   일시적 트레이스 공백 및 호스트 마운트 변경 가능성으로 거부.
   사용자가 취소했으며 실행하지 않았다. 독립 DaemonSet 배치를 유지한다.

nginx 재배치: iptables 18개, ipvs 17개, nftables 16개. 모두 동일한 Deployment의
stateless 파드이며 원래 desired replicas 180은 변경하지 않았다. 한 개씩 재배치 후
가용성을 확인했고, 최종 Available도 각각 180이다. 기존 데이터베이스·StatefulSet·
CloudWatch·로컬 Prometheus 파드는 재배치 대상으로 선택하지 않았다.

추가 유료 자원은 중앙 저장소의 gp3/컴퓨트, 내부 NLB·PrivateLink 및 승인된
테스트 워커 3대다. platform-cluster는 배치 과정에서 Auto Mode가 용량을 조정했으며
초기 노드 2개에서 최종 3개가 됐다.
향후 워커를 다시 4대로 줄이면 파드 슬롯 부족이 재발할 수 있으므로, 수집기와
워크로드 용량을 확인한 후 축소해야 한다.
