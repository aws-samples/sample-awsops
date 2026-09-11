"""Tests for tempo_mcp — read-only TraceQL connector on datasource_http (seconds time, hex trace_id)."""
import json, os, sys, unittest
from unittest import mock
from urllib.parse import urlparse, parse_qs, unquote
sys.path.insert(0, os.path.dirname(__file__))
import tempo_mcp as tm  # noqa: E402
DS={"endpoint":"http://tempo:3200","token":"tok"}
def _qs(u): return parse_qs(urlparse(u).query)

class _Base(unittest.TestCase):
    def setUp(self):
        for name in ("load_datasource","assert_host_allowed"):
            p=mock.patch.object(tm,name,return_value=DS if name=="load_datasource" else None); p.start(); self.addCleanup(p.stop)

class TestSearch(_Base):
    def test_search_seconds_window_encoding(self):
        cap={}
        with mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u,h=headers) or (200,{"traces":[]}))):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":'{ .service.name="x" }'}},None)
        self.assertEqual(out["statusCode"],200)
        q=_qs(cap["url"]); self.assertIn("/api/search",cap["url"])
        self.assertEqual(q["q"][0], '{ .service.name="x" }')
        start,end=int(q["start"][0]),int(q["end"][0])
        self.assertLess(start, 10**11)  # SECONDS magnitude (not ns)
        self.assertAlmostEqual(end-start, 3600, delta=5)
    def test_no_envelope_status_still_success(self):
        # Tempo has no {status:success}; HTTP 200 with {traces:[...]} must succeed (not error)
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[{"traceID":"a1"}]})):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        self.assertEqual(out["statusCode"],200)
        self.assertEqual(len(json.loads(out["body"])["traces"]),1)
    def test_http_error(self):
        with mock.patch.object(tm,"http_json",return_value=(500,{"raw":"boom"})):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)

class TestTrace(_Base):
    def test_get_trace_hex_path(self):
        cap={}
        with mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(url=u) or (200,{"batches":[]}))):
            tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"a1B2c3"}},None)
        self.assertTrue(cap["url"].endswith("/api/traces/a1B2c3"))
    def test_non_hex_trace_id_rejected_before_request(self):
        with mock.patch.object(tm,"http_json") as hj:
            out=tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"x; rm -rf"}},None)
        self.assertEqual(out["statusCode"],400); hj.assert_not_called()

class TestTags(_Base):
    def test_tags_and_values(self):
        cap={}
        def fake(m,u,headers=None,body=None,timeout=None): cap["url"]=u; return 200,{"tagNames":["service.name"]}
        with mock.patch.object(tm,"http_json",side_effect=fake):
            tm.lambda_handler({"tool_name":"tempo_search_tags","arguments":{}},None); self.assertIn("/api/search/tags",cap["url"])
            tm.lambda_handler({"tool_name":"tempo_tag_values","arguments":{"tag":"service.name"}},None); self.assertIn("/api/search/tag/service.name/values",cap["url"])
    def test_tag_values_requires_tag(self):
        self.assertEqual(tm.lambda_handler({"tool_name":"tempo_tag_values","arguments":{}},None)["statusCode"],400)

class TestOrgId(_Base):
    def test_org_id(self):
        cap={}
        with mock.patch.object(tm,"load_datasource",return_value={**DS,"org_id":"t9"}), \
             mock.patch.object(tm,"http_json",side_effect=lambda m,u,headers=None,body=None,timeout=None:(cap.update(h=headers) or (200,{"traces":[]}))):
            tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        self.assertEqual(cap["h"]["X-Scope-OrgID"],"t9")

