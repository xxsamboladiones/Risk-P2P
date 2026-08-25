param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path
)

$resolvedFiles = foreach ($candidate in $Path) {
  Get-ChildItem -Path $candidate -File -ErrorAction SilentlyContinue
}

if (-not $resolvedFiles) {
  throw "Nenhum executável foi encontrado para validar a assinatura Authenticode."
}

foreach ($file in $resolvedFiles) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne "Valid") {
    throw "Assinatura inválida ou ausente em $($file.FullName): $($signature.Status) $($signature.StatusMessage)"
  }
  Write-Host "Assinatura Authenticode válida: $($file.Name)"
}
