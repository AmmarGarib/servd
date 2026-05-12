# Bulk-replace tenantId reads with tenantFilter so portfolio mode works
# across every route. Only touches lines that look like Prisma where filters
# (anything matching `concept: { tenantId: req.staffUser!.tenantId` or a
# bare `{ tenantId: req.staffUser!.tenantId, ... }` shape).
#
# Writes — `data: { tenantId: req.staffUser!.tenantId }` — stay as-is
# because the regex matches on `concept: {` prefix or being inside `where`
# context. We do NOT use a broad replace of every occurrence; that would
# break Prisma create() calls which require a single string.
#
# Patterns covered:
#   1. concept: { tenantId: req.staffUser!.tenantId, ... }
#   2. concept: { tenantId: req.staffUser?.tenantId, ... }
#   3. (bareword) tenantId: req.staffUser!.tenantId followed by comma + a
#      field that's clearly part of a where filter (e.g. deletedAt,
#      isActive). Skips `data: { tenantId: ... }`.
#
# Run from c:\Dev\servd\backend.

$files = Get-ChildItem -Path "src/modules" -Filter "*.ts" -Recurse |
  Where-Object { Select-String -Path $_.FullName -Pattern "req\.staffUser[!?]\.tenantId" -Quiet }

$totalChanges = 0
foreach ($f in $files) {
  $orig = Get-Content -Raw $f.FullName
  $next = $orig

  # 1. Nested via concept: { tenantId: ... }
  #    These are always reads (concept relation filters never appear in writes).
  $next = $next -replace 'concept:\s*\{\s*tenantId:\s*req\.staffUser!\.tenantId', 'concept: { tenantId: req.staffUser!.tenantFilter'
  $next = $next -replace 'concept:\s*\{\s*tenantId:\s*req\.staffUser\?\.tenantId', 'concept: { tenantId: req.staffUser?.tenantFilter'

  # 2. order: { concept: { tenantId: ... } }
  #    (Same pattern, one level deeper; the previous regex already covers it
  #     because we don't anchor the start.)

  # 3. Bare `tenantId: req.staffUser!.tenantId, deletedAt:` shape — the
  #    `deletedAt:` neighbour pins it as a where clause, not a create data.
  $next = $next -replace 'tenantId:\s*req\.staffUser!\.tenantId,\s*deletedAt', 'tenantId: req.staffUser!.tenantFilter, deletedAt'
  $next = $next -replace 'tenantId:\s*req\.staffUser\?\.tenantId,\s*deletedAt', 'tenantId: req.staffUser?.tenantFilter, deletedAt'

  # 4. `where: { tenantId: req.staffUser!.tenantId` — clear where filter.
  $next = $next -replace 'where:\s*\{\s*tenantId:\s*req\.staffUser!\.tenantId', 'where: { tenantId: req.staffUser!.tenantFilter'
  $next = $next -replace 'where:\s*\{\s*tenantId:\s*req\.staffUser\?\.tenantId', 'where: { tenantId: req.staffUser?.tenantFilter'

  # 5. `OR: [ ... concept: { tenantId: ... } ... ]` already covered by #1.

  if ($next -ne $orig) {
    Set-Content -Path $f.FullName -Value $next -NoNewline
    # Count how many lines changed for the summary.
    $diffCount = 0
    $origLines = $orig -split "`n"
    $nextLines = $next -split "`n"
    for ($i = 0; $i -lt $origLines.Length; $i++) {
      if ($origLines[$i] -ne $nextLines[$i]) { $diffCount++ }
    }
    $totalChanges += $diffCount
    Write-Host ("{0,-60} {1} line(s) updated" -f $f.FullName.Substring($f.FullName.IndexOf('src/modules')), $diffCount)
  }
}

Write-Host ""
Write-Host "Done. $totalChanges line(s) updated across $($files.Count) file(s)."
