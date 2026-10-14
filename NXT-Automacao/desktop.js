const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, shell, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const APP_ID = "br.com.operacoesti.controle";
let janelaPrincipal = null;
let janelaConfiguracao = null;
let servidor = null;
let tray = null;
let encerrando = false;
let abrirCriacaoAdmin = false;
const arquivoLog = path.join(os.tmpdir(), "Central-Operacoes-TI.log");

function registrarErroInicializacao(error) {
  const mensagem = error?.stack || error?.message || String(error);
  try {
    fs.appendFileSync(arquivoLog, `[${new Date().toISOString()}] ${mensagem}\n\n`, "utf8");
  } catch {}
  try {
    dialog.showErrorBox(
      "Não foi possível abrir a Central de Operações de TI",
      `${error?.message || mensagem}\n\nDetalhes foram salvos em:\n${arquivoLog}`
    );
  } catch {}
}

process.on("uncaughtException", registrarErroInicializacao);
process.on("unhandledRejection", registrarErroInicializacao);

app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) app.quit();

function caminhos() {
  const raiz = app.getPath("userData");
  return { raiz, dados: path.join(raiz, "dados"), env: path.join(raiz, ".env") };
}

function carregarConfiguracao() {
  const { env } = caminhos();
  if (!fs.existsSync(env)) return {};
  const resultado = {};
  for (const linha of fs.readFileSync(env, "utf8").split(/\r?\n/)) {
    const separador = linha.indexOf("=");
    if (separador > 0) resultado[linha.slice(0, separador).trim()] = linha.slice(separador + 1).trim();
  }
  return resultado;
}

function salvarConfiguracao({ email, password, snmpCommunity, port = 3000, skip = false }) {
  const destino = caminhos();
  fs.mkdirSync(destino.raiz, { recursive: true });
  const limpar = (valor) => String(valor || "").replace(/[\r\n]/g, "").trim();
  const porta = Number.parseInt(port, 10);
  if (!Number.isInteger(porta) || porta < 1024 || porta > 65535) {
    throw new Error("Escolha uma porta entre 1024 e 65535.");
  }
  const conteudo = [
    `NXT_EMAIL=${limpar(email)}`,
    `NXT_PASSWORD=${limpar(password)}`,
    `NXT_SNMP_COMMUNITY=${limpar(snmpCommunity)}`,
    `NXT_PORT=${porta}`,
    "NXT_CONFIG_VERSION=3",
    `NXT_SETUP_SKIPPED=${skip ? "1" : "0"}`,
    "",
  ].join("\n");
  fs.writeFileSync(destino.env, conteudo, { encoding: "utf8", mode: 0o600 });
  process.env.NXT_EMAIL = limpar(email);
  process.env.NXT_PASSWORD = limpar(password);
  process.env.NXT_SNMP_COMMUNITY = limpar(snmpCommunity);
  process.env.PORT = String(porta);
}

function configurarAmbiente() {
  const destino = caminhos();
  fs.mkdirSync(destino.dados, { recursive: true });
  process.env.NXT_DESKTOP_MODE = "1";
  process.env.NXT_BROWSER_CHANNEL = process.env.NXT_BROWSER_CHANNEL || "msedge";
  process.env.NXT_AUTOMATION_HEADLESS = "1";
  process.env.NXT_DATA_DIR = destino.dados;
  process.env.NXT_ENV_FILE = destino.env;
  process.env.NXT_HOST = "0.0.0.0";
  const config = carregarConfiguracao();
  process.env.PORT = String(config.NXT_PORT || "3000");
}

function criarJanelaConfiguracao(primeiroAcesso = false) {
  if (janelaConfiguracao && !janelaConfiguracao.isDestroyed()) return janelaConfiguracao.focus();
  janelaConfiguracao = new BrowserWindow({
    width: 520, height: 650, minWidth: 460, minHeight: 600,
    autoHideMenuBar: true, backgroundColor: "#f5f8fc",
    parent: janelaPrincipal || undefined, modal: Boolean(janelaPrincipal),
    icon: carregarIcone(256),
    webPreferences: { preload: path.join(__dirname, "desktop-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  janelaConfiguracao.loadFile(path.join(__dirname, "desktop-setup.html"), {
    query: { primeiroAcesso: primeiroAcesso ? "1" : "0" },
  });
  janelaConfiguracao.on("closed", () => {
    janelaConfiguracao = null;
    if (primeiroAcesso && !janelaPrincipal) iniciarSistema();
  });
}

function portaConfigurada() {
  return Number.parseInt(process.env.PORT || carregarConfiguracao().NXT_PORT || "3000", 10);
}

function obterEnderecoRede() {
  const interfaces = os.networkInterfaces();
  for (const enderecos of Object.values(interfaces)) {
    for (const endereco of enderecos || []) {
      if (endereco.family === "IPv4" && !endereco.internal) return `http://${endereco.address}:${portaConfigurada()}`;
    }
  }
  return `http://IP-DO-SERVIDOR:${portaConfigurada()}`;
}

function carregarIcone(tamanho) {
  const svg = fs.readFileSync(path.join(__dirname, "build", "icon.svg"), "utf8");
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
  return nativeImage.createFromDataURL(dataUrl).resize({ width: tamanho, height: tamanho, quality: "best" });
}

function criarTray() {
  const imagem = carregarIcone(32);
  tray = new Tray(imagem);
  tray.setToolTip("Nexo TI · Central de Operações");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir sistema", click: () => janelaPrincipal?.show() },
    { label: `Acesso na rede: ${obterEnderecoRede()}`, click: () => shell.openExternal(obterEnderecoRede()) },
    { label: "Configurar credenciais NXT", click: () => criarJanelaConfiguracao(false) },
    { label: "Abrir pasta de dados", click: () => shell.openPath(caminhos().dados) },
    { type: "separator" },
    { label: "Sair", click: () => { encerrando = true; app.quit(); } },
  ]));
  tray.on("click", () => { janelaPrincipal?.show(); janelaPrincipal?.focus(); });
  tray.on("double-click", () => { janelaPrincipal?.show(); janelaPrincipal?.focus(); });
}

