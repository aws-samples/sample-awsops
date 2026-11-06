"""The worker Lambda zip (workers.tf archive_file.workers_src) ships the local modules its files need.

Module-level imports must be shipped; lazy imports inside functions may target Fargate-only modules,
except the provider shim model_runtime, which every Lambda-run LLM call path imports lazily.
"""
import ast
import re
from pathlib import Path

WORKERS = Path(__file__).resolve().parent
TF = WORKERS.parents[2] / "terraform" / "foundation" / "workers.tf"


def _zip_files():
    text = TF.read_text()
    start = text.index('data "archive_file" "workers_src"')
    block = text[start:text.index("\n}\n", start)]
    return set(re.findall(r'filename\s*=\s*"([^"]+)"', block))


def _local_imports(path):
    tree = ast.parse(path.read_text())
    def shim(node):
        if isinstance(node, ast.ImportFrom):
            return node.module == "model_runtime"
        return isinstance(node, ast.Import) and any(a.name == "model_runtime" for a in node.names)

    nodes = list(tree.body) + [n for n in ast.walk(tree) if shim(n)]
    for node in nodes:
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else (
            [node.module] if isinstance(node, ast.ImportFrom) and node.module and node.level == 0 else [])
        for name in names:
            top = name.split(".")[0]
            if (WORKERS / f"{top}.py").is_file():
                yield f"{top}.py"


def test_zip_contains_every_top_level_module_its_files_import():
    shipped = _zip_files()
    missing = sorted({(name, dep) for name in shipped if name.endswith(".py") and (WORKERS / name).is_file()
                      for dep in _local_imports(WORKERS / name) if dep not in shipped})
    assert missing == []
