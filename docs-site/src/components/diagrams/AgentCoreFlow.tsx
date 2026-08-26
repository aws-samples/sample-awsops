'use client';

import React, { useCallback } from 'react';
import { useCanvas, THEME, roundRect, isHover, canvasWrapperStyle, DrawContext } from './useCanvas';

interface Route {
  priority: number;
  name: string;
  color: string;
  target: string;
  tools: number;
  toolList?: string[];
}

// v2: 9 routed sections (8 AWS-domain gateways + external-obs, chat key "observability").
// Tool counts from the full catalog (scripts/v2/agentcore/catalog.py) — actual activation is
// staged behind agentcore_enabled/integrations_enabled (P3).
const ROUTES: Route[] = [
  { priority: 1, name: 'network', color: THEME.cyan, target: 'Network Gateway', tools: 16, toolList: ['Reachability Analyzer', 'Flow Logs', 'TGW', 'VPN', 'Network Firewall', 'ENI lookup'] },
  { priority: 2, name: 'container', color: THEME.green, target: 'Container Gateway', tools: 12, toolList: ['EKS Clusters', 'ECS Services', 'Fargate', 'CloudWatch Container Insights'] },
  { priority: 3, name: 'data', color: THEME.purple, target: 'Data Gateway', tools: 28, toolList: ['DynamoDB', 'RDS/Aurora', 'ElastiCache', 'MSK', 'ClickHouse'] },
  { priority: 4, name: 'security', color: THEME.red, target: 'Security Gateway', tools: 14, toolList: ['IAM users/roles/policies', 'Policy simulation', 'Account security summary'] },
  { priority: 5, name: 'cost', color: THEME.orange, target: 'Cost Gateway', tools: 14, toolList: ['Cost Explorer', 'Budgets', 'Forecast', 'Compute Optimizer', 'RI/SP recommendations'] },
  { priority: 6, name: 'monitoring', color: THEME.cyan, target: 'Monitoring Gateway', tools: 40, toolList: ['CloudWatch Metrics/Logs', 'CloudTrail', 'OpenSearch', 'Prometheus', 'Loki', 'Tempo', 'Mimir'] },
  { priority: 7, name: 'iac', color: THEME.purple, target: 'IaC Gateway', tools: 12, toolList: ['CloudFormation', 'CDK docs', 'Terraform AWS/AWSCC providers'] },
  { priority: 8, name: 'ops', color: THEME.muted, target: 'Ops Gateway', tools: 5, toolList: ['AWS documentation search/read'] },
  { priority: 9, name: 'observability', color: THEME.green, target: 'External-Obs', tools: 3, toolList: ['Notion (external integrations)'] },
];

const CANVAS_HEIGHT = 550;

