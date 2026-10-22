# Runs every suite and reports one summary. Non-zero exit if anything fails.
#   powershell -File tests\run-all.ps1
#   powershell -File tests\run-all.ps1 -Offline    (skip the ones needing network)
param([switch]$Offline)

$ErrorActionPreference = "Continue"
$root = Split-Path $PSScriptRoot -Parent

$suites = @(
  @{ Name = "charts";               Cmd = "node";   Arg = "tests\test_chart.mjs";     Net = $false }
  @{ Name = "comparison deltas";    Cmd = "node";   Arg = "tests\test_compare.mjs";   Net = $false }
  @{ Name = "viewer framing";       Cmd = "node";   Arg = "tests\test_framing.mjs";   Net = $false }
  @{ Name = "plot shape";           Cmd = "node";   Arg = "tests\test_plot_shape.mjs"; Net = $false }
  @{ Name = "run field names";      Cmd = "node";   Arg = "tests\test_run_fields.mjs"; Net = $false }
  @{ Name = "run field names";      Cmd = "node";   Arg = "tests\test_auto_spec.mjs"; Net = $false }
  @{ Name = "results conversion";   Cmd = "node";   Arg = "tests	est_finish.mjs";   Net = $false }
  @{ Name = "data migration";       Cmd = "node";   Arg = "tests	est_migrate.mjs";  Net = $false }
  @{ Name = "money and RLS";        Cmd = "node";   Arg = "supabase	estsun.mjs"; Net = $true  }
  @{ Name = "wheel grouping";      Cmd = "python"; Arg = "tests\test_wheel_grouping.py"; Net = $false }
  @{ Name = "wheel detection";     Cmd = "python"; Arg = "tests\test_wheel_detection.py"; Net = $false }
  @{ Name = "drag direction";       Cmd = "python"; Arg = "tests\test_symmetry_plane.py";  Net = $false }
)

Push-Location $root
$failed = @()
$skipped = @()

foreach ($s in $suites) {
  if ($Offline -and $s.Net) { $skipped += $s.Name; continue }
  $out = & $s.Cmd $s.Arg 2>&1
  if ($LASTEXITCODE -eq 0) {
    $last = ($out | Where-Object { $_ -match '^ok' } | Select-Object -Last 1)
    "{0,-22} PASS  {1}" -f $s.Name, $last
  } else {
    "{0,-22} FAIL" -f $s.Name
    $out | Select-Object -Last 12 | ForEach-Object { "    $_" }
    $failed += $s.Name
  }
}
Pop-Location

""
if ($skipped) { "skipped (network): $($skipped -join ', ')" }
if ($failed) {
  "FAILED: $($failed -join ', ')"
  exit 1
}
"all suites passed"
