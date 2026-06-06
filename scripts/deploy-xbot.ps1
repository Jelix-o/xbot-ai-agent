param(
  [string]$HostName = "ubuntu@43.213.52.97",
  [string]$KeyPath = "$HOME\.ssh\jelix.pem",
  [string]$RemoteDir = "/opt/xbot",
  [string]$Version = "1.2.0"
)

$ErrorActionPreference = "Stop"

$node22 = "D:\environment\nvm\v22.17.0"
if (Test-Path $node22) {
  $env:PATH = "$node22;$env:PATH"
}

npm run build

ssh -i $KeyPath $HostName "mkdir -p $RemoteDir"

$packagePath = "release/xbot-v$Version.tar.gz"
if (Test-Path $packagePath) {
  Remove-Item -LiteralPath $packagePath -Force
}

tar --exclude="config/users.json" --exclude="release/*.tar.gz" -czf $packagePath @(
  "admin",
  "config",
  "dist",
  "release",
  "skills",
  ".env.example",
  "COMMANDS.md",
  "README.md",
  "package-lock.json",
  "package.json"
)

scp -i $KeyPath $packagePath "${HostName}:/tmp/xbot-v$Version.tar.gz"
ssh -i $KeyPath $HostName "mkdir -p $RemoteDir && tar -xzf /tmp/xbot-v$Version.tar.gz -C $RemoteDir && cd $RemoteDir && npm ci --omit=dev"

Write-Host "Uploaded XBot to ${HostName}:${RemoteDir}"
Write-Host "Server .env, data/, and config/users.json are preserved by the package."
Write-Host "Install release/xbot.service as /etc/systemd/system/xbot.service after .env is configured."
