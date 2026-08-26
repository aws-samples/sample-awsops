class FakeClient:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def call_tool_sync(self, name, arguments=None):
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
    ops = FakeClient(edges)

    assert BoundedTools({"ops": ops}).topology_edges() == edges
    assert ops.calls == [("get_topology", {})]


def test_topology_edges_tolerates_missing_ops_client():
    BoundedTools = load_bounded_tools()

    assert BoundedTools({}).topology_edges() == []


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
