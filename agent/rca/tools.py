import json
from uuid import uuid4


LOG_LIMIT = 50


def _call(client, name, args):
    return client.call_tool_sync(tool_use_id=uuid4().hex, name=name, arguments=args)


def _topology_payload(value, depth=0):
    """Accept the pinned MCP SDK envelope or the older direct graph response."""
    if depth > 4:
        return None
    if isinstance(value, str):
        try:
            return _topology_payload(json.loads(value), depth + 1)
        except (ValueError, TypeError):
            return None
    if isinstance(value, list):
        value = {"edges": value}
    if not isinstance(value, dict) or value.get("status") == "error" or value.get("isError"):
        return None
    if "statusCode" in value:
        return _topology_payload(value.get("body"), depth + 1) if value["statusCode"] == 200 else None
    if isinstance(value.get("edges"), list):
        if not all(isinstance(edge, dict) and isinstance(edge.get("source"), str)
                   and isinstance(edge.get("target"), str) for edge in value["edges"]):
            return None
        return {key: value[key] for key in ("edges", "class", "selection", "truncation",
                "collection", "warning", "node_count", "edge_count") if key in value}
    if "structuredContent" in value:
        result = _topology_payload(value["structuredContent"], depth + 1)
        if result is not None:
            return result
    for item in value.get("content", []) if isinstance(value.get("content"), list) else []:
        if isinstance(item, dict):
            result = _topology_payload(item.get("json", item.get("text")), depth + 1)
            if result is not None:
                return result
    return None


def _escape_logql_label_value(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


class BoundedTools:
    def __init__(self, clients: dict):
        self.clients = clients

    def topology_edges(self, failing_entity):
        client = self.clients.get("ops")
        result = _topology_payload(_call(client, "get_topology", {"resource_id": failing_entity})) if client else None
        if result is None:
            return {"edges": [], "warning": "Topology read is unavailable; dependency coverage is unknown."}
        if not isinstance(result.get("selection"), dict) or not isinstance(result.get("truncation"), dict):
            result["warning"] = " ".join(filter(None, [
                result.get("warning"), "Topology coverage metadata is unavailable.",
            ]))
        return result

    def gather(self, node_id):
        client = self.clients.get("monitoring")
        if client is None:
            return {"node": node_id, "logs": []}

        logs = _call(
            client,
            "loki_query_range",
            {"query": f'{{entity="{_escape_logql_label_value(node_id)}"}}', "limit": LOG_LIMIT},
        )
        return {"node": node_id, "logs": logs}
