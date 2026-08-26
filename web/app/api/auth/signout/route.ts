export const dynamic = 'force-dynamic';

// Sign-out is intentionally NOT auth-gated: an expired/invalid token must still be able to
// log out. HttpOnly cookies can only be cleared server-side, so we expire awsops_token here and
// return { redirect: '/login' } so the client lands on the in-app login form. There is no Cognito
// hosted-UI /logout round-trip anymore — the v2 self-hosted /login form has no hosted-UI browser
// session to break (the hosted-UI code flow survives only as a dark fallback). The edge must let
// this path through public (cognito_edge.py.tftpl is_public) — otherwise an expired token traps the
// user in a 302→login loop and they can never reach the signout route to clear the stale cookie.
export async function POST() {
  return new Response(JSON.stringify({ redirect: '/login' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'awsops_token=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    },
  });
}
