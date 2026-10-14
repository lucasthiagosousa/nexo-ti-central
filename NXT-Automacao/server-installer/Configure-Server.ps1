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

# Durante uma atualização, o SCM pode manter o serviço em transição por alguns
# segundos mesmo após informar Stopped. Tente pelos dois caminhos suportados e
# consulte uma nova instância de ServiceController em cada ciclo.
$startDiagnostics = @()
$serviceStatus = "Stopped"

for ($cycle = 1; $cycle -le 5; $cycle++) {
  $scOutput = & cmd.exe /d /c "sc.exe start $serviceName 2>&1"
  $scExitCode = $LASTEXITCODE
  $startDiagnostics += "sc.exe tentativa $cycle (código $scExitCode): $($scOutput -join ' ')"
  Start-Sleep -Seconds 2

  $serviceStatus = (Get-Service -Name $serviceName -ErrorAction Stop).Status
  if ($serviceStatus -eq "Running") {
    break
  }

  $wrapperCommand = '"{0}" start 2>&1' -f $serviceExe
  $wrapperOutput = & cmd.exe /d /c $wrapperCommand
  $wrapperExitCode = $LASTEXITCODE
  $startDiagnostics += "WinSW tentativa $cycle (código $wrapperExitCode): $($wrapperOutput -join ' ')"

  for ($attempt = 1; $attempt -le 10; $attempt++) {
    Start-Sleep -Milliseconds 500
    $serviceStatus = (Get-Service -Name $serviceName -ErrorAction Stop).Status
    if ($serviceStatus -eq "Running") {
      break
    }
  }

  if ($serviceStatus -eq "Running") {
    break
  }

  Start-Sleep -Seconds 2
}

if ($serviceStatus -ne "Running") {
  $diagnosticLog = Join-Path $DataRoot "logs\instalacao-servico.log"
  $startDiagnostics | Set-Content -Path $diagnosticLog -Encoding UTF8
  throw "O serviço $serviceName foi registrado, mas não iniciou. Estado: $serviceStatus. Consulte $diagnosticLog."
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
