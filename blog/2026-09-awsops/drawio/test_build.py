"""Offline regression checks for fresh export validation."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("blog_diagram_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ExportTests(unittest.TestCase):
    def run_export(self, produce):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = root / "images"
            images.mkdir()
            figure = build.FIGURES[0]
            original = b"existing export" * 1000
            for suffix in ("png", "svg"):
                (images / f"{figure}.{suffix}").write_bytes(original)

            def run(command, **_kwargs):
                if "-o" in command:
                    output = Path(command[command.index("-o") + 1])
                    self.assertNotEqual(output.parent, images)
                    produce(output)

            with patch.object(build, "HERE", root), patch.object(build, "IMAGES", images), \
                    patch.object(build, "PRESERVED", {}), \
                    patch.object(build.shutil, "which", return_value="/fixture/drawio"), \
                    patch.object(build.subprocess, "run", side_effect=run), \
                    patch.object(build.sys, "argv", ["build.py", figure]), \
                    patch.dict(build.os.environ, {"DISPLAY": ":fixture"}):
                try:
                    build.main()
                except SystemExit:
                    for suffix in ("png", "svg"):
                        self.assertEqual((images / f"{figure}.{suffix}").read_bytes(), original)
                    self.assertEqual(len(list(images.iterdir())), 2)
                    raise
            return [(images / f"{figure}.{suffix}").read_bytes() for suffix in ("png", "svg")]

    def test_success_without_output_cannot_reuse_committed_exports(self):
        with self.assertRaisesRegex(SystemExit, "Export missing"):
            self.run_export(lambda _output: None)

    def test_second_export_failure_keeps_both_originals(self):
        def produce(output):
            if output.suffix == ".png":
                output.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 10001)
        with self.assertRaisesRegex(SystemExit, "Export missing"):
            self.run_export(produce)

    def test_replaces_exports_only_after_both_fresh_outputs_validate(self):
        png = b"\x89PNG\r\n\x1a\n" + b"x" * 10001
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><!--' + b"x" * 10001 + b"--></svg>"
        result = self.run_export(lambda output: output.write_bytes(png if output.suffix == ".png" else svg))
        self.assertEqual(result, [png, svg])


if __name__ == "__main__":
    unittest.main()
