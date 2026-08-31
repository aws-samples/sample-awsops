import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'AWSops 사용자 가이드',
  tagline: 'AWS + Kubernetes 운영 대시보드 사용자 가이드',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],

  url: process.env.SITE_URL || 'https://www.atomai.click',
  baseUrl: process.env.BASE_URL || '/awsops/',

  stylesheets: [
    {
      // Pinned to the immutable /npm/ path (not /gh/@tag, which is a
      // re-assignable git ref) and locked with SRI, since GitHub Pages
      // can't send a CSP to backstop a compromised or re-tagged asset.
      href: 'https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/static/pretendard.min.css',
      type: 'text/css',
      integrity: 'sha384-1WPwPzrT39Q3uXVY1qOrNSiFcW7oxY0Xf5CZYw4D3j1EuApQlY8DzzfQw0tySMyG',
      crossorigin: 'anonymous',
    },
  ],

  organizationName: 'Atom-oh',
  projectName: 'awsops',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',
  onBrokenAnchors: 'warn',

  i18n: {
    defaultLocale: 'ko',
    locales: ['ko', 'en', 'ja', 'zh'],
    localeConfigs: {
      ko: { label: '한국어', direction: 'ltr' },
      en: { label: 'English', direction: 'ltr' },
      ja: { label: '日本語', direction: 'ltr' },
      zh: { label: '简体中文', direction: 'ltr', htmlLang: 'zh-Hans' },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
        },
        blog: {
          path: 'whatsnew',
          routeBasePath: 'whatsnew',
          blogTitle: "What's New",
          blogDescription: 'AWSops 개발 현황 및 릴리스 노트',
          blogSidebarTitle: '릴리스 노트',
          blogSidebarCount: 'ALL',
          showReadingTime: true,
        },
        theme: {
          customCss: './src/css/custom.css',
        },
        gtag: {
          trackingID: 'G-GWVLEW5JLL',
          anonymizeIP: true,
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/awsops-social-card.png',
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'AWSops Guide',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'guideSidebar',
          position: 'left',
          label: '가이드',
        },
        {
          to: '/faq/general',
          label: 'FAQ',
          position: 'left',
        },
        {
          to: '/whatsnew',
          label: "What's New",
          position: 'left',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
        {
          href: 'pathname:///presentation/awsops-intro/index.html',
          label: 'Presentation',
          position: 'left',
        },
        {
          href: 'https://awsops.atomai.click/',
          label: '대시보드',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: '가이드',
          items: [
            { label: '시작하기', to: '/getting-started/login' },
            { label: 'AI 어시스턴트', to: '/getting-started/ai-assistant' },
            { label: "What's New", to: '/whatsnew' },
          ],
        },
        {
          title: '리소스',
          items: [
            { label: 'Dashboard', href: 'https://awsops.atomai.click/' },
          ],
        },
        {
          title: 'AWS 서비스',
          items: [
            { label: 'Amazon Bedrock', href: 'https://aws.amazon.com/bedrock/' },
            { label: 'Steampipe', href: 'https://steampipe.io/' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AWSops. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json', 'sql'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
