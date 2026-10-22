#!/usr/bin/env sh
# Everything that can be checked without the emulator suite or a credit.
#
# Runs all of them and reports at the end, rather than stopping at the first
# failure: when the design audit fails on a pre-existing rule in the marketing
# stylesheet, that is not a reason to skip the contrast audit behind it.
#
# The two rules suites need the emulator, so they run only with --emulator:
#   sh tests/run-all.sh --emulator
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
run test_client_ip    node tests/test_client_ip.mjs
run test_google_only  node tests/test_google_only.mjs
run test_quantities   node tests/test_quantities.mjs
run test_summarise    python tests/test_summarise.py
run test_drag_sign    python tests/test_drag_sign.py
run test_half_car     python tests/test_half_car.py
run test_symmetry_plane    python tests/test_symmetry_plane.py
run test_wheel_grouping    python tests/test_wheel_grouping.py
run test_wheel_detection    python tests/test_wheel_detection.py
run test_cut_car_out    python tests/test_cut_car_out.py
run test_service_names    python tests/test_service_names.py
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
run csp-audit         node scripts/csp-audit.mjs
run type-audit        node scripts/type-audit.mjs

if [ "$1" = "--emulator" ]; then
  echo
  printf '%-20s ' "rules suites"
  echo "(starting emulators)"
  # functions too: onUserCreate is a *blocking* auth function, so without the
  # functions emulator the security suite waits forever for an account document
  # that nothing is going to write.
  if npx firebase-tools emulators:exec --only auth,firestore,storage,functions        --project demo-turboflow        "node tests/test_security.mjs && node tests/test_storage_rules.mjs"; then :;
  else failed="$failed rules"; fi
fi

echo
if [ -n "$failed" ]; then
  echo "FAILED:$failed"
  exit 1
fi
echo "all green"
