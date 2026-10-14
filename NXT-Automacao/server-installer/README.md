# Instalação no servidor interno

## O que este instalador faz

- instala a Central em `C:\Program Files\Nexo TI\Central de Operacoes`;
- executa o sistema como serviço do Windows, mesmo sem usuário conectado;
- inicia automaticamente com o Windows;
- libera a porta escolhida somente no perfil de rede **Privada** e para a sub-rede local;
- armazena banco, configurações e logs em `C:\ProgramData\NexoTI\CentralOperacoes`;
- preserva os dados em atualizações e desinstalações;
- inclui Node.js e Chromium, sem exigir instalação manual dessas dependências.

## Instalação

1. Copie `NexoTI-Central-Servidor-Setup.exe` para o Windows Server.
2. Execute como administrador.
3. Confirme a porta (padrão: `3000`) e a comunidade SNMP.
4. Ao concluir, abra `http://localhost:3000/setup.html` no servidor e crie o primeiro administrador.
5. Em outro computador da mesma rede, acesse:

   `http://IP-DO-SERVIDOR:3000`

Para descobrir o IP do servidor, execute `ipconfig` e use o endereço IPv4 da placa conectada à rede interna.

## Atualização

Execute a versão nova do instalador por cima da atual. O serviço é parado e recriado automaticamente. Banco, usuários, configurações e logs permanecem na pasta de dados.

## Diagnóstico

Serviço do Windows:

`Nexo TI - Central de Operações`

Logs:

`C:\ProgramData\NexoTI\CentralOperacoes\logs`

Configuração:

`C:\ProgramData\NexoTI\CentralOperacoes\.env`

Verificação no PowerShell (Administrador):

```powershell
Get-Service NexoTICentral
Test-NetConnection localhost -Port 3000
```

Se a porta estiver ocupada, encerre ou desinstale a antiga versão desktop que iniciava ao fazer login, ou escolha outra porta durante a instalação.
