'use client';

import { useCallback } from 'react';
import { useCanvas, THEME, roundRect, isHover, canvasWrapperStyle, DrawContext } from './useCanvas';

interface Node {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  color: string;
  details: string;
  children?: { label: string; color: string }[];
}

interface Connection {
  from: string;
  to: string;
  label: string;
  dashed?: boolean;
  color: string;
}

export default function ArchitectureFlow() {
  const draw = useCallback((dc: DrawContext) => {
    const { ctx, width, height, frame, mouse, dpr } = dc;

    // Scale factor for responsive layout
    const scale = Math.min(width / (1200 * dpr), 1);
    const baseX = (width - 1100 * dpr * scale) / 2;
    const baseY = 40 * dpr;

    // Node definitions (positions relative to baseX, scaled)
    const s = (v: number) => v * dpr * scale;
    const px = (v: number) => baseX + s(v);

    const nodes: Node[] = [
      {
        id: 'users',
        x: px(20), y: baseY + s(180),
        w: s(80), h: s(80),
        label: 'Users',
        color: THEME.muted,
        details: 'Global Users',
      },
      {
        id: 'cloudfront',
        x: px(150), y: baseY + s(160),
        w: s(120), h: s(70),
        label: 'CloudFront',
        color: THEME.purple,
        details: 'HTTPS, CACHING_DISABLED',
      },
      {
        id: 'lambda-edge',
        x: px(160), y: baseY + s(260),
        w: s(100), h: s(50),
        label: 'Lambda@Edge',
        color: THEME.orange,
        details: 'Cognito JWT Auth',
      },
      {
        id: 'alb',
        x: px(340), y: baseY + s(160),
        w: s(100), h: s(70),
        label: 'ALB',
        color: THEME.cyan,
        details: 'Internet-facing, Port 80/3000\nCustom Header Validation',
      },
      {
        id: 'ec2',
        x: px(500), y: baseY + s(100),
        w: s(240), h: s(200),
        label: 'EC2',
        color: THEME.green,
        details: 't4g.2xlarge ARM64 Graviton\nPrivate Subnet',
        children: [
          { label: 'Next.js 14', color: THEME.cyan },
          { label: 'Steampipe', color: THEME.green },
        ],
      },
      {
        id: 'agentcore',
        x: px(820), y: baseY + s(80),
        w: s(240), h: s(240),
        label: 'Bedrock AgentCore',
        color: THEME.purple,
        details: 'Runtime (Strands)\n8 Gateways, 125 MCP Tools\n19 Lambda Functions',
        children: [
          { label: 'Code Interpreter', color: THEME.orange },
          { label: 'Memory Store', color: THEME.cyan },
        ],
      },
    ];

    const connections: Connection[] = [
      { from: 'users', to: 'cloudfront', label: 'HTTPS', color: THEME.cyan },
      { from: 'cloudfront', to: 'lambda-edge', label: 'Auth Check', dashed: true, color: THEME.orange },
      { from: 'cloudfront', to: 'alb', label: 'Custom Header', color: THEME.purple },
      { from: 'alb', to: 'ec2', label: 'Port 3000', color: THEME.cyan },
      { from: 'ec2', to: 'agentcore', label: 'API Call', color: THEME.purple },
    ];

    // VPC boundary
    const vpcX = px(310);
    const vpcY = baseY + s(60);
    const vpcW = s(460);
    const vpcH = s(280);

    // Draw background
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, width, height);

    // Draw VPC boundary (dashed)
    ctx.strokeStyle = THEME.dim;
    ctx.lineWidth = 2 * dpr * scale;
    ctx.setLineDash([8 * dpr * scale, 4 * dpr * scale]);
    roundRect(ctx, vpcX, vpcY, vpcW, vpcH, 12 * dpr * scale);
    ctx.stroke();
    ctx.setLineDash([]);

    // VPC label
    ctx.fillStyle = THEME.muted;
    ctx.font = `${12 * dpr * scale}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('VPC 10.254.0.0/16 - 2 AZ, NAT Gateway', vpcX + s(10), vpcY + s(20));

    // Find node by id
    const findNode = (id: string) => nodes.find(n => n.id === id);

    // Get connection points
    const getNodeCenter = (node: Node) => ({
      x: node.x + node.w / 2,
      y: node.y + node.h / 2,
    });

    const getConnectionPoints = (from: Node, to: Node) => {
      const fromCenter = getNodeCenter(from);
      const toCenter = getNodeCenter(to);

      // Determine exit/entry points based on relative positions
      let startX = from.x + from.w;
      let startY = fromCenter.y;
      let endX = to.x;
      let endY = toCenter.y;

      // Special case for lambda-edge (below cloudfront)
      if (from.id === 'cloudfront' && to.id === 'lambda-edge') {
        startX = fromCenter.x;
        startY = from.y + from.h;
        endX = toCenter.x;
        endY = to.y;
      }

      return { startX, startY, endX, endY };
    };

    // Draw connections with animated particles
    connections.forEach(conn => {
      const fromNode = findNode(conn.from);
      const toNode = findNode(conn.to);
      if (!fromNode || !toNode) return;

      const { startX, startY, endX, endY } = getConnectionPoints(fromNode, toNode);

      // Draw line
      ctx.strokeStyle = conn.color + '60';
      ctx.lineWidth = 2 * dpr * scale;
      if (conn.dashed) {
        ctx.setLineDash([6 * dpr * scale, 4 * dpr * scale]);
      }
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw animated particles
      const particleCount = 3;
      const speed = 0.003;
      const lineLen = Math.hypot(endX - startX, endY - startY);

      for (let i = 0; i < particleCount; i++) {
        const t = ((frame * speed + i / particleCount) % 1);
        const px = startX + (endX - startX) * t;
        const py = startY + (endY - startY) * t;

        ctx.beginPath();
        ctx.arc(px, py, 4 * dpr * scale, 0, Math.PI * 2);
        ctx.fillStyle = conn.color;
        ctx.fill();
      }

      // Draw label at midpoint
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2 - s(10);
      ctx.fillStyle = THEME.muted;
      ctx.font = `${10 * dpr * scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(conn.label, midX, midY);
    });

    // Track hovered node for tooltip
    let hoveredNode: Node | null = null;

    // Draw nodes
    nodes.forEach(node => {
      const hovered = isHover(mouse.x, mouse.y, node.x, node.y, node.w, node.h);
      if (hovered) hoveredNode = node;

      // Glow effect on hover
      if (hovered) {
        ctx.shadowColor = node.color;
        ctx.shadowBlur = 20 * dpr * scale;
      }

      // Draw node background
      ctx.fillStyle = THEME.card;
      ctx.strokeStyle = hovered ? node.color : node.color + '80';
      ctx.lineWidth = (hovered ? 3 : 2) * dpr * scale;
      roundRect(ctx, node.x, node.y, node.w, node.h, 8 * dpr * scale);
      ctx.fill();
      ctx.stroke();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      // Draw icon/indicator for users node
      if (node.id === 'users') {
        // Globe icon representation
        ctx.strokeStyle = node.color;
        ctx.lineWidth = 2 * dpr * scale;
        const cx = node.x + node.w / 2;
        const cy = node.y + node.h / 2 - s(10);
        const r = s(20);

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();

        // Horizontal lines
        ctx.beginPath();
        ctx.moveTo(cx - r, cy);
        ctx.lineTo(cx + r, cy);
        ctx.stroke();

        // Vertical ellipse
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 0.4, r, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Draw label
      ctx.fillStyle = THEME.text;
      ctx.font = `bold ${14 * dpr * scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';

      if (node.id === 'users') {
        ctx.fillText(node.label, node.x + node.w / 2, node.y + node.h - s(10));
      } else if (node.children) {
        ctx.fillText(node.label, node.x + node.w / 2, node.y + s(25));

        // Draw child boxes
        const childY = node.y + s(45);
        const childH = s(35);
        const childW = node.w - s(20);
        const childX = node.x + s(10);

        node.children.forEach((child, i) => {
          const cy = childY + i * (childH + s(10));

          ctx.strokeStyle = child.color + '80';
          ctx.lineWidth = 1.5 * dpr * scale;
          roundRect(ctx, childX, cy, childW, childH, 4 * dpr * scale);
          ctx.stroke();

          ctx.fillStyle = THEME.text;
          ctx.font = `${12 * dpr * scale}px Inter, system-ui, sans-serif`;
          ctx.fillText(child.label, childX + childW / 2, cy + childH / 2 + s(4));
        });

        // Additional details for EC2
        if (node.id === 'ec2') {
          ctx.fillStyle = THEME.muted;
          ctx.font = `${10 * dpr * scale}px Inter, system-ui, sans-serif`;
          ctx.fillText('App Router, 35 pages', childX + childW / 2, childY + childH - s(8));
          ctx.fillText('PostgreSQL :9193', childX + childW / 2, childY + childH + s(10) + childH - s(8));
          ctx.fillText('380+ AWS, 60+ K8s tables', childX + childW / 2, childY + childH + s(10) + childH + s(5));
        }

        // Additional details for AgentCore
        if (node.id === 'agentcore') {
          ctx.fillStyle = THEME.muted;
          ctx.font = `${10 * dpr * scale}px Inter, system-ui, sans-serif`;
          ctx.fillText('Runtime (Strands)', node.x + node.w / 2, node.y + s(195));
          ctx.fillText('8 Gateways, 125 MCP Tools', node.x + node.w / 2, node.y + s(210));
          ctx.fillText('19 Lambda Functions', node.x + node.w / 2, node.y + s(225));
        }
      } else {
        ctx.fillText(node.label, node.x + node.w / 2, node.y + node.h / 2 + s(5));
      }
    });

    // Draw internal connections (Next.js <-> Steampipe)
    const ec2 = findNode('ec2');
    if (ec2) {
      const childW = ec2.w - s(20);
      const childX = ec2.x + s(10);
      const childY = ec2.y + s(45);
      const childH = s(35);

      // Arrow from Next.js to Steampipe
      const arrowX = childX + childW / 2;
      const arrowY1 = childY + childH + s(2);
      const arrowY2 = childY + childH + s(8);

      ctx.strokeStyle = THEME.cyan + '60';
      ctx.lineWidth = 1.5 * dpr * scale;
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY1);
      ctx.lineTo(arrowX, arrowY2);
      ctx.stroke();

      // Arrow head
      ctx.beginPath();
      ctx.moveTo(arrowX - s(4), arrowY2 - s(3));
      ctx.lineTo(arrowX, arrowY2);
      ctx.lineTo(arrowX + s(4), arrowY2 - s(3));
      ctx.stroke();
    }

    // Draw tooltip for hovered node
    if (hoveredNode && hoveredNode.id !== 'users') {
      const tooltipX = hoveredNode.x + hoveredNode.w + s(10);
      const tooltipY = hoveredNode.y;
      const lines = hoveredNode.details.split('\n');
      const tooltipW = s(180);
      const tooltipH = s(20 + lines.length * 16);

      // Ensure tooltip stays within canvas
      let tx = tooltipX;
      let ty = tooltipY;
      if (tx + tooltipW > width - s(10)) {
        tx = hoveredNode.x - tooltipW - s(10);
      }
      if (ty + tooltipH > height - s(10)) {
        ty = height - tooltipH - s(10);
      }

      // Tooltip background
      ctx.fillStyle = THEME.border;
      ctx.strokeStyle = hoveredNode.color;
      ctx.lineWidth = 1 * dpr * scale;
      roundRect(ctx, tx, ty, tooltipW, tooltipH, 6 * dpr * scale);
      ctx.fill();
      ctx.stroke();

      // Tooltip text
      ctx.fillStyle = THEME.text;
      ctx.font = `${11 * dpr * scale}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'left';
      lines.forEach((line, i) => {
        ctx.fillText(line, tx + s(10), ty + s(18) + i * s(16));
      });
    }

    // Draw title
    ctx.fillStyle = THEME.text;
    ctx.font = `bold ${16 * dpr * scale}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('AWSops System Architecture', width / 2, baseY);

  }, []);

  const canvasRef = useCanvas(draw, 500);

  return (
    <div style={canvasWrapperStyle}>
      <canvas ref={canvasRef} />
    </div>
  );
}
