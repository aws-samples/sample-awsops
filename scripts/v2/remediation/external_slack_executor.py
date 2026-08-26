"""external_slack_executor.py — ADR-040/041 governed external Slack-write executor (RW-slice T4).

A DATA-write (NOT an AWS-resource mutation). The model only PROPOSED the inputs; a human already
plan->approved (4-eyes) via /api/actions. This executor is the LAST hop: it RE-applies DLP redaction +
the channel allowlist (never trusts the web layer), REFUSES any non-`external:` action (defense-in-depth
against a mis-routed AWS-resource action), and supports a dry-run that renders the preview WITHOUT
posting. The Slack token is fetched from Secrets Manager and the HTTP post is performed by injected
callables (so the pure governance logic is unit-tested without network/AWS).
"""
import egress_dlp


class NotExternalAction(Exception):
    """Raised if a non-external: action reaches this executor (must never happen — gate + prefix split)."""


def execute(action, inputs, allowlist, *, get_secret, http_post, dry_run=False):
    """Run (or dry-run) a governed Slack post.

    action     : the action_catalog row dict (must have target_resource_type startsWith 'external:').
    inputs     : {channel, text, ...} proposed inputs.
    allowlist  : list of allowed channels (the integration's source_allowlist).
    get_secret : injected () -> dict|str  (the Slack token from Secrets Manager).
    http_post  : injected (channel, text, token) -> response.
    Returns a result dict; raises NotExternalAction / egress_dlp.ChannelNotAllowed on a violation.
    """
    if not (action.get("target_resource_type") or "").startswith("external:"):
        raise NotExternalAction("executor refuses non-external action: %s" % action.get("name"))

    # Re-redact at the final hop (never trust upstream). The destination (channel) allowlist is a
    # SEND-time control — a dry-run is a preview that egresses nothing, so it only renders the redacted
    # content for the human 4-eyes review; the allowlist is re-asserted before the actual post.
    red, redactions = egress_dlp.redact_egress(inputs)
    channel = red.get("channel")
    text = red.get("text")

    if dry_run:
        return {"dry_run": True, "posted": False, "preview": {"channel": channel, "text": text}, "redactions": redactions}

    egress_dlp.assert_channel_allowed(channel, allowlist)
    secret = get_secret()
    token = secret.get("token") if isinstance(secret, dict) else secret
    if not token:
        raise ValueError("slack executor: no token in secret")
    resp = http_post(channel, text, token)
    return {"dry_run": False, "posted": True, "redactions": redactions, "response": resp}
