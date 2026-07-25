"""Audit study workspaces for private executable functionality.

Study-local data analysis is intentionally allowed.  Historic scripts captured
inside artifact, archive, or provenance snapshots are evidence, not live
entrypoints, and must not retain executable permission bits.  Every other code
file below a study is a boundary violation.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import stat
from typing import Any


CODE_SUFFIXES = frozenset(
    {
        ".ado",
        ".bash",
        ".do",
        ".ipynb",
        ".jl",
        ".js",
        ".jsx",
        ".m",
        ".py",
        ".qmd",
        ".r",
        ".rmd",
        ".sas",
        ".sh",
        ".sps",
        ".sql",
        ".stan",
        ".ts",
        ".tsx",
        ".zsh",
    }
)


def _has_shebang(path: Path) -> bool:
    if path.is_symlink():
        return False
    try:
        with path.open("rb") as handle:
            return handle.read(2) == b"#!"
    except OSError:
        return False


def _is_code_file(path: Path, mode: int, *, frozen_provenance: bool) -> bool:
    if path.suffix.lower() in CODE_SUFFIXES:
        return True
    if stat.S_ISLNK(mode):
        return False
    executable = bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
    if not executable:
        return False
    # Runtime profiles can retain execute bits on non-code data.  Outside frozen
    # evidence every executable is functional; inside it, require a script marker.
    return not frozen_provenance or _has_shebang(path)


def _classification(relative: Path) -> str:
    parts = relative.parts
    if len(parts) < 3 or parts[0] != "studies":
        raise ValueError(f"path is not inside one study: {relative}")
    study_relative = parts[2:]
    if "artifacts" in study_relative or "_archive" in study_relative or "provenance" in study_relative:
        return "frozen_provenance"
    if study_relative and study_relative[0] == "analysis":
        return "study_data_analysis"
    return "forbidden_private_functional_code"


def audit_study_code_ownership(workspace_root: str | Path) -> dict[str, Any]:
    """Classify all study code without changing source or artifact bytes."""

    root = Path(workspace_root).resolve(strict=True)
    studies_root = root / "studies"
    if not studies_root.is_dir():
        raise ValueError(f"workspace has no studies directory: {studies_root}")
    scanned_study_ids = sorted(
        path.name for path in studies_root.iterdir() if path.is_dir() and not path.is_symlink()
    )
    entries: list[dict[str, object]] = []
    study_counts: dict[str, int] = {study_id: 0 for study_id in scanned_study_ids}
    study_classification_counts: dict[str, dict[str, int]] = {
        study_id: {} for study_id in scanned_study_ids
    }
    for path in sorted(studies_root.rglob("*")):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        relative = path.relative_to(root)
        if len(relative.parts) < 3:
            # Workspace control files such as studies/.DS_Store are not study code.
            continue
        classification = _classification(relative)
        if not _is_code_file(
            path,
            mode,
            frozen_provenance=classification == "frozen_provenance",
        ):
            continue
        executable = bool(mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
        violation: str | None = None
        if path.is_symlink():
            violation = "study_code_symlink_forbidden"
        elif classification == "forbidden_private_functional_code":
            violation = classification
        elif classification == "frozen_provenance" and executable:
            violation = "frozen_provenance_must_not_be_executable"
        entries.append(
            {
                "path": relative.as_posix(),
                "classification": classification,
                "executable": executable,
                "violation": violation,
            }
        )
        study_id = relative.parts[1]
        study_counts[study_id] = study_counts.get(study_id, 0) + 1
        classification_counts = study_classification_counts.setdefault(study_id, {})
        classification_counts[classification] = classification_counts.get(classification, 0) + 1
    violations = [entry for entry in entries if entry["violation"] is not None]
    counts: dict[str, int] = {}
    for entry in entries:
        key = str(entry["classification"])
        counts[key] = counts.get(key, 0) + 1
    return {
        "surface_kind": "opl_study_functional_code_ownership_audit.v1",
        "workspace_root": str(root),
        "status": "passed" if not violations else "blocked",
        "scanned_study_ids": scanned_study_ids,
        "counts": dict(sorted(counts.items())),
        "study_counts": dict(sorted(study_counts.items())),
        "study_classification_counts": {
            study_id: dict(sorted(classification_counts.items()))
            for study_id, classification_counts in sorted(study_classification_counts.items())
        },
        "entries": entries,
        "violations": violations,
        "policy": {
            "allowed_live_code": "studies/<study_id>/analysis/** only",
            "frozen_provenance_roots": [
                "studies/<study_id>/artifacts/**",
                "studies/<study_id>/_archive/**",
                "studies/<study_id>/**/provenance/**",
            ],
            "frozen_provenance_executable": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit study code ownership boundaries")
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = audit_study_code_ownership(args.workspace)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    else:
        print(f"{result['status']}: {len(result['violations'])} boundary violations")
    return 0 if result["status"] == "passed" else 3


if __name__ == "__main__":
    raise SystemExit(main())
