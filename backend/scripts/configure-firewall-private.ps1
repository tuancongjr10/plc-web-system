$ErrorActionPreference = 'Stop'
$displayName = 'PLC Web System TCP 80 (Private)'
$existing = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue

if ($existing) {
  Set-NetFirewallRule -DisplayName $displayName -Enabled True -Direction Inbound -Action Allow -Profile Private
} else {
  New-NetFirewallRule -DisplayName $displayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -Profile Private | Out-Null
}

Write-Output "Firewall rule ready: $displayName"
