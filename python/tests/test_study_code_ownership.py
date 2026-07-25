from __future__ import annotations

from pathlib import Path

from opl_framework.study_code_ownership import audit_study_code_ownership


def _write(path: Path, content: str = "print('ok')\n", executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(path.stat().st_mode | 0o111)


def test_audit_allows_only_top_level_live_analysis_and_freezes_provenance(tmp_path: Path) -> None:
    study = tmp_path / "studies" / "001-demo"
    _write(study / "analysis" / "model.py", executable=True)
    _write(study / "artifacts" / "revision" / "tools" / "build.py", executable=True)
    _write(study / "manuscript" / "provenance" / "analysis" / "replay.py")
    _write(study / "manuscript" / "figures" / "analysis" / "not_live.py")
    _write(study / "manuscript" / "tools" / "private_tool.py")

    result = audit_study_code_ownership(tmp_path)

    assert result["status"] == "blocked"
    assert result["study_counts"] == {"001-demo": 5}
    assert result["study_classification_counts"] == {
        "001-demo": {
            "forbidden_private_functional_code": 2,
            "frozen_provenance": 2,
            "study_data_analysis": 1,
        }
    }
    entries = {entry["path"]: entry for entry in result["entries"]}
    assert entries["studies/001-demo/analysis/model.py"]["violation"] is None
    assert entries["studies/001-demo/artifacts/revision/tools/build.py"]["classification"] == "frozen_provenance"
    assert entries["studies/001-demo/artifacts/revision/tools/build.py"]["violation"] == (
        "frozen_provenance_must_not_be_executable"
    )
    assert entries["studies/001-demo/manuscript/provenance/analysis/replay.py"]["violation"] is None
    assert entries["studies/001-demo/manuscript/figures/analysis/not_live.py"]["violation"] == (
        "forbidden_private_functional_code"
    )
    assert entries["studies/001-demo/manuscript/tools/private_tool.py"]["violation"] == (
        "forbidden_private_functional_code"
    )


def test_audit_includes_extensionless_executable_as_private_functionality(tmp_path: Path) -> None:
    _write(tmp_path / "studies" / "001-demo" / "tools" / "release", "#!/bin/sh\n", executable=True)

    result = audit_study_code_ownership(tmp_path)

    assert result["status"] == "blocked"
    assert result["violations"] == [
        {
            "path": "studies/001-demo/tools/release",
            "classification": "forbidden_private_functional_code",
            "executable": True,
            "violation": "forbidden_private_functional_code",
        }
    ]


def test_audit_does_not_treat_executable_non_code_provenance_as_a_script(tmp_path: Path) -> None:
    _write(tmp_path / "studies" / "001-demo" / "artifacts" / "profile" / "lastsynchronized", executable=True)

    result = audit_study_code_ownership(tmp_path)

    assert result["status"] == "passed"
    assert result["entries"] == []


def test_audit_ignores_workspace_control_files_below_studies_root(tmp_path: Path) -> None:
    control_file = tmp_path / "studies" / ".DS_Store"
    _write(control_file, executable=True)

    result = audit_study_code_ownership(tmp_path)

    assert result["status"] == "passed"
    assert result["entries"] == []


def test_audit_ignores_non_code_compatibility_symlinks(tmp_path: Path) -> None:
    study = tmp_path / "studies" / "001-demo"
    (study / "manuscript").mkdir(parents=True)
    (study / "paper").symlink_to(study / "manuscript")

    result = audit_study_code_ownership(tmp_path)

    assert result["status"] == "passed"
    assert result["entries"] == []


def test_audit_reports_studies_with_no_code(tmp_path: Path) -> None:
    (tmp_path / "studies" / "004-no-code" / "manuscript").mkdir(parents=True)

    result = audit_study_code_ownership(tmp_path)

    assert result["scanned_study_ids"] == ["004-no-code"]
    assert result["study_counts"] == {"004-no-code": 0}
    assert result["study_classification_counts"] == {"004-no-code": {}}
