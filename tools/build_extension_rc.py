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
import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "extension"  # default; --source overrides
MANIFEST = "RC_MANIFEST.json"

#: Files the popup loads, in order. The order is a fact about `popup.html`, checked rather than assumed.
POPUP_ORDER = ["lib/build_stamp.js", "lib/queue_error_view.js", "lib/single_shot_view.js",
               "lib/readiness_queue_view.js", "lib/diagnostic_view.js", "popup.js"]


def _rename(src: Path, dst: Path) -> None:
    """Single hook for every directory move, so a test can fail the real branch instead of miming it."""
    src.rename(dst)


def all_files(root: Path) -> list[str]:
    """Every file, hidden ones included. `shipped_files` skips dotfiles on purpose; identity checks may not."""
    out = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            if rel != MANIFEST:
                out.append(rel)
    return out


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


def _fold(path: Path) -> str:
    """Case-folded, symlink-resolved key. Windows is case-insensitive, and a junction can hide the target."""
    try:
        resolved = path.resolve()
    except OSError:
        resolved = path.absolute()
    return os.path.normcase(str(resolved))


def _is_within(child: Path, parent: Path) -> bool:
    child_key, parent_key = _fold(child), _fold(parent)
    return child_key == parent_key or child_key.startswith(parent_key + os.sep)


def guard_out(out: Path, source: Path = SOURCE, allow_temp: bool = False) -> list[str]:
    """Every reason to refuse to touch `out`, checked before any delete or write.

    T178: `build()` used to call `shutil.rmtree(out)` as its first statement, so a bad `--out` could delete
    the source tree, the repository root or anything else the operator named. Deletion is now gated on the
    path being a place this tool is allowed to write, and never on the source or one of its ancestors.
    """
    problems: list[str] = []
    out_key, source_key, root_key = _fold(out), _fold(source), _fold(ROOT)
    dist_root = ROOT / "dist"

    if out_key == source_key:
        problems.append(f"refusing --out {out}: it is the source tree")
    elif _is_within(source, out):
        problems.append(f"refusing --out {out}: it contains the source tree")
    elif _is_within(out, source):
        problems.append(f"refusing --out {out}: it is inside the source tree")
    if out_key == root_key:
        problems.append(f"refusing --out {out}: it is the repository root")
    elif _is_within(ROOT, out) and out_key != root_key:
        problems.append(f"refusing --out {out}: it contains the repository")
    # Default is the controlled dist/ area. A drill that ships a *temporary* source (the test harness) may
    # also write under the system temp directory -- but never when the real extension tree is the source,
    # which is the only case an operator runs by hand.
    in_dist = _is_within(out, dist_root) and out_key != _fold(dist_root)
    drill_out = allow_temp and _is_within(out, Path(tempfile.gettempdir()))
    if not (in_dist or drill_out):
        problems.append(f"refusing --out {out}: candidates may only be created under {dist_root}" +
                        ("" if drill_out else " (or, for a --source outside the repo, under the temp dir)"))
    # A path that exists and is not a directory cannot be an RC either.
    if out.exists() and not out.is_dir():
        problems.append(f"refusing --out {out}: it exists and is not a directory")
    return problems


