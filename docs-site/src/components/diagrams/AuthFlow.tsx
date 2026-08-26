import React, { useCallback } from 'react';
import { useCanvas, THEME, roundRect, isHover, canvasWrapperStyle, DrawContext } from './useCanvas';

interface Actor {
  id: string;
  label: string;
  color: string;
  x: number;
}

interface FlowStep {
  from: number;
  to: number;
  label: string;
  sublabel?: string;
}

const ACTORS: Omit<Actor, 'x'>[] = [
  { id: 'browser', label: 'Browser', color: THEME.cyan },
  { id: 'cloudfront', label: 'CloudFront', color: THEME.orange },
  { id: 'lambda', label: 'Lambda@Edge', color: THEME.purple },
  { id: 'cognito', label: 'Cognito', color: THEME.green },
  { id: 'alb', label: 'ALB / EC2', color: THEME.red },
];

const FIRST_VISIT_STEPS: FlowStep[] = [
  { from: 0, to: 1, label: 'GET /awsops', sublabel: '1. Request' },
  { from: 1, to: 2, label: 'viewer-request', sublabel: '2. Trigger' },
  { from: 2, to: 2, label: 'No cookie', sublabel: '3. Check' },
  { from: 2, to: 0, label: '302 Redirect', sublabel: '4. To Cognito' },
  { from: 0, to: 3, label: 'Login page', sublabel: '5. Auth UI' },
  { from: 3, to: 0, label: '302 + code', sublabel: '6. Auth code' },
  { from: 0, to: 2, label: '/callback?code=', sublabel: '7. Callback' },
  { from: 2, to: 3, label: 'Token exchange', sublabel: '8. OAuth2' },
  { from: 2, to: 0, label: 'Set-Cookie', sublabel: '9. JWT (1hr)' },
  { from: 0, to: 4, label: 'Authenticated', sublabel: '10. Access' },
];

const RETURN_VISIT_STEPS: FlowStep[] = [
  { from: 0, to: 2, label: 'Valid JWT', sublabel: '1. Cookie' },
  { from: 2, to: 2, label: 'JWT verify OK', sublabel: '2. Validate' },
  { from: 2, to: 4, label: 'Forward', sublabel: '3. Pass through' },
];

const CANVAS_HEIGHT = 450;
const ACTOR_BOX_W = 90;
const ACTOR_BOX_H = 50;
const ACTOR_Y = 30;
const LANE_TOP = ACTOR_Y + ACTOR_BOX_H + 20;
const LANE_BOTTOM = 320;
const INFO_BOX_Y = 350;

const STEP_DURATION = 90; // frames per step
const PAUSE_DURATION = 60; // frames between flows

