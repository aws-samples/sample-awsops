"""Tests for external_slack_executor.execute (RW-slice T4). stdlib unittest; I/O injected."""
import unittest

import egress_dlp as dlp
import external_slack_executor as ex

SLACK = {"name": "slack.post_message", "target_resource_type": "external:slack"}
AWS = {"name": "ec2-create-tags", "target_resource_type": "ec2:instance"}
ALLOW = ["#ops", "#incidents"]


class SlackExecutorTest(unittest.TestCase):
    def test_refuses_non_external_action(self):
        with self.assertRaises(ex.NotExternalAction):
            ex.execute(AWS, {"channel": "#ops", "text": "hi"}, ALLOW,
                       get_secret=lambda: {"token": "t"}, http_post=lambda *a: None)

    def test_dry_run_renders_preview_without_posting(self):
        calls = []
        r = ex.execute(SLACK, {"channel": "#ops", "text": "deploy done"}, ALLOW,
                       get_secret=lambda: {"token": "t"}, http_post=lambda *a: calls.append(a), dry_run=True)
        self.assertTrue(r["dry_run"])
        self.assertFalse(r["posted"])
        self.assertEqual(r["preview"]["channel"], "#ops")
        self.assertEqual(calls, [])  # NOTHING posted on a dry-run

    def test_execute_redacts_then_posts(self):
        posted = {}
        def http_post(channel, text, token):
            posted.update(channel=channel, text=text, token=token); return {"ok": True}
        r = ex.execute(SLACK, {"channel": "#ops", "text": "leak AKIAIOSFODNN7EXAMPLE now"}, ALLOW,
                       get_secret=lambda: {"token": "xoxb-tok"}, http_post=http_post)
        self.assertTrue(r["posted"])
        self.assertNotIn("AKIAIOSFODNN7EXAMPLE", posted["text"])  # re-redacted at the final hop
        self.assertEqual(posted["token"], "xoxb-tok")

    def test_channel_not_in_allowlist_raises(self):
        with self.assertRaises(dlp.ChannelNotAllowed):
            ex.execute(SLACK, {"channel": "#random", "text": "hi"}, ALLOW,
                       get_secret=lambda: {"token": "t"}, http_post=lambda *a: None)

    def test_empty_allowlist_deny_all(self):
        with self.assertRaises(dlp.ChannelNotAllowed):
            ex.execute(SLACK, {"channel": "#ops", "text": "hi"}, [],
                       get_secret=lambda: {"token": "t"}, http_post=lambda *a: None)


if __name__ == "__main__":
    unittest.main()
