#!/usr/bin/env python3
"""Build and verify a release-candidate copy of `extension/` without touching any installed copy.

Reuses `tools/extension_stamp.py` for the stamp instead of inventing a second stamping scheme. The output is
a self-contained directory (and an optional zip) plus `RC_MANIFEST.json`, which lists every shipped file with
its sha256 so a later check can prove bytes, missing files and extra files.

    python -B tools/build_extension_rc.py --out dist/rc            # build + verify
    python -B tools/build_extension_rc.py --verify dist/rc --check-parse

Exit code 0 means: the candidate is byte-identical to `extension/`, nothing is missing, nothing extra, and
(with --check-parse) every script in it is executable by Node or parseable as a classic script.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"
MANIFEST = "RC_MANIFEST.json"

#: Files the popup loads, in order. The order is a fact about `popup.html`, checked rather than assumed.
POPUP_ORDER = ["lib/build_stamp.js", "lib/queue_error_view.js", "lib/single_shot_view.js",
               "lib/readiness_queue_view.js", "lib/diagnostic_view.js", "popup.js"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def shipped_files(root: Path) -> list[str]:
    out = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".") or rel == MANIFEST:
            continue
        out.append(rel)
    return out


def stamp(root: Path) -> str:
    """Ask the existing tool for the stamp; never re-implement its hashing here."""
    proc = subprocess.run([sys.executable, "-B", str(ROOT / "tools" / "extension_stamp.py"),
                           "--check", "--root", str(root)],
                          capture_output=True, text=True)
    text = (proc.stdout + proc.stderr).strip()
    return text.splitlines()[0] if text else "unknown"


def structure_problems(root: Path) -> list[str]:
    problems = []
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        return ["manifest.json is missing"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"manifest.json does not parse: {exc}"]
    if manifest.get("manifest_version") != 3:
        problems.append("manifest_version is not 3")
    background = manifest.get("background") or {}
    for key in ("service_worker", "scripts"):
        value = background.get(key)
        for name in ([value] if isinstance(value, str) else (value or [])):
            if not (root / name).is_file():
                problems.append(f"background entry {name} is missing")
    for entry in manifest.get("content_scripts", []):
        for name in entry.get("js", []):
            if not (root / name).is_file():
                problems.append(f"content script {name} is missing")
    for entry in manifest.get("web_accessible_resources", []):
        for name in entry.get("resources", []):
            if not (root / name).is_file():
                problems.append(f"web-accessible resource {name} is missing")
    for key in ("action", "browser_action", "page_action"):
        default_popup = (manifest.get(key) or {}).get("default_popup")
        if default_popup and not (root / default_popup).is_file():
            problems.append(f"popup {default_popup} is missing")

    popup = root / "popup.html"
    if popup.is_file():
        html = popup.read_text(encoding="utf-8")
        found = [name for name in POPUP_ORDER if name in html]
        for name in POPUP_ORDER:
            if name not in html:
                problems.append(f"popup.html does not load {name}")
        indexes = [html.index(name) for name in found]
        if indexes != sorted(indexes):
            problems.append("popup.html loads its scripts out of order")
        for name in found:
            if not (root / name).is_file():
                problems.append(f"popup script {name} is missing")
    return problems


def parse_problems(root: Path) -> list[str]:
    """Node parses classic scripts, and dynamic import proves the module graph resolves."""
    problems = []
    node = shutil.which("node")
    if not node:
        return ["node is unavailable, so parse checks were skipped"]
    for rel in shipped_files(root):
        if not rel.endswith(".js"):
            continue
        path = root / rel
        text = path.read_text(encoding="utf-8", errors="replace")
        probe = subprocess.run([node, "--check", str(path)], capture_output=True, text=True)
        if probe.returncode == 0:
            continue
        if "import " in text or "export " in text:
            dynamic = subprocess.run(
                [node, "--input-type=module", "-e",
                 "import(process.argv[1]).then(()=>process.exit(0),e=>{"
                 "console.error(e&&e.message||e);process.exit(3)})", path.as_uri()],
                capture_output=True, text=True)
            if dynamic.returncode != 0:
                problems.append(f"{rel} is not loadable: {dynamic.stderr.strip().splitlines()[:1]}")
            continue
        problems.append(f"{rel} does not parse: {probe.stderr.strip().splitlines()[:1]}")
    return problems


def build(out: Path) -> int:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(SOURCE, out, ignore=shutil.ignore_patterns(".*"))
    files = {rel: sha256(out / rel) for rel in shipped_files(out)}
    manifest = {
        "kind": "extension-release-candidate",
        "source": "extension/",
        "stamp": stamp(out),
        "files": files,
        "fileCount": len(files),
        "popupOrder": POPUP_ORDER,
    }
    (out / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                               encoding="utf-8", newline="\n")
    print(f"built {out} ({len(files)} files, stamp {manifest['stamp']})")
    return verify(out, check_parse=True)


def verify(root: Path, check_parse: bool = False) -> int:
    manifest_path = root / MANIFEST
    problems: list[str] = []
    if not manifest_path.is_file():
        print(f"FAIL no {MANIFEST} in {root}")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = manifest.get("files", {})
    present = {rel: sha256(root / rel) for rel in shipped_files(root)}
    for rel, digest in expected.items():
        if rel not in present:
            problems.append(f"missing: {rel}")
        elif present[rel] != digest:
            problems.append(f"changed: {rel}")
    for rel in present:
        if rel not in expected:
            problems.append(f"extra: {rel}")
    # The candidate must still be byte-identical to the tree it claims to come from.
    for rel, digest in expected.items():
        source = SOURCE / rel
        if not source.is_file():
            problems.append(f"not in extension/: {rel}")
        elif sha256(source) != digest:
            problems.append(f"differs from extension/: {rel}")
    problems.extend(structure_problems(root))
    if check_parse:
        problems.extend(parse_problems(root))

    if problems:
        print("FAIL")
        for item in problems:
            print(f"  {item}")
        return 1
    print(f"PASS {root} matches extension/ ({len(expected)} files), structure and parse checks clean")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="build/verify an extension release candidate offline")
    parser.add_argument("--out", type=Path, help="candidate directory to create")
    parser.add_argument("--verify", type=Path, help="existing candidate directory to check")
    parser.add_argument("--check-parse", action="store_true", help="also run node parse checks")
    args = parser.parse_args()
    if args.out:
        return build(args.out)
    if args.verify:
        return verify(args.verify, check_parse=args.check_parse)
    parser.error("one of --out or --verify is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
