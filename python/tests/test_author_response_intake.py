from __future__ import annotations

import pytest

from opl_framework.author_response_intake import (
    AuthorResponseIntakeError,
    build_empty_analysis_impact_matrix,
    validate_author_response_intake,
)


REGISTRY_SHA256 = "a" * 64


def registry():
    return {
        "study_id": "study-001",
        "candidate_generation": "v1",
        "authority": False,
        "submission_ready": False,
        "items": [
            {
                "id": "FACT_A",
                "responsible_owner": "data owner",
                "category": "scientific_fact",
                "blocks_formal_submission": True,
                "reanalysis_trigger": "reassess if cohort membership changes",
                "placements": [
                    {
                        "placement_id": "FACT_A-P01",
                        "surface_kind": "manuscript_text",
                        "surface_ref": "draft.md",
                        "section": "Methods",
                        "exact_annotation": "[AUTHOR INPUT: FACT_A]",
                    },
                    {
                        "placement_id": "FACT_A-P02",
                        "surface_kind": "declarations",
                        "surface_ref": "declarations.md",
                        "section": "Data governance",
                        "exact_annotation": "[AUTHOR INPUT: FACT_A]",
                    },
                ],
            },
            {
                "id": "OWNER_B",
                "responsible_owner": "lead author",
                "category": "author_metadata",
                "blocks_formal_submission": True,
                "placements": [
                    {
                        "placement_id": "OWNER_B-P01",
                        "surface_kind": "title_page",
                        "surface_ref": "title_page.md",
                        "section": "Authors",
                        "exact_annotation": "[AUTHOR INPUT: OWNER_B]",
                    }
                ],
            },
        ],
    }


def responses():
    return {
        "study_id": "study-001",
        "candidate_generation": "v1",
        "authority": False,
        "submission_ready": False,
        "source_binding": {"author_input_registry_sha256": REGISTRY_SHA256},
        "allowed_answer_statuses": [
            "provided",
            "owner_decision_pending",
            "not_available",
            "not_applicable_with_justification",
        ],
        "responses": [
            {
                "id": item_id,
                "answer_status": "owner_decision_pending",
                "fact_response": None,
                "evidence_locator": None,
                "approver_name": None,
                "approver_role": None,
                "approved_at": None,
                "authority_confirmation": None,
                "notes": None,
            }
            for item_id in ("FACT_A", "OWNER_B")
        ],
    }


def test_empty_intake_and_placement_matrix_validate_exactly() -> None:
    source = registry()
    matrix = build_empty_analysis_impact_matrix(
        source,
        registry_sha256=REGISTRY_SHA256,
    )

    result = validate_author_response_intake(
        source,
        responses(),
        matrix,
        registry_sha256=REGISTRY_SHA256,
        expect_empty=True,
    )

    assert result["state"] == "empty_template_validated_awaiting_author_input"
    assert result["registry_item_count"] == 2
    assert result["registry_placement_count"] == 3
    assert result["response_status_counts"]["owner_decision_pending"] == 2
    assert result["all_fact_fields_empty"] is True
    assert result["all_evidence_fields_empty"] is True
    assert result["all_authority_fields_empty"] is True
    assert result["impact_decisions_empty"] is True
    assert result["authority"] is False
    assert matrix == build_empty_analysis_impact_matrix(
        source,
        registry_sha256=REGISTRY_SHA256,
    )


