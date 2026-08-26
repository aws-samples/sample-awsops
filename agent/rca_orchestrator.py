import os
from contextlib import ExitStack

from rca.tools import BoundedTools
from rca.controller import run_rca
from rca.reasoning import label_node


def _open_clients(stack, keys):
    from strands.tools.mcp.mcp_client import MCPClient
    from agent import GATEWAYS, create_gateway_transport

    clients = {}
    for key in keys:
        gateway_url = GATEWAYS.get(key)
        if not gateway_url:
            continue

        client = MCPClient(lambda url=gateway_url: create_gateway_transport(url))
        stack.enter_context(client)
        clients[key] = client
    return clients


def _bedrock_invoke(prompt):
    import boto3
    import json

    client = boto3.client(
        "bedrock-runtime",
        region_name=os.environ.get("AWS_REGION", "ap-northeast-2"),
    )
    response = client.invoke_model(
        # Stays on sonnet-4-6 (AGENTS.md's pinned RCA model) with temperature=0 for ADR-038
        # determinism. A model-generation bump is a separate decision (own PR + ADR) — and
        # note for that PR: sonnet-5 rejects `temperature` outright with a ValidationException
        # (see agent.py's MODEL_ID + hotfix c30ac9e7), so the bump must drop the param too.
        modelId="global.anthropic.claude-sonnet-4-6",
        contentType="application/json",
        accept="application/json",
        body=json.dumps(
            {
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 512,
                "temperature": 0,
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": prompt}]}
                ],
            }
        ),
    )
    body = json.loads(response["body"].read())
    return "\n".join(
        part.get("text", "")
        for part in body.get("content", [])
        if part.get("type") == "text"
    )


def handle_rca(payload) -> dict:
    if os.environ.get("RCA_ORCHESTRATOR_ENABLED") != "true":
        return {"disabled": True}

    incident_id = payload.get("incident_id")
    failing_entity = payload.get("failing_entity")
    if not incident_id or not failing_entity:
        return {"error": "incident_id and failing_entity required"}

    with ExitStack() as stack:
        clients = _open_clients(stack, ("ops", "monitoring"))
        tools = BoundedTools(clients)
        edges = tools.topology_edges()
        result = run_rca(
            failing_entity,
            edges,
            gather_evidence=tools.gather,
            label=lambda n, ev: label_node(n, ev, _bedrock_invoke),
        )

    return {
        "incident_id": incident_id,
        "rca": result,
        "root_causes": result["root_causes"],
        "node_count": len(result["nodes"]),
    }
