# Second pass — handle the `const tenantId = req.staffUser!.tenantId` pattern
# that the first sweep skipped.
#
# Strategy:
#   • Replace ` const tenantId = req.staffUser!.tenantId` with
#     `const tenantId = req.staffUser!.tenantFilter` so the variable carries
#     the portfolio-aware union into every where clause that uses it.
#   • The same variable name still serves writes (Prisma create) — we just
#     spot-check after for type errors and fix manually.
#
# Lines where the bang-assertion form `tenantId!` is used (i.e.
# kitchen-staff/routes.ts uses `tenantId!` because it knows it can't be null
# inside the handler) get the same swap — TypeScript's flow analysis still
# works because tenantFilter has the same nullable type.

$files = Get-ChildItem -Path "src/modules" -Filter "*.ts" -Recurse |
  Where-Object { Select-String -Path $_.FullName -Pattern "const tenantId\s*=\s*req\.staffUser!\.tenantId" -Quiet }

$changed = 0
foreach ($f in $files) {
  $orig = Get-Content -Raw $f.FullName
  $next = $orig -replace 'const tenantId(\!?)\s*=\s*req\.staffUser!\.tenantId', 'const tenantId$1 = req.staffUser!.tenantFilter'
  if ($next -ne $orig) {
    Set-Content -Path $f.FullName -Value $next -NoNewline
    $changed++
    Write-Host ("updated: " + $f.Name)
  }
}
Write-Host ""
Write-Host "$changed file(s) updated."