def test_provided_response_requires_evidence_and_owner_authority() -> None:
    response = responses()
    supplied = response["responses"][0]
    supplied.update(
        {
            "answer_status": "provided",
            "fact_response": "Author-approved fact.",
            "approver_name": "Owner",
            "approver_role": "Data custodian",
            "approved_at": "2026-07-26T00:00:00Z",
            "authority_confirmation": {
                "confirmed_by_responsible_owner": True,
                "approval_scope": "FACT_A",
                "authority_evidence_locator": "attestation:1",
            },
        }
    )
    matrix = build_empty_analysis_impact_matrix(
        registry(),
        registry_sha256=REGISTRY_SHA256,
    )
    for row in matrix["rows"]:
        if row["item_id"] == "FACT_A":
            row["response_status"] = "provided"

    with pytest.raises(AuthorResponseIntakeError, match="evidence_locator"):
        validate_author_response_intake(
            registry(),
            response,
            matrix,
            registry_sha256=REGISTRY_SHA256,
        )

    supplied["evidence_locator"] = "protocol:section-2"
    supplied["authority_confirmation"]["confirmed_by_responsible_owner"] = False
    with pytest.raises(AuthorResponseIntakeError, match="must be true"):
        validate_author_response_intake(
            registry(),
            response,
            matrix,
            registry_sha256=REGISTRY_SHA256,
        )


def test_intake_rejects_response_id_or_registry_binding_drift() -> None:
    response = responses()
    response["responses"][1]["id"] = "UNKNOWN"
    with pytest.raises(AuthorResponseIntakeError, match="do not match registry ids"):
        validate_author_response_intake(
            registry(),
            response,
            build_empty_analysis_impact_matrix(
                registry(),
                registry_sha256=REGISTRY_SHA256,
            ),
            registry_sha256=REGISTRY_SHA256,
            expect_empty=True,
        )

    response = responses()
    response["source_binding"]["author_input_registry_sha256"] = "b" * 64
    with pytest.raises(AuthorResponseIntakeError, match="not bound"):
        validate_author_response_intake(
            registry(),
            response,
            build_empty_analysis_impact_matrix(
                registry(),
                registry_sha256=REGISTRY_SHA256,
            ),
            registry_sha256=REGISTRY_SHA256,
            expect_empty=True,
        )


def test_intake_rejects_placement_or_decision_drift() -> None:
    matrix = build_empty_analysis_impact_matrix(
        registry(),
        registry_sha256=REGISTRY_SHA256,
    )
    matrix["rows"][0]["section"] = "Results"
    with pytest.raises(AuthorResponseIntakeError, match="does not match the registry"):
        validate_author_response_intake(
            registry(),
            responses(),
            matrix,
            registry_sha256=REGISTRY_SHA256,
            expect_empty=True,
        )

    matrix = build_empty_analysis_impact_matrix(
        registry(),
        registry_sha256=REGISTRY_SHA256,
    )
    matrix["rows"][0]["reanalysis_required"] = False
    with pytest.raises(AuthorResponseIntakeError, match="before impact assessment"):
        validate_author_response_intake(
            registry(),
            responses(),
            matrix,
            registry_sha256=REGISTRY_SHA256,
        )


def test_intake_rejects_authority_or_submission_elevation() -> None:
    response = responses()
    response["authority"] = True
    with pytest.raises(AuthorResponseIntakeError, match="authority must remain false"):
        validate_author_response_intake(
            registry(),
            response,
            build_empty_analysis_impact_matrix(
                registry(),
                registry_sha256=REGISTRY_SHA256,
            ),
            registry_sha256=REGISTRY_SHA256,
            expect_empty=True,
        )

    matrix = build_empty_analysis_impact_matrix(
        registry(),
        registry_sha256=REGISTRY_SHA256,
    )
    matrix["submission_ready"] = True
    with pytest.raises(AuthorResponseIntakeError, match="submission_ready must remain false"):
        validate_author_response_intake(
            registry(),
            responses(),
            matrix,
            registry_sha256=REGISTRY_SHA256,
            expect_empty=True,
        )


def test_empty_decisions_are_observed_without_expect_empty_mode() -> None:
    source = registry()
    matrix = build_empty_analysis_impact_matrix(
        source,
        registry_sha256=REGISTRY_SHA256,
    )

    result = validate_author_response_intake(
        source,
        responses(),
        matrix,
        registry_sha256=REGISTRY_SHA256,
    )

    assert result["impact_decisions_empty"] is True
