import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  guideSidebar: [
    'intro',
    {
      type: 'category',
      label: '시작하기',
      collapsed: false,
      items: [
        'getting-started/login',
        'getting-started/navigation',
      ],
    },
    {
      type: 'category',
      label: '개요',
      items: [
        'overview/dashboard',
        'overview/assistant',
        'overview/agentcore',
      ],
    },
    {
      type: 'category',
      label: 'AI 운영',
      items: [
        'operations/ai-diagnosis',
        'operations/custom-agents',
        'operations/jobs',
      ],
    },
    {
      type: 'category',
      label: '리소스',
      items: [
        'resources/inventory',
        'resources/eks',
        'resources/topology',
      ],
    },
    {
      type: 'category',
      label: '비용',
      items: [
        'cost/cost-explorer',
        'cost/bedrock',
      ],
    },
    {
      type: 'category',
      label: '관측성',
      items: [
        'observability/datasources',
      ],
    },
    {
      type: 'category',
      label: 'FAQ',
      items: [
        'faq/general',
        'faq/troubleshooting',
        'faq/ai-assistant',
        'faq/architecture',
        'faq/agentcore-memory',
        'faq/datasource-development',
        'faq/decisions',
      ],
    },
  ],
};

export default sidebars;
