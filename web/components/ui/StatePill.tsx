import Badge, { type BadgeTone } from './Badge';

/**
 * StatePill — maps a resource state string to a Badge tone (soft + dot).
 *   running / Running / available / active            → positive
 *   stopped / stopping / terminated / inactive         → neutral
 *   Pending / pending / creating / modifying           → brand
 *   CrashLoopBackOff / Failed / error / unhealthy      → negative
 * Unknown states fall back to neutral.
 */
function toneFor(value: string): BadgeTone {
  const v = value.trim().toLowerCase();
  if (['crashloopbackoff', 'failed', 'error', 'unhealthy', 'imagepullbackoff', 'oomkilled'].includes(v)) {
    return 'negative';
  }
  if (['running', 'available', 'active', 'healthy', 'succeeded', 'ready'].includes(v)) {
    return 'positive';
  }
  if (['pending', 'creating', 'modifying', 'provisioning', 'queued', 'starting'].includes(v)) {
    return 'brand';
  }
  return 'neutral';
}

export default function StatePill({ value }: { value: string }) {
  const tone = toneFor(value);
  return (
    <Badge tone={tone} variant="soft" dot>
      {value}
    </Badge>
  );
}
