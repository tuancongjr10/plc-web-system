$ErrorActionPreference = 'Stop'
$backendRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resultPath = Join-Path $backendRoot 'logs\service\deployment-result.json'
$errorPath = Join-Path $backendRoot 'logs\service\deployment-error.log'
trap {
  $_ | Format-List * -Force | Out-String | Set-Content -LiteralPath $errorPath -Encoding UTF8
  exit 1
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'prepare-service-directories.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Service directory preparation failed' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'configure-firewall-private.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Firewall configuration failed' }

Set-Location $backendRoot
$service = Get-Service -Name 'PLCWebSystem' -ErrorAction SilentlyContinue
if (-not $service) {
  & npm.cmd run service:install
  if ($LASTEXITCODE -ne 0) { throw 'PLC Web System service installation failed' }
}

$service = Get-Service -Name 'PLCWebSystem'
if ($service.Status -eq 'Running') {
  $serviceProcess = Get-CimInstance Win32_Service -Filter "Name='PLCWebSystem'"
  $nodeProcess = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $serviceProcess.ProcessId -and $_.Name -eq 'node.exe' } | Select-Object -First 1
  $port80Listener = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $nodeProcess.ProcessId } | Select-Object -First 1
  if (-not $port80Listener) {
    Stop-Service -Name 'PLCWebSystem' -Force
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    $service = Get-Service -Name 'PLCWebSystem'
  }
}

if ($service.Status -ne 'Running') {
  & npm.cmd run service:start
  if ($LASTEXITCODE -ne 0) { throw 'PLC Web System service start failed' }
}

$runtimeService = Get-Service -Name 'PLCWebSystem'
$runtimeService.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))
$service = Get-CimInstance Win32_Service -Filter "Name='PLCWebSystem'"
$firewall = Get-NetFirewallRule -DisplayName 'PLC Web System TCP 80 (Private)'
$nodeProcess = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $service.ProcessId -and $_.Name -eq 'node.exe' } | Select-Object -First 1
if (-not $nodeProcess) { throw 'PLC Web System Node child process was not found' }
$listener = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq $nodeProcess.ProcessId } | Select-Object -First 1
if (-not $listener) { throw 'PLC Web System Node process is not listening on TCP 80' }
$networkProfiles = @(Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory, IPv4Connectivity)
$result = [ordered]@{
  timestamp = (Get-Date).ToString('o')
  serviceName = $service.Name
  displayName = $service.DisplayName
  state = $service.State
  startMode = $service.StartMode
  startName = $service.StartName
  pathName = $service.PathName
  processId = $service.ProcessId
  nodeProcessId = $nodeProcess.ProcessId
  listenAddress = $listener.LocalAddress
  listenPort = $listener.LocalPort
  firewallEnabled = [string]$firewall.Enabled
  firewallProfile = [string]$firewall.Profile
  networkProfiles = $networkProfiles
  rebooted = $false
}
$result | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
$result | ConvertTo-Json
