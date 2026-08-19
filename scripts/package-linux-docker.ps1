$ErrorActionPreference = "Stop"

$projectPath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releasePath = Join-Path $projectPath "apps\desktop\release"
$environmentPath = Join-Path $projectPath ".env"
New-Item -ItemType Directory -Force -Path $releasePath | Out-Null

$publicEnvironment = @{}
if (Test-Path $environmentPath) {
  foreach ($line in Get-Content -LiteralPath $environmentPath) {
    if ($line -match '^\s*(VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY)\s*=\s*(.*)\s*$') {
      $publicEnvironment[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
}
if (-not $publicEnvironment.VITE_SUPABASE_URL -or -not $publicEnvironment.VITE_SUPABASE_ANON_KEY) {
  throw "Defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no arquivo .env."
}

Write-Host "Gerando AppImage e DEB dentro de um container Linux..."
& docker build --file infrastructure/desktop/Dockerfile.linux --tag risk-p2p-linux-builder:local .
if ($LASTEXITCODE -ne 0) { throw "Não foi possível preparar a imagem Linux." }
& docker run --rm `
  --env "VITE_SUPABASE_URL=$($publicEnvironment.VITE_SUPABASE_URL)" `
  --env "VITE_SUPABASE_ANON_KEY=$($publicEnvironment.VITE_SUPABASE_ANON_KEY)" `
  --volume "${releasePath}:/project/apps/desktop/release" `
  --volume "risk-p2p-electron-cache:/root/.cache/electron" `
  --volume "risk-p2p-electron-builder-cache:/root/.cache/electron-builder" `
  risk-p2p-linux-builder:local
if ($LASTEXITCODE -ne 0) { throw "O empacotamento Linux falhou com código $LASTEXITCODE." }
Write-Host "Pacotes disponíveis em apps/desktop/release/."
