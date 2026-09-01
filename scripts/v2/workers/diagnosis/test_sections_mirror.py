"""Lockstep guard: the web UI's static section-catalog mirror (web/lib/diagnosis-sections.ts)
must match this package's SECTIONS/_DEEP_ONLY/INTENDED_VS_ACTUAL_SECTION keys+titles and
TITLES_I18N variants. The UI already degrades honestly on drift (unknown titles don't check a
box; a size mismatch falls back to the bar view) — this test makes drift a FAILING build
instead of a silent degradation."""
import re
from pathlib import Path

import pytest

from diagnosis import sections as S

_TS = Path(__file__).resolve().parents[4] / "web" / "lib" / "diagnosis-sections.ts"


def _parse_mirror():
    text = _TS.read_text(encoding="utf-8")
    entries = {}
    for m in re.finditer(r"\{ key: '([^']+)', title: '([^']+)'(?:, deep: true)?(?:,\s*\n?\s*variants: \[([^\]]*)\])?", text):
        key, title, variants = m.group(1), m.group(2), m.group(3)
        var_list = re.findall(r"'([^']+)'", variants) if variants else []
        entries[key] = {"title": title, "variants": var_list}
    return entries


@pytest.mark.skipif(not _TS.exists(), reason="web tree not present in this checkout")
def test_ts_mirror_matches_python_catalog():
    mirror = _parse_mirror()
    catalog = {s["key"]: s["title"] for s in S.DEEP_SECTIONS}
    catalog[S.INTENDED_VS_ACTUAL_SECTION["key"]] = S.INTENDED_VS_ACTUAL_SECTION["title"]
    assert set(mirror) == set(catalog), "section keys drifted between sections.py and diagnosis-sections.ts"
    for key, title in catalog.items():
        assert mirror[key]["title"] == title, f"title drifted for {key}"
    for key, variants in S.TITLES_I18N.items():
        assert mirror[key]["variants"] == [variants["en"], variants["zh"], variants["ja"]], \
            f"localized variants drifted for {key}"
