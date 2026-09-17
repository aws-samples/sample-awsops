#!/usr/bin/env python3
"""Validate canonical draw.io sources and export the blog's diagram set.

The .drawio files own content and routed geometry; YAML files are topology
references. Requires drawio, xvfb-run on headless Linux, and the installed
architecture-diagram plugin. Override AWS_DIAGRAM_SKILL_DIR for another install.

Run without arguments to validate and export PNG (2x) and SVG. --check validates
only. Optional figure stems select a subset. The preserved workflow is verified
against its original hashes and is never rewritten or exported.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
IMAGES = HERE.parent / "images"
FIGURES = (
    "fig2a-interactive",
    "fig2b-diagnosis",
    "fig3-agentcore",
    "fig4-workers",
    "appendix-a-private-edge",
    "appendix-b-edge-auth",
)
PRESERVED = {
    HERE / "fig1-sre-workflow.drawio":
        "99ad30c09a10840ef710123d48474c7eeb91c375c2839193388e915034b0400f",
    IMAGES / "fig1-sre-workflow.png":
        "6683521d6d1e22022c4ebc5936dd52592461b52193e6883f42a711c3e1bd14b7",
    IMAGES / "fig1-sre-workflow.svg":
        "cc7f98599eac5cfe807793df13310774ad28c0ea7af90285518c1c221453d9cd",
}
DEFAULT_SKILL = (
    Path.home()
    / ".codex/plugins/cache/oh-my-cloud-skills/aws-content-plugin"
    / "1.17.0/skills/architecture-diagram"
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("figures", nargs="*", help="Figure stems; defaults to all.")
    args = parser.parse_args()
    selected = args.figures or list(FIGURES)
    if any(name not in FIGURES for name in selected):
        parser.error(f"Select from: {', '.join(FIGURES)}")

    for path, expected in PRESERVED.items():
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise SystemExit(f"Preserved workflow differs: {path}")
    print("Preserved workflow: all three original SHA-256 hashes match.", flush=True)

    skill = Path(os.environ.get("AWS_DIAGRAM_SKILL_DIR", str(DEFAULT_SKILL)))
    for name in selected:
        source = HERE / f"{name}.drawio"
        for checker in ("validate_drawio.py", "lint_layout.py"):
            subprocess.run(
                [sys.executable, str(skill / "scripts" / checker), str(source)],
                check=True,
            )
    if args.check:
        return

    drawio = shutil.which("drawio")
    if not drawio:
        raise SystemExit("Cannot export: drawio CLI is not installed.")
    prefix: list[str] = []
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        xvfb = shutil.which("xvfb-run")
        if not xvfb:
            raise SystemExit("Cannot export: DISPLAY and xvfb-run are unavailable.")
        prefix = [xvfb, "-a"]
    for name in selected:
        # Validate fresh files before replacing either committed export. A CLI
        # that exits successfully without writing cannot reuse stale artifacts.
        with tempfile.TemporaryDirectory(prefix=f".{name}-", dir=IMAGES) as staging:
            exports = []
            for format_name in ("png", "svg"):
                target = Path(staging) / f"{name}.{format_name}"
                command = [
                    *prefix, drawio, "--disable-gpu", "-x", "-f", format_name,
                    "-b", "20", "-o", str(target), str(HERE / f"{name}.drawio"),
                ]
                if format_name == "png":
                    command.extend(["-s", "2"])
                subprocess.run(command, check=True, timeout=60)
                if not target.is_file() or target.stat().st_size < 10_000:
                    raise SystemExit(f"Export missing or suspiciously small: {target.name}")
                if format_name == "png":
                    if target.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
                        raise SystemExit(f"Invalid PNG export: {target.name}")
                elif ET.parse(target).getroot().tag != "{http://www.w3.org/2000/svg}svg":
                    raise SystemExit(f"Invalid SVG export: {target.name}")
                exports.append(target)
            for target in exports:
                destination = IMAGES / target.name
                target.replace(destination)
                print(f"Exported {destination.name}: {destination.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    main()