def candidate_identity(root: Path) -> tuple[bool, str]:
    """Is this directory a candidate of ours, judged by its own manifest? Says why not when it is not."""
    manifest_path = root / MANIFEST
    if not manifest_path.is_file():
        return False, f"{root} has no {MANIFEST}, so it is not a candidate this tool created"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return False, f"{root}/{MANIFEST} does not parse: {exc}"
    if manifest.get("kind") != "extension-release-candidate":
        return False, f"{root}/{MANIFEST} is not an extension-release-candidate"
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        return False, f"{root}/{MANIFEST} lists no files"
    for rel, digest in files.items():
        rel_path = Path(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            return False, f"{root}/{MANIFEST} lists {rel}, which is not a path inside the candidate"
        if not (root / rel).is_file():
            return False, f"{root} is missing {rel}, so its manifest no longer describes it"
        if sha256(root / rel) != digest:
            return False, f"{root}/{rel} does not match the digest its manifest records"
    # T180: a manifest describes *the whole directory*. A foreign file inside it would be deleted along with
    # the candidate, so it must refuse rather than be silently destroyed.
    listed = set(files)
    present = set(all_files(root))
    extra = sorted(present - listed)
    if extra:
        return False, (f"{root} contains files its manifest does not list ({', '.join(extra[:3])}), so it is "
                       "not a directory this tool may replace; delete that file yourself if it is stray, or "
                       "build into a different --out -- this tool will not delete it for you")
    return True, ""


def identity_fingerprint(root: Path) -> str | None:
    """What `candidate_identity` just looked at, reduced to one value.

    T183: re-checking narrows the window between validation and the retire rename; it does not close it. No
    portable directory lock exists here (Windows has no `flock`), so the honest claim is "the swap refuses if
    the target changed while the new candidate was being built", not "the swap is atomic".
    """
    ok, _why = candidate_identity(root)
    if not ok:
        return None
    digest = hashlib.sha256()
    for rel in sorted(all_files(root)):
        path = root / rel
        try:
            digest.update(rel.encode("utf-8"))
            digest.update(b"\0")
            digest.update(bytes.fromhex(sha256(path)))
        except OSError:
            return None
    manifest = root / MANIFEST
    try:
        digest.update(manifest.read_bytes())
    except OSError:
        return None
    return digest.hexdigest()


def build(out: Path, source: Path = SOURCE, allow_temp: bool = False) -> int:
    # 1) Safety, before anything is deleted or written.
    problems = guard_out(out, source, allow_temp=allow_temp)
    if problems:
        print("FAIL refusing to build")
        for item in problems:
            print(f"  {item}")
        return 1

    # 2) Freshness of the source. A stale source must leave an existing candidate exactly as it was.
    source_info, stamp_problems = stamp_probe(source, "source")
    if stamp_problems:
        print("FAIL refusing to build")
        for item in stamp_problems:
            print(f"  {item}")
        print(f"  (source declared {source_info['declared'] or 'unknown'}, "
              f"tree {source_info['tree'] or 'unknown'}; run python -B tools/extension_stamp.py --write)")
        if out.exists():
            print(f"  existing candidate {out} left untouched")
        return 1

    # 3) An existing directory may only be replaced if it proves it is one of ours.
    replaced = False
    if out.exists():
        ours, why = candidate_identity(out)
        if not ours:
            print("FAIL refusing to build")
            print(f"  {why}; refusing to delete a directory this tool cannot account for")
            return 1
        validated = identity_fingerprint(out)
        if validated is None:
            print("FAIL refusing to build")
            print(f"  {out} could not be fingerprinted; refusing to replace a directory in that state")
            return 1
        replaced = True

    # 4) Build and verify in a temporary sibling, then swap. A failed build therefore cannot leave a
    #    half-written candidate where the operator expects a good one.
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=out.name + ".staging-", dir=str(out.parent)))
    retired = staging.parent / (staging.name + ".retired")
    try:
        staged = staging / "payload"
        shutil.copytree(source, staged, ignore=shutil.ignore_patterns(".*"))
        files = {rel: sha256(staged / rel) for rel in shipped_files(staged)}
        manifest = {
            "kind": "extension-release-candidate",
            "source": source.name + "/",
            # The concrete digest, taken from the checker -- never `stdout.splitlines()[0]`.
            "stamp": "T112-" + source_info["tree"],
            "files": files,
            "fileCount": len(files),
            "popupOrder": POPUP_ORDER,
        }
        (staged / MANIFEST).write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                                       encoding="utf-8", newline="\n")
        if verify(staged, check_parse=True, source=source) != 0:
            print(f"FAIL staged candidate did not verify; {out} left untouched")
            return 1
        # T180/T181: the retired copy is parked beside the staging directory (never inside it) and is only
        # removed once the new candidate is in place *and* verified. A failed swap puts it back; if even that
        # fails, it is left exactly where it is so the operator still has the bytes.
        if replaced:
            # T183: the target was validated before the staged copy was built and verified, which takes
            # seconds. Re-check it now: if anything moved, refuse instead of retiring an unvalidated set.
            if identity_fingerprint(out) != validated:
                print("FAIL refusing to swap")
                print(f"  {out} changed while the new candidate was being built; it was not touched")
                print(f"  rebuild with a fresh --out, or inspect {out} and remove it yourself")
                return 1
            _rename(out, retired)
        try:
            _rename(staged, out)
        except OSError as exc:
            restored = False
            if retired.exists():
                try:
                    _rename(retired, out)
                    restored = True
                except OSError as restore_exc:
                    print(f"FAIL swap failed ({exc}) and the restore failed ({restore_exc})")
                    print(f"  the previous candidate is intact at {retired}")
                    return 1
            print(f"FAIL swap failed ({exc}); previous candidate "
                  + ("restored" if restored else "was not present"))
            return 1
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print(f"built {out} ({len(files)} files, stamp {manifest['stamp']})")
    code = verify(out, check_parse=True, source=source)
    if code == 0:
        # Only a landed, verified candidate earns the right to delete the recovery copy.
        if retired.exists():
            shutil.rmtree(retired, ignore_errors=True)
        return 0

    # T183: the swap already happened, so the healthy copy is parked. Put it back rather than leaving an
    # unverified directory where the operator expects a candidate: exiting non-zero while `out` is untrusted
    # is the failure mode this replaces.
    print("FAIL the candidate did not verify after the swap")
    rejected = retired.parent / (retired.name + ".rejected")
    try:
        _rename(out, rejected)
    except OSError as exc:
        print(f"  the rejected candidate could not be moved aside ({exc})")
        print(f"  the previous candidate is intact at {retired}")
        return 1
    if retired.exists():
        try:
            _rename(retired, out)
            print(f"  the previous candidate was restored to {out}")
            shutil.rmtree(rejected, ignore_errors=True)
        except OSError as exc:
            print(f"  the restore failed ({exc})")
            print(f"  previous candidate intact at {retired}; rejected build parked at {rejected}")
    else:
        print(f"  no previous candidate existed; the rejected build is parked at {rejected}")
    return 1


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
    parser.add_argument("--allow-temp-out", action="store_true",
                        help="test harness only: permit --out under the system temp directory")
    parser.add_argument("--source", type=Path, default=SOURCE,
                        help="tree to ship (default extension/); overridable so tests never touch it")
    args = parser.parse_args()
    if args.out:
        return build(args.out, source=args.source, allow_temp=args.allow_temp_out)
    if args.verify:
        return verify(args.verify, check_parse=args.check_parse, source=args.source)
    parser.error("one of --out or --verify is required")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
