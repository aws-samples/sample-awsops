LOG_LIMIT = 50


def _call(client, name, args):
    return client.call_tool_sync(name, arguments=args)


def _escape_logql_label_value(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


class BoundedTools:
    def __init__(self, clients: dict):
        self.clients = clients

    def topology_edges(self):
        client = self.clients.get("ops")
        if client is None:
            return []

        result = _call(client, "get_topology", {})
        if result is None:
            return []
        if isinstance(result, dict) and "edges" in result:
            return result.get("edges") or []
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