function iniciarSistema() {
  if (janelaPrincipal) return;
  configurarAmbiente();
  ({ servidor } = require("./server"));
  const abrir = () => {
    const endereco = servidor.address();
    const porta = typeof endereco === "object" && endereco ? endereco.port : portaConfigurada();
    janelaPrincipal = new BrowserWindow({
      width: 1500, height: 920, minWidth: 1040, minHeight: 680, show: false,
      autoHideMenuBar: true, backgroundColor: "#f4f7fb",
      icon: carregarIcone(256), title: "Central de Operações de TI",
      webPreferences: { preload: path.join(__dirname, "desktop-main-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const paginaInicial = abrirCriacaoAdmin ? "/setup.html" : "/";
    abrirCriacaoAdmin = false;
    janelaPrincipal.loadURL(`http://127.0.0.1:${porta}${paginaInicial}`);
    janelaPrincipal.once("ready-to-show", () => { janelaPrincipal.show(); janelaPrincipal.focus(); });
    janelaPrincipal.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && !url.startsWith(`http://127.0.0.1:${porta}`)) shell.openExternal(url);
      return { action: "deny" };
    });
    janelaPrincipal.on("close", (evento) => {
      if (!encerrando) { evento.preventDefault(); janelaPrincipal.hide(); }
    });
    criarTray();
  };
  if (servidor.listening) abrir(); else servidor.once("listening", abrir);
}

ipcMain.handle("report:save-pdf", async (_evento, options = {}) => {
  if (!janelaPrincipal || janelaPrincipal.isDestroyed()) throw new Error("Janela principal indisponível.");
  const suggestedName = String(options.fileName || "relatorio.pdf").replace(/[\\/:*?"<>|]/g, "-");
  const selection = await dialog.showSaveDialog(janelaPrincipal, {
    title: "Salvar relatório em PDF",
    defaultPath: path.join(app.getPath("documents"), suggestedName),
    filters: [{ name: "Documento PDF", extensions: ["pdf"] }],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  });
  if (selection.canceled || !selection.filePath) return { canceled: true };
  const pdf = await janelaPrincipal.webContents.printToPDF({
    printBackground: true,
    landscape: true,
    pageSize: "A4",
    margins: { top: 0.35, bottom: 0.35, left: 0.35, right: 0.35 },
  });
  fs.writeFileSync(selection.filePath, pdf);
  return { canceled: false, filePath: selection.filePath };
});

ipcMain.handle("nxt-config:get", () => {
  const config = carregarConfiguracao();
  return { email: config.NXT_EMAIL || "", snmpCommunity: config.NXT_SNMP_COMMUNITY || "", port: Number(config.NXT_PORT || 3000) };
});
ipcMain.handle("nxt-config:save", (_evento, dados) => {
  if (!dados?.email || !dados?.password || !dados?.snmpCommunity) throw new Error("Informe o e-mail, a senha do NXT e a comunidade SNMP.");
  salvarConfiguracao(dados);
  abrirCriacaoAdmin = Boolean(dados?.primeiroAcesso);
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});
ipcMain.handle("nxt-config:skip", () => {
  salvarConfiguracao({ email: "", password: "", snmpCommunity: "", port: 3000, skip: true });
  janelaConfiguracao?.close();
  if (!janelaPrincipal) iniciarSistema();
  return { sucesso: true };
});

app.on("second-instance", () => {
  if (janelaConfiguracao && !janelaConfiguracao.isDestroyed()) {
    janelaConfiguracao.show();
    janelaConfiguracao.restore();
    janelaConfiguracao.focus();
    return;
  }
  if (janelaPrincipal && !janelaPrincipal.isDestroyed()) {
    janelaPrincipal.show();
    janelaPrincipal.restore();
    janelaPrincipal.focus();
    return;
  }
  iniciarSistema();
});
app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  configurarAmbiente();
  const config = carregarConfiguracao();
  const configuracaoAtual = config.NXT_CONFIG_VERSION === "3";
  const credenciaisCompletas = Boolean(config.NXT_EMAIL && config.NXT_PASSWORD && config.NXT_SNMP_COMMUNITY);
  if (!configuracaoAtual || !credenciaisCompletas) criarJanelaConfiguracao(true);
  else iniciarSistema();
});
app.on("before-quit", () => { encerrando = true; if (servidor?.listening) servidor.close(); });
app.on("window-all-closed", () => {});
