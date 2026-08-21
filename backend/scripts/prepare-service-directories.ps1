$ErrorActionPreference = 'Stop'
$backendRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $backendRoot '..'))

$writeDirectories = @(
  (Join-Path $backendRoot 'database'),
  (Join-Path $backendRoot 'logs'),
  (Join-Path $backendRoot 'logs\service'),
  (Join-Path $backendRoot 'uploads'),
  (Join-Path $backendRoot 'uploads\scans'),
  (Join-Path $backendRoot 'tmp\service')
)

foreach ($directory in $writeDirectories) {
  $resolved = [System.IO.Path]::GetFullPath($directory)
  if (-not $resolved.StartsWith($workspaceRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to prepare path outside workspace: $resolved"
  }
  New-Item -ItemType Directory -Path $resolved -Force | Out-Null
  & icacls.exe $resolved /grant '*S-1-5-19:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to grant LocalService access to $resolved" }
}

Write-Output "Prepared LocalService write access under $backendRoot"