export default function AuthFlow() {
  const draw = useCallback((dc: DrawContext) => {
    const { ctx, width, height, frame, mouse, dpr } = dc;

    // Calculate actor positions based on width
    const padding = 40 * dpr;
    const usableWidth = width - padding * 2;
    const actorSpacing = usableWidth / (ACTORS.length - 1);

    const actors: Actor[] = ACTORS.map((a, i) => ({
      ...a,
      x: padding + i * actorSpacing,
    }));

    // Background
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, width, height);

    // Scale for DPR
    const s = dpr;

    // Draw title
    ctx.font = `bold ${16 * s}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = THEME.text;
    ctx.textAlign = 'center';
    ctx.fillText('Cognito Authentication Flow', width / 2, 20 * s);

    // Calculate current flow phase and step
    const firstVisitTotal = FIRST_VISIT_STEPS.length * STEP_DURATION;
    const returnVisitTotal = RETURN_VISIT_STEPS.length * STEP_DURATION;
    const cycleLength = firstVisitTotal + PAUSE_DURATION + returnVisitTotal + PAUSE_DURATION;
    const cycleFrame = frame % cycleLength;

    let currentSteps: FlowStep[];
    let currentStepIndex: number;
    let stepProgress: number;
    let flowLabel: string;
    let inPause = false;

    if (cycleFrame < firstVisitTotal) {
      // First visit flow
      currentSteps = FIRST_VISIT_STEPS;
      currentStepIndex = Math.floor(cycleFrame / STEP_DURATION);
      stepProgress = (cycleFrame % STEP_DURATION) / STEP_DURATION;
      flowLabel = 'First Visit (No Cookie)';
    } else if (cycleFrame < firstVisitTotal + PAUSE_DURATION) {
      // Pause after first visit
      currentSteps = FIRST_VISIT_STEPS;
      currentStepIndex = FIRST_VISIT_STEPS.length - 1;
      stepProgress = 1;
      flowLabel = 'First Visit (Complete)';
      inPause = true;
    } else if (cycleFrame < firstVisitTotal + PAUSE_DURATION + returnVisitTotal) {
      // Return visit flow
      const returnFrame = cycleFrame - firstVisitTotal - PAUSE_DURATION;
      currentSteps = RETURN_VISIT_STEPS;
      currentStepIndex = Math.floor(returnFrame / STEP_DURATION);
      stepProgress = (returnFrame % STEP_DURATION) / STEP_DURATION;
      flowLabel = 'Return Visit (Valid Cookie)';
    } else {
      // Pause after return visit
      currentSteps = RETURN_VISIT_STEPS;
      currentStepIndex = RETURN_VISIT_STEPS.length - 1;
      stepProgress = 1;
      flowLabel = 'Return Visit (Complete)';
      inPause = true;
    }

    // Draw flow label
    ctx.font = `${12 * s}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = THEME.cyan;
    ctx.textAlign = 'left';
    ctx.fillText(flowLabel, padding, ACTOR_Y * s - 5 * s);

    // Draw actor boxes and vertical lanes
    actors.forEach((actor, i) => {
      const boxX = actor.x - (ACTOR_BOX_W * s) / 2;
      const boxY = ACTOR_Y * s;
      const boxW = ACTOR_BOX_W * s;
      const boxH = ACTOR_BOX_H * s;

      // Check hover
      const hovered = isHover(mouse.x, mouse.y, boxX, boxY, boxW, boxH);

      // Actor box
      roundRect(ctx, boxX, boxY, boxW, boxH, 8 * s);
      ctx.fillStyle = hovered ? actor.color + '40' : THEME.card;
      ctx.fill();
      ctx.strokeStyle = hovered ? actor.color : THEME.border;
      ctx.lineWidth = hovered ? 2 * s : 1 * s;
      ctx.stroke();

      // Actor label
      ctx.font = `bold ${11 * s}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = hovered ? actor.color : THEME.text;
      ctx.textAlign = 'center';
      ctx.fillText(actor.label, actor.x, boxY + boxH / 2 + 4 * s);

      // Vertical lane line (dashed)
      ctx.beginPath();
      ctx.setLineDash([4 * s, 4 * s]);
      ctx.moveTo(actor.x, LANE_TOP * s);
      ctx.lineTo(actor.x, LANE_BOTTOM * s);
      ctx.strokeStyle = THEME.dim;
      ctx.lineWidth = 1 * s;
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Draw completed steps (dimmed)
    for (let i = 0; i < currentStepIndex; i++) {
      drawStep(ctx, actors, currentSteps[i], i, s, 0.3, 1);
    }

    // Draw current step (highlighted with animation)
    if (currentStepIndex < currentSteps.length) {
      drawStep(ctx, actors, currentSteps[currentStepIndex], currentStepIndex, s, 1, stepProgress);

      // Draw animated particle
      if (!inPause) {
        drawParticle(ctx, actors, currentSteps[currentStepIndex], s, stepProgress);
      }
    }

    // Draw info card
    drawInfoCard(ctx, width, s, mouse);
  }, []);

  const canvasRef = useCanvas(draw, CANVAS_HEIGHT);

  return (
    <div style={canvasWrapperStyle}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function drawStep(
  ctx: CanvasRenderingContext2D,
  actors: Actor[],
  step: FlowStep,
  stepIndex: number,
  s: number,
  opacity: number,
  progress: number
) {
  const fromActor = actors[step.from];
  const toActor = actors[step.to];

  const yOffset = LANE_TOP + 25 + stepIndex * 22;
  const y = yOffset * s;

  // Self-referencing step (check/validation)
  if (step.from === step.to) {
    const x = fromActor.x;
    const loopRadius = 15 * s;

    ctx.beginPath();
    ctx.arc(x + loopRadius, y, loopRadius, Math.PI, Math.PI * 2 * progress + Math.PI);
    ctx.strokeStyle = `rgba(168, 85, 247, ${opacity})`; // purple
    ctx.lineWidth = 2 * s;
    ctx.stroke();

    // Arrow head at end
    if (progress > 0.9) {
      const arrowX = x + loopRadius * (1 - Math.cos(Math.PI * 2 * progress));
      const arrowY = y - loopRadius * Math.sin(Math.PI * 2 * progress);
      drawArrowHead(ctx, arrowX, arrowY, Math.PI / 2, s, `rgba(168, 85, 247, ${opacity})`);
    }

    // Label
    ctx.font = `${10 * s}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(226, 232, 240, ${opacity})`;
    ctx.textAlign = 'left';
    ctx.fillText(step.label, x + loopRadius * 2 + 8 * s, y + 4 * s);

    return;
  }

  const startX = fromActor.x;
  const endX = toActor.x;
  const direction = endX > startX ? 1 : -1;

  // Determine arrow color based on direction
  const color = direction > 0 ? THEME.cyan : THEME.green;

  // Draw arrow line (animated based on progress)
  const currentEndX = startX + (endX - startX) * progress;

  ctx.beginPath();
  ctx.moveTo(startX, y);
  ctx.lineTo(currentEndX, y);
  ctx.strokeStyle = `rgba(${hexToRgb(color)}, ${opacity})`;
  ctx.lineWidth = 2 * s;
  ctx.stroke();

  // Arrow head
  if (progress > 0.8) {
    drawArrowHead(ctx, currentEndX, y, direction > 0 ? 0 : Math.PI, s, `rgba(${hexToRgb(color)}, ${opacity})`);
  }

  // Label above the arrow
  if (progress > 0.3) {
    const labelX = (startX + endX) / 2;
    ctx.font = `${10 * s}px Inter, system-ui, sans-serif`;
    ctx.fillStyle = `rgba(226, 232, 240, ${opacity * Math.min(1, (progress - 0.3) / 0.3)})`;
    ctx.textAlign = 'center';
    ctx.fillText(step.label, labelX, y - 6 * s);

    // Sublabel (step number)
    if (step.sublabel) {
      ctx.font = `${9 * s}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = `rgba(100, 116, 139, ${opacity * Math.min(1, (progress - 0.3) / 0.3)})`;
      ctx.fillText(step.sublabel, labelX, y + 12 * s);
    }
  }
}

function drawParticle(
  ctx: CanvasRenderingContext2D,
  actors: Actor[],
  step: FlowStep,
  s: number,
  progress: number
) {
  const fromActor = actors[step.from];
  const toActor = actors[step.to];

  // Self-referencing - particle moves in arc
  if (step.from === step.to) {
    const x = fromActor.x;
    const stepIndex = FIRST_VISIT_STEPS.indexOf(step);
    const idx = stepIndex >= 0 ? stepIndex : RETURN_VISIT_STEPS.indexOf(step);
    const yOffset = LANE_TOP + 25 + idx * 22;
    const y = yOffset * s;
    const loopRadius = 15 * s;

    const angle = Math.PI + Math.PI * 2 * progress;
    const particleX = x + loopRadius + loopRadius * Math.cos(angle);
    const particleY = y + loopRadius * Math.sin(angle);

    drawGlowingParticle(ctx, particleX, particleY, s, THEME.purple);
    return;
  }

  const stepIndex = FIRST_VISIT_STEPS.indexOf(step);
  const idx = stepIndex >= 0 ? stepIndex : RETURN_VISIT_STEPS.indexOf(step);
  const yOffset = LANE_TOP + 25 + idx * 22;
  const y = yOffset * s;

  const startX = fromActor.x;
  const endX = toActor.x;
  const particleX = startX + (endX - startX) * progress;

  const color = endX > startX ? THEME.cyan : THEME.green;
  drawGlowingParticle(ctx, particleX, y, s, color);
}

function drawGlowingParticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  color: string
) {
  // Outer glow
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, 12 * s);
  gradient.addColorStop(0, color + 'cc');
  gradient.addColorStop(0.5, color + '44');
  gradient.addColorStop(1, color + '00');

  ctx.beginPath();
  ctx.arc(x, y, 12 * s, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Inner particle
  ctx.beginPath();
  ctx.arc(x, y, 4 * s, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  s: number,
  color: string
) {
  const size = 8 * s;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size / 2);
  ctx.lineTo(-size, size / 2);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawInfoCard(
  ctx: CanvasRenderingContext2D,
  width: number,
  s: number,
  mouse: { x: number; y: number }
) {
  const cardX = 20 * s;
  const cardY = INFO_BOX_Y * s;
  const cardW = width - 40 * s;
  const cardH = 85 * s;

  const hovered = isHover(mouse.x, mouse.y, cardX, cardY, cardW, cardH);

  // Card background
  roundRect(ctx, cardX, cardY, cardW, cardH, 8 * s);
  ctx.fillStyle = hovered ? THEME.card + 'ee' : THEME.card + 'aa';
  ctx.fill();
  ctx.strokeStyle = hovered ? THEME.cyan : THEME.border;
  ctx.lineWidth = 1 * s;
  ctx.stroke();

  // Title
  ctx.font = `bold ${11 * s}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = THEME.cyan;
  ctx.textAlign = 'left';
  ctx.fillText('Cognito Configuration', cardX + 12 * s, cardY + 18 * s);

  // Info items
  const items = [
    ['User Pool', 'awsops-user-pool (self-signup disabled)'],
    ['Password', '8+ chars, upper/lower/digits required'],
    ['OAuth', 'authorization_code grant, 1hr token validity'],
    ['Cookie', 'HttpOnly (server-side deletion via POST /api/auth)'],
  ];

  ctx.font = `${10 * s}px Inter, system-ui, sans-serif`;

  const colWidth = (cardW - 24 * s) / 2;
  items.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = cardX + 12 * s + col * colWidth;
    const y = cardY + 36 * s + row * 18 * s;

    ctx.fillStyle = THEME.muted;
    ctx.textAlign = 'left';
    ctx.fillText(item[0] + ':', x, y);

    ctx.fillStyle = THEME.text;
    ctx.fillText(item[1], x + 70 * s, y);
  });
}

function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return '255, 255, 255';
  return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
}
