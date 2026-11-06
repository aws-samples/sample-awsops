"""The worker Lambda zip (workers.tf archive_file.workers_src) ships the local modules its files need.

The zip is flat: each `source` maps a repo file (possibly under a package, e.g. diagnosis/) to an
in-zip filename. Module-level imports must resolve to shipped files; lazy imports inside functions
may target Fargate-only modules, except the provider shim model_runtime, which every Lambda-run
LLM call path imports lazily.
"""
import ast
import re
from pathlib import Path

WORKERS = Path(__file__).resolve().parent
TF = WORKERS.parents[2] / "terraform" / "foundation" / "workers.tf"
SOURCE = re.compile(r'content\s*=\s*file\("\$\{local\.workers_src\}/([^"]+)"\)\s*filename\s*=\s*"([^"]+)"')


def _zip_sources():
    text = TF.read_text()
    start = text.index('data "archive_file" "workers_src"')
    block = text[start:text.index("\n}\n", start)]
    return dict((name, WORKERS / path) for path, name in SOURCE.findall(block))


def _imports(path):
    def shim(node):
        if isinstance(node, ast.ImportFrom):
            return node.module == "model_runtime"
        return isinstance(node, ast.Import) and any(a.name == "model_runtime" for a in node.names)

    tree = ast.parse(path.read_text())
    for node in list(tree.body) + [n for n in ast.walk(tree) if shim(n)]:
        if isinstance(node, ast.Import):
            yield from (a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            yield node.module.split(".")[0]


def test_zip_contains_every_local_module_its_files_import():
    sources = _zip_sources()
    local = {p.name for p in WORKERS.rglob("*.py") if "test" not in p.name}
    assert "signal_catalog_gen.py" in sources  # flattened entries are parsed
    missing = sorted({(name, f"{top}.py") for name, path in sources.items() if name.endswith(".py")
                      for top in _imports(path) if f"{top}.py" in local and f"{top}.py" not in sources})
    assert missing == []
