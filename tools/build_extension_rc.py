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
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"  # default; --source overrides
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


STAMP_TOOL = ROOT / "tools" / "extension_stamp.py"
STAMP_LITERAL = re.compile(r"T112-[0-9a-f]{8}")


def read_declared(root: Path) -> str:
    """The literal the candidate itself carries. `--check` reads the *repo* copy, so read this too."""
    path = root / "lib" / "build_stamp.js"
    if not path.is_file():
        return ""
    found = STAMP_LITERAL.findall(path.read_text(encoding="utf-8"))
    return found[0] if found else ""


def stamp_probe(root: Path, label: str) -> tuple[dict, list[str]]:
    """Run the project's own checker and insist on exit 0 *and* `fresh`.

    T177: the previous version returned `stdout.splitlines()[0]` and never looked at the exit code, so a
    stale stamp printed "STALE -- run --write" with status 1 and the candidate still reported PASS. A
    release candidate whose stamp does not describe its own bytes is not a candidate; it is a directory.
    """
    problems: list[str] = []
    info = {"label": label, "root": str(root), "declared": "", "tree": "", "verdict": "",
            "returncode": None, "fresh": False}
    if not root.is_dir():
        problems.append(f"{label}: {root} does not exist")
        return info, problems
    proc = subprocess.run([sys.executable, "-B", str(STAMP_TOOL), "--check", "--root", str(root)],
                          capture_output=True, text=True)
    info["returncode"] = proc.returncode
    text = (proc.stdout or "") + (proc.stderr or "")
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "declared":
            info["declared"] = parts[1]
        elif len(parts) >= 2 and parts[0] == "tree":
            info["tree"] = parts[1]
        elif len(parts) >= 2 and parts[0] == "verdict":
            info["verdict"] = " ".join(parts[1:])
    own = read_declared(root)
    # `declared` carries the T112- prefix, `tree` is the bare digest; compare like with like.
    own_digest = own.split("-", 1)[1] if "-" in own else own
    info["own"] = own
    if proc.returncode != 0:
        problems.append(f"{label}: extension_stamp.py --check failed (exit {proc.returncode}); "
                        f"declared {info['declared'] or 'unknown'} vs tree {info['tree'] or 'unknown'}")
    if "STALE" in info["verdict"].upper():
        problems.append(f"{label}: stale stamp -- declared {info['declared'] or 'unknown'} "
                        f"vs tree {info['tree'] or 'unknown'}")
    if own_digest and info["tree"] and own_digest != info["tree"]:
        problems.append(f"{label}: its own lib/build_stamp.js declares {own}, its tree hashes to "
                        f"T112-{info['tree']}")
    if own and info["declared"] and own != info["declared"]:
        problems.append(f"{label}: the repository copy declares {info['declared']} but this directory "
                        f"declares {own}")
    # `fresh` is the tool's own verdict; nothing here may be inferred from prose alone.
    info["fresh"] = (proc.returncode == 0 and "STALE" not in info["verdict"].upper()
                     and bool(info["tree"]) and (not own_digest or own_digest == info["tree"]))
    if not info["fresh"] and not problems:
        problems.append(f"{label}: stamp check did not confirm fresh (verdict {info['verdict'] or 'empty'})")
    return info, problems


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


def build(out: Path, source: Path = SOURCE) -> int:
    if out.exists():
        shutil.rmtree(out)
    # The source must be fresh *before* it is copied: a stale source produces a stale candidate, and the
    # candidate is what an operator would load.
    source_info, problems = stamp_probe(source, "source")
    if problems:
        print("FAIL refusing to build")
        for item in problems:
            print(f"  {item}")
        print(f"  (source declared {source_info['declared'] or 'unknown'}, "
              f"tree {source_info['tree'] or 'unknown'}; run python -B tools/extension_stamp.py --write)")
        return 1
    shutil.copytree(source, out, ignore=shutil.ignore_patterns(".*"))
    files = {rel: sha256(out / rel) for rel in shipped_files(out)}
    manifest = {
        "kind": "extension-release-candidate",
        "source": source.name + "/",
        # The concrete digest, taken from the checker -- never `stdout.splitlines()[0]`.
        "stamp": "T112-" + source_info["tree"],
        "files": files,
        "fileCount": len(files),
        "popupOrder": POPUP_ORDER,
    }
    (out / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                               encoding="utf-8", newline="\n")
    print(f"built {out} ({len(files)} files, stamp {manifest['stamp']})")
    return verify(out, check_parse=True, source=source)


def verify(root: Path, check_parse: bool = False, source: Path = SOURCE) -> int:
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
        origin = source / rel
        if not origin.is_file():
            problems.append(f"not in {source.name}/: {rel}")
        elif sha256(origin) != digest:
            problems.append(f"differs from {source.name}/: {rel}")
    # Both directories are judged, not just one: the candidate is only as good as the tree it mirrors.
    source_info, stamp_problems = stamp_probe(source, "source")
    problems.extend(stamp_problems)
    if source_info["tree"] and manifest.get("stamp") != "T112-" + source_info["tree"]:
        problems.append(f"manifest stamp {manifest.get('stamp')} is not the source tree digest "
                        f"T112-{source_info['tree']}")
    # The candidate cannot be re-hashed by the checker as a whole: it carries RC_MANIFEST.json, which is
    # not part of the tree the stamp describes. So it is judged by its own literal plus the per-file hashes
    # above -- a candidate whose build_stamp.js was edited no longer matches, byte for byte.
    own = read_declared(root)
    own_digest = own.split("-", 1)[1] if "-" in own else own
    if not own:
        problems.append("candidate: lib/build_stamp.js carries no stamp literal")
    elif source_info["tree"] and own_digest != source_info["tree"]:
        problems.append(f"candidate: its own lib/build_stamp.js declares {own}, the source tree hashes to "
                        f"T112-{source_info['tree']}")
    if manifest.get("stamp") and own and manifest["stamp"] != own:
        problems.append(f"candidate: manifest says {manifest['stamp']} but the directory declares {own}")
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
    parser.add_argument("--source", type=Path, default=SOURCE,
                        help="tree to ship (default extension/); overridable so tests never touch it")
    args = parser.parse_args()
    if args.out:
        return build(args.out, source=args.source)
    if args.verify:
        return verify(args.verify, check_parse=args.check_parse, source=args.source)
    parser.error("one of --out or --verify is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
