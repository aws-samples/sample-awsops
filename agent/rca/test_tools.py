import json


class FakeClient:
    def __init__(self, result):
        self.result = result
        self.calls = []
        self.tool_use_ids = []

    def call_tool_sync(self, tool_use_id, name, arguments=None):
        assert isinstance(tool_use_id, str) and tool_use_id
        self.tool_use_ids.append(tool_use_id)
        self.calls.append((name, arguments))
        return self.result


def load_bounded_tools():
    try:
        from rca.tools import BoundedTools
    except ModuleNotFoundError as exc:
        raise AssertionError("rca.tools.BoundedTools is missing") from exc
    return BoundedTools


def test_topology_edges_calls_ops_get_topology():
    BoundedTools = load_bounded_tools()
    edges = [{"source": "alb:app", "target": "ecs:web"}]
    metadata = {"selection": {"status": "resolved", "resolved_id": "alb:app"},
                "truncation": {"nodes": False, "edges": True}, "warning": "bounded graph"}
    ops = FakeClient({"edges": edges, **metadata})

    result = BoundedTools({"ops": ops}).topology_edges("alb:app")
    assert result == {"edges": edges, **metadata}
    assert ops.calls == [("get_topology", {"resource_id": "alb:app"})]


def test_topology_edges_tolerates_missing_ops_client():
    BoundedTools = load_bounded_tools()

    result = BoundedTools({}).topology_edges("ec2:x")
    assert result["edges"] == []
    assert "unavailable" in result["warning"].lower()


def test_topology_preserves_metadata_from_the_pinned_sdk_result_envelopes():
    BoundedTools = load_bounded_tools()
    body = {"edges": [{"source": "ec2:x", "target": "rds:db"}], "class": "flow",
            "selection": {"status": "resolved", "requested_id": "x", "resolved_id": "ec2:x"},
            "truncation": {"nodes": False, "edges": True},
            "collection": {"status": "partial", "stale": True}, "warning": "partial evidence"}
    for envelope in (
        {"status": "success", "structuredContent": body},
        {"status": "success", "content": [{"text": json.dumps(body)}]},
        {"status": "success", "content": [{"text": json.dumps(
            {"statusCode": 200, "body": json.dumps(body)})}]},
    ):
        ops = FakeClient(envelope)
        assert BoundedTools({"ops": ops}).topology_edges("x") == body
        assert ops.calls == [("get_topology", {"resource_id": "x"})]


def test_topology_missing_metadata_does_not_silently_certify_dependency_coverage():
    BoundedTools = load_bounded_tools()
    edges = [{"source": "ec2:x", "target": "rds:db"}]
    result = BoundedTools({"ops": FakeClient(edges)}).topology_edges("ec2:x")
    assert result["edges"] == edges
    assert "metadata" in result["warning"].lower()
    for response in (None, {"status": "error", "content": [{"text": "credential=secret"}]}):
        result = BoundedTools({"ops": FakeClient(response)}).topology_edges("ec2:x")
        assert result["edges"] == []
        assert "unavailable" in result["warning"].lower()
        assert "credential" not in json.dumps(result)


def test_tool_calls_use_distinct_sdk_correlation_ids():
    BoundedTools = load_bounded_tools()
    client = FakeClient({"edges": [], "selection": {"status": "all"},
                         "truncation": {"nodes": False, "edges": False}})
    tools = BoundedTools({"ops": client, "monitoring": client})
    tools.topology_edges("ec2:x")
    tools.gather("ec2:x")
    assert len(set(client.tool_use_ids)) == 2


def test_gather_calls_monitoring_loki_with_bounded_limit_and_returns_logs():
    BoundedTools = load_bounded_tools()
    logs = {"streams": [{"values": [["1", "line"]]}]}
    monitoring = FakeClient(logs)

    result = BoundedTools({"monitoring": monitoring}).gather("ecs:web")

    assert result == {"node": "ecs:web", "logs": logs}
    assert "logs" in result
    assert monitoring.calls[0][0] == "loki_query_range"
    args = monitoring.calls[0][1]
    assert args["limit"] <= 50
    assert "ecs:web" in args["query"]


def test_gather_escapes_node_id_for_logql_label_selector():
    BoundedTools = load_bounded_tools()
    monitoring = FakeClient({"streams": []})

    BoundedTools({"monitoring": monitoring}).gather('ecs:web"} |= "secret')

    args = monitoring.calls[0][1]
    assert args["query"] == '{entity="ecs:web\\"} |= \\"secret"}'


def test_gather_tolerates_missing_monitoring_client():
    BoundedTools = load_bounded_tools()

    assert BoundedTools({}).gather("ecs:web") == {"node": "ecs:web", "logs": []}
