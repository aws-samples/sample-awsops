import type { FlowInput } from './flow-topology';

export const FLOW_INPUT_KEY = {
  route53: 'route53', cloudfront: 'cloudfront', alb: 'alb', nlb: 'nlb', target_group: 'tg', waf: 'waf',
  ec2: 'ec2', lambda: 'lambda', ecs_task: 'ecsTask', s3: 's3', subnet: 'subnet',
  apigatewayv2_api: 'apigatewayv2_api', apigatewayv2_integration: 'apigatewayv2_integration',
  cloudfront_vpc_origin: 'cloudfront_vpc_origin',
  apigatewayv2_route: 'apigatewayv2_route', alb_listener_rule: 'alb_listener_rule',
  eni: 'eni', vpc_endpoint: 'vpc_endpoint', nat_gateway: 'nat_gateway',
  rds: 'rds', rds_cluster: 'rds_cluster', rds_proxy: 'rds_proxy',
} as const satisfies Record<string, keyof FlowInput>;

export const INTERACTIVE_FLOW_TYPES = ['route53', 'cloudfront', 'alb', 'nlb', 'target_group', 'waf', 'ec2', 'lambda', 'ecs_task', 's3', 'subnet',
  'apigatewayv2_api', 'apigatewayv2_integration', 'cloudfront_vpc_origin', 'apigatewayv2_route', 'alb_listener_rule',
  'eni', 'vpc_endpoint', 'nat_gateway'] as const;

export const FLOW_ENRICHMENT: ReadonlySet<string> = new Set([
  'eni', 'vpc_endpoint', 'nat_gateway', 'rds', 'rds_cluster', 'rds_proxy', 'apigatewayv2_route', 'alb_listener_rule',
]);
