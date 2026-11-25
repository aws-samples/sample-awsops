// Client-side "what the user is looking at" store for the AI chat (module-level, one value per tab).
// A page that renders something the AI should see (today only the site flow view) sets a bounded text rendering
// and clears it on unmount; useChat attaches it to the next request as `pageContext`, and the chat drawer
// subscribes to disclose that it is attached. The server caps, wraps and keeps it out of routing and history.
type Listener = () => void;

let current: string | null = null;
const listeners = new Set<Listener>();

/** Replace the page context (`null` or an empty string clears it). Listeners fire only on a change. */
export function setPageContext(text: string | null): void {
  const next = text ? text : null;
  if (next === current) return;
  current = next;
  for (const l of [...listeners]) l();
}

export function getPageContext(): string | null {
  return current;
}

/** useSyncExternalStore-compatible subscription; returns the unsubscribe. */
export function subscribePageContext(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