class TestBounding(_Base):
    def test_traces_bounded(self):
        big={"traces":[{"traceID":str(i),"spanSet":{"spans":[{"x":1}]*10}} for i in range(300)]}
        with mock.patch.object(tm,"http_json",return_value=(200,big)):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)
        body=json.loads(out["body"]); self.assertTrue(body["truncated"]); self.assertLessEqual(len(body["traces"]),tm.MAX_TRACES)
    def test_trace_bytes_bounded_multibyte(self):
        big={"batches":[{"log":"오류"*250000}]}  # ~1.5MB UTF-8 (exceeds MAX_TOTAL_BYTES)
        with mock.patch.object(tm,"http_json",return_value=(200,big)):
            out=tm.lambda_handler({"tool_name":"tempo_get_trace","arguments":{"trace_id":"ab"}},None)
        self.assertLessEqual(len(out["body"].encode("utf-8")), tm.MAX_TOTAL_BYTES*2)
        self.assertTrue(json.loads(out["body"]).get("truncated"))

class TestGuards(_Base):
    def test_not_connected(self):
        with mock.patch.object(tm,"load_datasource",side_effect=tm.NotConnected("tempo not connected")):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_ssrf(self):
        with mock.patch.object(tm,"assert_host_allowed",side_effect=tm.SsrfBlocked("endpoint blocked")):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}"}},None)["statusCode"],400)
    def test_target_account_id_popped(self):
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[]})):
            self.assertEqual(tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":"{}","target_account_id":"222222222222"}},None)["statusCode"],200)
    def test_unknown_tool(self):
        self.assertEqual(tm.lambda_handler({"tool_name":"tempo_write","arguments":{}},None)["statusCode"],400)


class TestSchema(_Base):
    def test_schema_tags(self):
        seq = [(200, {}), (404, {"raw": "not found"}),
               (200, {"tagNames": ["service.name", "http.status"]})]
        with mock.patch.object(tm,"http_json",side_effect=seq):
            out=tm.lambda_handler({"tool_name":"tempo_schema","arguments":{}},None)
        import json as _j; self.assertEqual(_j.loads(out["body"])["tags"],["service.name","http.status"])


class TestSchemaVersion(_Base):
    def test_schema_version_and_instance_id(self):
        seq=[(200,{"version":"2.4.0"}),(404,{"raw":"not found"}),(200,{"tagNames":["service.name"]})]
        with mock.patch.object(tm,"http_json",side_effect=lambda *a,**k: seq.pop(0)):
            out=tm.lambda_handler({"tool_name":"tempo_schema","arguments":{}},None)
        b=json.loads(out["body"]); self.assertEqual(b["version"],"2.4.0"); self.assertIn("service.name",b["tags"])

    def test_instance_id_credential_blind(self):
        tm.load_datasource.reset_mock()
        with mock.patch.object(tm,"http_json",return_value=(200,{"traces":[]})):
            out=tm.lambda_handler({"tool_name":"tempo_search","arguments":{"query":'{ .service.name="x" }',"instance_id":7}},None)
        self.assertEqual(out["statusCode"],200); tm.load_datasource.assert_any_call(tm.SLUG, instance_id=7)


class TestSchemaIntrospection(_Base):
    def schema(self, tags, *, values=None, legacy=None, buildinfo=None, args=None):
        """Fake only HTTP; exercise the handler, guarded _get and URL encoding."""
        calls = []
        values = values or {}

        def respond(method, url, headers=None, timeout=None):
            self.assertEqual(method, "GET")
            self.assertIsNotNone(timeout, "schema calls need a short request timeout")
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 4)
            parsed = urlparse(url)
            calls.append((unquote(parsed.path), _qs(url), headers))
            if parsed.path == "/api/status/buildinfo":
                response = buildinfo if buildinfo is not None else (200, {"version": "2.9.0"})
            elif parsed.path == "/api/v2/search/tags":
                response = tags
            elif parsed.path == "/api/search/tags":
                self.assertIsNotNone(legacy, "unexpected legacy fallback")
                response = legacy
            elif parsed.path.startswith("/api/v2/search/tag/") and parsed.path.endswith("/values"):
                identifier = unquote(parsed.path[len("/api/v2/search/tag/"):-len("/values")])
                self.assertIn(identifier, values, f"unexpected type lookup: {identifier}")
                response = values[identifier]
            else:
                self.fail(f"unexpected request: {url}")
            if isinstance(response, Exception):
                raise response
            return response

        with mock.patch.object(tm, "http_json", side_effect=respond), \
             mock.patch.object(tm.time, "time", return_value=1_710_000_000):
            out = tm.lambda_handler({"tool_name": "tempo_schema", "arguments": args or {}}, None)
        return out, json.loads(out["body"]), calls

    def test_scopes_and_observed_types_preserve_old_and_new_http_names(self):
        out, body, calls = self.schema(
            (200, {"scopes": [
                {"name": "span", "tags": [
                    "http.status_code", "http.response.status_code", "service.name", "custom",
                ]},
                {"name": "resource", "tags": ["service.name", "custom"]},
            ], "metrics": {"inspectedBytes": "1234"}}),
            values={
                "span.http.status_code": (200, {"tagValues": [
                    {"type": "int", "value": "503"},
                    {"type": "string", "value": "502"},
                    {"type": "int", "value": "504"},
                ]}),
                "span.http.response.status_code": (200, {"tagValues": [
                    {"type": "int", "value": "200"},
                ]}),
                "resource.service.name": (200, {"tagValues": [
                    {"type": "string", "value": "private-resource-name"},
                ]}),
                "span.service.name": (200, {"tagValues": [
                    {"type": "string", "value": "private-span-name"},
                ]}),
            },
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["version"], "2.9.0")
        self.assertEqual(body["tags"], [
            "http.status_code", "http.response.status_code", "service.name", "custom",
        ])
        self.assertEqual(body["attributes"], [
            {"name": "span.http.status_code", "types": ["int", "string"]},
            {"name": "span.http.response.status_code", "types": ["int"]},
            {"name": "span.service.name", "types": ["string"]},
            {"name": "span.custom"},
            {"name": "resource.service.name", "types": ["string"]},
            {"name": "resource.custom"},
        ])
        self.assertFalse(body["truncated"])
        self.assertEqual(len(calls), 6)
        for sample in ("private-resource-name", "private-span-name", "503", "502", "504", "200"):
            self.assertNotIn(sample, out["body"])
        self.assertNotIn("value", out["body"])

    def test_many_tags_still_use_at_most_four_bounded_type_requests(self):
        important = ["http.status_code", "http.response.status_code", "service.name"]
        names = important + [f"custom.{i}" for i in range(150)]
        out, body, calls = self.schema(
            (200, {"scopes": [
                {"name": "span", "tags": names},
                {"name": "resource", "tags": ["service.name"]},
            ]}),
            values={name: (200, {"tagValues": []}) for name in (
                "span.http.status_code", "span.http.response.status_code",
                "span.service.name", "resource.service.name",
            )},
            args={"start": "0", "end": "9999999999", "limit": 100000},
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(len(body["attributes"]), 154)
        self.assertLessEqual(len(calls), 6)
        for path, params, headers in calls[1:]:
            self.assertEqual(params["start"], ["1709996400"])
            self.assertEqual(params["end"], ["1710000000"])
            self.assertEqual(headers["Authorization"], "Bearer tok")
            self.assertGreater(int(params["limit"][0]), 0)
            self.assertLessEqual(int(params["limit"][0]), 32 if path.endswith("/values") else 201)
            self.assertGreater(int(params["maxStaleValues"][0]), 0)
            self.assertLessEqual(int(params["maxStaleValues"][0]), 200)

    def test_no_type_inference_from_numeric_strings_or_unknown_types(self):
        out, body, _ = self.schema(
            (200, {"scopes": [{"name": "span", "tags": [
                "http.status_code", "http.response.status_code", "custom",
            ]}]}),
            values={
                "span.http.status_code": (200, {"tagValues": [
                    {"type": "string", "value": "503"},
                    {"type": "unknown", "value": 503},
                    {"value": 503},
                    {"type": ["int"], "value": "503"},
                    None, "503",
                ]}),
                "span.http.response.status_code": (200, {"tagValues": [
                    {"value": 200}, {"type": "unknown", "value": "200"},
                ]}),
            },
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [
            {"name": "span.http.status_code", "types": ["string"]},
            {"name": "span.http.response.status_code"},
            {"name": "span.custom"},
        ])

    def test_unsupported_v2_falls_back_without_inventing_legacy_scopes(self):
        for status in (404, 405, 501):
            with self.subTest(status=status):
                out, body, calls = self.schema(
                    (status, {"raw": "unsupported"}),
                    legacy=(200, {"tagNames": [
                        "service.name", "http.status_code", "http.response.status_code", "foo",
                    ]}),
                    buildinfo=(404, {"raw": "unavailable"}),
                )
                self.assertEqual(out["statusCode"], 200)
                self.assertEqual(body["attributes"], [
                    {"name": ".service.name"}, {"name": ".http.status_code"},
                    {"name": ".http.response.status_code"}, {"name": ".foo"},
                ])
                self.assertIsNone(body["version"])
                self.assertFalse(body["truncated"])
                self.assertEqual(len(calls), 3)
                self.assertIn("start", calls[-1][1])
                self.assertIn("end", calls[-1][1])

    def test_auth_and_server_errors_do_not_trigger_legacy_fallback(self):
        for status in (401, 403, 429, 500):
            with self.subTest(status=status):
                out, body, calls = self.schema((status, {"raw": "denied"}))
                self.assertEqual(out["statusCode"], 400)
                self.assertIn(f"Tempo HTTP {status}", body["error"])
                self.assertEqual(len(calls), 2)

    def test_type_endpoint_errors_leave_names_available_without_types(self):
        for response in (
            (404, {"raw": "unsupported"}), (501, {"raw": "unsupported"}),
            (500, {"raw": "unavailable"}), TimeoutError("timed out"),
        ):
            with self.subTest(response=response):
                out, body, _ = self.schema(
                    (200, {"scopes": [{"name": "span", "tags": ["http.status_code"]}]}),
                    values={"span.http.status_code": response},
                )
                self.assertEqual(out["statusCode"], 200)
                self.assertEqual(body["attributes"], [{"name": "span.http.status_code"}])
                self.assertNotIn("value", out["body"])

    def test_type_lookup_failure_does_not_discard_other_observed_types(self):
        out, body, _ = self.schema(
            (200, {"scopes": [{"name": "span", "tags": [
                "http.status_code", "http.response.status_code",
            ]}]}),
            values={
                "span.http.status_code": (500, {"raw": "unavailable"}),
                "span.http.response.status_code": (200, {"tagValues": [{"type": "int", "value": "200"}]}),
            },
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [
            {"name": "span.http.status_code"}, {"name": "span.http.response.status_code", "types": ["int"]},
        ])

    def test_quoted_identifiers_preserve_unusual_raw_attribute_names(self):
        raw = ["http.header with spaces", 'a"b', r"path\key", "고객.이름", "route/name"]
        expected = [
            'span."http.header with spaces"', 'span."a\\"b"', 'span."path\\\\key"',
            'span."고객.이름"', 'span."route/name"',
        ]
        out, body, _ = self.schema((200, {"scopes": [{"name": "span", "tags": raw}]}))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["tags"], raw)
        self.assertEqual([a["name"] for a in body["attributes"]], expected)
        self.assertFalse(body["truncated"])

    def test_legacy_unusual_names_get_unscoped_quoted_identifiers(self):
        out, body, _ = self.schema(
            (404, {"raw": "unsupported"}),
            legacy=(200, {"tagNames": ["name with spaces", "resource.service.name"]}),
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [
            {"name": '."name with spaces"'}, {"name": '."resource.service.name"'},
        ])

    def test_scope_like_raw_keys_are_quoted_instead_of_reinterpreted(self):
        out, body, _ = self.schema((200, {"scopes": [{"name": "span", "tags": [
            "resource.service.name", "span.foo", "event", "instrumentation.foo", "parent.foo",
        ]}]}))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [
            {"name": 'span."resource.service.name"'}, {"name": 'span."span.foo"'},
            {"name": 'span."event"'}, {"name": 'span."instrumentation.foo"'},
            {"name": 'span."parent.foo"'},
        ])

    def test_other_scopes_and_intrinsics_remain_valid_identifiers(self):
        out, body, _ = self.schema((200, {"scopes": [
            {"name": "event", "tags": ["exception.type"]},
            {"name": "link", "tags": ["link_type"]},
            {"name": "instrumentation", "tags": ["language"]},
            {"name": "intrinsic", "tags": ["duration", "span:status", "trace:rootService"]},
        ]}))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [
            {"name": "event.exception.type"}, {"name": "link.link_type"},
            {"name": "instrumentation.language"}, {"name": "duration"},
            {"name": "span:status"}, {"name": "trace:rootService"},
        ])
        self.assertFalse(body["truncated"])

    def test_malformed_entries_are_skipped_and_duplicates_coalesced(self):
        out, body, _ = self.schema((200, {"scopes": [
            None, "bad", {"name": "span", "tags": "bad"}, {"tags": ["lost"]},
            {"name": [], "tags": ["lost"]}, {"name": "unsupported", "tags": ["lost"]},
            {"name": "span", "tags": ["foo", "foo", None, 3, {}, "", "bad\nname", "\ud800"]},
            {"name": "resource", "tags": ["foo"]},
            {"name": "intrinsic", "tags": ["not an intrinsic", "duration"]},
        ]}))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["tags"], ["foo", "duration"])
        self.assertEqual(body["attributes"], [
            {"name": "span.foo"}, {"name": "resource.foo"}, {"name": "duration"},
        ])
        self.assertTrue(body["truncated"])

    def test_malformed_top_level_payload_does_not_crash_or_fabricate_attributes(self):
        for payload in (
            [], None, {"scopes": "bad"}, {"scopes": None}, {"raw": "not JSON"},
            {"tagNames": ["foo"]},
        ):
            with self.subTest(payload=payload):
                out, body, _ = self.schema((200, payload))
                self.assertEqual(out["statusCode"], 200)
                self.assertEqual(body["tags"], [])
                self.assertEqual(body["attributes"], [])
                self.assertTrue(body["truncated"])

    def test_timeout_fetching_optional_version_still_returns_schema(self):
        out, body, _ = self.schema(
            (200, {"scopes": [{"name": "span", "tags": ["foo"]}]}),
            buildinfo=TimeoutError("timed out"),
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertIsNone(body["version"])
        self.assertEqual(body["attributes"], [{"name": "span.foo"}])

    def test_empty_protobuf_payload_is_an_empty_schema(self):
        out, body, calls = self.schema((200, {}))
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [])
        self.assertFalse(body["truncated"])
        self.assertEqual(len(calls), 2)

    def test_malformed_values_or_buildinfo_do_not_erase_valid_names(self):
        for payload in ([], None, {"tagValues": "bad"}, {"tagValues": [None, 1, "200"]}):
            with self.subTest(payload=payload):
                out, body, _ = self.schema(
                    (200, {"scopes": [{"name": "span", "tags": ["http.status_code"]}]}),
                    values={"span.http.status_code": (200, payload)},
                    buildinfo=(200, {"version": {"malformed": True}}),
                )
                self.assertEqual(out["statusCode"], 200)
                self.assertIsNone(body["version"])
                self.assertEqual(body["attributes"], [{"name": "span.http.status_code"}])

    def test_tag_limit_applies_across_scopes_and_legacy_results(self):
        cases = [
            ((200, {"scopes": [{"name": "span", "tags": [f"tag{i}" for i in range(201)]}]}), None),
            ((200, {"scopes": [
                {"name": "span", "tags": [f"tag{i}" for i in range(150)]},
                {"name": "resource", "tags": [f"tag{i}" for i in range(150)]},
            ]}), None),
            ((404, {"raw": "unsupported"}), (200, {"tagNames": [f"tag{i}" for i in range(201)]})),
        ]
        for tags, legacy in cases:
            with self.subTest(legacy=legacy is not None):
                out, body, _ = self.schema(tags, legacy=legacy)
                self.assertEqual(out["statusCode"], 200)
                self.assertEqual(len(body["attributes"]), 200)
                self.assertLessEqual(len(body["tags"]), 200)
                self.assertTrue(body["truncated"])

    def test_type_candidates_survive_full_earlier_scopes(self):
        candidates = {
            "span.http.status_code": "int", "span.http.response.status_code": "int",
            "resource.service.name": "string", "span.service.name": "string",
        }
        out, body, calls = self.schema(
            (200, {"scopes": [
                {"name": "resource", "tags": [f"custom{i}" for i in range(200)] + ["service.name"]},
                {"name": "span", "tags": ["http.status_code", "http.response.status_code", "service.name"]},
            ]}),
            values={name: (200, {"tagValues": [{"type": kind, "value": "private"}]})
                    for name, kind in candidates.items()},
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(len(body["attributes"]), 200)
        by_name = {attribute["name"]: attribute for attribute in body["attributes"]}
        for name, kind in candidates.items():
            self.assertEqual(by_name[name]["types"], [kind])
        self.assertTrue(body["truncated"])
        self.assertEqual(len(calls), 6)
        self.assertNotIn("private", out["body"])

    def test_schema_response_has_utf8_byte_cap_without_trace_preview(self):
        names = [f"tag{i}" + "오" * 200 for i in range(200)]
        out, body, _ = self.schema((200, {"scopes": [{"name": "span", "tags": names}]}))
        self.assertEqual(out["statusCode"], 200)
        self.assertLessEqual(len(out["body"].encode("utf-8")), 64_000)
        self.assertGreater(len(body["attributes"]), 0)
        self.assertTrue(body["truncated"])
        self.assertNotIn("preview", body)
        self.assertEqual(len(body["tags"]), len(body["attributes"]))

    def test_oversized_and_malformed_legacy_tags_cannot_swamp_schema(self):
        out, body, _ = self.schema(
            (404, {"raw": "unsupported"}),
            legacy=(200, {"tagNames": ["good", None, {}, "x" * 100_000, "other"]}),
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["tags"], ["good", "other"])
        self.assertEqual(body["attributes"], [{"name": ".good"}, {"name": ".other"}])
        self.assertTrue(body["truncated"])

    def test_values_above_limit_are_not_used_as_type_evidence(self):
        out, body, _ = self.schema(
            (200, {"scopes": [{"name": "span", "tags": ["http.status_code"]}]}),
            values={"span.http.status_code": (200, {"tagValues": (
                [{"type": "string", "value": "503"}] * 32 + [{"type": "int", "value": "503"}]
            )})},
        )
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(body["attributes"], [{"name": "span.http.status_code", "types": ["string"]}])
        self.assertTrue(body["truncated"])

    def test_schema_remains_behind_existing_ssrf_guard(self):
        with mock.patch.object(tm, "assert_host_allowed", side_effect=tm.SsrfBlocked("blocked")), \
             mock.patch.object(tm, "http_json") as http:
            out = tm.lambda_handler({"tool_name": "tempo_schema", "arguments": {}}, None)
        self.assertEqual(out["statusCode"], 400)
        http.assert_not_called()


if __name__=="__main__": unittest.main()
