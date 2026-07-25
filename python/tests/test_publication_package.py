from __future__ import annotations

from pathlib import Path
import zipfile

import pytest

from opl_framework.publication_package import (
    PublicationPackageError,
    package_inventory,
    package_inventory_sha256,
    safe_relative_path,
    verify_deterministic_archive,
    verify_sha256_sidecar,
    write_deterministic_archive,
    write_sha256_sidecar,
)


FINALIZED_AT = "2026-07-24T01:00:01Z"


def test_archive_member_path_rejects_windows_separator() -> None:
    with pytest.raises(PublicationPackageError, match="contained normalized path"):
        safe_relative_path("nested\\payload.txt")


def _source_tree(root: Path) -> Path:
    source = root / "source"
    (source / "nested").mkdir(parents=True)
    (source / "a.txt").write_text("alpha\n", encoding="utf-8")
    (source / "nested" / "omega.txt").write_text("omega\n", encoding="utf-8")
    return source


def test_deterministic_archive_is_byte_exact_and_has_visible_frozen_timestamp(tmp_path: Path) -> None:
    source = _source_tree(tmp_path)
    first = tmp_path / "first.zip"
    second = tmp_path / "second.zip"
    inventory = package_inventory(source)

    first_result = write_deterministic_archive(
        source,
        first,
        finalized_at_utc=FINALIZED_AT,
        expected_inventory=inventory,
    )
    second_result = write_deterministic_archive(
        source,
        second,
        finalized_at_utc=FINALIZED_AT,
        expected_inventory=inventory,
    )

    assert first.read_bytes() == second.read_bytes()
    assert first_result["sha256"] == second_result["sha256"]
    assert first_result["member_timestamp_utc"] == "2026-07-24T01:00:00Z"
    assert first_result["member_count"] == 2
    assert first_result["source_inventory_sha256"] == package_inventory_sha256(inventory)
    with zipfile.ZipFile(first) as archive:
        assert archive.namelist() == ["a.txt", "nested/omega.txt"]
        assert {member.date_time for member in archive.infolist()} == {(2026, 7, 24, 1, 0, 0)}
        assert all(member.extra.startswith(b"UT\x05\x00\x01") for member in archive.infolist())
    assert verify_deterministic_archive(
        source,
        first,
        finalized_at_utc=FINALIZED_AT,
        expected_inventory=inventory,
    )["exact_member_bytes_passed"] is True


@pytest.mark.parametrize(
    "timestamp",
    [
        "1980-01-01T00:00:00Z",
        "2026-07-24T01:00:00",
        "2108-01-01T00:00:00Z",
    ],
)
def test_deterministic_archive_rejects_sentinel_or_invalid_timestamp(
    tmp_path: Path, timestamp: str
) -> None:
    with pytest.raises(PublicationPackageError):
        write_deterministic_archive(_source_tree(tmp_path), tmp_path / "result.zip", finalized_at_utc=timestamp)


def test_deterministic_archive_rejects_symlink_and_source_tree_destination(tmp_path: Path) -> None:
    source = _source_tree(tmp_path)
    link = tmp_path / "archive-link.zip"
    link.symlink_to(tmp_path / "target.zip")

    with pytest.raises(PublicationPackageError, match="symbolic link"):
        write_deterministic_archive(source, link, finalized_at_utc=FINALIZED_AT)
    with pytest.raises(PublicationPackageError, match="inside the source root"):
        write_deterministic_archive(source, source / "result.zip", finalized_at_utc=FINALIZED_AT)


def test_archive_verification_rejects_metadata_drift(tmp_path: Path) -> None:
    source = _source_tree(tmp_path)
    archive_path = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive_path, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for source_path in sorted(source.rglob("*")):
            if source_path.is_file():
                archive.write(source_path, source_path.relative_to(source).as_posix())

    with pytest.raises(PublicationPackageError, match="metadata"):
        verify_deterministic_archive(source, archive_path, finalized_at_utc=FINALIZED_AT)


def test_archive_writer_rejects_source_that_differs_from_authorized_inventory(tmp_path: Path) -> None:
    source = _source_tree(tmp_path)
    inventory = package_inventory(source)
    (source / "a.txt").write_text("changed\n", encoding="utf-8")

    with pytest.raises(PublicationPackageError, match="authorized expected_inventory"):
        write_deterministic_archive(
            source,
            tmp_path / "result.zip",
            finalized_at_utc=FINALIZED_AT,
            expected_inventory=inventory,
        )


def test_sha256_sidecar_is_exact_and_fail_closed(tmp_path: Path) -> None:
    archive_path = tmp_path / "artifact.zip"
    archive_path.write_bytes(b"exact bytes")
    sidecar = write_sha256_sidecar(archive_path)

    assert verify_sha256_sidecar(archive_path, sidecar)["path"] == "artifact.zip.sha256"
    sidecar.write_text("0" * 64 + "  artifact.zip\n", encoding="utf-8")
    with pytest.raises(PublicationPackageError, match="does not match"):
        verify_sha256_sidecar(archive_path, sidecar)
