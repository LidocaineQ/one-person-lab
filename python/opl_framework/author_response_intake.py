"""Deterministic, domain-neutral author-response intake validation.

Domain owners define the requested facts, evidence expectations, authority
owners, placement inventory, and analysis-impact rules. OPL Framework validates
cross-document identity and fail-closed intake mechanics without interpreting
or supplying domain answers.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any


ALLOWED_ANSWER_STATUSES = (
    "provided",
    "owner_decision_pending",
    "not_available",
    "not_applicable_with_justification",
)

_RESPONSE_FIELDS = {
    "id",
    "answer_status",
    "fact_response",
    "evidence_locator",
    "approver_name",
    "approver_role",
    "approved_at",
    "authority_confirmation",
    "notes",
}

_MATRIX_ROW_FIELDS = {
    "item_id",
    "placement_id",
    "surface_kind",
    "surface_ref",
    "section",
    "exact_annotation",
    "responsible_owner",
    "category",
    "blocks_formal_submission",
    "registered_reanalysis_trigger",
    "response_status",
    "evidence_validation_status",
    "authority_validation_status",
    "analysis_impact_decision",
    "reanalysis_required",
    "integration_disposition",
    "independent_review_status",
}

_EVIDENCE_STATUSES = {"not_started", "accepted", "rejected"}
_AUTHORITY_STATUSES = {"not_started", "accepted", "rejected"}
_IMPACT_DECISIONS = {
    None,
    "no_analysis_change",
    "analysis_review_required",
    "reanalysis_required",
    "cannot_determine",
}
_INTEGRATION_DISPOSITIONS = {
    None,
    "hold",
    "text_only_candidate",
    "analysis_routeback",
    "required_owner_clarification",
}
_REVIEW_STATUSES = {"not_started", "pending", "passed", "failed"}


class AuthorResponseIntakeError(ValueError):
    """The author-response intake contract is invalid."""


def _object(value: object, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AuthorResponseIntakeError(f"{field} must be an object")
    return value


def _list(value: object, field: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise AuthorResponseIntakeError(f"{field} must be a list")
    return value


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AuthorResponseIntakeError(f"{field} must be a non-empty string")
    return value.strip()


def _bool(value: object, field: str) -> bool:
    if not isinstance(value, bool):
        raise AuthorResponseIntakeError(f"{field} must be a boolean")
    return value


def _nullable_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _text(value, field)


def _sha256_digest(value: object, field: str) -> str:
    digest = _text(value, field)
    if (
        len(digest) != 64
        or digest != digest.lower()
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise AuthorResponseIntakeError(f"{field} must be a lowercase SHA-256 digest")
    return digest


def _date_time(value: object, field: str) -> str:
    text = _text(value, field)
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise AuthorResponseIntakeError(f"{field} must be a valid ISO-8601 date-time") from error
    return text


def _load_json(path: Path, field: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuthorResponseIntakeError(f"unable to read {field}: {path}") from error
    return dict(_object(payload, field))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _identity(payload: Mapping[str, Any], field: str) -> tuple[str, str]:
    study_id = _text(payload.get("study_id"), f"{field}.study_id")
    generation = _text(payload.get("candidate_generation"), f"{field}.candidate_generation")
    return study_id, generation


def _require_non_authority(payload: Mapping[str, Any], field: str) -> None:
    if _bool(payload.get("authority"), f"{field}.authority"):
        raise AuthorResponseIntakeError(f"{field}.authority must remain false")
    if _bool(payload.get("submission_ready"), f"{field}.submission_ready"):
        raise AuthorResponseIntakeError(f"{field}.submission_ready must remain false")


def _registry_contract(
    registry: Mapping[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    _require_non_authority(registry, "registry")
    items: dict[str, dict[str, Any]] = {}
    placements: dict[str, dict[str, Any]] = {}
    for item_index, raw_item in enumerate(_list(registry.get("items"), "registry.items")):
        item = _object(raw_item, f"registry.items[{item_index}]")
        item_id = _text(item.get("id"), f"registry.items[{item_index}].id")
        if item_id in items:
            raise AuthorResponseIntakeError(f"registry item id is duplicated: {item_id}")
        normalized_item = {
            "responsible_owner": _text(
                item.get("responsible_owner"),
                f"registry.items[{item_index}].responsible_owner",
            ),
            "category": _text(item.get("category"), f"registry.items[{item_index}].category"),
            "blocks_formal_submission": _bool(
                item.get("blocks_formal_submission"),
                f"registry.items[{item_index}].blocks_formal_submission",
            ),
            "registered_reanalysis_trigger": _nullable_text(
                item.get("reanalysis_trigger"),
                f"registry.items[{item_index}].reanalysis_trigger",
            ),
        }
        item_placements = _list(
            item.get("placements"),
            f"registry.items[{item_index}].placements",
        )
        if not item_placements:
            raise AuthorResponseIntakeError(f"registry item must contain placements: {item_id}")
        for placement_index, raw_placement in enumerate(item_placements):
            placement = _object(
                raw_placement,
                f"registry.items[{item_index}].placements[{placement_index}]",
            )
            placement_id = _text(
                placement.get("placement_id"),
                f"registry.items[{item_index}].placements[{placement_index}].placement_id",
            )
            if placement_id in placements:
                raise AuthorResponseIntakeError(
                    f"registry placement id is duplicated: {placement_id}"
                )
            placements[placement_id] = {
                "item_id": item_id,
                "placement_id": placement_id,
                "surface_kind": _text(
                    placement.get("surface_kind"),
                    f"registry placement {placement_id}.surface_kind",
                ),
                "surface_ref": _text(
                    placement.get("surface_ref"),
                    f"registry placement {placement_id}.surface_ref",
                ),
                "section": _text(
                    placement.get("section"),
                    f"registry placement {placement_id}.section",
                ),
                "exact_annotation": _text(
                    placement.get("exact_annotation"),
                    f"registry placement {placement_id}.exact_annotation",
                ),
                **normalized_item,
            }
        items[item_id] = normalized_item
    if not items:
        raise AuthorResponseIntakeError("registry.items must not be empty")
    return items, placements


def _validate_source_binding(
    payload: Mapping[str, Any],
    field: str,
    registry_sha256: str,
) -> None:
    binding = _object(payload.get("source_binding"), f"{field}.source_binding")
    bound_digest = _sha256_digest(
        binding.get("author_input_registry_sha256"),
        f"{field}.source_binding.author_input_registry_sha256",
    )
    if bound_digest != registry_sha256:
        raise AuthorResponseIntakeError(
            f"{field} is not bound to the supplied author-input registry"
        )


def _validate_authority_confirmation(value: object, field: str) -> dict[str, Any]:
    confirmation = _object(value, field)
    expected_fields = {
        "confirmed_by_responsible_owner",
        "approval_scope",
        "authority_evidence_locator",
    }
    if set(confirmation) != expected_fields:
        raise AuthorResponseIntakeError(
            f"{field} must contain exactly {', '.join(sorted(expected_fields))}"
        )
    if not _bool(
        confirmation.get("confirmed_by_responsible_owner"),
        f"{field}.confirmed_by_responsible_owner",
    ):
        raise AuthorResponseIntakeError(
            f"{field}.confirmed_by_responsible_owner must be true"
        )
    return {
        "confirmed_by_responsible_owner": True,
        "approval_scope": _text(confirmation.get("approval_scope"), f"{field}.approval_scope"),
        "authority_evidence_locator": _text(
            confirmation.get("authority_evidence_locator"),
            f"{field}.authority_evidence_locator",
        ),
    }


def _validate_responses(
    response_document: Mapping[str, Any],
    items: Mapping[str, Mapping[str, Any]],
    *,
    expect_empty: bool,
) -> dict[str, str]:
    allowed = tuple(
        _text(status, f"response_document.allowed_answer_statuses[{index}]")
        for index, status in enumerate(
            _list(
                response_document.get("allowed_answer_statuses"),
                "response_document.allowed_answer_statuses",
            )
        )
    )
    if allowed != ALLOWED_ANSWER_STATUSES:
        raise AuthorResponseIntakeError(
            "response_document.allowed_answer_statuses does not match the Framework contract"
        )

    statuses: dict[str, str] = {}
    for index, raw_response in enumerate(
        _list(response_document.get("responses"), "response_document.responses")
    ):
        response = _object(raw_response, f"response_document.responses[{index}]")
        if set(response) != _RESPONSE_FIELDS:
            raise AuthorResponseIntakeError(
                f"response_document.responses[{index}] fields do not match the contract"
            )
        item_id = _text(response.get("id"), f"response_document.responses[{index}].id")
        if item_id in statuses:
            raise AuthorResponseIntakeError(f"response id is duplicated: {item_id}")
        status = _text(
            response.get("answer_status"),
            f"response_document.responses[{index}].answer_status",
        )
        if status not in ALLOWED_ANSWER_STATUSES:
            raise AuthorResponseIntakeError(f"response status is not allowed: {status}")

        content_fields = {
            "fact_response": response.get("fact_response"),
            "evidence_locator": response.get("evidence_locator"),
            "approver_name": response.get("approver_name"),
            "approver_role": response.get("approver_role"),
            "approved_at": response.get("approved_at"),
            "authority_confirmation": response.get("authority_confirmation"),
            "notes": response.get("notes"),
        }
        if status == "owner_decision_pending":
            if any(value is not None for value in content_fields.values()):
                raise AuthorResponseIntakeError(
                    f"pending response fields must remain null: {item_id}"
                )
        else:
            if status == "provided":
                _text(response.get("fact_response"), f"response {item_id}.fact_response")
            elif response.get("fact_response") is not None:
                raise AuthorResponseIntakeError(
                    f"non-provided response fact must remain null: {item_id}"
                )
            _text(response.get("evidence_locator"), f"response {item_id}.evidence_locator")
            _text(response.get("approver_name"), f"response {item_id}.approver_name")
            _text(response.get("approver_role"), f"response {item_id}.approver_role")
            _date_time(response.get("approved_at"), f"response {item_id}.approved_at")
            _validate_authority_confirmation(
                response.get("authority_confirmation"),
                f"response {item_id}.authority_confirmation",
            )
            if status != "provided":
                _text(response.get("notes"), f"response {item_id}.notes")
            else:
                _nullable_text(response.get("notes"), f"response {item_id}.notes")
        if expect_empty and status != "owner_decision_pending":
            raise AuthorResponseIntakeError(
                f"expect-empty requires every response to remain pending: {item_id}"
            )
        statuses[item_id] = status

    if set(statuses) != set(items):
        missing = sorted(set(items) - set(statuses))
        extra = sorted(set(statuses) - set(items))
        raise AuthorResponseIntakeError(
            f"response ids do not match registry ids; missing={missing}, extra={extra}"
        )
    return statuses


def build_empty_analysis_impact_matrix(
    registry: Mapping[str, Any],
    *,
    registry_sha256: str,
) -> dict[str, Any]:
    """Build a deterministic, blank placement-level impact decision matrix."""

    digest = _sha256_digest(registry_sha256, "registry_sha256")
    _, placements = _registry_contract(registry)
    study_id, generation = _identity(registry, "registry")
    rows = []
    for placement_id in sorted(placements):
        placement = placements[placement_id]
        rows.append(
            {
                **placement,
                "response_status": "owner_decision_pending",
                "evidence_validation_status": "not_started",
                "authority_validation_status": "not_started",
                "analysis_impact_decision": None,
                "reanalysis_required": None,
                "integration_disposition": None,
                "independent_review_status": "not_started",
            }
        )
    return {
        "surface_kind": "opl_author_response_analysis_impact_matrix.v1",
        "schema_version": 1,
        "study_id": study_id,
        "candidate_generation": generation,
        "authority": False,
        "submission_ready": False,
        "source_binding": {"author_input_registry_sha256": digest},
        "placement_count": len(rows),
        "rows": rows,
    }


def _validate_matrix_row_decisions(
    row: Mapping[str, Any],
    *,
    placement_id: str,
    expect_empty: bool,
) -> None:
    evidence_status = _text(
        row.get("evidence_validation_status"),
        f"impact_matrix row {placement_id}.evidence_validation_status",
    )
    authority_status = _text(
        row.get("authority_validation_status"),
        f"impact_matrix row {placement_id}.authority_validation_status",
    )
    review_status = _text(
        row.get("independent_review_status"),
        f"impact_matrix row {placement_id}.independent_review_status",
    )
    if evidence_status not in _EVIDENCE_STATUSES:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.evidence_validation_status is not allowed"
        )
    if authority_status not in _AUTHORITY_STATUSES:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.authority_validation_status is not allowed"
        )
    if review_status not in _REVIEW_STATUSES:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.independent_review_status is not allowed"
        )
    decision = row.get("analysis_impact_decision")
    disposition = row.get("integration_disposition")
    reanalysis_required = row.get("reanalysis_required")
    if decision not in _IMPACT_DECISIONS:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.analysis_impact_decision is not allowed"
        )
    if disposition not in _INTEGRATION_DISPOSITIONS:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.integration_disposition is not allowed"
        )
    if reanalysis_required is not None and not isinstance(reanalysis_required, bool):
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id}.reanalysis_required must be boolean or null"
        )
    if decision is None and (reanalysis_required is not None or disposition is not None):
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id} cannot set downstream decisions before impact assessment"
        )
    if decision == "no_analysis_change" and reanalysis_required is not False:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id} must set reanalysis_required=false"
        )
    if decision == "reanalysis_required" and reanalysis_required is not True:
        raise AuthorResponseIntakeError(
            f"impact_matrix row {placement_id} must set reanalysis_required=true"
        )
    if expect_empty and (
        evidence_status != "not_started"
        or authority_status != "not_started"
        or review_status != "not_started"
        or decision is not None
        or reanalysis_required is not None
        or disposition is not None
    ):
        raise AuthorResponseIntakeError(
            f"expect-empty requires impact decisions to remain blank: {placement_id}"
        )


def _validate_impact_matrix(
    impact_matrix: Mapping[str, Any],
    placements: Mapping[str, Mapping[str, Any]],
    response_statuses: Mapping[str, str],
    *,
    expect_empty: bool,
) -> bool:
    declared_count = impact_matrix.get("placement_count")
    if isinstance(declared_count, bool) or declared_count != len(placements):
        raise AuthorResponseIntakeError(
            "impact_matrix.placement_count does not match registry placements"
        )
    seen: set[str] = set()
    for index, raw_row in enumerate(_list(impact_matrix.get("rows"), "impact_matrix.rows")):
        row = _object(raw_row, f"impact_matrix.rows[{index}]")
        if set(row) != _MATRIX_ROW_FIELDS:
            raise AuthorResponseIntakeError(
                f"impact_matrix.rows[{index}] fields do not match the contract"
            )
        placement_id = _text(
            row.get("placement_id"),
            f"impact_matrix.rows[{index}].placement_id",
        )
        if placement_id in seen:
            raise AuthorResponseIntakeError(
                f"impact matrix placement id is duplicated: {placement_id}"
            )
        if placement_id not in placements:
            raise AuthorResponseIntakeError(
                f"impact matrix placement is not in the registry: {placement_id}"
            )
        expected = placements[placement_id]
        for field in (
            "item_id",
            "placement_id",
            "surface_kind",
            "surface_ref",
            "section",
            "exact_annotation",
            "responsible_owner",
            "category",
            "blocks_formal_submission",
            "registered_reanalysis_trigger",
        ):
            if row.get(field) != expected[field]:
                raise AuthorResponseIntakeError(
                    f"impact_matrix row {placement_id}.{field} does not match the registry"
                )
        response_status = _text(
            row.get("response_status"),
            f"impact_matrix row {placement_id}.response_status",
        )
        if response_status != response_statuses[expected["item_id"]]:
            raise AuthorResponseIntakeError(
                f"impact_matrix row {placement_id}.response_status does not match the response"
            )
        _validate_matrix_row_decisions(
            row,
            placement_id=placement_id,
            expect_empty=expect_empty,
        )
        seen.add(placement_id)
    if seen != set(placements):
        missing = sorted(set(placements) - seen)
        raise AuthorResponseIntakeError(
            f"impact matrix does not cover every registry placement; missing={missing}"
        )
    return all(
        row["evidence_validation_status"] == "not_started"
        and row["authority_validation_status"] == "not_started"
        and row["analysis_impact_decision"] is None
        and row["reanalysis_required"] is None
        and row["integration_disposition"] is None
        and row["independent_review_status"] == "not_started"
        for row in impact_matrix["rows"]
    )


def validate_author_response_intake(
    registry: Mapping[str, Any],
    response_document: Mapping[str, Any],
    impact_matrix: Mapping[str, Any],
    *,
    registry_sha256: str,
    expect_empty: bool = False,
) -> dict[str, Any]:
    """Validate registry, response, evidence, authority, and placement closure."""

    digest = _sha256_digest(registry_sha256, "registry_sha256")
    items, placements = _registry_contract(registry)
    registry_identity = _identity(registry, "registry")
    for field, payload in (
        ("response_document", response_document),
        ("impact_matrix", impact_matrix),
    ):
        _require_non_authority(payload, field)
        if _identity(payload, field) != registry_identity:
            raise AuthorResponseIntakeError(f"{field} identity does not match the registry")
        _validate_source_binding(payload, field, digest)

    statuses = _validate_responses(response_document, items, expect_empty=expect_empty)
    impact_decisions_empty = _validate_impact_matrix(
        impact_matrix,
        placements,
        statuses,
        expect_empty=expect_empty,
    )
    status_counts = {
        status: sum(value == status for value in statuses.values())
        for status in ALLOWED_ANSWER_STATUSES
    }
    pending = status_counts["owner_decision_pending"]
    return {
        "surface_kind": "opl_author_response_intake_validation.v1",
        "schema_version": 1,
        "status": "passed",
        "state": (
            "empty_template_validated_awaiting_author_input"
            if pending == len(items)
            else "responses_structurally_validated_domain_assessment_required"
        ),
        "study_id": registry_identity[0],
        "candidate_generation": registry_identity[1],
        "registry_sha256": digest,
        "registry_item_count": len(items),
        "registry_placement_count": len(placements),
        "blocking_item_count": sum(
            bool(item["blocks_formal_submission"]) for item in items.values()
        ),
        "response_status_counts": status_counts,
        "all_fact_fields_empty": pending == len(items),
        "all_evidence_fields_empty": pending == len(items),
        "all_authority_fields_empty": pending == len(items),
        "impact_decisions_empty": impact_decisions_empty,
        "intake_preparation_complete": True,
        "external_author_input_required": pending > 0,
        "domain_impact_assessment_required_after_response": True,
        "authority": False,
        "submission_ready": False,
        "writes_domain_truth": False,
        "writes_submission_package": False,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    render = subparsers.add_parser("render-impact-matrix")
    render.add_argument("--registry", type=Path, required=True)
    validate = subparsers.add_parser("validate")
    validate.add_argument("--registry", type=Path, required=True)
    validate.add_argument("--responses", type=Path, required=True)
    validate.add_argument("--impact-matrix", type=Path, required=True)
    validate.add_argument("--expect-empty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    registry = _load_json(args.registry, "registry")
    registry_sha256 = _sha256_file(args.registry)
    if args.command == "render-impact-matrix":
        result = build_empty_analysis_impact_matrix(
            registry,
            registry_sha256=registry_sha256,
        )
    else:
        result = validate_author_response_intake(
            registry,
            _load_json(args.responses, "responses"),
            _load_json(args.impact_matrix, "impact_matrix"),
            registry_sha256=registry_sha256,
            expect_empty=args.expect_empty,
        )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "ALLOWED_ANSWER_STATUSES",
    "AuthorResponseIntakeError",
    "build_empty_analysis_impact_matrix",
    "validate_author_response_intake",
]
