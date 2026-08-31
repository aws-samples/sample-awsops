// Owns the site root route "/". No doc may declare `slug: /` — it would
// collide with this page route and fail the Docusaurus build.
import React, { useEffect, useRef, useState } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Translate, { translate } from '@docusaurus/Translate';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './index.module.css';

const DASHBOARD_URL = 'https://awsops.atomai.click/';

function useScrollReveal(): React.RefObject<HTMLDivElement> {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-reveal]'));
    items.forEach((item) => {
      item.dataset.reveal = 'pending';
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.reveal = 'in';
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -12% 0px' },
    );
    items.forEach((item) => observer.observe(item));

    return () => observer.disconnect();
  }, []);

  return rootRef;
}

function TourVideo(): React.ReactElement {
  const webmUrl = useBaseUrl('/video/product-tour.webm');
  const mp4Url = useBaseUrl('/video/product-tour.mp4');
  const posterUrl = useBaseUrl('/video/product-tour-poster.webp');
  const [motionOk, setMotionOk] = useState(false);

  useEffect(() => {
    setMotionOk(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  return (
    <figure className={`${styles.frame} ${styles.frameWide} ${styles.tourFrame}`} data-reveal="">
      {motionOk ? (
        <video
          className={styles.tourVideo}
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={posterUrl}
          aria-hidden="true"
        >
          <source src={webmUrl} type="video/webm" />
          <source src={mp4Url} type="video/mp4" />
        </video>
      ) : (
        <img
          className={styles.tourVideo}
          src={posterUrl}
          loading="lazy"
          alt={translate({ id: 'home.watch.alt', message: 'AWSops 제품 투어 미리보기' })}
        />
      )}
      <figcaption>
        <Translate id="home.watch.caption">
          대시보드부터 보안·컴플라이언스·EKS·AI 진단까지, 8개 화면을 훑는 30초 투어입니다.
        </Translate>
      </figcaption>
    </figure>
  );
}

function HeroGlyph(): React.ReactElement {
  return (
    <svg
      className={styles.heroGlyph}
      viewBox="0 0 420 300"
      role="img"
      aria-label={translate({
        id: 'home.hero.svgAria',
        message: '연결된 운영 노드 그래프',
      })}
    >
      <defs>
        <radialGradient id="awsopsHeroHalo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#00d4ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="#33415c" strokeWidth="1.4" fill="none">
        <line x1="60" y1="220" x2="210" y2="150" />
        <line x1="210" y1="150" x2="360" y2="90" />
        <line x1="210" y1="150" x2="350" y2="220" />
        <line x1="60" y1="220" x2="150" y2="70" />
        <line x1="150" y1="70" x2="210" y2="150" />
        <line x1="350" y1="220" x2="360" y2="90" />
        <line x1="60" y1="220" x2="350" y2="220" />
      </g>
      <g stroke="#00d4ff" strokeWidth="1.8" fill="none" strokeDasharray="4 6">
        <line x1="210" y1="150" x2="360" y2="90">
          <animate attributeName="stroke-dashoffset" from="40" to="0" dur="2.4s" repeatCount="indefinite" />
        </line>
        <line x1="60" y1="220" x2="210" y2="150">
          <animate attributeName="stroke-dashoffset" from="40" to="0" dur="3s" repeatCount="indefinite" />
        </line>
      </g>
      <g>
        <circle cx="60" cy="220" r="9" fill="#0f1629" stroke="#4a5a7a" strokeWidth="1.6" />
        <circle cx="150" cy="70" r="9" fill="#0f1629" stroke="#4a5a7a" strokeWidth="1.6" />
        <circle cx="360" cy="90" r="9" fill="#0f1629" stroke="#4a5a7a" strokeWidth="1.6" />
        <circle cx="350" cy="220" r="9" fill="#0f1629" stroke="#4a5a7a" strokeWidth="1.6" />
      </g>
      <circle cx="210" cy="150" r="46" fill="url(#awsopsHeroHalo)">
        <animate attributeName="r" values="40;52;40" dur="3.2s" repeatCount="indefinite" />
      </circle>
      <circle cx="210" cy="150" r="17" fill="#00d4ff" />
      <circle cx="210" cy="150" r="9" fill="#0a0e1a" />
      <g fontFamily="'SFMono-Regular', Consolas, 'Liberation Mono', monospace" fontSize="11" fill="#8fa3c4">
        <text x="60" y="246" textAnchor="middle">EC2 · EKS</text>
        <text x="150" y="52" textAnchor="middle">VPC · <Translate id="home.hero.glyph.network">네트워크</Translate></text>
        <text x="360" y="72" textAnchor="middle"><Translate id="home.hero.glyph.cost">비용</Translate> · FinOps</text>
        <text x="350" y="246" textAnchor="middle"><Translate id="home.hero.glyph.security">보안</Translate> · CIS</text>
        <text x="210" y="207" textAnchor="middle" fill="#00d4ff" fontWeight="600">AgentCore</text>
      </g>
    </svg>
  );
}

function Hero(): React.ReactElement {
  return (
    <header className={styles.hero}>
      <div className={`${styles.wrap} ${styles.heroGrid}`}>
        <div>
          <span className={styles.eyebrow}>
            <Translate id="home.hero.eyebrow">AWS + Kubernetes operations</Translate>
          </span>
          <h1>AWSops</h1>
          <p className={styles.heroLine}>
            <Translate id="home.hero.line">흩어진 AWS 운영을 하나의 화면에.</Translate>
          </p>
          <p className={styles.heroCopy}>
            <Translate id="home.hero.copy">
              운영 현황을 보고, 라이브 데이터에 질문하고, Well-Architected 관점의 진단까지 한
              흐름으로 이어갑니다.
            </Translate>
          </p>
          <div className={styles.ctaRow}>
            <Link className={styles.button} to="/intro">
              <Translate id="home.hero.ctaPrimary">가이드 시작하기</Translate>
            </Link>
            <Link className={`${styles.button} ${styles.buttonGhost}`} to="/overview/dashboard">
              <Translate id="home.hero.ctaSecondary">대시보드 살펴보기</Translate>
            </Link>
          </div>
          <div className={styles.metrics}>
            <div className={styles.metric}>
              <div className={styles.metricValue}>9</div>
              <div className={styles.metricLabel}>
                <Translate id="home.proof.routes">AI 라우팅 섹션</Translate>
              </div>
            </div>
            <div className={styles.metric}>
              <div className={styles.metricValue}>6</div>
              <div className={styles.metricLabel}>
                <Translate id="home.proof.pillars">Well-Architected 필러</Translate>
              </div>
            </div>
            <div className={styles.metric}>
              <div className={styles.metricValue}>3</div>
              <div className={styles.metricLabel}>
                <Translate id="home.proof.exports">리포트 내보내기 형식</Translate>
              </div>
            </div>
          </div>
        </div>
        <aside className={styles.heroFig}>
          <div className={styles.heroFigCap}>SINGLE PANE OF GLASS</div>
          <div className={styles.heroFigCap2}>
            <Translate id="home.hero.figCap2">
              계정 · 리전 · 클러스터를 가로질러 하나의 운영 신경망으로.
            </Translate>
          </div>
          <HeroGlyph />
        </aside>
      </div>
    </header>
  );
}

export default function Home(): React.ReactElement {
  const rootRef = useScrollReveal();

  return (
    <Layout
      title={translate({ id: 'home.meta.title', message: 'AWSops | 흩어진 AWS 운영을 하나의 화면에' })}
      description={translate({
        id: 'home.meta.description',
        message:
          'AWS 운영 현황, 리소스 관계, 비용과 보안을 한 화면에서 보고, 라이브 데이터 질문은 Amazon Bedrock AgentCore로, 종합 진단은 읽기 전용 비동기 워커로 수행하는 읽기 전용 운영 대시보드입니다.',
      })}
    >
      <div ref={rootRef} className={styles.page}>
        <Hero />

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Watch</span>
              <h2>
                <Translate id="home.watch.heading">30초로 보는 AWSops</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.watch.lead">
                  실제 화면을 이어붙인 짧은 투어로 무엇을 할 수 있는지 먼저 확인하세요.
                </Translate>
              </p>
            </div>
            <TourVideo />
          </div>
        </section>

        <section className={styles.section}>
          <div className={`${styles.wrap} ${styles.story}`}>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/dashboard.webp')}
                loading="lazy"
                alt={translate({ id: 'home.see.alt', message: 'AWSops 통합 운영 대시보드' })}
              />
              <figcaption>
                <Translate id="home.see.caption">
                  컴퓨트·스토리지·네트워크·보안·비용 KPI를 메인 화면에 모아 봅니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>See</span>
              <h2>
                <Link to="/overview/dashboard">
                  <Translate id="home.see.heading">대시보드에서 한눈에 확인합니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.see.lead">
                  분산된 리소스 현황을 한 화면의 KPI와 분포 차트로 정리해 보여줍니다.
                </Translate>
              </p>
            </div>
          </div>
        </section>

        <section className={styles.band}>
          <div className={`${styles.wrap} ${styles.story}`}>
            <figure className={`${styles.frame} ${styles.frameTall}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/assistant-answer.webp')}
                loading="lazy"
                alt={translate({
                  id: 'home.ask.alt',
                  message: '비용 질문에 근거를 제시하는 AWSops AI 어시스턴트',
                })}
              />
              <figcaption>
                <Translate id="home.ask.caption">
                  도메인별 읽기 전용 도구가 수집한 근거를 하나의 답변으로 합성합니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>Ask</span>
              <h2>
                <Link to="/overview/assistant">
                  <Translate id="home.ask.heading">운영 데이터에 바로 질문합니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.ask.lead">
                  질문 의도를 전문 라우트로 분류하고 라이브 데이터를 조회합니다. 여러 도메인의
                  결과는 한 번에 읽을 수 있는 답변으로 돌아옵니다.
                </Translate>
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Explore</span>
              <h2>
                <Translate id="home.explore.heading">관계, 비용, 통제를 같은 맥락에서.</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.explore.lead">
                  리소스 흐름을 따라가고, 비용 추이와 보안 통제를 함께 확인합니다.
                </Translate>
              </p>
            </div>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <Link to="/resources/topology">
                <img
                  src={useBaseUrl('/showcase/media/topology.webp')}
                  loading="lazy"
                  alt={translate({
                    id: 'home.explore.topologyAlt',
                    message: 'DNS에서 타깃까지 이어지는 AWS 리소스 토폴로지',
                  })}
                />
              </Link>
              <figcaption>
                <Translate id="home.explore.topologyCaption">
                  요청 경로와 리소스 관계를 시각적으로 탐색합니다.
                </Translate>
              </figcaption>
            </figure>
            <div className={styles.pair}>
              <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
                <Link to="/cost/cost-explorer">
                  <img
                    src={useBaseUrl('/showcase/media/cost-explorer.webp')}
                    loading="lazy"
                    alt={translate({
                      id: 'home.explore.costAlt',
                      message: '월별 및 일별 AWS 비용 추이',
                    })}
                  />
                </Link>
                <figcaption>
                  <Translate id="home.explore.costCaption">
                    서비스별 비용과 변화를 비교합니다.
                  </Translate>
                </figcaption>
              </figure>
              <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
                <Link to="/security/compliance">
                  <img
                    src={useBaseUrl('/showcase/media/compliance.webp')}
                    loading="lazy"
                    alt={translate({
                      id: 'home.explore.complianceAlt',
                      message: '보안 이슈와 CIS 컴플라이언스 요약',
                    })}
                  />
                </Link>
                <figcaption>
                  <Translate id="home.explore.complianceCaption">
                    위험 신호와 컴플라이언스 상태를 빠르게 확인합니다.
                  </Translate>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className={styles.band}>
          <div className={`${styles.wrap} ${styles.story} ${styles.storyReverse}`}>
            <div className={styles.storyCopy} data-reveal="">
              <span className={styles.kicker}>Diagnose</span>
              <h2>
                <Link to="/operations/ai-diagnosis">
                  <Translate id="home.diagnose.heading">관찰을 의사결정 자료로 바꿉니다.</Translate>
                </Link>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.diagnose.lead">
                  무거운 진단은 비동기 워커에서 처리하고, Well-Architected 관점의 결과를 MD,
                  DOCX, PDF로 내보냅니다.
                </Translate>
              </p>
            </div>
            <figure className={`${styles.frame} ${styles.frameWide}`} data-reveal="">
              <img
                src={useBaseUrl('/showcase/media/ai-diagnosis.webp')}
                loading="lazy"
                alt={translate({
                  id: 'home.diagnose.alt',
                  message: 'AWSops AI 진단 보고서와 목차',
                })}
              />
              <figcaption>
                <Translate id="home.diagnose.caption">
                  진단 결과와 개선 제안을 구조화된 보고서로 제공합니다.
                </Translate>
              </figcaption>
            </figure>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.wrap}>
            <div className={styles.sectionHead} data-reveal="">
              <span className={styles.kicker}>Trust</span>
              <h2>
                <Translate id="home.trust.heading">변경보다 근거를 우선합니다.</Translate>
              </h2>
              <p className={styles.lead}>
                <Translate id="home.trust.lead">
                  AWSops는 운영 상태를 관찰하고 진단과 개선 제안을 제공합니다. 진단 결과로
                  고객 AWS 리소스를 자동 변경하거나 자율 복구하지 않습니다.
                </Translate>
              </p>
            </div>
            <div className={styles.trustGrid} data-reveal="">
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.edge.title">Private edge</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.edge.body">
                    CloudFront VPC Origin 뒤의 내부 ALB로 애플리케이션을 보호합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.identity.title">Verified identity</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.identity.body">
                    Cognito와 Lambda@Edge의 RS256 검증으로 접근을 통제합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.privilege.title">Least privilege</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.privilege.body">
                    챗의 라이브 조회는 AgentCore MCP 도구 경계 안에서, 종합 진단은 읽기 전용 권한의
                    비동기 워커에서 수행합니다.
                  </Translate>
                </p>
              </article>
              <article className={styles.trustItem}>
                <h3>
                  <Translate id="home.trust.encrypted.title">Encrypted state</Translate>
                </h3>
                <p>
                  <Translate id="home.trust.encrypted.body">
                    Aurora와 관리형 시크릿으로 상태와 자격 증명을 분리합니다.
                  </Translate>
                </p>
              </article>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.closing}`}>
          <div className={styles.wrap} data-reveal="">
            <h2>
              <Translate id="home.cta.heading">운영을 하나의 화면으로 옮겨보세요.</Translate>
            </h2>
            <p>
              <Translate id="home.cta.lead">
                실제 대시보드에서 통합 가시성과 AI 진단 흐름을 확인할 수 있습니다.
              </Translate>
            </p>
            <div className={styles.ctaRow}>
              <Link className={styles.button} to="/intro">
                <Translate id="home.cta.ctaGuide">가이드 시작하기</Translate>
              </Link>
              <a
                className={`${styles.button} ${styles.buttonGhost}`}
                href={DASHBOARD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Translate id="home.cta.ctaDemo">제품 데모 보기</Translate>
              </a>
            </div>
          </div>
        </section>
      </div>
    </Layout>
  );
}
