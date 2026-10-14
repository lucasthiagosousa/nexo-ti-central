param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$Port,

  [string]$DataRoot = "$env:ProgramData\NexoTI\CentralOperacoes",

  [switch]$VerifyOnly
)

$ErrorActionPreference = "Stop"
$firewallRuleName = "Nexo TI - Central de Operacoes"

if ($VerifyOnly) {
  $url = "http://127.0.0.1:$Port/login.html"
  $lastError = $null

  for ($attempt = 1; $attempt -le 12; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
        Write-Host "Servidor validado em $url"
        exit 0
      }
    }
    catch {
      $lastError = $_
      Start-Sleep -Seconds 2
    }
  }

  $logPath = Join-Path $DataRoot "logs"
  throw "O serviço foi instalado, mas não respondeu na porta $Port. Consulte os logs em $logPath. Erro: $lastError"
}

$directories = @(
  $DataRoot,
  (Join-Path $DataRoot "dados"),
  (Join-Path $DataRoot "logs")
)

foreach ($directory in $directories) {
  New-Item -Path $directory -ItemType Directory -Force | Out-Null
}

# Somente SYSTEM e administradores locais acessam banco, credenciais e logs.
& icacls.exe $DataRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Não foi possível proteger a pasta de dados $DataRoot."
}

Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule -DisplayName $firewallRuleName -Direction Inbound -Action Allow -Enabled True -Profile Private -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet | Out-Null

# Recria o registro do serviço de forma idempotente. Ao atualizar o executável
# do wrapper, o Windows precisa concluir a exclusão anterior antes do novo registro.
$serviceName = "NexoTICentral"
$serviceExe = Join-Path $PSScriptRoot "NexoTICentral.exe"
if (-not (Test-Path $serviceExe)) {
  throw "Executável do serviço não encontrado em $serviceExe."
}

$existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existingService) {
  # Em atualizações, o caminho do serviço permanece o mesmo. Reutilizar o
  # registro existente evita o estado transitório do SCM em que o wrapper
  # aparece como Running, mas o processo Node não é iniciado.
  if ($existingService.Status -ne "Stopped") {
    Stop-Service -Name $serviceName -Force -ErrorAction Stop
    $existingService.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
  }
  $existingService.Dispose()
  $existingService = $null
}
else {
  $installOutput = & $serviceExe install 2>&1
  $installExitCode = $LASTEXITCODE
  if ($installExitCode -ne 0) {
    throw "Não foi possível registrar o serviço $serviceName. Código: $installExitCode. Detalhes: $($installOutput -join ' ')"
  }
}

# Use sc.exe e consultas novas a cada tentativa. Isso evita o cache interno de
# ServiceController observado durante uma atualização executada pelo Inno Setup.
$startOutput = & sc.exe start $serviceName 2>&1
$startExitCode = $LASTEXITCODE
if ($startExitCode -ne 0 -and ($startOutput -join " ") -notmatch "1056") {
  throw "Não foi possível iniciar o serviço $serviceName. Código: $startExitCode. Detalhes: $($startOutput -join ' ')"
}

$serviceStatus = $null
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  $serviceStatus = (Get-Service -Name $serviceName -ErrorAction Stop).Status
  if ($serviceStatus -eq "Running") {
    break
  }
}

if ($serviceStatus -ne "Running") {
  throw "O serviço $serviceName foi registrado, mas não iniciou. Estado: $serviceStatus."
}

# Confirma que o processo não iniciou e caiu imediatamente.
Start-Sleep -Seconds 3
$serviceStatus = (Get-Service -Name $serviceName -ErrorAction Stop).Status
if ($serviceStatus -ne "Running") {
  $errorLog = Join-Path $DataRoot "logs\NexoTICentral.err.log"
  $details = if (Test-Path $errorLog) {
    (Get-Content $errorLog -Tail 20 -ErrorAction SilentlyContinue) -join " | "
  } else {
    "log de erro ainda não criado"
  }
  throw "O serviço $serviceName iniciou, mas foi encerrado. Estado: $serviceStatus. Detalhes: $details"
}

Write-Host "Pasta persistente: $DataRoot"
Write-Host "Firewall privado liberado na porta: $Port"
