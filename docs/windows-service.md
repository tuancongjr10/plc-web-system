# PLC Web System - Windows Service Deployment

## Production architecture

Windows SCM starts **PLC Web System** through WinSW. WinSW launches one production `node.exe` process in `backend`, which serves the API, WebSocket `/ws`, and the compiled Vue SPA from `frontend/dist` on `0.0.0.0:80`. Vite, a reverse proxy, and port 5173 are not used in production.

The selected wrapper is **WinSW x64 2.12.0**, the latest stable release published by the WinSW project. It wraps an arbitrary executable, so its Node compatibility does not depend on Node module APIs. The installed Node version is `v24.19.0`.

- Release: https://github.com/winsw/winsw/releases/tag/v2.12.0
- XML/service options: https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md
- Wrapper SHA-256: `05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA`
- Note: the official release asset is not Authenticode-signed; it was downloaded from the official release URL and its version/hash are pinned above.

## Build and direct production start

Run from `D:\plc-web-system-export\backend`:

```powershell
npm.cmd run build:frontend
npm.cmd test
npm.cmd start
```

`npm start` runs `node scripts/start-production.js`, which sets production mode and starts the Node application without nodemon or Vite.

Production URLs:

- Local: `http://localhost`
- Friendly URL after the pending hostname reboot: `http://robolinks-tcjr`
- Current TP-Link/Wi-Fi address: `http://192.168.1.212`
- Current secondary address: `http://192.168.0.241`

The LAN URLs may change until the ThinkPad receives its separately planned static IP.

## Service commands

Run these from an Administrator terminal in `D:\plc-web-system-export\backend`:

```powershell
npm.cmd run service:install
npm.cmd run service:start
npm.cmd run service:status
npm.cmd run service:stop
npm.cmd run service:uninstall
```

The complete idempotent install checkpoint, including ACLs and the firewall rule, is:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-service-checkpoint.ps1
```

Service configuration:

- SCM ID: `PLCWebSystem`
- Display name: `PLC Web System`
- Startup: Automatic (Delayed Start)
- Recovery: restart after 10 seconds; failure count resets after one hour
- Account: `NT AUTHORITY\LocalService`
- Working directory: `D:\plc-web-system-export\backend`
- Listener: `0.0.0.0:80`

## Service account and printers

LocalService was selected instead of LocalSystem to reduce privileges. It can run the web server, access the SQLite/database directories granted by the deployment script, and open the unauthenticated PLC TCP connection.

LocalService does not share the interactive user's profile or per-user printer queues. A future real Godex/Zebra/TSC queue must be installed machine-wide with a driver accessible to LocalService, then verified under the service account. Microsoft Print to PDF Save-As is interactive and is not a supported production queue. PDF to Trace QR remains independent of desktop sessions and printers because the browser downloads the generated PDF directly.

## Fixed runtime paths

- Environment: `D:\plc-web-system-export\backend\.env`
- Runtime database: `D:\plc-web-system-export\backend\database\plc_system.db`
- Deployment backup: `D:\plc-web-system-export\backend\database\backups\plc_system-20260821-1136-service-checkpoint.db`
- Application logs: `D:\plc-web-system-export\backend\logs\app.log` and `app-error.log`
- WinSW logs: `D:\plc-web-system-export\backend\logs\service\PLCWebSystem.wrapper.log`, `.out.log`, `.err.log`
- Label temp: `D:\plc-web-system-export\backend\tmp\service\plc-web-system\labels`
- Scanner uploads: `D:\plc-web-system-export\backend\uploads\scans`
- Frontend: `D:\plc-web-system-export\frontend\dist`
- Trace QR: generated in memory and downloaded by the operator's browser; no server-side Downloads path

All application paths are resolved from the project/backend location, not the shell current directory.

## Friendly hostname

The computer rename is prepared without an automatic reboot. Run from an Administrator terminal:

```powershell
npm.cmd run hostname:prepare
```

Equivalent native command:

```powershell
Rename-Computer -NewName "robolinks-tcjr" -Force
```

The active hostname remains unchanged until an authorized manual Windows reboot. No IP adapter settings are changed.

## Firewall and TP-Link network profile

The installed firewall rule allows inbound TCP 80 on the Private profile only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\configure-firewall-private.ps1
```

Equivalent Administrator command:

```powershell
New-NetFirewallRule -DisplayName "PLC Web System TCP 80 (Private)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80 -Profile Private
```

At the friendly-URL checkpoint, `TP-Link_6F86` reports Windows NetworkCategory `Private`, so the TCP 80 rule applies. The deployment scripts do not change the network profile. If Windows later classifies this trusted factory network as Public, an administrator can restore it deliberately:

```powershell
Set-NetConnectionProfile -Name "TP-Link_6F86" -NetworkCategory Private
```

This changes the Windows trust profile only; it does not change the adapter IP. Apply it only while connected to the trusted factory TP-Link network.

## Reboot checklist (do not reboot automatically)

After an authorized manual reboot:

1. Confirm `$env:COMPUTERNAME` is `ROBOLINKS-TCJR`.
2. Run `npm.cmd run service:status`; expect `Started`.
3. Open `http://localhost/api/health`; expect server healthy and database `ok`.
4. Open `http://robolinks-tcjr`, `/dashboard`, `/printer`, and `/scanner` directly without Vite.
5. Confirm the operator can open `http://robolinks-tcjr` from another TP-Link client after the network is Private.
6. Confirm `logs/app.log` shows the existing database path and `Environment: production`.
7. If the PLC is off, confirm the UI remains available and PLC is offline/stale. When the PLC returns, observe the existing reconnect/telemetry behavior without restarting the service.
8. Before enabling physical label printing, verify the machine-wide printer queue is visible to LocalService.
9. Do not use Microsoft Print to PDF Save-As as a production service test.