export default function AgentCoreFlow(): React.ReactElement {
  const draw = useCallback((dc: DrawContext) => {
    const { ctx, width, height, frame, mouse, dpr } = dc;
    const scale = dpr;

    // Layout constants
    const userBoxY = 30 * scale;
    const userBoxH = 50 * scale;
    const routerBoxY = 120 * scale;
    const routerBoxH = 60 * scale;
    const routesY = 230 * scale;
    const routeBoxH = 70 * scale;
    const runtimeY = 420 * scale;
    const runtimeH = 100 * scale;

    const centerX = width / 2;
    const boxWidth = 200 * scale;
    const routeBoxW = Math.min(90 * scale, (width - 40 * scale) / ROUTES.length - 8 * scale);
    const routeSpacing = 8 * scale;
    const totalRoutesWidth = ROUTES.length * routeBoxW + (ROUTES.length - 1) * routeSpacing;
    const routesStartX = (width - totalRoutesWidth) / 2;

    // Animation: cycle through routes every 3 seconds (180 frames at 60fps)
    const cycleFrames = 180;
    const activeRouteIndex = Math.floor((frame % (cycleFrames * ROUTES.length)) / cycleFrames);
    const cycleProgress = (frame % cycleFrames) / cycleFrames;

    // Particle position calculation
    let particleX = centerX;
    let particleY = userBoxY + userBoxH;
    const activeRouteX = routesStartX + activeRouteIndex * (routeBoxW + routeSpacing) + routeBoxW / 2;

    if (cycleProgress < 0.25) {
      // User -> Router
      const t = cycleProgress / 0.25;
      particleY = userBoxY + userBoxH + t * (routerBoxY - userBoxY - userBoxH);
    } else if (cycleProgress < 0.5) {
      // Router -> Route (horizontal + vertical)
      const t = (cycleProgress - 0.25) / 0.25;
      particleX = centerX + t * (activeRouteX - centerX);
      particleY = routerBoxY + routerBoxH + t * (routesY - routerBoxY - routerBoxH);
    } else if (cycleProgress < 0.75) {
      // Stay at route (glow)
      particleX = activeRouteX;
      particleY = routesY + routeBoxH / 2;
    } else {
      // Route -> Runtime
      const t = (cycleProgress - 0.75) / 0.25;
      particleX = activeRouteX + t * (centerX - activeRouteX);
      particleY = routesY + routeBoxH + t * (runtimeY - routesY - routeBoxH);
    }

    // Helper: draw box with optional glow
    function drawBox(x: number, y: number, w: number, h: number, color: string, glow = false) {
      if (glow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 20 * scale;
      }
      ctx.fillStyle = THEME.card;
      roundRect(ctx, x, y, w, h, 8 * scale);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * scale;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Helper: draw text
    function drawText(text: string, x: number, y: number, color: string, size: number, align: CanvasTextAlign = 'center') {
      ctx.fillStyle = color;
      ctx.font = `${size * scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
    }

    // Helper: draw arrow
    function drawArrow(x1: number, y1: number, x2: number, y2: number, color: string) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      // Arrowhead
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = 10 * scale;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }

    // 1. User Query Box
    const userBoxW = boxWidth;
    const userBoxX = centerX - userBoxW / 2;
    drawBox(userBoxX, userBoxY, userBoxW, userBoxH, THEME.cyan);
    drawText('User Query', centerX, userBoxY + userBoxH / 2, THEME.text, 14);

    // Arrow: User -> Router
    drawArrow(centerX, userBoxY + userBoxH, centerX, routerBoxY, THEME.dim);

    // 2. AI Router Box
    const routerBoxW = 320 * scale;
    const routerBoxX = centerX - routerBoxW / 2;
    drawBox(routerBoxX, routerBoxY, routerBoxW, routerBoxH, THEME.purple);
    drawText('AI Router', centerX, routerBoxY + 20 * scale, THEME.text, 14);
    drawText(`${ROUTES.length}-Section Routing (Haiku 4.5, ADR-038)`, centerX, routerBoxY + 42 * scale, THEME.muted, 10);

    // Arrows: Router -> Routes (fan out)
    for (let i = 0; i < ROUTES.length; i++) {
      const routeX = routesStartX + i * (routeBoxW + routeSpacing) + routeBoxW / 2;
      const color = i === activeRouteIndex ? ROUTES[i].color : THEME.dim;
      drawArrow(centerX, routerBoxY + routerBoxH, routeX, routesY, color);
    }

    // 3. Route Boxes
    let hoveredRoute: Route | null = null;
    let hoverX = 0;
    let hoverY = 0;

    for (let i = 0; i < ROUTES.length; i++) {
      const route = ROUTES[i];
      const x = routesStartX + i * (routeBoxW + routeSpacing);
      const y = routesY;
      const isActive = i === activeRouteIndex && cycleProgress >= 0.5 && cycleProgress < 0.75;
      const isHovered = isHover(mouse.x, mouse.y, x, y, routeBoxW, routeBoxH);

      if (isHovered) {
        hoveredRoute = route;
        hoverX = x + routeBoxW / 2;
        hoverY = y;
      }

      drawBox(x, y, routeBoxW, routeBoxH, route.color, isActive || isHovered);

      // Priority badge
      ctx.fillStyle = route.color;
      roundRect(ctx, x + 4 * scale, y + 4 * scale, 18 * scale, 16 * scale, 4 * scale);
      ctx.fill();
      drawText(String(route.priority), x + 13 * scale, y + 12 * scale, THEME.bg, 9);

      // Route name
      drawText(route.name, x + routeBoxW / 2, y + 30 * scale, THEME.text, 10);

      // Tool count badge
      const toolText = String(route.tools);
      const badgeW = (toolText.length * 6 + 12) * scale;
      const badgeX = x + routeBoxW / 2 - badgeW / 2;
      const badgeY = y + routeBoxH - 22 * scale;
      ctx.fillStyle = route.color + '33';
      roundRect(ctx, badgeX, badgeY, badgeW, 16 * scale, 4 * scale);
      ctx.fill();
      drawText(toolText, x + routeBoxW / 2, badgeY + 8 * scale, route.color, 9);

      // Arrow to Runtime
      const arrowColor = i === activeRouteIndex ? route.color : THEME.dim;
      drawArrow(x + routeBoxW / 2, y + routeBoxH, centerX, runtimeY, arrowColor);
    }

    // 4. AgentCore Runtime Box
    const runtimeW = Math.min(500 * scale, width - 40 * scale);
    const runtimeX = centerX - runtimeW / 2;
    drawBox(runtimeX, runtimeY, runtimeW, runtimeH, THEME.green);
    drawText('AgentCore Runtime', centerX, runtimeY + 25 * scale, THEME.text, 16);
    drawText('Strands Agent Framework + Claude Sonnet 4.6', centerX, runtimeY + 50 * scale, THEME.muted, 11);

    // Stats badges
    const badge1X = centerX - 80 * scale;
    const badge2X = centerX + 80 * scale;
    const badgeY = runtimeY + 75 * scale;

    ctx.fillStyle = THEME.cyan + '33';
    roundRect(ctx, badge1X - 50 * scale, badgeY - 10 * scale, 100 * scale, 20 * scale, 4 * scale);
    ctx.fill();
    drawText('144 MCP Tools', badge1X, badgeY, THEME.cyan, 10);

    ctx.fillStyle = THEME.orange + '33';
    roundRect(ctx, badge2X - 50 * scale, badgeY - 10 * scale, 100 * scale, 20 * scale, 4 * scale);
    ctx.fill();
    drawText('23 Lambda', badge2X, badgeY, THEME.orange, 10);

    // 5. Draw particle
    const particleRadius = 6 * scale;
    const activeColor = ROUTES[activeRouteIndex].color;
    ctx.beginPath();
    ctx.arc(particleX, particleY, particleRadius, 0, Math.PI * 2);
    ctx.fillStyle = activeColor;
    ctx.shadowColor = activeColor;
    ctx.shadowBlur = 15 * scale;
    ctx.fill();
    ctx.shadowBlur = 0;

    // 6. Tooltip on hover
    if (hoveredRoute) {
      const tooltipW = 180 * scale;
      const tooltipH = Math.min((hoveredRoute.toolList?.length || 0) * 16 + 40, 200) * scale;
      let tooltipX = hoverX - tooltipW / 2;
      let tooltipY = hoverY - tooltipH - 10 * scale;

      // Keep tooltip in bounds
      if (tooltipX < 10 * scale) tooltipX = 10 * scale;
      if (tooltipX + tooltipW > width - 10 * scale) tooltipX = width - tooltipW - 10 * scale;
      if (tooltipY < 10 * scale) tooltipY = hoverY + routeBoxH + 10 * scale;

      ctx.fillStyle = THEME.bg + 'ee';
      roundRect(ctx, tooltipX, tooltipY, tooltipW, tooltipH, 8 * scale);
      ctx.fill();
      ctx.strokeStyle = hoveredRoute.color;
      ctx.lineWidth = 1 * scale;
      ctx.stroke();

      drawText(hoveredRoute.target, tooltipX + tooltipW / 2, tooltipY + 16 * scale, hoveredRoute.color, 11);
      drawText(`${hoveredRoute.tools} tools`, tooltipX + tooltipW / 2, tooltipY + 32 * scale, THEME.muted, 9);

      if (hoveredRoute.toolList) {
        const maxTools = Math.min(hoveredRoute.toolList.length, 8);
        for (let i = 0; i < maxTools; i++) {
          drawText(
            hoveredRoute.toolList[i],
            tooltipX + 10 * scale,
            tooltipY + 52 * scale + i * 14 * scale,
            THEME.text,
            8,
            'left'
          );
        }
        if (hoveredRoute.toolList.length > 8) {
          drawText(
            `+${hoveredRoute.toolList.length - 8} more...`,
            tooltipX + 10 * scale,
            tooltipY + 52 * scale + 8 * 14 * scale,
            THEME.muted,
            8,
            'left'
          );
        }
      }
    }
  }, []);

  const canvasRef = useCanvas(draw, CANVAS_HEIGHT);

  return (
    <div style={canvasWrapperStyle}>
      <canvas ref={canvasRef} />
    </div>
  );
}
