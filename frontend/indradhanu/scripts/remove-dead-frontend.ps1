# Delete the frontend modules nothing imports any more.
#
# Every screen now reads the live API, so the scripted world that stood in for
# it before the backend existed is dead code: the mock client and its fixtures,
# the scenario stepper that drove them, the guided tour that narrated them, the
# two portals that CitizenApp and FieldApp replaced, and two files already
# reduced to re-export stubs.
#
# Kept deliberately: `api/httpClient.ts` (the real client), `components/map/
# LiveMap.tsx` (MapView's replacement), and everything under `components/ui`.
#
# Run from the repo root:   powershell -ExecutionPolicy Bypass -File frontend\indradhanu\scripts\remove-dead-frontend.ps1
# Nothing here is referenced by `src/App.tsx` or anything it reaches; run
# `npm run build` afterwards and it should still be clean.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # .../frontend/indradhanu

$targets = @(
  'src/api/client.ts',
  'src/api/types.ts',
  'src/api/mock',
  'src/hooks/useApi.ts',
  'src/scenario',
  'src/components/tour',
  'src/components/map/MapView.tsx',
  'src/routes/citizen/CitizenPortal.tsx',
  'src/routes/field/FieldPortal.tsx',
  'src/routes/admin/LiveOps.tsx',
  'src/routes/demo/MapCanvas.tsx'
)

foreach ($t in $targets) {
  $path = Join-Path $root $t
  if (Test-Path $path) {
    Remove-Item -Recurse -Force $path
    Write-Host "removed  $t"
  } else {
    Write-Host "missing  $t (already gone)"
  }
}

Write-Host ''
Write-Host 'Now run: npm run build'
