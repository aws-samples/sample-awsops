// Client-side "what the user is looking at" store for the AI chat (module-level, one value per tab).
// A page that renders something the AI should see (today only the site flow view) sets a bounded text rendering
// under its own owner token and clears it on unmount with clearPageContext(owner), which removes the value only if
// that owner still holds it (a newer producer's value survives an older producer's unmount). useChat attaches the
// value to the next request as `pageContext`, and the chat drawer subscribes to disclose that it is attached. The
// server caps, wraps and keeps it out of routing and history.
type Listener = () => void;
export type PageContextOwner = symbol;

let current: string | null = null;
let owner: PageContextOwner | null = null;
const listeners = new Set<Listener>();

/** A fresh owner token for one producer (e.g. one mounted view). */
export function createPageContextOwner(): PageContextOwner {
  return Symbol('page-context-owner');
}

/** Replace the page context (`null` or an empty string clears it) and make `by` (minted when omitted) its owner.
 *  Ownership moves even when the text is unchanged; listeners fire only on a value change. Returns the owner. */
export function setPageContext(text: string | null, by: PageContextOwner = createPageContextOwner()): PageContextOwner {
  const next = text ? text : null;
  owner = by;
  if (next === current) return by;
  current = next;
  for (const l of [...listeners]) l();
  return by;
}

/** Clear-if-mine: removes the value only while `by` still owns it. */
export function clearPageContext(by: PageContextOwner): void {
  if (owner === by) setPageContext(null, by);
}

export function getPageContext(): string | null {
  return current;
}

/** useSyncExternalStore-compatible subscription; returns the unsubscribe. */
export function subscribePageContext(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
