#!/usr/bin/env bash
set -u -o pipefail

compare_ref="${OPL_QUALITY_DETAILS_COMPARE_REF:-origin/main}"
quality_details_bin="${OPL_QUALITY_DETAILS_BIN:-./bin/opl}"
quality_details_limit="${OPL_QUALITY_DETAILS_LIMIT:-30}"
quality_details_focus="${OPL_QUALITY_DETAILS_FOCUS:-auto}"
quality_details_timeout_seconds="${OPL_QUALITY_DETAILS_TIMEOUT_SECONDS:-240}"

run_quality_details_with_timeout() {
  local resolved_compare_ref="$1"

  node ./scripts/run-quality-details-with-timeout.mjs \
    "$quality_details_timeout_seconds" \
    "$quality_details_bin" \
    "$resolved_compare_ref" \
    "$quality_details_limit" \
    "$quality_details_focus"
}

emit_quality_details() {
  local reason="$1"
  local resolved_compare_ref="$compare_ref"

  echo
  echo "## OPL quality details (${reason})"
  if ! git rev-parse --verify "${resolved_compare_ref}^{commit}" >/dev/null 2>&1; then
    if git rev-parse --verify "HEAD^" >/dev/null 2>&1; then
      echo "::notice::Compare ref ${compare_ref} is unavailable; using HEAD^ for quality details." >&2
      resolved_compare_ref="HEAD^"
    fi
  fi
  run_quality_details_with_timeout "$resolved_compare_ref"
  local details_status=$?
  if [ "$details_status" -eq 124 ]; then
    echo "::warning::OPL quality details exceeded ${quality_details_timeout_seconds}s in the local structure gate; rerun opl quality details directly with a larger timeout for full output." >&2
  elif [ "$details_status" -ne 0 ]; then
    echo "::warning::OPL quality details failed for compare ref: ${resolved_compare_ref}" >&2
  fi
}

run_gate() {
  if [ ! -f .sentrux/baseline.json ]; then
    echo "::notice::No .sentrux/baseline.json found; skipping Sentrux gate."
    return 0
  fi

  sentrux gate .
  local status=$?
  if [ "$status" -ne 0 ]; then
    emit_quality_details "sentrux baseline regression advisory"
    echo "::warning::Sentrux baseline regression reported structural drift; quality details were emitted for triage. Structural quality findings are advisory and must be resolved through an owner-scoped refactor, not a generic blocking gate." >&2
    return 0
  fi
}

run_rules_check() {
  if [ ! -f .sentrux/rules.toml ]; then
    echo "Sentrux explicit rules are not configured; baseline regression checks remain active."
    return 0
  fi

  sentrux check .
  local status=$?
  if [ "$status" -ne 0 ]; then
    emit_quality_details "sentrux rules advisory"
    echo "::warning::Sentrux explicit rules reported structural drift. The finding remains advisory; use it to select a natural refactor boundary rather than blocking unrelated work." >&2
    return 0
  fi
}

run_gate || exit $?
run_rules_check || exit $?
