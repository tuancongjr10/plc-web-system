$ErrorActionPreference = 'Stop'
$targetName = 'robolinks-tcjr'
$resultDirectory = Join-Path ([System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) 'logs\service'
$resultPath = Join-Path $resultDirectory 'hostname-result.json'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdministrator) {
  throw 'Administrator privileges are required to rename this computer.'
}

$activeName = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName').ComputerName
$pendingName = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName').ComputerName

if ($activeName -ine $targetName -and $pendingName -ine $targetName) {
  Rename-Computer -NewName $targetName -Force -ErrorAction Stop
  $pendingName = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName').ComputerName
}

$result = [ordered]@{
  timestamp = (Get-Date).ToString('o')
  activeName = $activeName
  pendingName = $pendingName
  targetName = $targetName
  rebootRequired = ($activeName -ine $pendingName)
  rebootPerformed = $false
}

New-Item -ItemType Directory -Path $resultDirectory -Force | Out-Null
$result | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
$result | ConvertTo-Json

if ($result.rebootRequired) {
  Write-Warning 'Hostname rename is staged. Reboot Windows manually when authorized; this script does not reboot.'
}
