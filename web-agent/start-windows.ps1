$ErrorActionPreference = "Stop"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ non trovato. Installare Node.js LTS e riprovare." -ForegroundColor Red
  exit 1
}
if (-not $env:CDA_WEB_BRIDGE_ORIGIN) {
  $env:CDA_WEB_BRIDGE_ORIGIN = Read-Host "URL PWA autorizzata (es. http://172.31.0.29 oppure https://cpe.cda-net.it)"
}
Write-Host "Installazione dipendenze Web Bridge..."
npm install --omit=dev
Write-Host "Avvio CDA Net Web Bridge..."
node server.mjs
