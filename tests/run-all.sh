#!/usr/bin/env sh
# Everything that can be checked without a database or a credit.
#
# Runs all of them and reports at the end, rather than stopping at the first
# failure: when the design audit fails on a pre-existing rule in the marketing
# stylesheet, that is not a reason to skip the contrast audit behind it.
#
# The database suites need a Supabase project (SUPABASE_DB_URL, see
# supabase/README.md), so they run only with --db:
#   sh tests/run-all.sh --db
cd "$(dirname "$0")/.."
failed=""

run() {
  name="$1"
  shift
  printf '%-20s ' "$name"
  if "$@"; then :; else failed="$failed $name"; fi
}

run test_pricing      node tests/test_pricing.mjs
run test_chart        node tests/test_chart.mjs
run test_compare      node tests/test_compare.mjs
run test_framing      node tests/test_framing.mjs
run test_plot_shape   node tests/test_plot_shape.mjs
run test_frontal_area node tests/test_frontal_area.mjs
run test_run_fields   node tests/test_run_fields.mjs
run test_auto_spec    node tests/test_auto_spec.mjs
run test_clamp        node tests/test_clamp_paid_run.mjs
run test_safe_path    node tests/test_safe_path.mjs
run test_quantities   node tests/test_quantities.mjs
run test_symmetry_plane    python tests/test_symmetry_plane.py
run test_wheel_grouping    python tests/test_wheel_grouping.py
run test_wheel_detection    python tests/test_wheel_detection.py
run test_cut_car_out    python tests/test_cut_car_out.py
run test_transform    python tests/test_transform.py
run results_export    python tests/test_results_export.py
run openfoam_export   python tests/test_openfoam_export.py

echo
run design-audit      node scripts/design-audit.mjs
run contrast-audit    node scripts/contrast-audit.mjs
run palette-audit    node scripts/palette-audit.mjs
run token-audit    node scripts/token-audit.mjs
run orphan-classes    node scripts/orphan-classes.mjs
run legacy-model      node scripts/legacy-model-audit.mjs
run type-audit        node scripts/type-audit.mjs

if [ "$1" = "--db" ]; then
  run money-suite       node supabase/tests/run.mjs
  run poller-lock       node supabase/tests/lock.mjs
fi

echo
if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "all green"
