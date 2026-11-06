"""Catalog tool schemas stay within AgentCore Gateway's SchemaDefinition shape."""
import subprocess
import sys
from pathlib import Path

import catalog

HERE = Path(__file__).resolve().parent
SCHEMA_KEYS = {"type", "description", "properties", "required", "items"}


def _nodes(node, path):
    yield path, node
    for key, child in (node.get("properties") or {}).items():
        yield from _nodes(child, f"{path}.{key}")
    if "items" in node:
        yield from _nodes(node["items"], f"{path}[]")


def test_every_schema_node_uses_only_gateway_keys():
    bad = [
        (path, sorted(set(node) - SCHEMA_KEYS))
        for name, target in catalog.TARGETS.items()
        for tool in target["tools"]
        for path, node in _nodes(tool["inputSchema"], f"{name}/{tool['name']}")
        if set(node) - SCHEMA_KEYS
    ]
    assert bad == []


def test_catalog_check_passes():
    result = subprocess.run([sys.executable, "catalog_check.py"], cwd=HERE, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
