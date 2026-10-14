#define MyAppName "Nexo TI - Central de Operações"
#define MyAppVersion "1.3.1"
#define MyAppPublisher "Nexo TI"
#define StageDir GetEnv("NXT_STAGE_DIR")
#define OutputDir GetEnv("NXT_OUTPUT_DIR")

[Setup]
AppId={{1B6E29A9-8B21-4BCA-B6D9-D173D1FB71B5}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppVerName={#MyAppName} {#MyAppVersion}
DefaultDirName={autopf}\Nexo TI\Central de Operacoes
DefaultGroupName=Nexo TI
OutputDir={#OutputDir}
OutputBaseFilename=NexoTI-Central-Servidor-Setup
SetupIconFile={#StageDir}\app\public\assets\nexo-ti-icon.ico
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableProgramGroupPage=yes
UninstallDisplayName={#MyAppName}
SetupLogging=yes
RestartIfNeededByRun=no
CloseApplications=yes

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Dirs]
Name: "{commonappdata}\NexoTI\CentralOperacoes"; Permissions: admins-full system-full
Name: "{commonappdata}\NexoTI\CentralOperacoes\dados"; Permissions: admins-full system-full
Name: "{commonappdata}\NexoTI\CentralOperacoes\logs"; Permissions: admins-full system-full

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\browsers\*"; DestDir: "{app}\browsers"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\service\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Abrir Central de Operações"; Filename: "http://localhost:{code:GetPort}/login.html"; IconFilename: "{app}\app\public\assets\nexo-ti-icon.ico"
Name: "{group}\Logs do servidor"; Filename: "{commonappdata}\NexoTI\CentralOperacoes\logs"
Name: "{group}\Desinstalar servidor"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Nexo TI - Central"; Filename: "http://localhost:{code:GetPort}/login.html"; IconFilename: "{app}\app\public\assets\nexo-ti-icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na Área de Trabalho"; GroupDescription: "Atalhos:"; Flags: unchecked

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\service\Configure-Server.ps1"" -Port {code:GetPort}"; StatusMsg: "Protegendo dados e configurando o firewall..."; Flags: runhidden waituntilterminated
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\service\Configure-Server.ps1"" -Port {code:GetPort} -VerifyOnly"; StatusMsg: "Validando o servidor..."; Flags: runhidden waituntilterminated
Filename: "http://localhost:{code:GetPort}/setup.html"; Description: "Abrir configuração inicial"; Flags: shellexec postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\service\NexoTICentral.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{app}\service\NexoTICentral.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ""Get-NetFirewallRule -DisplayName 'Nexo TI - Central de Operacoes' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"""; Flags: runhidden waituntilterminated

[Code]
var
  ServerPage: TInputQueryWizardPage;

function ConfigPath: string;
begin
  Result := ExpandConstant('{commonappdata}\NexoTI\CentralOperacoes\.env');
end;

function GetPort(Param: string): string;
begin
  Result := Trim(ServerPage.Values[0]);
end;

procedure LoadExistingConfiguration;
var
  Lines: TArrayOfString;
  I: Integer;
  Line: string;
begin
  if not LoadStringsFromFile(ConfigPath, Lines) then
    Exit;

  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Trim(Lines[I]);
    if Pos('PORT=', Line) = 1 then
      ServerPage.Values[0] := Copy(Line, 6, Length(Line))
    else if Pos('NXT_SNMP_COMMUNITY=', Line) = 1 then
      ServerPage.Values[1] := Copy(Line, 20, Length(Line));
  end;
end;

procedure SetEnvironmentValue(const Key, Value: string);
var
  Lines: TArrayOfString;
  I, Count: Integer;
  Prefix: string;
  Found: Boolean;
begin
  Prefix := Key + '=';
  Found := False;

  if not LoadStringsFromFile(ConfigPath, Lines) then
    SetArrayLength(Lines, 0);

  Count := GetArrayLength(Lines);
  for I := 0 to Count - 1 do
  begin
    if Pos(Prefix, Lines[I]) = 1 then
    begin
      Lines[I] := Prefix + Value;
      Found := True;
      Break;
    end;
  end;

  if not Found then
  begin
    SetArrayLength(Lines, Count + 1);
    Lines[Count] := Prefix + Value;
  end;

  if not SaveStringsToFile(ConfigPath, Lines, False) then
    RaiseException('Não foi possível salvar a configuração do servidor.');
end;

procedure SaveServerConfiguration;
begin
  ForceDirectories(ExtractFileDir(ConfigPath));

  if not FileExists(ConfigPath) then
  begin
    if not SaveStringToFile(
      ConfigPath,
      '# Configuração local do servidor Nexo TI' + #13#10 +
      'NXT_EMAIL=' + #13#10 +
      'NXT_PASSWORD=' + #13#10 +
      'NXT_SECURE_COOKIE=0' + #13#10 +
      'NXT_ALLOW_REMOTE_SETUP=0' + #13#10 +
      'NXT_JSON_LIMIT=32mb' + #13#10,
      False
    ) then
      RaiseException(
        'Não foi possível criar a configuração em ' + ConfigPath + '. ' +
        'Execute o instalador como administrador.'
      );
  end;

  SetEnvironmentValue('NXT_HOST', '0.0.0.0');
  SetEnvironmentValue('PORT', GetPort(''));
  SetEnvironmentValue('NXT_SNMP_COMMUNITY', Trim(ServerPage.Values[1]));
  SetEnvironmentValue('NXT_AUTOMATION_HEADLESS', '1');
end;

function PortIsListening(const Port: string): Boolean;
var
  ResultCode: Integer;
  Params: string;
begin
  Params :=
    '-NoProfile -NonInteractive -Command "' +
    'if (Get-NetTCPConnection -State Listen -LocalPort ' + Port +
    ' -ErrorAction SilentlyContinue) { exit 20 } else { exit 0 }"';

  if not Exec(
    ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  ) then
  begin
    Result := False;
    Exit;
  end;

  Result := ResultCode = 20;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  PortNumber: Integer;
begin
  Result := True;

  if CurPageID <> ServerPage.ID then
    Exit;

  PortNumber := StrToIntDef(Trim(ServerPage.Values[0]), 0);
  if (PortNumber < 1) or (PortNumber > 65535) then
  begin
    MsgBox('Informe uma porta válida entre 1 e 65535.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if Pos(#10, ServerPage.Values[1]) > 0 then
  begin
    MsgBox('A comunidade SNMP deve ocupar uma única linha.', mbError, MB_OK);
    Result := False;
    Exit;
  end;

  if PortIsListening(IntToStr(PortNumber)) then
  begin
    { Em atualização silenciosa, a porta pertence ao próprio serviço instalado. }
    if WizardSilent then
    begin
      Result := True;
      Exit;
    end;

    Result :=
      MsgBox(
        'A porta ' + IntToStr(PortNumber) + ' já está sendo usada.' + #13#10 + #13#10 +
        'Isso pode acontecer se a versão desktop antiga ainda estiver aberta. ' +
        'Feche ou desinstale a versão antiga antes de continuar. ' +
        'Deseja continuar mesmo assim?',
        mbConfirmation,
        MB_YESNO
      ) = IDYES;
  end;
end;

procedure StopPreviousService;
var
  ServiceExe, Port: string;
  ResultCode, Attempt: Integer;
begin
  ServiceExe := ExpandConstant('{app}\service\NexoTICentral.exe');
  if not FileExists(ServiceExe) then
    Exit;

  { Na atualização, mantenha o registro do serviço para evitar o estado
    "marcado para exclusão" do Windows. A desinstalação real o remove. }
  Exec(ServiceExe, 'stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  { O wrapper pode terminar alguns instantes antes do processo Node liberar a porta. }
  Port := GetPort('');
  for Attempt := 1 to 60 do
  begin
    if not PortIsListening(Port) then
      Exit;
    Sleep(500);
  end;

  RaiseException(
    'O serviço anterior foi parado, mas a porta ' + Port +
    ' continua ocupada. Aguarde alguns segundos e execute o instalador novamente.'
  );
end;

function EnsurePersistentDataAccess: Boolean;
var
  DataRoot, Params: string;
  ResultCode: Integer;
begin
  DataRoot := ExpandConstant('{commonappdata}\NexoTI\CentralOperacoes');
  ForceDirectories(DataRoot);

  { Instalações anteriores podem ter deixado ProgramData acessível apenas ao SYSTEM. }
  Params := '/F "' + DataRoot + '" /R /D Y';
  Exec(
    ExpandConstant('{sys}\takeown.exe'),
    Params,
    '',
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );

  Params :=
    '"' + DataRoot + '" /inheritance:e ' +
    '/grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /C';
  Result :=
    Exec(
      ExpandConstant('{sys}\icacls.exe'),
      Params,
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode
    ) and (ResultCode = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
begin
  StopPreviousService;

  if not EnsurePersistentDataAccess then
  begin
    Result :=
      'Não foi possível preparar a pasta de dados persistentes. ' +
      'Execute o instalador como administrador.';
    Exit;
  end;

  { Grave a configuração antes de o script proteger ProgramData novamente. }
  SaveServerConfiguration;
  Result := '';
end;

procedure InitializeWizard;
begin
  ServerPage := CreateInputQueryPage(
    wpSelectDir,
    'Configuração do servidor',
    'Defina como os colaboradores acessarão a Central.',
    'A porta será liberada somente na rede privada. A comunidade SNMP é usada para consultar as impressoras.'
  );

  ServerPage.Add('Porta HTTP:', False);
  ServerPage.Add('Comunidade SNMP:', False);
  ServerPage.Values[0] := '3000';
  ServerPage.Values[1] := 'public';

  LoadExistingConfiguration;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpFinished then
  begin
    WizardForm.FinishedLabel.Caption :=
      'A Central de Operações está instalada como serviço do Windows.' + #13#10 + #13#10 +
      'Acesso neste servidor: http://localhost:' + GetPort('') + #13#10 +
      'Acesso dos colaboradores: http://IP-DO-SERVIDOR:' + GetPort('') + #13#10 + #13#10 +
      'Os dados permanecem em C:\ProgramData\NexoTI\CentralOperacoes.';
  end;
end;
