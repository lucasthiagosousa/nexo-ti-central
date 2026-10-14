const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createAuth } = require("./auth");
const tonerMonitor = require("./toner-monitor");

const arquivoEnv = process.env.NXT_ENV_FILE || path.join(__dirname, ".env");
const dotenv = require("dotenv");
dotenv.config({ path: arquivoEnv });

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
const PORTA = Number(process.env.PORT || 3000);
const HOST = process.env.NXT_HOST || "127.0.0.1";

const pastaProjeto = __dirname;
const pastaPublica = path.join(pastaProjeto, "public");
const pastaDados = process.env.NXT_DATA_DIR
  ? path.resolve(process.env.NXT_DATA_DIR)
  : path.join(pastaProjeto, "dados");

fs.mkdirSync(pastaDados, { recursive: true });
const arquivoPlanilha = path.join(pastaDados, "estoque-atual.xlsx");
const arquivoAutomacao = process.versions.electron
  ? path.join(process.resourcesPath, "app.asar.unpacked", "automacao.js")
  : path.join(pastaProjeto, "automacao.js");
const arquivoBanco = path.join(pastaDados, "controle-estoque.db");
const arquivoToner = path.join(pastaDados, "toner-atual.json");
const arquivoRestauracao = path.join(pastaDados, "restauracao-pendente.db");
if (fs.existsSync(arquivoRestauracao)) {
  try {
    const probe = new DatabaseSync(arquivoRestauracao, { readOnly:true });
    const integrity = probe.prepare("PRAGMA integrity_check").get();
    probe.close();
    if (!integrity || String(Object.values(integrity)[0]).toLowerCase() !== "ok") throw new Error("Banco inválido");
    if (fs.existsSync(arquivoBanco)) {
      fs.copyFileSync(arquivoBanco, path.join(pastaDados, "controle-estoque-antes-restauracao.db"));
      fs.rmSync(arquivoBanco);
      ["-wal","-shm"].forEach(function(suffix){try{fs.rmSync(arquivoBanco+suffix);}catch{}});
    }
    fs.renameSync(arquivoRestauracao, arquivoBanco);
  } catch (error) {
    console.error("Restauração pendente ignorada:", error.message);
  }
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function sameOriginRequest(request) {
  const fetchSite = String(request.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = request.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host === request.get("host");
  } catch {
    return false;
  }
}
function loopbackRequest(request) {
  const address = String(request.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}
app.use((request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; "
    + "style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' blob:; "
    + "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (request.secure) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
  if (MUTATING_METHODS.has(request.method) && !sameOriginRequest(request)) {
    return response.status(403).json({ sucesso: false, mensagem: "Origem da requisição não autorizada." });
  }
  return next();
});
app.use(express.json({ limit: process.env.NXT_JSON_LIMIT || "32mb", strict: true }));
app.use("/assets", express.static(path.join(pastaPublica, "assets"), {
  fallthrough: false,
  immutable: true,
  maxAge: "1d",
  dotfiles: "deny"
}));

app.get("/favicon.ico", (req, res) => {
  res.type("image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.sendFile(path.join(pastaPublica, "assets", "nexo-ti-icon.svg"));
});
app.get("/favicon.svg", (req, res) => {
  res.type("image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.sendFile(path.join(pastaPublica, "assets", "nexo-ti-icon.svg"));
});

const auth = createAuth({
  databasePath: arquivoBanco,
});
auth.seedPrinters(tonerMonitor.printers);
auth.database.exec(
  "CREATE TABLE IF NOT EXISTS stock_snapshots ("
  + "id INTEGER PRIMARY KEY AUTOINCREMENT,snapshot_date TEXT NOT NULL,captured_at TEXT NOT NULL,"
  + "categories_json TEXT NOT NULL,assets_json TEXT NOT NULL DEFAULT '[]',source TEXT NOT NULL DEFAULT 'manual'"
  + ");"
  + "CREATE INDEX IF NOT EXISTS idx_stock_snapshots_date ON stock_snapshots(snapshot_date,captured_at);"
);
const stockSnapshotColumns=auth.database.prepare("PRAGMA table_info(stock_snapshots)").all().map(function(column){return column.name;});
if(!stockSnapshotColumns.includes("assets_json"))auth.database.exec("ALTER TABLE stock_snapshots ADD COLUMN assets_json TEXT NOT NULL DEFAULT '[]'");
auth.database.exec(
  "CREATE TABLE IF NOT EXISTS stock_movement_events ("
  +"id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,movement_type TEXT NOT NULL,"
  +"asset_code TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',previous_location TEXT NOT NULL DEFAULT '',"
  +"new_location TEXT NOT NULL DEFAULT '',detected_at TEXT NOT NULL,source TEXT NOT NULL DEFAULT '',"
  +"reported_slot TEXT NOT NULL DEFAULT '',reported_at TEXT NOT NULL DEFAULT ''"
  +");"
  +"CREATE INDEX IF NOT EXISTS idx_stock_movement_pending ON stock_movement_events(reported_at,detected_at);"
);

app.get(["/login", "/login.html"], (req, res) => {
  res.sendFile(path.join(pastaPublica, "login.html"));
});

app.get(["/setup", "/setup.html"], (req, res) => {
  res.sendFile(path.join(pastaPublica, "setup.html"));
});

app.post("/api/auth/setup", (request, response, next) => {
  if (!loopbackRequest(request) && process.env.NXT_ALLOW_REMOTE_SETUP !== "1") {
    return response.status(403).json({
      sucesso: false,
      mensagem: "A criação do primeiro administrador só pode ser feita diretamente no servidor."
    });
  }
  return next();
});
app.use("/api/auth", auth.router);

app.get(["/admin", "/admin.html"], auth.requireAuth, (req, res) => {
  if (req.user.role !== "master") {
    return res.redirect("/");
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return res.sendFile(path.join(pastaPublica, "admin.html"));
});

app.get(["/configuracoes", "/configuracoes.html"], auth.requireAuth, (req, res) => {
  if (req.user.role !== "master") return res.redirect("/");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.sendFile(path.join(pastaPublica, "configuracoes.html"));
});

app.get(["/relatorios","/relatorios.html"],auth.requireMaster,function(req,res){
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.sendFile(path.join(pastaPublica,"relatorios.html"));
});
app.get(["/automacoes","/automacoes.html"],auth.requireMaster,function(req,res){
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  return res.sendFile(path.join(pastaPublica,"automacoes.html"));
});

app.use(auth.requireAuth);
app.use((req, res, next) => {
  if (/\.(?:html|js|css)$/i.test(req.path)) {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static(pastaPublica, {
  dotfiles: "deny",
  etag: true,
  index: false,
  redirect: false
}));

let estadoAtualizacao = {
  executando: false,
  sucesso: null,
  mensagem: "Nenhuma atualização executada.",
  inicio: null,
  fim: null,
  log: [],
};

let tonerExecutando = false;
let tonerDigestExecutando = false;
let tonerRetryScheduled = false;

/*
 * Operação de toner: compatibilidade, reservas e trocas.
 * As tabelas são criadas sem alterar os dados já existentes.
 */
auth.database.exec(
  "CREATE TABLE IF NOT EXISTS toner_compatibility ("
  + "id INTEGER PRIMARY KEY AUTOINCREMENT,printer_model TEXT NOT NULL,toner_model TEXT NOT NULL,"
  + "color TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,created_by INTEGER,"
  + "created_at TEXT NOT NULL,updated_at TEXT NOT NULL,"
  + "UNIQUE(printer_model,toner_model,color)"
  + ");"
  + "CREATE TABLE IF NOT EXISTS toner_reservations ("
  + "id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,toner_model TEXT NOT NULL,"
  + "color TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'reserved',reserved_by INTEGER,"
  + "reserved_at TEXT NOT NULL,completed_at TEXT NOT NULL DEFAULT ''"
  + ");"
  + "CREATE INDEX IF NOT EXISTS idx_toner_reservations_status ON toner_reservations(status,toner_model,color);"
  + "CREATE TABLE IF NOT EXISTS toner_exchanges ("
  + "id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,printer_name TEXT NOT NULL DEFAULT '',"
  + "printer_model TEXT NOT NULL DEFAULT '',toner_model TEXT NOT NULL,color TEXT NOT NULL DEFAULT '',"
  + "previous_level INTEGER,performed_by INTEGER,created_at TEXT NOT NULL"
  + ");"
  + "CREATE INDEX IF NOT EXISTS idx_toner_exchanges_printer ON toner_exchanges(printer_ip,created_at);"
  + "CREATE TABLE IF NOT EXISTS printer_page_history (id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,printer_model TEXT NOT NULL DEFAULT '',hostname TEXT NOT NULL DEFAULT '',total_pages INTEGER NOT NULL,recorded_at TEXT NOT NULL);"
  + "CREATE INDEX IF NOT EXISTS idx_printer_pages_ip_date ON printer_page_history(printer_ip,recorded_at);"
  + "CREATE TABLE IF NOT EXISTS printer_maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,maintenance_type TEXT NOT NULL,interval_pages INTEGER NOT NULL DEFAULT 100000,last_pages INTEGER NOT NULL DEFAULT 0,next_due_pages INTEGER NOT NULL DEFAULT 100000,last_at TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_by INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);"
  + "CREATE TABLE IF NOT EXISTS toner_change_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,printer_name TEXT NOT NULL DEFAULT '',printer_model TEXT NOT NULL DEFAULT '',supply_name TEXT NOT NULL,previous_level INTEGER NOT NULL,current_level INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',detected_at TEXT NOT NULL,resolved_at TEXT NOT NULL DEFAULT '',resolved_by INTEGER);"
);
const exchangeColumns=auth.database.prepare("PRAGMA table_info(toner_exchanges)").all().map(function(column){return column.name;});
if(!exchangeColumns.includes("source"))auth.database.exec("ALTER TABLE toner_exchanges ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
if(!exchangeColumns.includes("current_level"))auth.database.exec("ALTER TABLE toner_exchanges ADD COLUMN current_level INTEGER");
const candidateColumns=auth.database.prepare("PRAGMA table_info(toner_change_candidates)").all().map(function(column){return column.name;});
if(!candidateColumns.includes("confirmation_count"))auth.database.exec("ALTER TABLE toner_change_candidates ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 1");
if(!candidateColumns.includes("last_seen_at"))auth.database.exec("ALTER TABLE toner_change_candidates ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''");
auth.database.exec("CREATE INDEX IF NOT EXISTS idx_toner_candidates_pending ON toner_change_candidates(status,printer_ip,supply_name)");
auth.database.exec("PRAGMA optimize");


auth.database.exec(
  "CREATE TABLE IF NOT EXISTS automation_runs ("
  +"id INTEGER PRIMARY KEY AUTOINCREMENT,automation_type TEXT NOT NULL,trigger_type TEXT NOT NULL DEFAULT 'scheduled',"
  +"status TEXT NOT NULL DEFAULT 'running',started_at TEXT NOT NULL,finished_at TEXT NOT NULL DEFAULT '',"
  +"duration_ms INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT ''"
  +");"
  +"CREATE INDEX IF NOT EXISTS idx_automation_runs_date ON automation_runs(started_at DESC);"
  +"CREATE TABLE IF NOT EXISTS system_backups ("
  +"id INTEGER PRIMARY KEY AUTOINCREMENT,file_name TEXT NOT NULL,file_path TEXT NOT NULL,size_bytes INTEGER NOT NULL DEFAULT 0,"
  +"status TEXT NOT NULL DEFAULT 'created',integrity_status TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,"
  +"verified_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT ''"
  +");"
);

function lerTonerAtual() {
  try {
    const report = JSON.parse(fs.readFileSync(arquivoToner, "utf8"));
    const registered = new Map(auth.getPrinters().map(function (printer) { return [printer.ip, printer]; }));
    report.printers = (report.printers || []).map(function (printer) {
      const saved = registered.get(printer.ip) || {};
      return { ...printer, location: saved.location || printer.location || "", unit: saved.unit || printer.unit || "" };
    });
    return report;
  } catch {
    return {
      updatedAt: null,
      threshold: 20,
      summary: { total: auth.getPrinters().filter((item) => item.active).length, online: 0, offline: 0, critical: 0, warning: 0 },
      printers: auth.getPrinters().filter((item) => item.active).map(({ ip, model, location, unit }) => ({
        ip,
        model,
        hostname: "",
        online: null,
        supplies: [],
        status: "unknown",
        location,
        unit: unit || "",
        cartridge: "Aguardando consulta SNMP",
      }))
    };
  }
}

function texto(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  return String(valor).trim();
}

function normalizar(valor) {
  return texto(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .trim();
}

function obterLinhas(resultado) {
  if (!Array.isArray(resultado)) {
    return [];
  }

  /*
   * Algumas versões/bibliotecas retornam:
   * [{ sheet: "Sheet", data: [...] }]
   */
  if (
    resultado.length > 0 &&
    resultado[0] &&
    Array.isArray(resultado[0].data)
  ) {
    return resultado[0].data;
  }

  return resultado;
}

function encontrarColuna(cabecalho, nomes) {
  const cabecalhoNormalizado = cabecalho.map(normalizar);

  for (const nome of nomes) {
    const indice = cabecalhoNormalizado.findIndex(
      (coluna) => coluna === normalizar(nome)
    );

    if (indice >= 0) {
      return indice;
    }
  }

  return -1;
}

function valorDaColuna(linha, indice) {
  if (indice < 0 || indice >= linha.length) {
    return "";
  }

  return texto(linha[indice]);
}

function adicionarLog(mensagem) {
  const linhas = String(mensagem)
    .split(/\r?\n/)
    .map((linha) => linha.trim())
    .filter(Boolean);

  for (const linha of linhas) {
    console.log(`[AUTOMAÇÃO] ${linha}`);

    estadoAtualizacao.log.push(linha);

    /*
     * Evita que o histórico cresça indefinidamente.
     */
    if (estadoAtualizacao.log.length > 100) {
      estadoAtualizacao.log.shift();
    }
  }
}

async function lerPlanilha() {
  if (!fs.existsSync(arquivoPlanilha)) {
    throw new Error(
      "A planilha estoque-atual.xlsx ainda não foi encontrada."
    );
  }

  const modulo = await import("read-excel-file/node");
  const readXlsxFile = modulo.default || modulo;

  const resultado = await readXlsxFile(arquivoPlanilha);
  const linhas = obterLinhas(resultado);

  if (!linhas.length) {
    throw new Error("A planilha está vazia.");
  }

  /*
   * Localiza a linha real dos títulos da tabela.
   */
  const indiceCabecalho = linhas.findIndex((linha) => {
    const colunas = linha.map(normalizar);

    return (
      colunas.includes("CODIGO") &&
      colunas.includes("MODELO")
    );
  });

  if (indiceCabecalho < 0) {
    throw new Error(
      "Não foi possível localizar as colunas do relatório NXT4Insight."
    );
  }

  const cabecalho = linhas[indiceCabecalho];

  const colunaProprietario = encontrarColuna(
    cabecalho,
    ["Proprietário", "Proprietario"]
  );

  const colunaAlocado = encontrarColuna(
    cabecalho,
    ["Alocado para"]
  );

  const colunaCodigo = encontrarColuna(
    cabecalho,
    ["Código", "Codigo"]
  );

  const colunaFabricante = encontrarColuna(
    cabecalho,
    ["Fabricante"]
  );

  const colunaMarca = encontrarColuna(
    cabecalho,
    ["Marca"]
  );

  const colunaModelo = encontrarColuna(
    cabecalho,
    ["Modelo"]
  );

  const ativos = [];
  let categoriaAtual = "";

  for (
    let indice = indiceCabecalho + 1;
    indice < linhas.length;
    indice++
  ) {
    const linha = linhas[indice];

    if (!Array.isArray(linha)) {
      continue;
    }

    const conteudoLinha = linha
      .map(texto)
      .filter(Boolean)
      .join(" ");

    /*
     * Exemplo encontrado no relatório:
     * Tipo do ativo: CARREGADOR (Contagem: 13)
     */
    const categoriaEncontrada = conteudoLinha.match(
      /Tipo\s+do\s+ativo\s*:\s*(.+?)(?:\s*\(Contagem\s*:\s*\d+\))?$/i
    );

    if (categoriaEncontrada) {
      categoriaAtual = categoriaEncontrada[1]
        .replace(/\s*\(Contagem.*$/i, "")
        .trim();

      continue;
    }

    if (!categoriaAtual) {
      continue;
    }

    const codigo = valorDaColuna(
      linha,
      colunaCodigo
    );

    const modelo = valorDaColuna(
      linha,
      colunaModelo
    );

    const fabricante = valorDaColuna(
      linha,
      colunaFabricante
    );

    const marca = valorDaColuna(
      linha,
      colunaMarca
    );

    const proprietario = valorDaColuna(
      linha,
      colunaProprietario
    );

    const alocadoPara = valorDaColuna(
      linha,
      colunaAlocado
    );

    /*
     * Ignora linhas de agrupamento, filtros ou linhas vazias.
     */
    if (
      !codigo &&
      !modelo &&
      !fabricante &&
      !marca
    ) {
      continue;
    }

    ativos.push({
      categoria: categoriaAtual,
      proprietario,
      alocadoPara,
      codigo,
      fabricante,
      marca,
      modelo: modelo || "NÃO INFORMADO",
    });
  }

  if (!ativos.length) {
    throw new Error(
      "Nenhum ativo foi encontrado dentro da planilha."
    );
  }

  const mapaCategorias = new Map();

  for (const ativo of ativos) {
    const nomeCategoria =
      ativo.categoria || "SEM CATEGORIA";

    if (!mapaCategorias.has(nomeCategoria)) {
      mapaCategorias.set(nomeCategoria, {
        nome: nomeCategoria,
        atual: 0,
        quantidade: 0,
        modelos: new Map(),
      });
    }

    const categoria = mapaCategorias.get(
      nomeCategoria
    );

    categoria.atual++;
    categoria.quantidade++;

    const nomeModelo =
      ativo.modelo || "NÃO INFORMADO";

    categoria.modelos.set(
      nomeModelo,
      (categoria.modelos.get(nomeModelo) || 0) + 1
    );
  }

  const categorias = Array.from(
    mapaCategorias.values()
  )
    .map((categoria) => ({
      nome: categoria.nome,
      atual: categoria.atual,
      quantidade: categoria.quantidade,
      modelos: Array.from(
        categoria.modelos.entries()
      )
        .map(([nome, quantidade]) => ({
          nome,
          quantidade,
        }))
        .sort(
          (a, b) =>
            b.quantidade - a.quantidade ||
            a.nome.localeCompare(b.nome, "pt-BR")
        ),
    }))
    .sort(
      (a, b) =>
        b.atual - a.atual ||
        a.nome.localeCompare(b.nome, "pt-BR")
    );

  const informacoesArquivo =
    fs.statSync(arquivoPlanilha);

  return {
    sucesso: true,

    /*
     * Campos principais usados pelo dashboard.
     */
    totalAtivos: ativos.length,
    totalCategorias: categorias.length,
    categorias,
    ativos,

    arquivo: {
      nome: path.basename(arquivoPlanilha),
      atualizadoEm:
        informacoesArquivo.mtime.toISOString(),
    },

    /*
     * Campos alternativos para manter compatibilidade
     * com a primeira versão do dashboard.
     */
    total: ativos.length,
    nomeArquivo: path.basename(arquivoPlanilha),
    atualizadoEm:
      informacoesArquivo.mtime.toISOString(),
  };
}


function lerConfiguracaoEnv() {
  try {
    return dotenv.parse(fs.readFileSync(arquivoEnv, "utf8"));
  } catch {
    return {};
  }
}

function salvarConfiguracaoEnv(changes) {
  const current = { ...lerConfiguracaoEnv(), ...changes };
  const content = Object.entries(current)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => key + "=" + JSON.stringify(String(value).replace(/[\r\n]/g, "")))
    .join("\n") + "\n";
  fs.mkdirSync(path.dirname(arquivoEnv), { recursive: true });
  fs.writeFileSync(arquivoEnv, content, "utf8");
  Object.assign(process.env, changes);
}

function formatBytes(value) {
  const units=["B","KB","MB","GB","TB"];let n=Number(value)||0,index=0;
  while(n>=1024&&index<units.length-1){n/=1024;index++;}
  return n.toFixed(index?1:0)+" "+units[index];
}


const pastaBackups=path.join(pastaDados,"backups");
fs.mkdirSync(pastaBackups,{recursive:true});
function automationStart(type,trigger){
  const result=auth.database.prepare("INSERT INTO automation_runs (automation_type,trigger_type,status,started_at) VALUES (?,?,\'running\',?)").run(type,trigger||"scheduled",new Date().toISOString());
  return{ id:Number(result.lastInsertRowid),started:Date.now() };
}
function automationFinish(run,ok,message,details){
  if(!run)return;
  auth.database.prepare("UPDATE automation_runs SET status=?,finished_at=?,duration_ms=?,message=?,details=? WHERE id=?")
    .run(ok?"success":"error",new Date().toISOString(),Math.max(0,Date.now()-run.started),String(message||"").slice(0,1000),String(details||"").slice(0,4000),run.id);
}
function verifyDatabaseFile(file){
  const probe=new DatabaseSync(file,{readOnly:true});
  try{const result=probe.prepare("PRAGMA integrity_check").get(),tables=probe.prepare("SELECT name FROM sqlite_master WHERE type=\'table\'").all().map(r=>r.name);return String(Object.values(result)[0]).toLowerCase()==="ok"&&tables.includes("users");}
  finally{probe.close();}
}
function createAutomaticBackup(trigger){
  const run=automationStart("backup",trigger||"scheduled"),stamp=new Date().toISOString().replace(/[:.]/g,"-"),name="central-operacoes-"+stamp+".db",destination=path.join(pastaBackups,name);
  try{
    auth.database.exec("PRAGMA wal_checkpoint(FULL)");
    auth.database.exec("VACUUM INTO \'"+destination.replace(/\'/g,"\'\'")+"\'");
    const valid=verifyDatabaseFile(destination),stat=fs.statSync(destination);
    auth.database.prepare("INSERT INTO system_backups (file_name,file_path,size_bytes,status,integrity_status,created_at,verified_at,error) VALUES (?,?,?,?,?,?,?,?)")
      .run(name,destination,stat.size,valid?"created":"error",valid?"ok":"failed",new Date().toISOString(),new Date().toISOString(),valid?"":"Falha na verificação de integridade");
    if(!valid)throw new Error("O backup foi criado, mas falhou na verificação de integridade.");
    const retention=Math.max(1,Math.min(365,Number(auth.getSetting("backup_retention_days","30"))||30)),cutoff=Date.now()-retention*86400000;
    auth.database.prepare("SELECT id,file_path filePath,created_at createdAt FROM system_backups ORDER BY created_at").all().forEach(function(item){if(Date.parse(item.createdAt)<cutoff){try{fs.rmSync(item.filePath);}catch{}auth.database.prepare("DELETE FROM system_backups WHERE id=?").run(item.id);}});
    auth.setSetting("backup_last_success",new Date().toISOString(),null);automationFinish(run,true,"Backup criado e verificado.",name);return{name,path:destination,size:stat.size};
  }catch(error){
    auth.setSetting("backup_last_error",error.message,null);automationFinish(run,false,error.message,"");
    dispatchNotification("backup-failed:"+localDateKey(),"backup","Falha no backup automático",error.message,false).catch(function(notificationError){console.error("Alerta de falha no backup:",notificationError.message);});
    throw error;
  }
}
function contingencyTonerReport(next){
  const previous=lerTonerAtual(),previousPrinters=previous.printers||[],previousMap=new Map(previousPrinters.map(p=>[p.ip,p])),now=next.updatedAt||new Date().toISOString();
  if(!(next.printers||[]).length&&previousPrinters.length){
    return{...previous,lastAttemptAt:now,contingency:{active:true,lastAttemptAt:now,preserved:previousPrinters.length,reason:"A leitura não retornou impressoras; os últimos dados válidos foram mantidos."},printers:previousPrinters.map(p=>({...p,stale:true,lastSuccessfulAt:p.lastSuccessfulAt||previous.updatedAt||null,lastAttemptAt:now}))};
  }
  const printers=(next.printers||[]).map(function(current){
    const old=previousMap.get(current.ip);
    if(current.online===false&&old&&old.online!==null&&(old.supplies||[]).length){
      return{...old,online:false,status:"offline",stale:true,lastSuccessfulAt:old.lastSuccessfulAt||previous.updatedAt||null,lastAttemptAt:now,error:"Sem resposta na última tentativa"};
    }
    return{...current,stale:false,lastSuccessfulAt:current.online?now:(old&&old.lastSuccessfulAt)||null,lastAttemptAt:now};
  });
  return{...next,printers,contingency:{active:printers.some(p=>p.stale),lastAttemptAt:now,preserved:printers.filter(p=>p.stale).length}};
}

app.get("/api/system/health", auth.requireMaster, (req,res) => {
  let disk={free:"Indisponível",total:"Indisponível"};
  try { const info=fs.statfsSync(pastaDados);disk={free:formatBytes(info.bavail*info.bsize),total:formatBytes(info.blocks*info.bsize)}; } catch {}
  let databaseOk=false,databaseMessage="";
  try { const result=auth.database.prepare("PRAGMA quick_check").get();databaseMessage=String(Object.values(result)[0]);databaseOk=databaseMessage.toLowerCase()==="ok"; } catch(error){databaseMessage=error.message;}
  let spreadsheet=null;try{spreadsheet=fs.statSync(arquivoPlanilha).mtime.toISOString();}catch{}
  const toner=lerTonerAtual();
  const recentErrors=auth.database.prepare("SELECT error,created_at AS createdAt FROM notification_log WHERE status='error' ORDER BY id DESC LIMIT 5").all();
  res.json({sucesso:true,health:{
    database:{ok:databaseOk,message:databaseMessage,path:arquivoBanco},
    lastSpreadsheet:spreadsheet,lastNxtUpdate:estadoAtualizacao.fim,lastSnmp:toner.updatedAt||null,
    disk:disk,server:{host:HOST,port:PORTA,url:"http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA},
    uptimeSeconds:Math.round(process.uptime()),node:process.version,recentErrors:recentErrors
  }});
});

app.get("/api/system/backup", auth.requireMaster, (req,res) => {
  const destination=path.join(pastaDados,"backup-"+Date.now()+".db");
  try {
    auth.database.exec("PRAGMA wal_checkpoint(FULL)");
    auth.database.exec("VACUUM INTO '"+destination.replace(/'/g,"''")+"'");
    res.download(destination,"central-operacoes-backup-"+new Date().toISOString().slice(0,10)+".db",function(){try{fs.rmSync(destination);}catch{}});
    auth.addAudit(req.user.id,"export","database","","Backup do banco baixado");
  } catch(error) { try{fs.rmSync(destination);}catch{} res.status(500).json({sucesso:false,mensagem:"Não foi possível gerar o backup: "+error.message}); }
});

app.post("/api/system/restore", auth.requireMaster, (req,res) => {
  try {
    const buffer=Buffer.from(String(req.body.databaseBase64||""),"base64");
    if(buffer.length<100||buffer.subarray(0,16).toString("utf8")!=="SQLite format 3\u0000")throw new Error("O arquivo não é um banco SQLite válido.");
    fs.writeFileSync(arquivoRestauracao,buffer);
    const probe=new DatabaseSync(arquivoRestauracao,{readOnly:true});
    const tables=probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(function(row){return row.name;});
    const check=probe.prepare("PRAGMA integrity_check").get();probe.close();
    if(!tables.includes("users")||String(Object.values(check)[0]).toLowerCase()!=="ok")throw new Error("O backup está incompleto ou corrompido.");
    auth.addAudit(req.user.id,"restore","database","","Restauração agendada");
    res.json({sucesso:true,restartRequired:true,mensagem:"Backup validado. Reinicie o servidor para concluir a restauração."});
  } catch(error){try{fs.rmSync(arquivoRestauracao);}catch{}res.status(400).json({sucesso:false,mensagem:error.message});}
});


app.get("/api/system/backup-settings",auth.requireMaster,function(req,res){
  res.json({sucesso:true,settings:{enabled:auth.getSetting("backup_auto_enabled","1")==="1",time:auth.getSetting("backup_auto_time","02:00"),retentionDays:Number(auth.getSetting("backup_retention_days","30"))||30,lastSuccess:auth.getSetting("backup_last_success",""),lastError:auth.getSetting("backup_last_error","")},items:auth.database.prepare("SELECT id,file_name fileName,size_bytes sizeBytes,status,integrity_status integrityStatus,created_at createdAt,verified_at verifiedAt,error FROM system_backups ORDER BY id DESC LIMIT 100").all()});
});
app.put("/api/system/backup-settings",auth.requireMaster,function(req,res){
  const time=/^([01]\d|2[0-3]):[0-5]\d$/.test(String(req.body?.time||""))?String(req.body.time):"02:00",retention=Math.max(1,Math.min(365,Number(req.body?.retentionDays)||30));
  auth.setSetting("backup_auto_enabled",req.body?.enabled===false?"0":"1",req.user.id);auth.setSetting("backup_auto_time",time,req.user.id);auth.setSetting("backup_retention_days",String(retention),req.user.id);auth.addAudit(req.user.id,"update","backup_settings","",time+" · "+retention+" dias");res.json({sucesso:true});
});
app.post("/api/system/backups/run",auth.requireMaster,function(req,res){try{const item=createAutomaticBackup("manual");res.status(201).json({sucesso:true,item:{fileName:item.name,sizeBytes:item.size},mensagem:"Backup criado e verificado com sucesso."});}catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}});
app.post("/api/system/backups/:id/test",auth.requireMaster,function(req,res){try{const item=auth.database.prepare("SELECT * FROM system_backups WHERE id=?").get(Number(req.params.id));if(!item||!fs.existsSync(item.file_path))throw new Error("Arquivo de backup não encontrado.");const ok=verifyDatabaseFile(item.file_path);auth.database.prepare("UPDATE system_backups SET integrity_status=?,verified_at=?,error=? WHERE id=?").run(ok?"ok":"failed",new Date().toISOString(),ok?"":"Falha na integridade",item.id);res.json({sucesso:ok,mensagem:ok?"Backup íntegro e apto para restauração.":"O backup está corrompido."});}catch(error){res.status(400).json({sucesso:false,mensagem:error.message});}});
app.get("/api/system/backups/:id/download",auth.requireMaster,function(req,res){const item=auth.database.prepare("SELECT * FROM system_backups WHERE id=?").get(Number(req.params.id));if(!item||!fs.existsSync(item.file_path))return res.status(404).json({sucesso:false,mensagem:"Backup não encontrado."});res.download(item.file_path,item.file_name);});

app.get("/api/system/daily-report-settings",auth.requireMaster,function(req,res){
  res.json({
    sucesso:true,
    enabled:auth.getSetting("daily_stock_report","0")==="1",
    startTime:auth.getSetting("activity_start_report_time","07:00"),
    closingTime:auth.getSetting("daily_stock_report_time","17:00"),
    lastStartSent:auth.getSetting("activity_start_last_date",""),
    lastClosingSent:auth.getSetting("daily_stock_report_last_date","")
  });
});
app.put("/api/system/daily-report-settings",auth.requireMaster,function(req,res){
  const validTime=function(value,fallback){return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value||""))?String(value):fallback;};
  const startTime=validTime(req.body?.startTime,"07:00"),closingTime=validTime(req.body?.closingTime,"17:00");
  if(startTime===closingTime)return res.status(400).json({sucesso:false,mensagem:"Defina horários diferentes para o início e o fechamento do dia."});
  auth.setSetting("daily_stock_report",req.body?.enabled===false?"0":"1",req.user.id);
  auth.setSetting("activity_start_report_time",startTime,req.user.id);
  auth.setSetting("daily_stock_report_time",closingTime,req.user.id);
  auth.addAudit(req.user.id,"update","daily_report_settings","",startTime+" · "+closingTime);
  res.json({sucesso:true,enabled:req.body?.enabled!==false,startTime:startTime,closingTime:closingTime});
});
app.post("/api/system/daily-report/send",auth.requireMaster,async function(req,res){
  const mode=req.body?.mode==="start"?"start":"closing",run=automationStart(mode==="start"?"activity_start":"closing","manual");
  try{
    if(auth.getSetting("notifications_enabled","0")!=="1")throw new Error("Ative as notificações e configure o canal do Teams antes de enviar.");
    const sent=mode==="start"?await sendStartOfActivitiesReport(true):await sendDailyStockMovementReport(true);
    if(!sent)throw new Error("O relatório não foi entregue; confira as configurações do Teams.");
    const message=mode==="start"?"Relatório de início do dia enviado ao canal.":"Relatório de fechamento enviado ao canal.";
    automationFinish(run,true,message,"");res.json({sucesso:true,mensagem:message});
  }catch(error){automationFinish(run,false,error.message,"");res.status(500).json({sucesso:false,mensagem:error.message});}
});

app.get("/api/system/automations",auth.requireMaster,function(req,res){res.json({sucesso:true,items:auth.database.prepare("SELECT id,automation_type automationType,trigger_type triggerType,status,started_at startedAt,finished_at finishedAt,duration_ms durationMs,message,details FROM automation_runs ORDER BY id DESC LIMIT 300").all()});});
app.post("/api/system/automations/:type/run",auth.requireMaster,async function(req,res){
  const type=String(req.params.type||"");
  try{
    if(type==="snmp"){const ok=await scheduledTonerScan("manual");return res.status(ok?200:409).json({sucesso:ok,mensagem:ok?"Leitura SNMP concluída.":"Já existe uma leitura em andamento."});}
    if(type==="backup"){const item=createAutomaticBackup("manual");return res.json({sucesso:true,mensagem:"Backup "+item.name+" criado."});}
    if(type==="nxt"){const ok=scheduledNxtUpdate("manual");return res.status(ok?202:409).json({sucesso:ok,mensagem:ok?"Atualização do NXT iniciada.":"A atualização não pôde ser iniciada."});}
    const run=automationStart(type,"manual");let ok=false,message="";
    if(type==="teams"){const total=await sendOperationalSummaries(true,["stock","toner"]);ok=true;message=total+" resumo(s) enviado(s).";}
    else if(type==="closing"){ok=await sendDailyStockMovementReport(true);message=ok?"Relatório diário enviado manualmente.":"Relatório não enviado; confira as configurações.";}
    else throw new Error("Automação desconhecida.");
    automationFinish(run,ok,message,"");return res.status(ok?200:500).json({sucesso:ok,mensagem:message});
  }catch(error){return res.status(500).json({sucesso:false,mensagem:error.message});}
});

app.get("/api/reports/:type",auth.requireMaster,async function(req,res){
  try{
    const type=String(req.params.type||""),parseLocalDate=function(value,end){const parts=String(value||"").split("-").map(Number);if(parts.length!==3||!parts[0])return end?"9999-12-31T23:59:59.999Z":"0000-01-01T00:00:00.000Z";const date=new Date(parts[0],parts[1]-1,parts[2],end?23:0,end?59:0,end?59:0,end?999:0);return date.toISOString();},from=parseLocalDate(req.query.from,false),to=parseLocalDate(req.query.to,true),query=String(req.query.q||"").toLocaleLowerCase("pt-BR");let columns=[],rows=[];
    if(type==="stock"){const data=await lerPlanilha();columns=["Categoria","Quantidade atual","Modelos"];rows=data.categorias.map(x=>[x.nome,x.atual,x.modelos.map(m=>m.nome+" ("+m.quantidade+")").join(", ")]);}
    else if(type==="movements"){reconcileStockMovementHistory();columns=["Data","Tipo","Ativo","Categoria","Origem","Destino"];rows=auth.database.prepare("SELECT detected_at,movement_type,asset_code,category,previous_location,new_location FROM stock_movement_events WHERE detected_at BETWEEN ? AND ? ORDER BY detected_at DESC").all(from,to).map(x=>[x.detected_at,x.movement_type,x.asset_code,x.category,x.previous_location,x.new_location]);}
    else if(type==="purchases"){columns=["Solicitação","Status","Criada em","Atualizada em","Responsável"];rows=auth.getRestockRequests().filter(x=>String(x.createdAt||"")>=from&&String(x.createdAt||"")<=to).map(x=>[x.code||x.id,x.status,x.createdAt,x.updatedAt,x.createdBy||""]);}
    else if(type==="toners"){columns=["IP","Impressora","Modelo","Consumível","Nível","Status","Leitura"];const report=lerTonerAtual();rows=(report.printers||[]).flatMap(p=>(p.supplies||[]).filter(s=>s.isToner!==false).map(s=>[p.ip,p.hostname,p.model,s.description,s.percent,p.status,report.updatedAt]));}
    else if(type==="prints"){columns=["IP","Modelo","Hostname","Total de páginas","Data"];rows=auth.database.prepare("SELECT printer_ip,printer_model,hostname,total_pages,recorded_at FROM printer_page_history WHERE recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC").all(from,to).map(Object.values);}
    else if(type==="maintenance"){columns=["IP","Tipo","Último contador","Próximo vencimento","Última manutenção","Observações"];rows=auth.database.prepare("SELECT printer_ip,maintenance_type,last_pages,next_due_pages,last_at,notes FROM printer_maintenance ORDER BY next_due_pages").all().map(Object.values);}
    else if(type==="collaborators"){columns=["Tipo","Nome","Matrícula","Departamento/Situação","Data"];const snap=auth.database.prepare("SELECT data_json FROM collaborator_snapshot WHERE id=1").get(),items=snap?JSON.parse(snap.data_json||"[]"):[];rows=items.map(x=>[x.kind,x.nome,x.mat,x.dept||x.situacao||x.origem+" → "+x.destino,x.data||x.feriasFim||""]);}
    else if(type==="audit"){columns=["Data","Usuário","Ação","Entidade","Identificador","Detalhes"];rows=auth.database.prepare("SELECT a.created_at,COALESCE(u.username,'Sistema'),a.action,a.entity_type,a.entity_id,a.details FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.created_at BETWEEN ? AND ? ORDER BY a.id DESC").all(from,to).map(Object.values);}
    else return res.status(404).json({sucesso:false,mensagem:"Relatório não encontrado."});
    if(query)rows=rows.filter(row=>row.join(" ").toLocaleLowerCase("pt-BR").includes(query));
    res.json({sucesso:true,type,generatedAt:new Date().toISOString(),columns,rows,count:rows.length});
  }catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}
});

async function sendTeamsNotification(webhook,title,message,details,eventType) {
  const visual={
    "stock-summary":{icon:"📦",color:"Attention"},"toner-summary":{icon:"🖨️",color:"Attention"},
    "purchase":{icon:"🛒",color:"Accent"},"daily-stock":{icon:"📊",color:"Good"},
    "vacation":{icon:"👤",color:"Accent"},"task":{icon:"⏰",color:"Warning"},
    "request":{icon:"⚠️",color:"Warning"},"startup":{icon:"✅",color:"Good"},"activity-start":{icon:"🌅",color:"Good"},"test":{icon:"✅",color:"Good"}
  }[eventType]||{icon:"ℹ️",color:"Accent"};
  const body=[
    {type:"TextBlock",weight:"Bolder",size:"Medium",color:visual.color,text:visual.icon+" "+title}
  ];
  const printerGroups=eventType==="toner-summary"&&details&&Array.isArray(details.printerGroups)?details.printerGroups:null;
  const stockItems=eventType==="stock-summary"&&details&&Array.isArray(details.stockItems)?details.stockItems:null;
  const startReport=eventType==="activity-start"&&details&&details.startReport?details.startReport:null;
  const dailyReport=eventType==="daily-stock"&&details&&details.dailyReport?details.dailyReport:null;
  if(startReport){
    body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:startReport.date+"  •  Primeira visão operacional do dia"});
    body.push({type:"ColumnSet",spacing:"Medium",columns:[
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"ESTOQUE BAIXO"},{type:"TextBlock",weight:"Bolder",size:"Large",color:"Attention",spacing:"None",text:String(startReport.stockItems.length)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"TONERS CRÍTICOS"},{type:"TextBlock",weight:"Bolder",size:"Large",color:"Attention",spacing:"None",text:String(startReport.criticalToners)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"OFFLINE"},{type:"TextBlock",weight:"Bolder",size:"Large",spacing:"None",text:String(startReport.offline.length)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"COMPRAS ABERTAS"},{type:"TextBlock",weight:"Bolder",size:"Large",spacing:"None",text:String(startReport.openRequests)}]}
    ]});
    body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"Movimentações após o último fechamento"});
    if(!startReport.afterHours.length)body.push({type:"TextBlock",wrap:true,color:"Good",text:"Nenhuma movimentação pendente foi detectada."});
    startReport.afterHours.slice(0,15).forEach(function(item){
      const label=item.type==="exit"?"🔴 Saída":item.type==="entry"?"🟢 Entrada":"🔵 Transferência";
      body.push({type:"Container",style:"emphasis",spacing:"Small",items:[
        {type:"TextBlock",weight:"Bolder",wrap:true,text:label+"  •  "+item.category+"  •  "+item.code},
        {type:"TextBlock",isSubtle:true,size:"Small",spacing:"None",text:"Detectado na atualização das "+item.detectedAt+(item.extra?"  •  "+item.extra:"")}
      ]});
    });
    if(startReport.stockItems.length){body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"📦 Reposição necessária"});body.push({type:"FactSet",facts:startReport.stockItems.slice(0,10).map(function(item){return{title:item.name,value:"Comprar "+item.buy+"  •  atual "+item.current+" / mínimo "+item.minimum};})});}
    if(startReport.printerGroups.length){body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"🖨️ Toners para atenção"});startReport.printerGroups.slice(0,10).forEach(function(item){body.push({type:"TextBlock",wrap:true,spacing:"Small",text:item.printer+"  •  "+item.supplies.map(function(supply){return supply.description+" "+supply.level+"%";}).join("  |  ")});});}
    body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"Rede de impressoras"});
    body.push({type:"TextBlock",wrap:true,color:startReport.offline.length?"Attention":"Good",text:startReport.offline.length?startReport.offline.join("  •  "):"Todas as impressoras monitoradas estão online."});
  } else if(stockItems){
    const total=stockItems.reduce(function(sum,item){return sum+Number(item.buy||0);},0);
    body.push({type:"TextBlock",wrap:true,isSubtle:true,text:stockItems.length+" categoria(s) abaixo do mínimo  •  "+total+" unidade(s) para reposição"});
    stockItems.forEach(function(item,index){
      body.push({type:"Container",style:"emphasis",separator:index>0,spacing:index>0?"Medium":"Small",items:[{
        type:"ColumnSet",columns:[
          {type:"Column",width:"stretch",items:[
            {type:"TextBlock",weight:"Bolder",wrap:true,text:item.name},
            {type:"TextBlock",isSubtle:true,size:"Small",spacing:"Small",text:"Estoque atual: "+item.current+"  •  Mínimo: "+item.minimum}
          ]},
          {type:"Column",width:"auto",verticalContentAlignment:"Center",items:[
            {type:"TextBlock",horizontalAlignment:"Right",isSubtle:true,size:"Small",text:"COMPRAR"},
            {type:"TextBlock",horizontalAlignment:"Right",weight:"Bolder",size:"Large",color:"Attention",spacing:"None",text:String(item.buy)}
          ]}
        ]
      }]});
    });
  } else if(printerGroups){
    body.push({type:"TextBlock",wrap:true,isSubtle:true,text:"Leve os consumíveis indicados abaixo para realizar cada troca."});
    printerGroups.forEach(function(item,index){
      const items=[
        {type:"TextBlock",weight:"Bolder",size:"Default",wrap:true,text:"Impressora "+(index+1)+" — "+item.printer},
        {type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:(item.ip?"IP: "+item.ip+"  •  ":"")+"Modelo: "+(item.model||"Não identificado")}
      ];
      (item.supplies||[]).forEach(function(supply){
        const brandMatch=String(supply.description||"").match(/\b(HP|Samsung|Epson|Brother|Lexmark|Xerox|Canon)\b/i);
        const fallback=supply.kind==="Toner"?item.cartridge:"Confirmar pelo código do consumível";
        const take=supply.code?((brandMatch?brandMatch[1].toUpperCase()+" ":"")+supply.code):fallback;
        items.push({
          type:"ColumnSet",spacing:"Medium",separator:true,columns:[
            {type:"Column",width:"stretch",items:[
              {type:"TextBlock",wrap:true,weight:"Bolder",text:supply.description},
              {type:"TextBlock",wrap:true,spacing:"Small",color:"Good",weight:"Bolder",text:"LEVAR  →  1 × "+take}
            ]},
            {type:"Column",width:"auto",verticalContentAlignment:"Center",items:[
              {type:"TextBlock",horizontalAlignment:"Right",weight:"Bolder",size:"Large",color:"Attention",text:String(supply.level)+"%"},
              {type:"TextBlock",horizontalAlignment:"Right",isSubtle:true,size:"Small",spacing:"None",text:"nível atual"}
            ]}
          ]
        });
      });
      body.push({type:"Container",separator:index>0,spacing:index>0?"ExtraLarge":"Medium",style:"emphasis",items:items});
    });
  } else if(dailyReport){
    body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:dailyReport.date+"  •  Período monitorado: "+dailyReport.period+"  •  Última sincronização: "+dailyReport.lastSync});
    body.push({type:"ColumnSet",spacing:"Medium",columns:[
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"ENTRADAS"},{type:"TextBlock",weight:"Bolder",size:"Large",color:"Good",spacing:"None",text:String(dailyReport.entries.length)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"SAÍDAS"},{type:"TextBlock",weight:"Bolder",size:"Large",color:"Attention",spacing:"None",text:String(dailyReport.exits.length)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"SALDO"},{type:"TextBlock",weight:"Bolder",size:"Large",spacing:"None",text:(dailyReport.balance>0?"+":"")+String(dailyReport.balance)}]},
      {type:"Column",width:"stretch",items:[{type:"TextBlock",isSubtle:true,size:"Small",text:"CATEGORIAS"},{type:"TextBlock",weight:"Bolder",size:"Large",spacing:"None",text:String(dailyReport.changedCategories.length)}]}
    ]});
    body.push({type:"TextBlock",weight:"Bolder",color:"Attention",spacing:"Large",separator:true,text:"🔴 Saídas do estoque"});
    if(!dailyReport.exits.length)body.push({type:"TextBlock",wrap:true,color:dailyReport.sufficient?"Good":"Warning",text:dailyReport.sufficient?"Nenhuma saída foi detectada hoje.":"Ainda não há duas sincronizações concluídas hoje para confirmar as saídas."});
    dailyReport.exits.slice(0,15).forEach(function(item){body.push({type:"Container",style:"emphasis",spacing:"Small",items:[{type:"TextBlock",weight:"Bolder",wrap:true,text:item.category+"  •  "+item.code},{type:"TextBlock",isSubtle:true,size:"Small",spacing:"None",text:"Detectado na atualização das "+item.detectedAt}]});});
    body.push({type:"TextBlock",weight:"Bolder",color:"Good",spacing:"Large",separator:true,text:"🟢 Entradas no estoque"});
    if(!dailyReport.entries.length)body.push({type:"TextBlock",wrap:true,isSubtle:true,text:dailyReport.sufficient?"Nenhuma entrada foi detectada hoje.":"A primeira sincronização do dia foi registrada como referência."});
    dailyReport.entries.slice(0,15).forEach(function(item){body.push({type:"Container",style:"emphasis",spacing:"Small",items:[{type:"TextBlock",weight:"Bolder",wrap:true,text:item.category+"  •  "+item.code},{type:"TextBlock",isSubtle:true,size:"Small",spacing:"None",text:"Detectado na atualização das "+item.detectedAt}]});});
    if(dailyReport.changedCategories.length){
      body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"Variação por categoria"});
      body.push({type:"FactSet",facts:dailyReport.changedCategories.slice(0,15).map(function(item){return{title:item.name,value:item.before+" → "+item.after+" ("+(item.difference>0?"+":"")+item.difference+")"};})});
    }
    body.push({type:"TextBlock",weight:"Bolder",spacing:"Large",separator:true,text:"Situação final da operação"});
    body.push({type:"FactSet",facts:[
      {title:"Itens abaixo do mínimo",value:String(dailyReport.stockLow)},
      {title:"Toners críticos",value:String(dailyReport.criticalToners)},
      {title:"Impressoras offline",value:String(dailyReport.offlineCount)},
      {title:"Solicitações abertas",value:String(dailyReport.openRequests)}
    ]});
    body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",spacing:"Medium",text:dailyReport.unchangedCount+" categoria(s) permaneceram sem alteração. Movimentações calculadas somente entre sincronizações concluídas hoje."});
  } else {
    body.push({type:"TextBlock",wrap:true,text:message});
    const facts=Object.entries(details||{}).filter(function(entry){return entry[1]!==undefined&&entry[1]!==null&&String(entry[1]).trim();}).map(function(entry){return{title:String(entry[0]),value:String(entry[1])};});
    if(facts.length)body.push({type:"FactSet",facts:facts});
  }
  body.push({type:"TextBlock",wrap:true,isSubtle:true,size:"Small",text:"Central de Operações de TI · "+new Date().toLocaleString("pt-BR")});
  const dashboardUrl="http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA+"/central.html";
  const payload={type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{type:"AdaptiveCard",version:"1.4",body:body,actions:[{type:"Action.OpenUrl",title:"Abrir Central de Operações",url:dashboardUrl}]}}]};
  const response=await fetch(webhook,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  if(!response.ok)throw new Error("Teams respondeu HTTP "+response.status);
}

function sendEmailNotification(settings,title,message) {
  return new Promise(function(resolve,reject){
    const smtp=auth.getSetting("notifications_smtp_host",""),from=auth.getSetting("notifications_email_from",""),to=settings.emailTo;
    if(!smtp||!from||!to)return reject(new Error("Configure servidor SMTP, remetente e destinatário."));
    const script='$p=$env:NXT_SMTP_PORT; $c=New-Object Net.Mail.SmtpClient($env:NXT_SMTP_HOST,[int]$p); $c.EnableSsl=$env:NXT_SMTP_SSL -eq "1"; if($env:NXT_SMTP_USER){$c.Credentials=New-Object Net.NetworkCredential($env:NXT_SMTP_USER,$env:NXT_SMTP_PASS)}; $m=New-Object Net.Mail.MailMessage($env:NXT_MAIL_FROM,$env:NXT_MAIL_TO,$env:NXT_MAIL_SUBJECT,$env:NXT_MAIL_BODY); $c.Send($m)';
    const encoded=Buffer.from(script,"utf16le").toString("base64");
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],{windowsHide:true,env:{...process.env,NXT_SMTP_HOST:smtp,NXT_SMTP_PORT:auth.getSetting("notifications_smtp_port","587"),NXT_SMTP_SSL:auth.getSetting("notifications_smtp_ssl","1"),NXT_SMTP_USER:auth.getSetting("notifications_smtp_user",""),NXT_SMTP_PASS:auth.getSetting("notifications_smtp_password",""),NXT_MAIL_FROM:from,NXT_MAIL_TO:to,NXT_MAIL_SUBJECT:title,NXT_MAIL_BODY:message}});
    let error="";child.stderr.on("data",function(d){error+=d.toString();});child.on("error",reject);child.on("close",function(code){code===0?resolve():reject(new Error(error||"Falha SMTP"));});
  });
}

async function dispatchNotification(eventKey,eventType,title,message,force,details) {
  const db=auth.database;
  if(!force&&db.prepare("SELECT id FROM notification_log WHERE event_key=? AND status=\'sent\'").get(eventKey))return false;
  const enabled=auth.getSetting("notifications_enabled","0")==="1";if(!enabled&&!force)return false;
  const channel=auth.getSetting("notifications_channel","teams"),settings={emailTo:auth.getSetting("notifications_email_to","")};
  let status="sent",error="";
  try {
    if(channel==="teams"||channel==="both"){const hook=auth.getSetting("notifications_teams_webhook","");if(!hook)throw new Error("Webhook do Teams não configurado.");await sendTeamsNotification(hook,title,message,details,eventType);}
    if(channel==="email"||channel==="both")await sendEmailNotification(settings,title,message);
  } catch(e){status="error";error=e.message;}
  db.prepare("INSERT OR REPLACE INTO notification_log (event_key,event_type,title,message,channel,status,created_at,sent_at,error) VALUES (?,?,?,?,?,?,?,?,?)").run(eventKey,eventType,title,message,channel,status,new Date().toISOString(),status==="sent"?new Date().toISOString():"",error);
  return status==="sent";
}

function requestStatusLabel(status) {
  return ({draft:"Rascunho",awaiting_approval:"Aguardando aprovação",approved:"Aprovada",sc_open:"SC aberta",purchasing:"Em compra",partial_received:"Recebimento parcial",finished:"Finalizada"})[status]||status;
}
async function notifyRestockRequest(request, action) {
  if(!request)return false;
  const total=(request.items||[]).reduce(function(sum,item){return sum+Number(item.quantity||0);},0);
  const received=(request.items||[]).reduce(function(sum,item){return sum+Number(item.receivedQuantity||0);},0);
  const products=(request.items||[]).map(function(item){return item.categoryName+" ("+item.quantity+")";}).join(", ");
  const title=action==="created"?"Nova solicitação de compra":"Solicitação de compra atualizada";
  const message=action==="created"
    ?"Uma nova necessidade de reposição foi registrada e precisa de acompanhamento."
    :"O andamento da compra foi alterado. O canal está sendo atualizado automaticamente.";
  return dispatchNotification("purchase:"+request.id+":"+request.status+":"+String(request.updatedAt||Date.now()),"purchase",title,message,false,{
    "Solicitação":"#"+request.id,"Status":requestStatusLabel(request.status),"Itens":products||"Não informado",
    "Solicitado":total+" unidade(s)","Recebido":received+" unidade(s)","Pendente":Math.max(0,total-received)+" unidade(s)",
    "Número da SC":request.scNumber||"Ainda não informado","Responsável":request.buyer||request.updatedBy||"Não definido",
    "Previsão":request.expectedAt||"Não definida"
  });
}
async function sendStartupDigest(force) {
  if(auth.getSetting("notifications_enabled","0")!=="1"){if(force)throw new Error("Ative e salve as notificações antes de enviar o resumo.");return false;}
  let shortages=[],critical=0,openRequests=0;
  try{
    const stock=await lerPlanilha(),cats=stock.categorias||[];
    auth.getMinimums().filter(function(item){return item.monitored&&Number(item.minimum)>0;}).forEach(function(rule){
      const normalized=String(rule.categoryName||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
      const found=cats.find(function(cat){const name=String(cat.nome||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();return name===normalized||name.includes(normalized)||normalized.includes(name);});
      const current=found?Number(found.atual)||0:0,missing=Math.max(0,Number(rule.minimum)-current);
      if(missing)shortages.push(rule.categoryName+": comprar "+missing);
    });
  }catch{}
  try{const toner=lerTonerAtual();critical=Number(toner.summary&&toner.summary.critical)||0;}catch{}
  try{openRequests=auth.getRestockRequests().filter(function(item){return item.status!=="finished";}).length;}catch{}
  return dispatchNotification((force?"manual-digest:":"startup-digest:")+Date.now(),"startup","Servidor ativo · resumo operacional",
    shortages.length?"Existem itens abaixo do estoque mínimo que precisam de compra.":"O servidor foi iniciado e não existem faltas de estoque monitoradas.",false,{
      "Itens para comprar":shortages.length?shortages.join(" · "):"Nenhum",
      "Toners críticos":critical,"Solicitações abertas":openRequests,
      "Endereço":"http://"+(HOST==="0.0.0.0"?os.hostname():HOST)+":"+PORTA
    });
}

async function buildOperationalSummaryEvents(force, selectedTypes) {
  const types=Array.isArray(selectedTypes)&&selectedTypes.length?selectedTypes:["stock","toner"];
  const events=[],timestamp=Date.now(),day=new Date().toISOString().slice(0,10);
  const keySuffix=force?String(timestamp):day;
  const stockAlerts=[];
  if(types.includes("stock"))try {
    const stock=await lerPlanilha(),categories=Array.isArray(stock.categorias)?stock.categorias:[],rows=Array.isArray(stock.ativos)?stock.ativos:[],counts={};
    rows.forEach(function(item){
      const name=String(item.tipoAtivo||item.tipo||item.categoria||item.category||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
      if(name)counts[name]=(counts[name]||0)+1;
    });
    auth.getMinimums().filter(function(item){return item.monitored&&Number(item.minimum)>0;}).forEach(function(rule){
      const key=String(rule.categoryKey||rule.categoryName||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
      const category=categories.find(function(item){
        const name=String(item.nome||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().trim();
        return name===key||name.includes(key)||key.includes(name);
      });
      const current=category?Number(category.atual)||0:counts[key]||0;
      const buy=Math.max(0,Number(rule.minimum)-current);
      if(buy)stockAlerts.push({name:rule.categoryName,current:current,minimum:Number(rule.minimum),buy:buy});
    });
  } catch(error) { console.error("Resumo de estoque:",error.message); }
  if(stockAlerts.length){
    events.push({
      key:"stock-summary:"+keySuffix,type:"stock-summary",title:"Estoque mínimo · compra necessária",
      message:stockAlerts.map(function(item){return item.name+": comprar "+item.buy+" unidade(s) · atual "+item.current+" · mínimo "+item.minimum;}).join("\n"),
      details:{stockItems:stockAlerts}
    });
  }

  const tonerAlerts=[],toner=types.includes("toner")?lerTonerAtual():{printers:[],threshold:20},threshold=Number(toner.threshold||20);
  function supplyCode(description) {
    const matches=String(description||"").toUpperCase().match(/\b(?=[A-Z0-9-]{5,14}\b)(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]+\b/g)||[];
    return matches.length?matches[matches.length-1]:"";
  }
  (toner.printers||[]).forEach(function(printer){
    if(printer.online===false)return;
    const criticalSupplies=[];
    (printer.supplies||[]).forEach(function(supply){
      if(supply.isToner===false)return;
      const level=Number(supply.level??supply.percent);
      if(!Number.isFinite(level)||level>threshold)return;
      const description=String(supply.name||supply.description||"Toner");
      const code=String(supply.partNumber||supply.model||supplyCode(description));
      const collection=/(coleta|collection|waste|residu)/i.test(description);
      if(collection)return;
      criticalSupplies.push({
        description:description,level:level,code:code,
        kind:collection?"Unidade de coleta":"Toner"
      });
    });
    if(criticalSupplies.length)tonerAlerts.push({
      printer:printer.hostname||printer.model||printer.ip,
      ip:printer.ip||"",model:printer.model||"",cartridge:printer.cartridge||"",
      supplies:criticalSupplies
    });
  });
  if(tonerAlerts.length){
    const message=tonerAlerts.map(function(item,index){
      const identity="Impressora "+(index+1)+" — "+item.printer+(item.ip?" ("+item.ip+")":"");
      const lines=item.supplies.map(function(supply){
        const fallback=supply.kind==="Toner"?item.cartridge:"Confirmar pelo código do consumível";
        const brandMatch=supply.description.match(/\b(HP|Samsung|Epson|Brother|Lexmark|Xerox|Canon)\b/i);
        const take=supply.code?((brandMatch?brandMatch[1].toUpperCase()+" ":"")+supply.code):fallback;
        return "• "+supply.description+": "+supply.level+"%\n  LEVAR PARA TROCA: "+take;
      });
      if(item.model)lines.push("  Modelo da impressora: "+item.model);
      return identity+"\n"+lines.join("\n");
    }).join("\n\n");
    events.push({
      key:"toner-summary:"+keySuffix,type:"toner-summary",title:"Impressoras · consumíveis em nível crítico",
      message:message,
      details:{printerGroups:tonerAlerts}
    });
  }
  return events;
}

async function sendOperationalSummaries(force, selectedTypes) {
  if(auth.getSetting("notifications_enabled","0")!=="1"){
    if(force)throw new Error("Ative e salve as notificações antes de enviar o resumo.");
    return 0;
  }
  const events=await buildOperationalSummaryEvents(Boolean(force),selectedTypes);
  for(const event of events)await dispatchNotification(event.key,event.type,event.title,event.message,false,event.details);
  return events.length;
}

async function evaluateNotifications() {
  const events=[],today=new Date(),lead=Math.max(0,Number(auth.getSetting("notifications_task_lead_days","2"))||2),stale=Math.max(1,Number(auth.getSetting("notifications_stale_days","5"))||5);
  auth.database.prepare("SELECT id,title,due_date AS dueDate FROM operational_tasks WHERE status!='done' AND due_date!=''").all().forEach(function(task){
    const days=Math.ceil((new Date(task.dueDate+"T23:59:59")-today)/86400000);
    if(days<=lead)events.push({key:"task:"+task.id+":"+task.dueDate,type:"task",title:"Tarefa próxima do vencimento",message:task.title+" · "+(days<0?"atrasada há "+Math.abs(days)+" dia(s)":"vence em "+days+" dia(s)")});
  });
  auth.database.prepare("SELECT id,status,updated_at AS updatedAt FROM restock_requests WHERE status!='received'").all().forEach(function(item){
    const days=Math.floor((today-new Date(item.updatedAt))/86400000);
    if(days>=stale)events.push({key:"request:"+item.id+":"+item.updatedAt.slice(0,10),type:"request",title:"Solicitação sem atualização",message:"Solicitação #"+item.id+" está há "+days+" dia(s) sem atualização."});
  });
  auth.database.prepare("SELECT employee_key AS employeeKey,employee_name AS employeeName,activation_date AS activationDate FROM vacation_access_plans WHERE completed=0 AND activation_date!=''").all().forEach(function(plan){
    if(plan.activationDate<=today.toISOString().slice(0,10))events.push({key:"vacation:"+plan.employeeKey+":"+plan.activationDate,type:"vacation",title:"Retorno de férias",message:plan.employeeName+" retorna em "+plan.activationDate+". Confira a reativação dos acessos."});
  });
  for(const event of events)await dispatchNotification(event.key,event.type,event.title,event.message,false,event.details);
  return events.length;
}
app.post("/api/notifications/test", auth.requireMaster, async(req,res)=>{const ok=await dispatchNotification("test:"+Date.now(),"test","Teste de notificações","A Central de Operações de TI está conectada.",true);res.status(ok?200:500).json({sucesso:ok,mensagem:ok?"Notificação enviada.":"Falha no envio. Consulte o histórico."});});
app.post("/api/notifications/run", auth.requireMaster, async(req,res)=>{const total=await evaluateNotifications();res.json({sucesso:true,total});});
app.post("/api/notifications/digest", auth.requireMaster, async(req,res)=>{try{const types=(Array.isArray(req.body&&req.body.types)?req.body.types:[]).filter(function(type){return type==="stock"||type==="toner";});const total=await sendOperationalSummaries(true,types);res.json({sucesso:true,total:total,mensagem:total?"Resumos de estoque e impressoras enviados ao Teams.":"Não há itens abaixo do mínimo nem toners críticos."});}catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}});
setInterval(function(){evaluateNotifications().catch(function(error){console.error("Notificações:",error.message);});},15*60*1000).unref();

app.get("/api/configuracao/nxt", auth.requireMaster, (req, res) => {
  res.json({
    sucesso: true,
    email: process.env.NXT_EMAIL || "",
    senhaConfigurada: Boolean(process.env.NXT_PASSWORD),
  });
});

app.put("/api/configuracao/nxt", auth.requireMaster, (req, res) => {
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "");
  if (!email) return res.status(400).json({ sucesso: false, mensagem: "Informe o usuário ou e-mail do NXT." });
  if (!password && !process.env.NXT_PASSWORD) {
    return res.status(400).json({ sucesso: false, mensagem: "Informe a senha do NXT." });
  }
  const changes = { NXT_EMAIL: email };
  if (password) changes.NXT_PASSWORD = password;
  salvarConfiguracaoEnv(changes);
  return res.json({ sucesso: true, email, senhaConfigurada: true });
});

/*
 * Regras de estoque mínimo persistidas no banco local.
 */
app.get("/api/minimos", auth.requirePermission("stock"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    itens: auth.getMinimums(),
    podeEditar: req.user.role === "master",
  });
});

app.put(
  "/api/minimos",
  auth.requireMaster,
  (req, res) => {
    const itens = Array.isArray(req.body.itens)
      ? req.body.itens.slice(0, 500)
      : [];

    const salvos = auth.saveMinimums(
      itens,
      Number(req.user.id)
    );

    res.json({
      sucesso: true,
      itens: salvos,
    });
  }
);

/*
 * Solicitações de reposição e acompanhamento de compra.
 */
app.get("/api/solicitacoes", auth.requirePermission("stock"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    solicitacoes: auth.getRestockRequests(),
    podeEditar: req.user.role === "master" || auth.userPermissions(req.user).create_requests,
  });
});

app.post(
  "/api/solicitacoes",
  auth.requirePermission("create_requests"),
  (req, res) => {
    try {
      const solicitacao = auth.createRestockRequest(
        req.body.itens,
        req.body.observacao,
        Number(req.user.id)
      );

      res.status(201).json({
        sucesso: true,
        solicitacao,
      });
      notifyRestockRequest(solicitacao, "created").catch(function(error){ console.error("Teams · solicitação:", error.message); });
    } catch (erro) {
      res.status(400).json({
        sucesso: false,
        mensagem: erro.message,
      });
    }
  }
);

app.patch(
  "/api/solicitacoes/:id",
  auth.requirePermission("create_requests"),
  (req, res) => {
    let solicitacao;

    try {
      solicitacao = auth.updateRestockRequest(
        Number(req.params.id),
        {
          status: req.body.status,
          notes: req.body.observacao,
          scNumber: req.body.numeroSc,
          openedAt: req.body.dataAbertura,
          buyer: req.body.responsavelCompra,
          expectedAt: req.body.previsaoEntrega,
          items: req.body.itens,
        },
        Number(req.user.id)
      );
    } catch (erro) {
      return res.status(400).json({
        sucesso: false,
        mensagem: erro.message,
      });
    }

    if (!solicitacao) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Solicitação não encontrada.",
      });
    }

    res.json({
      sucesso: true,
      solicitacao,
    });
    notifyRestockRequest(solicitacao, "updated").catch(function(error){ console.error("Teams · solicitação:", error.message); });
    return;
  }
);

app.delete(
  "/api/solicitacoes/:id",
  auth.requireMaster,
  (req, res) => {
    const existingRequest = auth.getRestockRequests().find(function(item){ return item.id === Number(req.params.id); });
    const removida = auth.deleteRestockRequest(
      Number(req.params.id)
    );

    if (!removida) {
      return res.status(404).json({
        sucesso: false,
        mensagem: "Solicitação não encontrada.",
      });
    }

    res.json({
      sucesso: true,
      mensagem: "Solicitação excluída.",
    });
    if(existingRequest)dispatchNotification("purchase-deleted:"+existingRequest.id+":"+Date.now(),"purchase","Solicitação de compra excluída","Uma solicitação foi removida pelo Master Admin.",false,{"Solicitação":"#"+existingRequest.id,"Responsável":req.user.username||"Master Admin"}).catch(function(error){console.error("Teams · exclusão:",error.message);});
    return;
  }
);


app.get("/api/impressoras", auth.requirePermission("toner"), (req, res) => {
  res.json({
    sucesso: true,
    impressoras: auth.getPrinters(),
    podeEditar: ["master", "operator"].includes(req.user.role),
  });
});

app.get("/api/impressoras/:ip/detalhes", auth.requirePermission("toner"), function(req,res) {
  const ip=String(req.params.ip||"").trim();
  const printer=activePrinterByIp(ip);
  if(!printer)return res.status(404).json({sucesso:false,mensagem:"Impressora não encontrada no cadastro ativo."});
  const report=lerTonerAtual(),reading=(report.printers||[]).find(function(item){return item.ip===printer.ip;})||null;
  const pageHistory=auth.database.prepare(
    "SELECT total_pages AS totalPages,recorded_at AS recordedAt FROM printer_page_history WHERE printer_ip=? ORDER BY recorded_at DESC LIMIT 180"
  ).all(printer.ip).reverse();
  const tonerHistory=auth.database.prepare(
    "SELECT supply_name AS supplyName,level,status,recorded_at AS recordedAt FROM toner_history WHERE printer_ip=? ORDER BY recorded_at DESC LIMIT 120"
  ).all(printer.ip);
  const exchanges=auth.database.prepare(
    "SELECT e.id,e.toner_model AS tonerModel,e.color,e.previous_level AS previousLevel,e.current_level AS currentLevel,e.source,e.created_at AS createdAt,"
    +"CASE WHEN e.source='automatic' THEN 'Sistema automático' ELSE COALESCE(u.username,'Sistema') END AS performedBy "
    +"FROM toner_exchanges e LEFT JOIN users u ON u.id=e.performed_by WHERE e.printer_ip=? ORDER BY e.created_at DESC LIMIT 50"
  ).all(printer.ip);
  const maintenance=auth.database.prepare(
    "SELECT id,maintenance_type AS type,interval_pages AS intervalPages,last_pages AS lastPages,next_due_pages AS nextDuePages,last_at AS lastAt,notes,created_at AS createdAt,updated_at AS updatedAt "
    +"FROM printer_maintenance WHERE printer_ip=? ORDER BY next_due_pages"
  ).all(printer.ip);
  const supplies=reading&&Array.isArray(reading.supplies)?reading.supplies.filter(function(item){return item.isToner!==false;}):[];
  const alerts=[];
  if(!reading||reading.online===false)alerts.push({severity:"critical",title:"Impressora sem resposta",detail:"Não houve resposta na última consulta SNMP."});
  supplies.forEach(function(item){
    if(item.status==="critical")alerts.push({severity:"critical",title:"Toner crítico",detail:(item.description||"Suprimento")+" está com "+(item.percent==null?"nível indisponível":item.percent+"%")+"."});
    else if(item.status==="warning")alerts.push({severity:"warning",title:"Toner em atenção",detail:(item.description||"Suprimento")+" está com "+(item.percent==null?"nível indisponível":item.percent+"%")+"."});
  });
  const lastReading=report.updatedAt||null,ageMinutes=lastReading?Math.max(0,Math.round((Date.now()-Date.parse(lastReading))/60000)):null;
  if(ageMinutes!==null&&ageMinutes>120)alerts.push({severity:"warning",title:"Leitura desatualizada",detail:"A última leitura ocorreu há "+ageMinutes+" minutos."});
  maintenance.forEach(function(item){if(reading&&Number(reading.totalPages)>=Number(item.nextDuePages))alerts.push({severity:"warning",title:"Manutenção pendente",detail:item.type+" atingiu o contador previsto."});});
  if(!alerts.length)alerts.push({severity:"ok",title:"Operação normal",detail:"Nenhuma pendência identificada para esta impressora."});
  const firstPage=pageHistory[0],lastPage=pageHistory[pageHistory.length-1],pageDelta=firstPage&&lastPage?Math.max(0,Number(lastPage.totalPages)-Number(firstPage.totalPages)):0;
  return res.json({sucesso:true,printer:{
    id:printer.id,ip:printer.ip,model:printer.model,location:printer.location||"",unit:printer.unit||"",active:Boolean(printer.active),
    hostname:reading&&reading.hostname||"",serial:reading&&reading.serial||"",online:reading?reading.online:null,status:reading&&reading.status||"unknown",
    totalPages:reading&&reading.totalPages!=null?Number(reading.totalPages):null,cartridge:reading&&reading.cartridge||"",lastReading:lastReading,
    supplies:supplies
  },counters:{periodPages:pageDelta,readings:pageHistory},tonerHistory:tonerHistory,exchanges:exchanges,maintenance:maintenance,alerts:alerts,podeEditar:["master","operator"].includes(req.user.role)});
});

app.post("/api/impressoras", auth.requirePermission("toner"), (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id));
    auth.addAudit(req.user.id, "create", "printer", String(impressora.id), "Impressora cadastrada: " + impressora.ip);
    return res.status(201).json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.patch("/api/impressoras/:id", auth.requirePermission("toner"), (req, res) => {
  try {
    const impressora = auth.savePrinter(req.body, Number(req.user.id), Number(req.params.id));
    if (!impressora) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
    auth.addAudit(req.user.id, "update", "printer", String(impressora.id), "Impressora atualizada: " + impressora.ip);
    return res.json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.delete("/api/impressoras/:id", auth.requirePermission("toner"), (req, res) => {
  const deleted = auth.deletePrinter(Number(req.params.id));
  if (!deleted) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
  auth.addAudit(req.user.id, "delete", "printer", String(req.params.id), "Impressora removida");
  return res.json({ sucesso: true });
});


/*
 * Impressoras das linhas de produção. Não participam do monitoramento de toner:
 * este cadastro existe somente para acompanhar disponibilidade por ping.
 */
function lerImpressorasFabrica() {
  try {
    const items = JSON.parse(auth.getSetting("factory_printers", "[]"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}
function salvarImpressorasFabrica(items, userId) {
  auth.setSetting("factory_printers", JSON.stringify(items), Number(userId) || null);
}
function normalizarImpressoraFabrica(body, current) {
  const ip = String(body?.ip ?? current?.ip ?? "").trim();
  const linha = String(body?.linha ?? current?.linha ?? "").trim();
  const nome = String(body?.nome ?? current?.nome ?? "").trim();
  const unidade = String(body?.unidade ?? current?.unidade ?? "").trim();
  if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(ip)) {
    throw new Error("Informe um IP ou hostname válido.");
  }
  if (!linha || linha.length > 40) throw new Error("Informe o número ou nome da linha.");
  if (nome.length > 80) throw new Error("A descrição deve ter no máximo 80 caracteres.");
  if (!["Osasco", "CD", "Bahia"].includes(unidade)) throw new Error("Selecione uma unidade válida.");
  return { ip, linha, nome, unidade };
}
function verificarPing(host) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const windows = process.platform === "win32";
    const args = windows ? ["-n", "1", "-w", "1500", host] : ["-c", "1", "-W", "2", host];
    let finalizado = false;
    let processo;
    const concluir = (online, erro) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(limite);
      resolve({
        online,
        latenciaMs: online ? Math.max(1, Date.now() - inicio) : null,
        verificadoEm: new Date().toISOString(),
        erro: online ? null : (erro || "Sem resposta")
      });
    };
    const limite = setTimeout(() => {
      if (processo) processo.kill();
      concluir(false, "Tempo de resposta esgotado");
    }, 3000);
    try {
      processo = spawn("ping", args, { windowsHide: true, stdio: "ignore" });
      processo.once("error", () => concluir(false, "Não foi possível executar o ping"));
      processo.once("close", (codigo) => concluir(codigo === 0));
    } catch {
      concluir(false, "Não foi possível executar o ping");
    }
  });
}

app.get("/api/factory-printers", auth.requirePermission("toner"), (req, res) => {
  res.json({
    sucesso: true,
    impressoras: lerImpressorasFabrica(),
    podeEditar: ["master", "operator"].includes(req.user.role)
  });
});

app.post("/api/factory-printers", auth.requirePermission("toner"), (req, res) => {
  if (!["master", "operator"].includes(req.user.role)) return res.status(403).json({ sucesso: false, mensagem: "Acesso somente para edição." });
  try {
    const dados = normalizarImpressoraFabrica(req.body);
    const items = lerImpressorasFabrica();
    if (items.some((item) => item.ip.toLowerCase() === dados.ip.toLowerCase())) {
      return res.status(409).json({ sucesso: false, mensagem: "Este IP ou hostname já está cadastrado." });
    }
    const impressora = { id: crypto.randomUUID(), ...dados, criadaEm: new Date().toISOString() };
    items.push(impressora);
    salvarImpressorasFabrica(items, req.user.id);
    auth.addAudit(req.user.id, "create", "factory_printer", impressora.id, "Impressora de fábrica cadastrada: " + impressora.ip);
    return res.status(201).json({ sucesso: true, impressora });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.patch("/api/factory-printers/:id", auth.requirePermission("toner"), (req, res) => {
  if (!["master", "operator"].includes(req.user.role)) return res.status(403).json({ sucesso: false, mensagem: "Acesso somente para edição." });
  try {
    const items = lerImpressorasFabrica();
    const index = items.findIndex((item) => item.id === req.params.id);
    if (index < 0) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
    const dados = normalizarImpressoraFabrica(req.body, items[index]);
    if (items.some((item, itemIndex) => itemIndex !== index && item.ip.toLowerCase() === dados.ip.toLowerCase())) {
      return res.status(409).json({ sucesso: false, mensagem: "Este IP ou hostname já está cadastrado." });
    }
    items[index] = { ...items[index], ...dados, atualizadaEm: new Date().toISOString() };
    salvarImpressorasFabrica(items, req.user.id);
    auth.addAudit(req.user.id, "update", "factory_printer", items[index].id, "Impressora de fábrica atualizada: " + items[index].ip);
    return res.json({ sucesso: true, impressora: items[index] });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.delete("/api/factory-printers/:id", auth.requirePermission("toner"), (req, res) => {
  if (!["master", "operator"].includes(req.user.role)) return res.status(403).json({ sucesso: false, mensagem: "Acesso somente para edição." });
  const items = lerImpressorasFabrica();
  const index = items.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
  const [removed] = items.splice(index, 1);
  salvarImpressorasFabrica(items, req.user.id);
  auth.addAudit(req.user.id, "delete", "factory_printer", removed.id, "Impressora de fábrica removida: " + removed.ip);
  return res.json({ sucesso: true });
});

app.post("/api/factory-printers/check", auth.requirePermission("toner"), async (req, res) => {
  const items = lerImpressorasFabrica();
  const selected = req.body?.id ? items.filter((item) => item.id === req.body.id) : items;
  if (req.body?.id && !selected.length) return res.status(404).json({ sucesso: false, mensagem: "Impressora não encontrada." });
  const resultados = await Promise.all(selected.map(async (item) => { const result = await verificarPing(item.ip); registrarDisponibilidadeFabrica(item, result); return { id: item.id, ...result }; }));
  return res.json({ sucesso: true, resultados });
});


/*
 * Inteligência operacional. Consolida dados locais sem realizar qualquer escrita
 * no NXT4Insight, que permanece somente como fonte de consulta do estoque.
 */
function lerEstadoDisponibilidadeFabrica() {
  try {
    const value = JSON.parse(auth.getSetting("factory_availability_state", "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function salvarEstadoDisponibilidadeFabrica(value) {
  auth.setSetting("factory_availability_state", JSON.stringify(value), null);
}
function lerIncidentesFabrica() {
  try {
    const value = JSON.parse(auth.getSetting("factory_incidents", "[]"));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function salvarIncidentesFabrica(value, userId) {
  auth.setSetting("factory_incidents", JSON.stringify(value.slice(0, 500)), Number(userId) || null);
}
function registrarDisponibilidadeFabrica(printer, result) {
  const state = lerEstadoDisponibilidadeFabrica();
  const now = result.verificadoEm || new Date().toISOString();
  const current = state[printer.id] || {
    samples: 0, onlineSamples: 0, outages: 0, downtimeMs: 0,
    offlineSince: null, lastOnlineAt: null, lastStatus: "unknown", events: []
  };
  current.samples += 1;
  if (result.online) current.onlineSamples += 1;
  if (!result.online && current.lastStatus !== "offline") {
    current.outages += 1;
    current.offlineSince = now;
    current.events.unshift({ type: "offline", at: now });
  }
  if (result.online && current.lastStatus === "offline" && current.offlineSince) {
    current.downtimeMs += Math.max(0, Date.parse(now) - Date.parse(current.offlineSince));
    current.events.unshift({ type: "online", at: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(current.offlineSince)) });
    current.offlineSince = null;
  }
  if (result.online) current.lastOnlineAt = now;
  current.lastStatus = result.online ? "online" : "offline";
  current.lastCheckedAt = now;
  current.latencyMs = result.latenciaMs;
  current.events = current.events.slice(0, 100);
  state[printer.id] = current;
  salvarEstadoDisponibilidadeFabrica(state);

  const incidents = lerIncidentesFabrica();
  const open = incidents.find((item) => item.printerId === printer.id && ["open","acknowledged"].includes(item.status));
  const thresholdMinutes = Math.max(1, Number(auth.getSetting("factory_incident_minutes", "3")) || 3);
  const offlineMinutes = current.offlineSince ? (Date.now() - Date.parse(current.offlineSince)) / 60000 : 0;
  if (!result.online && offlineMinutes >= thresholdMinutes && !open) {
    incidents.unshift({
      id: crypto.randomUUID(), printerId: printer.id, equipment: printer.nome || ("Linha " + printer.linha),
      ip: printer.ip, line: printer.linha, unit: printer.unidade, startedAt: current.offlineSince,
      durationMinutes: Math.floor(offlineMinutes), responsible: "", deadline: "", status: "open",
      createdAt: now, updatedAt: now, notes: "Criado automaticamente após ausência de resposta ao ping."
    });
    salvarIncidentesFabrica(incidents);
  } else if (result.online && open) {
    open.status = "resolved"; open.resolvedAt = now; open.updatedAt = now;
    open.durationMinutes = Math.max(1, Math.floor((Date.parse(now) - Date.parse(open.startedAt)) / 60000));
    open.notes = (open.notes ? open.notes + " " : "") + "Resolvido automaticamente após o retorno do equipamento.";
    salvarIncidentesFabrica(incidents);
  }
}
async function monitorarImpressorasFabrica() {
  const items = lerImpressorasFabrica();
  if (!items.length) return [];
  const results = await Promise.all(items.map(async (printer) => {
    const result = await verificarPing(printer.ip);
    registrarDisponibilidadeFabrica(printer, result);
    return { id: printer.id, ...result };
  }));
  return results;
}
function disponibilidadeFabrica() {
  const state = lerEstadoDisponibilidadeFabrica();
  return lerImpressorasFabrica().map((printer) => {
    const item = state[printer.id] || {};
    const currentDowntime = item.offlineSince ? Math.max(0, Date.now() - Date.parse(item.offlineSince)) : 0;
    return {
      ...printer,
      status: item.lastStatus || "unknown",
      latencyMs: item.latencyMs ?? null,
      lastCheckedAt: item.lastCheckedAt || null,
      lastOnlineAt: item.lastOnlineAt || null,
      offlineSince: item.offlineSince || null,
      availability: item.samples ? Math.round((item.onlineSamples / item.samples) * 1000) / 10 : null,
      outages: Number(item.outages || 0),
      downtimeMinutes: Math.round((Number(item.downtimeMs || 0) + currentDowntime) / 60000),
      events: Array.isArray(item.events) ? item.events.slice(0, 20) : []
    };
  });
}
function prioridadeAlerta(type) {
  return { factory: 1, automation: 1, toner: 2, stock: 2, access: 3, purchase: 2 }[type] || 3;
}
async function construirInteligenciaOperacional() {
  const alerts = [];
  let stockShortages = [];
  try {
    const stock = await lerPlanilha(), categories = Array.isArray(stock.categorias) ? stock.categorias : [];
    auth.getMinimums().filter((rule) => rule.monitored && Number(rule.minimum) > 0).forEach((rule) => {
      const key = String(rule.categoryName || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const found = categories.find((cat) => {
        const name = String(cat.nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        return name === key || name.includes(key) || key.includes(name);
      });
      const current = found ? Number(found.atual) || 0 : 0, minimum = Number(rule.minimum) || 0;
      if (current < minimum) {
        const item = { name: rule.categoryName, current, minimum, missing: minimum - current };
        stockShortages.push(item);
        alerts.push({ id: "stock:" + (rule.categoryKey || key), type: "stock", priority: prioridadeAlerta("stock"), title: rule.categoryName + " abaixo do mínimo", detail: current + " disponível(is) · mínimo " + minimum, responsible: "Compras / Estoque", deadline: "Hoje", action: "/", actionLabel: "Abrir estoque" });
      }
    });
  } catch {}
  const toner = lerTonerAtual(), threshold = Math.max(1, Number(toner.threshold || auth.getSetting("toner_threshold", "20")) || 20);
  const criticalToners = [];
  (toner.printers || []).forEach((printer) => (printer.supplies || []).filter((supply) => supply.isToner !== false && Number(supply.percent) <= threshold).forEach((supply) => {
    const item = { ip: printer.ip, printer: printer.hostname || printer.model || printer.ip, unit: printer.unit || "", supply: supply.description, percent: Number(supply.percent) };
    criticalToners.push(item);
    alerts.push({ id: "toner:" + printer.ip + ":" + supply.description, type: "toner", priority: prioridadeAlerta("toner"), title: "Toner crítico · " + item.printer, detail: item.supply + " em " + item.percent + "%", responsible: "Suporte de TI", deadline: item.percent <= 5 ? "Imediato" : "Hoje", action: "/toner-operacao.html", actionLabel: "Abrir trocas" });
  }));
  const availability = disponibilidadeFabrica();
  availability.filter((printer) => printer.status === "offline").forEach((printer) => alerts.push({
    id: "factory:" + printer.id, type: "factory", priority: prioridadeAlerta("factory"),
    title: "Linha " + printer.linha + " sem resposta", detail: printer.ip + " · " + printer.unidade,
    responsible: "Infraestrutura de TI", deadline: printer.offlineSince ? "Em andamento" : "Verificar",
    action: "/inteligencia.html#disponibilidade", actionLabel: "Ver disponibilidade"
  }));
  let failedAutomations = [];
  try {
    failedAutomations = auth.database.prepare("SELECT id,automation_type type,message,started_at startedAt FROM automation_runs WHERE status='error' ORDER BY id DESC LIMIT 10").all();
    failedAutomations.forEach((run) => alerts.push({ id: "automation:" + run.id, type: "automation", priority: prioridadeAlerta("automation"), title: "Falha na automação · " + run.type, detail: run.message || "Execução não concluída", responsible: "Administração do sistema", deadline: "Imediato", action: "/automacoes.html#history-navigation", actionLabel: "Abrir histórico" }));
  } catch {}
  let pendingAccess = [];
  try {
    pendingAccess = auth.database.prepare("SELECT employee_key id,employee_name name,activation_date activationDate,updated_at updatedAt FROM vacation_access_plans WHERE completed=0 ORDER BY activation_date LIMIT 30").all();
    pendingAccess.forEach((plan) => alerts.push({ id: "access:" + plan.id, type: "access", priority: prioridadeAlerta("access"), title: "Acesso pendente · " + (plan.name || plan.id), detail: plan.activationDate ? "Programado para " + plan.activationDate : "Data não definida", responsible: "Suporte / Acessos", deadline: plan.activationDate || "Definir", action: "/colaboradores.html", actionLabel: "Abrir acessos" }));
  } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const purchases = auth.getRestockRequests();
  const overduePurchases = purchases.filter((request) => request.status !== "finished" && request.expectedAt && request.expectedAt < today);
  overduePurchases.forEach((request) => alerts.push({ id: "purchase:" + request.id, type: "purchase", priority: prioridadeAlerta("purchase"), title: "Solicitação atrasada · #" + request.id, detail: "Previsão era " + request.expectedAt + " · " + (request.buyer || "sem responsável"), responsible: request.buyer || "Compras", deadline: "Atrasada", action: "/#solicitacoes", actionLabel: "Abrir solicitação" }));
  alerts.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, "pt-BR"));

  const units = ["Osasco","Bahia","CD"].map((unit) => {
    const printers = availability.filter((printer) => printer.unidade === unit);
    const unitToners = criticalToners.filter((item) => item.unit === unit);
    return {
      unit,
      stock: stockShortages.length ? "attention" : "normal",
      stockLabel: stockShortages.length ? stockShortages.length + " abaixo do mínimo" : "Normal",
      printersOnline: printers.filter((printer) => printer.status === "online").length,
      printersTotal: printers.length,
      tonerCritical: unitToners.length,
      automationFailures: failedAutomations.length
    };
  });
  const exchanges = auth.database.prepare("SELECT toner_model model,color,COUNT(*) uses,MIN(created_at) firstAt,MAX(created_at) lastAt FROM toner_exchanges WHERE created_at>=datetime('now','-90 days') GROUP BY toner_model,color").all();
  const usageMap = new Map(exchanges.map((item) => [String(item.model).toLowerCase() + "|" + String(item.color).toLowerCase(), item]));
  const forecast = lerEstoqueToners().map((item) => {
    const usage = usageMap.get(String(item.modelo).toLowerCase() + "|" + String(item.cor).toLowerCase());
    const monthlyUse = usage ? Math.round((Number(usage.uses) / 90) * 30 * 10) / 10 : 0;
    const daysRemaining = monthlyUse > 0 ? Math.floor(Number(item.quantidade) / (monthlyUse / 30)) : null;
    return { ...item, monthlyUse, daysRemaining, estimatedEnd: daysRemaining === null ? null : new Date(Date.now() + daysRemaining * 86400000).toISOString().slice(0,10), recommendedPurchase: Math.max(0, Math.ceil(monthlyUse * 2 - Number(item.quantidade))) };
  }).sort((a,b) => (a.daysRemaining ?? 99999) - (b.daysRemaining ?? 99999));
  return { generatedAt: new Date().toISOString(), alerts, units, availability, incidents: lerIncidentesFabrica(), forecast, purchases };
}

app.get("/api/operations/intelligence", auth.requireAuth, async (req, res) => {
  try { return res.json({ sucesso: true, data: await construirInteligenciaOperacional() }); }
  catch (error) { return res.status(500).json({ sucesso: false, mensagem: error.message }); }
});
app.post("/api/operations/factory/check", auth.requirePermission("toner"), async (req, res) => {
  try { return res.json({ sucesso: true, resultados: await monitorarImpressorasFabrica() }); }
  catch (error) { return res.status(500).json({ sucesso: false, mensagem: error.message }); }
});
app.patch("/api/operations/incidents/:id", auth.requirePermission("toner"), (req, res) => {
  const incidents = lerIncidentesFabrica(), incident = incidents.find((item) => item.id === req.params.id);
  if (!incident) return res.status(404).json({ sucesso: false, mensagem: "Incidente não encontrado." });
  const status = String(req.body?.status || incident.status);
  if (!["open","acknowledged","resolved"].includes(status)) return res.status(400).json({ sucesso: false, mensagem: "Status inválido." });
  incident.status = status;
  incident.responsible = String(req.body?.responsible ?? incident.responsible).trim().slice(0,100);
  incident.deadline = String(req.body?.deadline ?? incident.deadline).trim().slice(0,30);
  incident.notes = String(req.body?.notes ?? incident.notes).trim().slice(0,1000);
  incident.updatedAt = new Date().toISOString();
  if (status === "resolved" && !incident.resolvedAt) incident.resolvedAt = incident.updatedAt;
  salvarIncidentesFabrica(incidents, req.user.id);
  auth.addAudit(req.user.id, "update", "factory_incident", incident.id, "Incidente de impressora atualizado");
  return res.json({ sucesso: true, incident });
});
app.post("/api/operations/diagnose", auth.requirePermission("toner"), async (req, res) => {
  const ip = String(req.body?.ip || "").trim(), printer = lerImpressorasFabrica().find((item) => item.ip === ip);
  if (!ip || !/^[a-zA-Z0-9.-]{1,253}$/.test(ip)) return res.status(400).json({ sucesso: false, mensagem: "Informe um IP ou hostname válido." });
  const ping = await verificarPing(ip);
  if (printer) registrarDisponibilidadeFabrica(printer, ping);
  const tonerReport = lerTonerAtual(), snmpPrinter = (tonerReport.printers || []).find((item) => item.ip === ip);
  const steps = [
    { label: "Resposta ao ping", ok: ping.online, detail: ping.online ? ping.latenciaMs + " ms" : (ping.erro || "Sem resposta") },
    { label: "Cadastro no monitor", ok: Boolean(printer || snmpPrinter), detail: printer ? "Impressora de fábrica" : snmpPrinter ? "Impressora com suprimentos" : "IP não cadastrado" },
    { label: "Leitura SNMP", ok: Boolean(snmpPrinter && snmpPrinter.online), detail: snmpPrinter ? (snmpPrinter.online ? "Respondendo" : "Sem resposta") : "Não aplicável ou não cadastrada" },
    { label: "Suprimentos disponíveis", ok: Boolean(snmpPrinter && (snmpPrinter.supplies || []).length), detail: snmpPrinter ? (snmpPrinter.supplies || []).length + " identificado(s)" : "Não aplicável à impressora de fábrica" }
  ];
  const conclusion = !ping.online ? "Verifique energia, cabo de rede, porta do switch, VLAN e endereço IP." : snmpPrinter && !snmpPrinter.online ? "A rede responde, mas o SNMP não. Confira serviço SNMP, comunidade e firewall." : "Comunicação básica funcionando. Continue a análise pelos indicadores apresentados.";
  return res.json({ sucesso: true, diagnosis: { ip, checkedAt: new Date().toISOString(), steps, conclusion } });
});

setInterval(() => { monitorarImpressorasFabrica().catch((error) => console.error("Monitor de fábrica:", error.message)); }, 60000).unref();

app.get("/api/configuracao/toner", auth.requireAuth, (req, res) => {
  const limite = Math.max(1, Math.min(99, Number(auth.getSetting("toner_threshold", "20")) || 20));
  res.json({ sucesso: true, limite, podeEditar: req.user.role === "master" });
});

app.put("/api/configuracao/toner", auth.requireMaster, (req, res) => {
  const limite = Number.parseInt(req.body?.limite, 10);
  if (!Number.isInteger(limite) || limite < 1 || limite > 99) {
    return res.status(400).json({ sucesso: false, mensagem: "Informe um limite entre 1% e 99%." });
  }
  auth.setSetting("toner_threshold", String(limite), Number(req.user.id));
  auth.addAudit(req.user.id, "update", "toner_threshold", "", "Limite de toner alterado para " + limite + "%");
  return res.json({ sucesso: true, limite });
});

/*
 * Identificadores internos para periféricos sem número de série de fábrica.
 */
function lerIdentificadoresPerifericos() {
  try {
    const items = JSON.parse(auth.getSetting("peripheral_identifiers", "[]"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}
function salvarIdentificadoresPerifericos(items, userId) {
  auth.setSetting("peripheral_identifiers", JSON.stringify(items), Number(userId) || null);
}
function prefixoIdentificador(tipo) {
  const value = String(tipo || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const known = {
    TECLADO: "TEC", MOUSE: "MOU", MONITOR: "MON", HEADSET: "HDS",
    WEBCAM: "WEB", DOCK: "DOC", CARREGADOR: "CAR", ADAPTADOR: "ADA",
    IMPRESSORA: "IMP", OUTRO: "OUT"
  };
  return known[value] || "OUT";
}
function siglaUnidadeIdentificador(unidade) {
  return ({ osasco: "OSA", cd: "CD", bahia: "BA" })[
    String(unidade || "").trim().toLocaleLowerCase("pt-BR")
  ] || "GER";
}

app.get("/api/peripheral-identifiers", auth.requirePermission("stock"), (req, res) => {
  const items = lerIdentificadoresPerifericos().sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  return res.json({ sucesso: true, itens: items });
});

app.post("/api/peripheral-identifiers", auth.requirePermission("stock"), (req, res) => {
  const tipo = String(req.body?.tipo || "").trim().slice(0, 40);
  const unidade = String(req.body?.unidade || "").trim().slice(0, 30);
  const descricao = String(req.body?.descricao || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const quantidade = Number.parseInt(req.body?.quantidade, 10);
  if (!tipo || !["Osasco", "CD", "Bahia"].includes(unidade)) {
    return res.status(400).json({ sucesso: false, mensagem: "Informe o tipo do periférico e a unidade." });
  }
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 50) {
    return res.status(400).json({ sucesso: false, mensagem: "Gere entre 1 e 50 etiquetas por vez." });
  }

  const items = lerIdentificadoresPerifericos();
  const existing = new Set(items.map((item) => String(item.codigo || "").toUpperCase()));
  const created = [];
  for (let index = 0; index < quantidade; index += 1) {
    let codigo = "";
    do {
      const random = crypto.randomBytes(4).toString("hex").toUpperCase();
      codigo = "NXT-" + prefixoIdentificador(tipo) + "-" + siglaUnidadeIdentificador(unidade) + "-" + random;
    } while (existing.has(codigo));
    existing.add(codigo);
    const item = {
      id: crypto.randomUUID(),
      codigo,
      tipo,
      unidade,
      descricao,
      createdAt: new Date().toISOString(),
      createdBy: req.user?.username || "Sistema"
    };
    items.push(item);
    created.push(item);
  }
  salvarIdentificadoresPerifericos(items, req.user.id);
  auth.addAudit(req.user.id, "create", "peripheral_identifier", "", quantidade + " identificador(es) gerado(s) para " + tipo);
  return res.status(201).json({ sucesso: true, itens: created, total: items.length });
});

app.delete("/api/peripheral-identifiers/:id", auth.requirePermission("stock"), (req, res) => {
  const items = lerIdentificadoresPerifericos();
  const index = items.findIndex((item) => item.id === String(req.params.id || ""));
  if (index < 0) return res.status(404).json({ sucesso: false, mensagem: "Identificador não encontrado." });
  const removed = items.splice(index, 1)[0];
  salvarIdentificadoresPerifericos(items, req.user.id);
  auth.addAudit(req.user.id, "delete", "peripheral_identifier", removed.id, "Identificador removido: " + removed.codigo);
  return res.json({ sucesso: true });
});

/*
 * Toners usados aguardando reposição.
 * A lista é compartilhada entre todos os usuários com acesso ao módulo.
 */
function normalizarUnidadeToner(value) {
  const key = String(value || "").trim().toLocaleLowerCase("pt-BR");
  return ({ osasco: "Osasco", cd: "CD", bahia: "Bahia" })[key] || "Sem unidade";
}
function lerTonersUsados() {
  try {
    const items = JSON.parse(auth.getSetting("used_toners", "[]"));
    return Array.isArray(items) ? items.map((item) => ({
      ...item,
      unidade: normalizarUnidadeToner(item?.unidade)
    })) : [];
  } catch {
    return [];
  }
}

app.get("/api/toner/used", auth.requirePermission("toner"), (req, res) => {
  return res.json({ sucesso: true, itens: lerTonersUsados() });
});

app.put("/api/toner/used", auth.requirePermission("toner"), (req, res) => {
  const source = Array.isArray(req.body?.itens) ? req.body.itens : null;
  if (!source) {
    return res.status(400).json({ sucesso: false, mensagem: "Lista de toners inválida." });
  }
  if (source.length > 200) {
    return res.status(400).json({ sucesso: false, mensagem: "A lista aceita até 200 modelos." });
  }
  const itens = [];
  for (const entry of source) {
    const modelo = String(entry?.modelo || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const cor = String(entry?.cor || "").trim().replace(/\s+/g, " ").slice(0, 30);
    const unidade = normalizarUnidadeToner(entry?.unidade);
    const quantidade = Number.parseInt(entry?.quantidade, 10);
    if (!modelo || !cor || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 999) {
      return res.status(400).json({ sucesso: false, mensagem: "Informe modelo, cor e uma quantidade válida." });
    }
    itens.push({ modelo, cor, unidade, quantidade });
  }
  auth.setSetting("used_toners", JSON.stringify(itens), Number(req.user.id));
  auth.addAudit(
    req.user.id,
    "update",
    "used_toners",
    "",
    "Lista de toners usados atualizada: " + itens.reduce((total, item) => total + item.quantidade, 0) + " unidade(s)"
  );
  return res.json({ sucesso: true, itens });
});

app.post("/api/toner/used/register", auth.requirePermission("toner"), (req, res) => {
  const modelo = String(req.body?.modelo || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const cor = String(req.body?.cor || "").trim().replace(/\s+/g, " ").slice(0, 30);
  const unidade = normalizarUnidadeToner(req.body?.unidade);
  if (!modelo || !cor || unidade === "Sem unidade") {
    return res.status(400).json({ sucesso: false, mensagem: "Informe o modelo, a cor e a unidade do toner usado." });
  }

  const inventory = lerEstoqueToners();
  const requestedCode = tonerCode(modelo);
  const stock = inventory.find((entry) => {
    const sameColor = String(entry.cor || "").toLocaleLowerCase("pt-BR") === cor.toLocaleLowerCase("pt-BR");
    const exactModel = tonerKey(entry.modelo, entry.cor) === tonerKey(modelo, cor);
    const stockCode = tonerCode(entry.modelo);
    return sameColor && (exactModel || (requestedCode && stockCode === requestedCode));
  });
  if (!stock || Number(stock.quantidade) < 1) {
    return res.status(409).json({
      sucesso: false,
      mensagem: "Não há saldo disponível deste toner no estoque. Cadastre uma unidade antes de registrar o uso."
    });
  }

  stock.quantidade = Number(stock.quantidade) - 1;
  const usados = lerTonersUsados();
  const usado = usados.find((entry) =>
    tonerKey(entry.modelo, entry.cor) === tonerKey(stock.modelo, stock.cor)
    && entry.unidade === unidade
  );
  if (usado) usado.quantidade = Number(usado.quantidade) + 1;
  else usados.push({ modelo: stock.modelo, cor: stock.cor, unidade, quantidade: 1 });

  auth.setSetting("toner_inventory", JSON.stringify(inventory), Number(req.user.id));
  auth.setSetting("used_toners", JSON.stringify(usados), Number(req.user.id));
  auth.addAudit(
    req.user.id,
    "update",
    "used_toners",
    "",
    "Uso registrado: 1 unidade de " + stock.modelo + " (" + stock.cor + ") em " + unidade
  );
  return res.status(201).json({
    sucesso: true,
    mensagem: "Uso registrado. Estoque atualizado de " + (Number(stock.quantidade) + 1) + " para " + stock.quantidade + ".",
    itens: inventory,
    usados,
    saldo: Number(stock.quantidade)
  });
});

/*
 * Estoque exclusivo de toners, separado do inventário de ativos.
 */
function lerEstoqueToners() {
  try {
    const items = JSON.parse(auth.getSetting("toner_inventory", "[]"));
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function validarEstoqueToners(source) {
  if (!Array.isArray(source)) throw new Error("Lista de estoque de toners inválida.");
  if (source.length > 200) throw new Error("O estoque aceita até 200 modelos.");
  const grouped = new Map();
  for (const entry of source) {
    const modelo = String(entry?.modelo || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const cor = String(entry?.cor || "").trim().replace(/\s+/g, " ").slice(0, 30);
    const quantidade = Number.parseInt(entry?.quantidade, 10);
    if (!modelo || !cor || !Number.isInteger(quantidade) || quantidade < 0 || quantidade > 9999) {
      throw new Error("Informe modelo, cor e uma quantidade válida.");
    }
    const key = modelo.toLocaleLowerCase("pt-BR") + "|" + cor.toLocaleLowerCase("pt-BR");
    const current = grouped.get(key);
    if (current) current.quantidade = Math.min(9999, current.quantidade + quantidade);
    else grouped.set(key, { modelo, cor, quantidade });
  }
  return Array.from(grouped.values()).sort((a, b) => a.modelo.localeCompare(b.modelo, "pt-BR"));
}

app.get("/api/toner/inventory", auth.requirePermission("toner"), (req, res) => {
  return res.json({ sucesso: true, itens: lerEstoqueToners() });
});

app.put("/api/toner/inventory", auth.requirePermission("toner"), (req, res) => {
  try {
    const itens = validarEstoqueToners(req.body?.itens);
    auth.setSetting("toner_inventory", JSON.stringify(itens), Number(req.user.id));
    auth.addAudit(
      req.user.id,
      "update",
      "toner_inventory",
      "",
      "Estoque de toners atualizado: " + itens.reduce((total, item) => total + item.quantidade, 0) + " unidade(s)"
    );
    return res.json({ sucesso: true, itens });
  } catch (error) {
    return res.status(400).json({ sucesso: false, mensagem: error.message });
  }
});

app.post("/api/toner/inventory/use", auth.requirePermission("toner"), (req, res) => {
  const modelo = String(req.body?.modelo || "").trim();
  const cor = String(req.body?.cor || "").trim();
  const unidade = normalizarUnidadeToner(req.body?.unidade);
  if (unidade === "Sem unidade") {
    return res.status(400).json({ sucesso: false, mensagem: "Selecione Osasco, CD ou Bahia antes de registrar o uso." });
  }
  const inventory = lerEstoqueToners();
  const item = inventory.find((entry) =>
    entry.modelo.toLocaleLowerCase("pt-BR") === modelo.toLocaleLowerCase("pt-BR")
    && entry.cor.toLocaleLowerCase("pt-BR") === cor.toLocaleLowerCase("pt-BR")
  );
  if (!item || Number(item.quantidade) < 1) {
    return res.status(400).json({ sucesso: false, mensagem: "Este toner não possui saldo disponível." });
  }
  item.quantidade = Number(item.quantidade) - 1;
  const used = lerTonersUsados();
  const usedItem = used.find((entry) =>
    entry.modelo.toLocaleLowerCase("pt-BR") === modelo.toLocaleLowerCase("pt-BR")
    && entry.cor.toLocaleLowerCase("pt-BR") === cor.toLocaleLowerCase("pt-BR")
    && entry.unidade === unidade
  );
  if (usedItem) usedItem.quantidade = Number(usedItem.quantidade) + 1;
  else used.push({ modelo: item.modelo, cor: item.cor, unidade, quantidade: 1 });
  auth.setSetting("toner_inventory", JSON.stringify(inventory), Number(req.user.id));
  auth.setSetting("used_toners", JSON.stringify(used), Number(req.user.id));
  auth.addAudit(req.user.id, "update", "toner_inventory", "", "Uso registrado: 1 unidade de " + item.modelo + " (" + item.cor + ")");
  return res.json({ sucesso: true, itens: inventory, usados: used, unidade, mensagem: "Uso registrado em " + unidade + " e enviado para reposição." });
});

/*
 * Central operacional de toners.
 */
function requireTonerOperator(req, res, next) {
  if (!req.user) {
    const user = auth.currentUser ? auth.currentUser(req) : null;
    if (user) req.user = user;
  }
  if (!req.user || !["master", "operator"].includes(req.user.role)) {
    return res.status(403).json({ sucesso:false, mensagem:"Apenas operadores e o Master Admin podem movimentar toners." });
  }
  return next();
}
function tonerKey(model, color) {
  return String(model || "").trim().toLocaleLowerCase("pt-BR") + "|" + String(color || "").trim().toLocaleLowerCase("pt-BR");
}
function tonerCode(description) {
  const matches = String(description || "").toUpperCase().match(/\b(?:CF|W|CE|Q|TN|MLT)[A-Z0-9-]{3,12}\b/g) || [];
  return matches.length ? matches[matches.length - 1] : "";
}
function tonerColor(description) {
  const text = String(description || "").toLowerCase();
  if (/black|preto/.test(text)) return "Preto";
  if (/cyan|ciano/.test(text)) return "Ciano";
  if (/magenta/.test(text)) return "Magenta";
  if (/yellow|amarel/.test(text)) return "Amarelo";
  return "Outro";
}
function activePrinterByIp(ip) {
  return auth.getPrinters().find(function(item) { return item.active && item.ip === String(ip || "").trim(); });
}
function latestPrinterReading(ip) {
  return (lerTonerAtual().printers || []).find(function(item) { return item.ip === ip; }) || null;
}
function reservedTonerCounts() {
  const counts = new Map();
  auth.database.prepare("SELECT toner_model AS model,color,COUNT(*) AS total FROM toner_reservations WHERE status='reserved' GROUP BY toner_model,color").all()
    .forEach(function(row) { counts.set(tonerKey(row.model, row.color), Number(row.total) || 0); });
  return counts;
}
function compatibilityRows() {
  return auth.database.prepare(
    "SELECT id,printer_model AS printerModel,toner_model AS tonerModel,color,active,created_at AS createdAt,updated_at AS updatedAt "
    + "FROM toner_compatibility ORDER BY printer_model,toner_model,color"
  ).all().map(function(row) { return { ...row, id:Number(row.id), active:Boolean(row.active) }; });
}
function currentTonerSupplies(printer) {
  return (printer && Array.isArray(printer.supplies) ? printer.supplies : []).filter(function(supply) {
    return supply.isToner !== false && Number.isFinite(Number(supply.percent));
  });
}
function buildTonerWorklist() {
  const report = lerTonerAtual();
  const threshold = Number(report.threshold) || 20;
  const inventory = lerEstoqueToners();
  const reserved = reservedTonerCounts();
  return (report.printers || []).filter(function(printer) {
    return printer.online !== false && currentTonerSupplies(printer).some(function(supply) { return Number(supply.percent) <= threshold + 15; });
  }).map(function(printer) {
    const supplies = currentTonerSupplies(printer).filter(function(supply) {
      return Number(supply.percent) <= threshold + 15;
    }).map(function(supply) {
      const detected = tonerCode(supply.description);
      const color = tonerColor(supply.description);
      const model = detected || printer.cartridge || "Confirmar modelo";
      const item = inventory.find(function(entry) {
        return tonerKey(entry.modelo, entry.cor) === tonerKey(model, color);
      });
      const reservedQuantity = reserved.get(tonerKey(model, color)) || 0;
      return {
        description:supply.description, level:Number(supply.percent), status:supply.status,
        tonerModel:model, color:color,
        stock:Number(item && item.quantidade) || 0,
        reserved:reservedQuantity,
        available:Math.max(0, (Number(item && item.quantidade) || 0) - reservedQuantity)
      };
    });
    return {
      ip:printer.ip, name:printer.hostname || printer.model || printer.ip,
      model:printer.model || "", location:(activePrinterByIp(printer.ip) || {}).location || "", unit:(activePrinterByIp(printer.ip) || {}).unit || "",
      status:printer.status, supplies:supplies
    };
  }).sort(function(a,b) {
    const al=Math.min(...a.supplies.map(function(item){return item.level;}));
    const bl=Math.min(...b.supplies.map(function(item){return item.level;}));
    return al-bl || a.name.localeCompare(b.name,"pt-BR");
  });
}

app.get("/api/toner/operations", auth.requirePermission("toner"), function(req,res) {
  const reservations=auth.database.prepare(
    "SELECT r.id,r.printer_ip AS printerIp,r.toner_model AS tonerModel,r.color,r.status,r.reserved_at AS reservedAt,"
    + "COALESCE(u.username,'Sistema') AS reservedBy FROM toner_reservations r LEFT JOIN users u ON u.id=r.reserved_by "
    + "WHERE r.status='reserved' ORDER BY r.reserved_at DESC"
  ).all();
  return res.json({sucesso:true,worklist:buildTonerWorklist(),reservations:reservations});
});
app.get("/api/toner/exchanges", auth.requirePermission("toner"), function(req,res) {
  const limit=Math.max(1,Math.min(500,Number(req.query.limit)||100));
  const items=auth.database.prepare(
    "SELECT e.id,e.printer_ip AS printerIp,e.printer_name AS printerName,e.printer_model AS printerModel,"
    + "e.toner_model AS tonerModel,e.color,e.previous_level AS previousLevel,e.current_level AS currentLevel,e.created_at AS createdAt,e.source,"
    + "CASE WHEN e.source='automatic' THEN 'Sistema automático' ELSE COALESCE(u.username,'Sistema') END AS performedBy FROM toner_exchanges e LEFT JOIN users u ON u.id=e.performed_by "
    + "ORDER BY e.created_at DESC LIMIT ?"
  ).all(limit);
  return res.json({sucesso:true,itens:items});
});
app.post("/api/toner/reservations", auth.requirePermission("toner"), requireTonerOperator, function(req,res) {
  const ip=String(req.body?.ip||"").trim(),model=String(req.body?.tonerModel||"").trim(),color=String(req.body?.color||"").trim();
  const printer=activePrinterByIp(ip);
  if(!printer)return res.status(404).json({sucesso:false,mensagem:"Impressora não encontrada no cadastro ativo."});
  const item=lerEstoqueToners().find(function(entry){return tonerKey(entry.modelo,entry.cor)===tonerKey(model,color);});
  const reserved=reservedTonerCounts().get(tonerKey(model,color))||0;
  if(!item||Number(item.quantidade)-reserved<1)return res.status(409).json({sucesso:false,mensagem:"Não existe saldo livre deste toner para reservar."});
  const existing=auth.database.prepare("SELECT id FROM toner_reservations WHERE printer_ip=? AND toner_model=? AND color=? AND status='reserved'").get(ip,model,color);
  if(existing)return res.json({sucesso:true,id:Number(existing.id),mensagem:"Este toner já está reservado para a impressora."});
  const now=new Date().toISOString();
  const result=auth.database.prepare("INSERT INTO toner_reservations (printer_ip,toner_model,color,status,reserved_by,reserved_at) VALUES (?,?,?,'reserved',?,?)")
    .run(ip,model,color,Number(req.user.id),now);
  auth.addAudit(req.user.id,"create","toner_reservation",String(result.lastInsertRowid),"Toner reservado: "+model+" para "+ip);
  return res.status(201).json({sucesso:true,id:Number(result.lastInsertRowid),mensagem:"Toner reservado. O saldo ficou protegido para esta troca."});
});
app.delete("/api/toner/reservations/:id", auth.requirePermission("toner"), requireTonerOperator, function(req,res) {
  const result=auth.database.prepare("UPDATE toner_reservations SET status='cancelled',completed_at=? WHERE id=? AND status='reserved'")
    .run(new Date().toISOString(),Number(req.params.id));
  if(!result.changes)return res.status(404).json({sucesso:false,mensagem:"Reserva não encontrada."});
  auth.addAudit(req.user.id,"delete","toner_reservation",String(req.params.id),"Reserva de toner cancelada");
  return res.json({sucesso:true});
});
app.post("/api/toner/exchanges", auth.requirePermission("toner"), requireTonerOperator, function(req,res) {
  const ip=String(req.body?.ip||"").trim(),model=String(req.body?.tonerModel||"").trim(),color=String(req.body?.color||"").trim();
  const printer=activePrinterByIp(ip);
  if(!printer||!model||!color)return res.status(400).json({sucesso:false,mensagem:"Informe impressora, modelo e cor do toner."});
  const inventory=lerEstoqueToners();
  const stock=inventory.find(function(entry){return tonerKey(entry.modelo,entry.cor)===tonerKey(model,color);});
  const ownReservation=auth.database.prepare("SELECT id FROM toner_reservations WHERE printer_ip=? AND toner_model=? AND color=? AND status='reserved' ORDER BY reserved_at LIMIT 1").get(ip,model,color);
  const totalReserved=reservedTonerCounts().get(tonerKey(model,color))||0;
  const freeQuantity=(Number(stock&&stock.quantidade)||0)-totalReserved;
  const canDeduct=Boolean(stock&&Number(stock.quantidade)>0&&(ownReservation||freeQuantity>=1));
  const allowWithoutStock=req.body?.allowWithoutStock===true;
  if(!canDeduct&&!allowWithoutStock)
    return res.status(409).json({sucesso:false,mensagem:stock?"O saldo disponível está reservado para outra troca. Confirme novamente para registrar sem descontar o estoque.":"Este toner não possui saldo cadastrado. Confirme novamente para registrar a troca sem desconto."});
  const reading=latestPrinterReading(ip);
  const matching=currentTonerSupplies(reading).find(function(supply){
    const code=tonerCode(supply.description);
    return code&&String(model).toUpperCase().includes(code);
  })||currentTonerSupplies(reading)[0];
  const now=new Date().toISOString();
  if(canDeduct)stock.quantidade=Number(stock.quantidade)-1;
  const used=lerTonersUsados(),unidade=normalizarUnidadeToner(printer.unit);
  const usedItem=used.find(function(entry){return tonerKey(entry.modelo,entry.cor)===tonerKey(model,color)&&entry.unidade===unidade;});
  if(usedItem)usedItem.quantidade=Number(usedItem.quantidade)+1;else used.push({modelo:model,cor:color,unidade,quantidade:1});
  auth.setSetting("toner_inventory",JSON.stringify(inventory),Number(req.user.id));
  auth.setSetting("used_toners",JSON.stringify(used),Number(req.user.id));
  const result=auth.database.prepare(
    "INSERT INTO toner_exchanges (printer_ip,printer_name,printer_model,toner_model,color,previous_level,performed_by,created_at) VALUES (?,?,?,?,?,?,?,?)"
  ).run(ip,(reading&&reading.hostname)||printer.location||printer.model,printer.model,model,color,matching?Number(matching.percent):null,Number(req.user.id),now);
  if(ownReservation)auth.database.prepare("UPDATE toner_reservations SET status='used',completed_at=? WHERE id=?")
    .run(now,Number(ownReservation.id));
  auth.addAudit(req.user.id,"create","toner_exchange",String(result.lastInsertRowid),"Troca confirmada: "+model+" em "+ip);
  return res.status(201).json({sucesso:true,id:Number(result.lastInsertRowid),mensagem:canDeduct?"Troca confirmada e estoque atualizado.":"Troca registrada. Não havia saldo livre para descontar; confira o estoque de toners.",saldo:stock?Number(stock.quantidade):0,estoqueAtualizado:canDeduct});
});
app.get("/api/toner/compatibility", auth.requirePermission("toner"), function(req,res) {
  return res.json({sucesso:true,itens:compatibilityRows()});
});
app.post("/api/toner/compatibility", auth.requireMaster, function(req,res) {
  const printerModel=String(req.body?.printerModel||"").trim().slice(0,160);
  const tonerModel=String(req.body?.tonerModel||"").trim().slice(0,100);
  const color=String(req.body?.color||"").trim().slice(0,30);
  if(!printerModel||!tonerModel||!color)return res.status(400).json({sucesso:false,mensagem:"Informe modelo da impressora, toner e cor."});
  const now=new Date().toISOString();
  auth.database.prepare(
    "INSERT INTO toner_compatibility (printer_model,toner_model,color,active,created_by,created_at,updated_at) VALUES (?,?,?,1,?,?,?) "
    + "ON CONFLICT(printer_model,toner_model,color) DO UPDATE SET active=1,updated_at=excluded.updated_at"
  ).run(printerModel,tonerModel,color,Number(req.user.id),now,now);
  auth.addAudit(req.user.id,"create","toner_compatibility","",printerModel+" compatível com "+tonerModel+" ("+color+")");
  return res.status(201).json({sucesso:true,itens:compatibilityRows()});
});
app.delete("/api/toner/compatibility/:id", auth.requireMaster, function(req,res) {
  const result=auth.database.prepare("DELETE FROM toner_compatibility WHERE id=?").run(Number(req.params.id));
  if(!result.changes)return res.status(404).json({sucesso:false,mensagem:"Compatibilidade não encontrada."});
  auth.addAudit(req.user.id,"delete","toner_compatibility",String(req.params.id),"Compatibilidade de toner removida");
  return res.json({sucesso:true});
});
app.get("/api/toner/diagnostics/:ip", auth.requireMaster, function(req,res) {
  const printer=activePrinterByIp(req.params.ip);
  if(!printer)return res.status(404).json({sucesso:false,mensagem:"Impressora não encontrada."});
  const reading=latestPrinterReading(printer.ip);
  const history=auth.database.prepare(
    "SELECT supply_name AS supplyName,level,status,recorded_at AS recordedAt FROM toner_history WHERE printer_ip=? ORDER BY recorded_at DESC LIMIT 30"
  ).all(printer.ip);
  const report=lerTonerAtual(),lastReading=report.updatedAt||null,supplies=reading&&reading.supplies||[];
  const responded=Boolean(reading&&reading.online),ageMinutes=lastReading?Math.max(0,Math.round((Date.now()-Date.parse(lastReading))/60000)):null;
  const validSupplies=supplies.filter(function(item){return item.isToner!==false&&Number.isFinite(Number(item.percent));});
  const unavailableSupplies=supplies.filter(function(item){return item.isToner!==false&&!Number.isFinite(Number(item.percent));});
  const recentHistory=history.slice(0,10),zeroReadings=recentHistory.filter(function(item){return Number(item.level)===0;}).length;
  const issues=[],actions=[];
  if(!responded){
    issues.push({severity:"critical",title:"Sem resposta SNMP",detail:"A impressora não respondeu à consulta UDP na porta 161."});
    actions.push("Confirme se a impressora está ligada e acessível pelo IP.");
    actions.push("Teste conectividade de rede entre o servidor e a impressora.");
    actions.push("Verifique se o SNMP v2c está habilitado e se a comunidade configurada está correta.");
    actions.push("Libere UDP 161 no firewall ou na VLAN, se necessário.");
  }else{
    if(!supplies.length){
      issues.push({severity:"warning",title:"Suprimentos não informados",detail:"O equipamento respondeu, mas não retornou a tabela de suprimentos."});
      actions.push("Confirme se o equipamento permite leitura da Printer-MIB.");
      actions.push("Atualize o firmware e revise as permissões SNMP somente leitura.");
    }
    if(unavailableSupplies.length){
      issues.push({severity:"warning",title:"Níveis incompletos",detail:unavailableSupplies.length+" consumível(is) foram encontrados sem percentual calculável."});
      actions.push("Confira se os campos de nível atual e capacidade máxima são fornecidos pelo fabricante.");
    }
    if(zeroReadings>=2){
      issues.push({severity:"warning",title:"Leituras zeradas recorrentes",detail:zeroReadings+" das últimas "+recentHistory.length+" leituras retornaram 0%. Isso pode gerar falso alerta."});
      actions.push("Compare o nível exibido no painel físico da impressora com a leitura SNMP.");
    }
  }
  if(ageMinutes!==null&&ageMinutes>120){
    issues.push({severity:"warning",title:"Leitura desatualizada",detail:"A última leitura ocorreu há "+ageMinutes+" minutos."});
    actions.push("Execute uma nova atualização das impressoras.");
  }
  if(responded&&supplies.length&&validSupplies.length&&!issues.length)
    issues.push({severity:"ok",title:"Comunicação saudável",detail:"A impressora respondeu e informou os níveis esperados."});
  return res.json({sucesso:true,diagnostic:{
    ip:printer.ip,model:printer.model,location:printer.location,unit:printer.unit||"",snmpVersion:"v2c",port:161,readOnly:true,
    responded:responded,status:reading?reading.status:"unknown",health:!responded?"critical":issues.some(function(item){return item.severity==="warning";})?"warning":"ok",
    lastReading:lastReading,ageMinutes:ageMinutes,hostname:reading&&reading.hostname||"",
    supplies:supplies,validSupplyCount:validSupplies.length,issues:issues,actions:Array.from(new Set(actions)),history:history
  }});
});
app.get("/api/toner/insights", auth.requirePermission("toner"), function(req,res) {
  const report=lerTonerAtual(),inventory=lerEstoqueToners(),reservations=reservedTonerCounts();
  const history=auth.database.prepare(
    "SELECT printer_ip AS printerIp,supply_name AS supplyName,level,recorded_at AS recordedAt FROM toner_history "
    + "WHERE recorded_at>=datetime('now','-30 days') ORDER BY printer_ip,supply_name,recorded_at"
  ).all();
  const exchanges=auth.database.prepare("SELECT printer_ip AS printerIp,toner_model AS tonerModel,created_at AS createdAt FROM toner_exchanges WHERE created_at>=datetime('now','-30 days')").all();
  const groups=new Map();
  history.forEach(function(row){
    const key=row.printerIp+"|"+row.supplyName;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  });
  const anomalies=[];
  groups.forEach(function(rows,key){
    if(rows.length<2)return;
    const first=rows[0],last=rows[rows.length-1],drop=Number(first.level)-Number(last.level);
    const elapsed=Math.max(1,(new Date(last.recordedAt)-new Date(first.recordedAt))/86400000);
    const lastStep=Number(rows[rows.length-2].level)-Number(last.level);
    const increased=Number(last.level)-Number(rows[rows.length-2].level);
    const ip=last.printerIp,supply=last.supplyName;
    if(lastStep>=25)anomalies.push({type:"rapid_drop",severity:"warning",ip:ip,supply:supply,title:"Queda incomum de "+lastStep+" pontos",detail:"Confira impressão intensa ou leitura incorreta."});
    if(increased>=15&&!exchanges.some(function(item){return item.printerIp===ip&&new Date(item.createdAt)>=new Date(rows[rows.length-2].recordedAt);}))
      anomalies.push({type:"unregistered_change",severity:"warning",ip:ip,supply:supply,title:"Nível aumentou sem troca registrada",detail:"Possível troca realizada fora do fluxo."});
    groups.get(key).dailyDrop=Math.max(0,drop/elapsed);
  });
  (report.printers||[]).filter(function(item){return item.online===false;}).forEach(function(item){
    anomalies.push({type:"offline",severity:"neutral",ip:item.ip,supply:"",title:(item.hostname||item.model||item.ip)+" está offline",detail:"Sem resposta na última leitura SNMP."});
  });
  const demand=new Map();
  (report.printers||[]).forEach(function(printer){
    currentTonerSupplies(printer).forEach(function(supply){
      const code=tonerCode(supply.description)||printer.cartridge||"Confirmar modelo";
      const color=tonerColor(supply.description);
      const rows=groups.get(printer.ip+"|"+supply.description);
      const daily=rows&&Number(rows.dailyDrop)||0;
      const projected=Math.max(0,Number(supply.percent)-daily*30);
      const needed=Number(supply.percent)<=Number(report.threshold||20)||projected<=Number(report.threshold||20)?1:0;
      if(!needed)return;
      const key=tonerKey(code,color),current=demand.get(key)||{tonerModel:code,color:color,required:0,printers:[]};
      current.required+=1;current.printers.push(printer.hostname||printer.ip);demand.set(key,current);
    });
  });
  const forecast=Array.from(demand.values()).map(function(item){
    const stock=inventory.find(function(entry){return tonerKey(entry.modelo,entry.cor)===tonerKey(item.tonerModel,item.color);});
    const quantity=Number(stock&&stock.quantidade)||0,reserved=reservations.get(tonerKey(item.tonerModel,item.color))||0;
    const available=Math.max(0,quantity-reserved);
    return {...item,stock:quantity,reserved:reserved,available:available,buy:Math.max(0,item.required-available)};
  }).sort(function(a,b){return b.buy-a.buy||a.tonerModel.localeCompare(b.tonerModel,"pt-BR");});
  return res.json({sucesso:true,anomalies:anomalies.slice(0,100),forecast:forecast,generatedAt:new Date().toISOString()});
});

/*
 * Monitoramento local das impressoras por SNMP.
 */
app.get("/api/timeline", auth.requirePermission("view_audit"), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "")) ? String(req.query.from) : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? String(req.query.to) : from;
  const start = new Date(from + "T00:00:00").toISOString();
  const end = new Date(to + "T23:59:59.999").toISOString();
  const auditRows = auth.database.prepare(
    "SELECT audit.id,audit.action,audit.entity_type AS entityType,audit.entity_id AS entityId,"
    + "audit.description,audit.created_at AS createdAt,COALESCE(users.username,'Sistema') AS username "
    + "FROM audit_log audit LEFT JOIN users ON users.id=audit.user_id "
    + "WHERE audit.created_at>=? AND audit.created_at<=? ORDER BY audit.created_at DESC LIMIT 1500"
  ).all(start, end);
  const movementRows = auth.database.prepare(
    "SELECT id,movement_type AS action,asset_code AS assetCode,category,previous_location AS previousLocation,"
    + "new_location AS newLocation,detected_at AS createdAt,source FROM stock_movement_events "
    + "WHERE detected_at>=? AND detected_at<=? ORDER BY detected_at DESC LIMIT 1500"
  ).all(start, end);
  function moduleFor(entityType) {
    const type = String(entityType || "").toLowerCase();
    if (/toner|printer/.test(type)) return "toner";
    if (/employee|collaborator|vacation|access/.test(type)) return "collaborators";
    if (/task/.test(type)) return "tasks";
    if (/user|setting|notification|backup|restore|permission/.test(type)) return "admin";
    if (/stock|asset|minimum|restock|inventory|nxt|import/.test(type)) return "stock";
    return "system";
  }
  const auditEvents = auditRows.map((row) => ({
    id: "audit-" + row.id,
    createdAt: row.createdAt,
    username: row.username || "Sistema",
    module: moduleFor(row.entityType),
    action: row.action,
    title: row.description || "Alteração registrada",
    detail: row.entityType + (row.entityId ? " · " + row.entityId : ""),
    source: "audit"
  }));
  const movementLabels = { entry: "Entrada de ativo", exit: "Saída de ativo", transfer: "Movimentação de ativo" };
  const movementEvents = movementRows.map((row) => ({
    id: "movement-" + row.id,
    createdAt: row.createdAt,
    username: "Sistema",
    module: "stock",
    action: row.action,
    title: (movementLabels[row.action] || "Movimentação de ativo") + " · " + row.assetCode,
    detail: [
      row.category,
      row.previousLocation && "Origem: " + row.previousLocation,
      row.newLocation && "Destino: " + row.newLocation
    ].filter(Boolean).join(" · "),
    source: row.source || "inventory"
  }));
  const events = auditEvents.concat(movementEvents)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 2000);
  return res.json({ sucesso: true, from, to, events });
});


function recordPrinterPages(report){
  const stamp=report?.updatedAt||new Date().toISOString(),insert=auth.database.prepare("INSERT INTO printer_page_history (printer_ip,printer_model,hostname,total_pages,recorded_at) VALUES (?,?,?,?,?)");
  auth.database.exec("BEGIN");try{(report?.printers||[]).forEach(function(p){const pages=Number(p.totalPages);if(Number.isFinite(pages)&&pages>=0)insert.run(p.ip||"",p.model||"",p.hostname||"",Math.round(pages),stamp);});auth.database.exec("DELETE FROM printer_page_history WHERE recorded_at < datetime('now','-800 days')");auth.database.exec("COMMIT");}catch(error){auth.database.exec("ROLLBACK");throw error;}
}
function registerAutomaticTonerExchange(item,currentLevel,stamp){
  const model=tonerCode(item.supply_name)||"Modelo não identificado",color=tonerColor(item.supply_name);
  const cooldownStart=new Date(Date.parse(stamp)-7*24*60*60*1000).toISOString();
  const recent=auth.database.prepare("SELECT id FROM toner_exchanges WHERE printer_ip=? AND toner_model=? AND color=? AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(item.printer_ip,model,color,cooldownStart);
  if(recent){
    auth.database.prepare("UPDATE toner_change_candidates SET status='ignored_cooldown',current_level=?,last_seen_at=?,resolved_at=? WHERE id=?").run(currentLevel,stamp,stamp,item.id);
    return{registered:false,reason:"cooldown"};
  }
  const existing=auth.database.prepare("SELECT id FROM toner_exchanges WHERE printer_ip=? AND toner_model=? AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(item.printer_ip,model,item.detected_at);
  if(existing){
    auth.database.prepare("UPDATE toner_change_candidates SET status='confirmed_manual',current_level=?,confirmation_count=2,last_seen_at=?,resolved_at=? WHERE id=?").run(currentLevel,stamp,stamp,item.id);
    return{registered:false,reason:"manual"};
  }
  const inventory=lerEstoqueToners(),stock=inventory.find(function(x){return tonerKey(x.modelo,x.cor)===tonerKey(model,color);});
  const reservation=auth.database.prepare("SELECT id FROM toner_reservations WHERE printer_ip=? AND toner_model=? AND color=? AND status='reserved' ORDER BY reserved_at LIMIT 1").get(item.printer_ip,model,color);
  const reserved=reservedTonerCounts().get(tonerKey(model,color))||0,free=(Number(stock&&stock.quantidade)||0)-reserved;
  const canDeduct=Boolean(stock&&Number(stock.quantidade)>0&&(reservation||free>=1));
  if(canDeduct)stock.quantidade=Number(stock.quantidade)-1;
  const printer=activePrinterByIp(item.printer_ip),unidade=normalizarUnidadeToner(printer&&printer.unit);
  const used=lerTonersUsados(),usedItem=used.find(function(x){return tonerKey(x.modelo,x.cor)===tonerKey(model,color)&&x.unidade===unidade;});
  if(usedItem)usedItem.quantidade=Number(usedItem.quantidade)+1;else used.push({modelo:model,cor:color,unidade,quantidade:1});
  auth.setSetting("toner_inventory",JSON.stringify(inventory),null);
  auth.setSetting("used_toners",JSON.stringify(used),null);
  const result=auth.database.prepare("INSERT INTO toner_exchanges (printer_ip,printer_name,printer_model,toner_model,color,previous_level,performed_by,created_at,source,current_level) VALUES (?,?,?,?,?,?,NULL,?,'automatic',?)")
    .run(item.printer_ip,item.printer_name,item.printer_model,model,color,item.previous_level,stamp,currentLevel);
  if(reservation)auth.database.prepare("UPDATE toner_reservations SET status='used',completed_at=? WHERE id=?").run(stamp,reservation.id);
  auth.database.prepare("UPDATE toner_change_candidates SET status='auto_confirmed',current_level=?,confirmation_count=2,last_seen_at=?,resolved_at=? WHERE id=?").run(currentLevel,stamp,stamp,item.id);
  auth.addAudit(null,"create","toner_exchange",String(result.lastInsertRowid),"Troca identificada automaticamente: "+model+" em "+item.printer_ip);
  dispatchNotification("toner-auto-exchange:"+result.lastInsertRowid,"toner","Troca de toner identificada automaticamente",(item.printer_name||item.printer_ip)+" · "+model+" · "+color+" · "+item.previous_level+"% → "+currentLevel+"%"+(canDeduct?" · estoque atualizado":" · sem saldo para desconto"),false).catch(function(error){console.error("Notificação de troca automática:",error.message);});
  return{registered:true,id:Number(result.lastInsertRowid),deducted:canDeduct};
}
function detectTonerChanges(report){
  const stamp=report?.updatedAt||new Date().toISOString();
  const HIGH_MIN=70,LOW_MAX=25,HIGH_TOLERANCE=12,CANDIDATE_MAX_AGE=6*60*60*1000;
  const history=auth.database.prepare("SELECT level,recorded_at FROM toner_history WHERE printer_ip=? AND supply_name=? AND recorded_at<? ORDER BY recorded_at DESC LIMIT 3");
  const pending=auth.database.prepare("SELECT * FROM toner_change_candidates WHERE printer_ip=? AND supply_name=? AND status='pending' ORDER BY id DESC LIMIT 1");
  const insert=auth.database.prepare("INSERT INTO toner_change_candidates (printer_ip,printer_name,printer_model,supply_name,previous_level,current_level,status,detected_at,confirmation_count,last_seen_at) VALUES (?,?,?,?,?,?,'pending',?,1,?)");
  (report?.printers||[]).forEach(function(p){
    if(p.online===false||p.stale)return;
    (p.supplies||[]).filter(function(s){return s.isToner!==false&&Number.isFinite(Number(s.percent));}).forEach(function(s){
      const name=String(s.description||s.name||"Toner"),level=Math.round(Number(s.percent)),candidate=pending.get(p.ip,name);
      if(candidate&&candidate.detected_at<stamp){
        const age=Date.parse(stamp)-Date.parse(candidate.detected_at);
        if(age>CANDIDATE_MAX_AGE){
          auth.database.prepare("UPDATE toner_change_candidates SET status='expired',current_level=?,last_seen_at=?,resolved_at=? WHERE id=?").run(level,stamp,stamp,candidate.id);
          return;
        }
        if(level>=HIGH_MIN&&Math.abs(level-Number(candidate.current_level))<=HIGH_TOLERANCE){
          const confirmations=Number(candidate.confirmation_count||1)+1;
          auth.database.prepare("UPDATE toner_change_candidates SET current_level=?,confirmation_count=?,last_seen_at=? WHERE id=?").run(level,confirmations,stamp,candidate.id);
          if(confirmations>=2)registerAutomaticTonerExchange({...candidate,confirmation_count:confirmations,current_level:level},level,stamp);
        }else if(level<=LOW_MAX){
          auth.database.prepare("UPDATE toner_change_candidates SET status='dismissed_unstable',current_level=?,last_seen_at=?,resolved_at=? WHERE id=?").run(level,stamp,stamp,candidate.id);
        }else{
          auth.database.prepare("UPDATE toner_change_candidates SET current_level=?,confirmation_count=1,last_seen_at=? WHERE id=?").run(level,stamp,candidate.id);
        }
        return;
      }
      if(level<HIGH_MIN)return;
      const readings=history.all(p.ip,name,stamp);
      const lowReadings=readings.slice(0,2);
      const hasTwoConsecutiveLow=lowReadings.length===2&&lowReadings.every(function(row){return Number(row.level)<=LOW_MAX;});
      const zeroReadings=lowReadings.filter(function(row){return Number(row.level)===0;}).length;
      const zeroConfirmed=zeroReadings<2||(readings.length>=3&&Number(readings[2].level)===0);
      if(!hasTwoConsecutiveLow||!zeroConfirmed)return;
      const previousLevel=Math.max(Number(lowReadings[0].level),Number(lowReadings[1].level));
      if(level-previousLevel<40)return;
      const model=tonerCode(name)||"Modelo não identificado",color=tonerColor(name),cooldownStart=new Date(Date.parse(stamp)-7*24*60*60*1000).toISOString();
      const recent=auth.database.prepare("SELECT id FROM toner_exchanges WHERE printer_ip=? AND toner_model=? AND color=? AND created_at>=? LIMIT 1").get(p.ip,model,color,cooldownStart);
      if(recent)return;
      insert.run(p.ip,p.hostname||p.model||p.ip,p.model||"",name,previousLevel,level,stamp,stamp);
    });
  });
}
function pageAnalytics(days){
  const period=Math.max(7,Math.min(365,Number(days)||30)),now=Date.now(),todayStart=new Date();todayStart.setHours(0,0,0,0);const since=new Date(now-period*86400000).toISOString(),rows=auth.database.prepare("SELECT printer_ip ip,printer_model model,hostname,total_pages totalPages,recorded_at recordedAt FROM printer_page_history WHERE recorded_at>=? ORDER BY printer_ip,recorded_at").all(since),groups={};
  rows.forEach(function(r){(groups[r.ip]||(groups[r.ip]=[])).push(r);});
  const currentPrinterMap=new Map((lerTonerAtual().printers||[]).map(function(p){return[p.ip,p];}));
  function delta(list,cutoff){const x=list.filter(function(r){return Date.parse(r.recordedAt)>=cutoff;});return x.length>1?Math.max(0,x[x.length-1].totalPages-x[0].totalPages):0;}
  const printers=Object.values(groups).map(function(list){const first=list[0],last=list[list.length-1],pages=Math.max(0,last.totalPages-first.totalPages),elapsed=Math.max(1,(Date.parse(last.recordedAt)-Date.parse(first.recordedAt))/86400000);const current=currentPrinterMap.get(last.ip)||{};return{ip:last.ip,serial:current.serial||"",model:last.model,hostname:last.hostname,totalPages:last.totalPages,periodPages:pages,today:delta(list,todayStart.getTime()),week:delta(list,now-7*86400000),month:delta(list,now-30*86400000),dailyAverage:pages/elapsed};}).sort(function(a,b){return b.periodPages-a.periodPages;});
  const fleet={today:printers.reduce((n,p)=>n+p.today,0),week:printers.reduce((n,p)=>n+p.week,0),month:printers.reduce((n,p)=>n+p.month,0),period:printers.reduce((n,p)=>n+p.periodPages,0)};
  const toner=auth.database.prepare("SELECT printer_ip ip,supply_name supply,level,recorded_at recordedAt FROM toner_history WHERE recorded_at>=? ORDER BY printer_ip,supply_name,recorded_at").all(since),tg={};toner.forEach(function(r){const k=r.ip+"|"+r.supply;(tg[k]||(tg[k]=[])).push(r);});
  const yields=[];Object.values(tg).forEach(function(list){if(list.length<2)return;const first=list[0],last=list[list.length-1],drop=first.level-last.level,p=printers.find(x=>x.ip===last.ip);if(drop>0&&p&&p.periodPages>0){const ratio=p.periodPages/drop;yields.push({ip:last.ip,supply:last.supply,level:last.level,estimatedYield:Math.round(ratio*100),remainingPages:Math.round(ratio*last.level)});}});
  const avg=printers.length?printers.reduce((n,p)=>n+p.dailyAverage,0)/printers.length:0,anomalies=[];printers.forEach(function(p){if(avg&&p.dailyAverage>avg*2.5)anomalies.push({severity:"warning",ip:p.ip,title:"Volume acima da média",detail:(p.hostname||p.ip)+" · "+Math.round(p.dailyAverage)+" páginas/dia"});});
  const costs=JSON.parse(auth.getSetting("toner_unit_costs","{}")||"{}"),exchanges=auth.database.prepare("SELECT toner_model model,COUNT(*) quantity FROM toner_exchanges WHERE created_at>=? GROUP BY toner_model").all(since),spend=exchanges.reduce((n,e)=>n+(Number(costs[String(e.model).toUpperCase()])||0)*e.quantity,0);
  const maintenance=auth.database.prepare("SELECT id,printer_ip ip,maintenance_type type,interval_pages intervalPages,last_pages lastPages,next_due_pages nextDuePages,last_at lastAt,notes FROM printer_maintenance ORDER BY next_due_pages").all().map(function(m){const p=printers.find(x=>x.ip===m.ip),current=p?p.totalPages:null;return{...m,currentPages:current,due:current!==null&&current>=m.nextDuePages,remaining:current===null?null:m.nextDuePages-current};});
  const candidates=auth.database.prepare("SELECT id,printer_ip ip,printer_name printerName,printer_model printerModel,supply_name supplyName,previous_level previousLevel,current_level currentLevel,detected_at detectedAt FROM toner_change_candidates WHERE status='pending' ORDER BY detected_at DESC").all();
  const firstReading=rows.length?rows.reduce(function(first,row){return !first||row.recordedAt<first?row.recordedAt:first;},""):null,lastReading=rows.length?rows.reduce(function(last,row){return !last||row.recordedAt>last?row.recordedAt:last;},""):null,coverageHours=firstReading?Math.max(0,(now-Date.parse(firstReading))/3600000):0;return{period,fleet,printers,yields,anomalies,costs,estimatedSpend:spend,costPerPage:fleet.period?spend/fleet.period:null,maintenance,candidates,dataCoverage:{firstReading:firstReading,lastReading:lastReading,hours:coverageHours,days:coverageHours/24,readings:rows.length,completePeriod:coverageHours>=period*24}};
}
app.get("/api/toner/analytics",auth.requirePermission("toner"),function(req,res){try{res.json({sucesso:true,...pageAnalytics(req.query.days)});}catch(error){res.status(500).json({sucesso:false,mensagem:error.message});}});
app.put("/api/toner/costs",auth.requireMaster,function(req,res){const clean={};Object.entries(req.body?.costs||{}).slice(0,200).forEach(function([key,value]){if(key.trim())clean[key.trim().toUpperCase()]=Math.max(0,Number(value)||0);});auth.setSetting("toner_unit_costs",JSON.stringify(clean),req.user.id);auth.addAudit(req.user.id,"update","toner_costs","","Custos de toner atualizados");res.json({sucesso:true,costs:clean});});
app.post("/api/toner/maintenance",auth.requireMaster,function(req,res){const ip=String(req.body?.ip||"").trim(),type=String(req.body?.type||"Manutenção preventiva").trim().slice(0,120),interval=Math.max(1000,Number(req.body?.intervalPages)||100000),current=Number((lerTonerAtual().printers||[]).find(p=>p.ip===ip)?.totalPages)||0,now=new Date().toISOString();if(!ip)return res.status(400).json({sucesso:false,mensagem:"Selecione uma impressora."});const result=auth.database.prepare("INSERT INTO printer_maintenance (printer_ip,maintenance_type,interval_pages,last_pages,next_due_pages,notes,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(ip,type,interval,current,current+interval,String(req.body?.notes||"").slice(0,500),req.user.id,now,now);auth.addAudit(req.user.id,"create","printer_maintenance",String(result.lastInsertRowid),type+" em "+ip);res.status(201).json({sucesso:true,id:Number(result.lastInsertRowid)});});
app.post("/api/toner/maintenance/:id/complete",auth.requireMaster,function(req,res){const m=auth.database.prepare("SELECT * FROM printer_maintenance WHERE id=?").get(Number(req.params.id));if(!m)return res.status(404).json({sucesso:false,mensagem:"Manutenção não encontrada."});const current=Number((lerTonerAtual().printers||[]).find(p=>p.ip===m.printer_ip)?.totalPages)||m.next_due_pages,now=new Date().toISOString();auth.database.prepare("UPDATE printer_maintenance SET last_pages=?,next_due_pages=?,last_at=?,updated_at=? WHERE id=?").run(current,current+m.interval_pages,now,now,m.id);auth.addAudit(req.user.id,"update","printer_maintenance",String(m.id),"Manutenção concluída");res.json({sucesso:true});});
app.patch("/api/toner/change-candidates/:id",auth.requirePermission("toner"),requireTonerOperator,function(req,res){const item=auth.database.prepare("SELECT * FROM toner_change_candidates WHERE id=? AND status='pending'").get(Number(req.params.id));if(!item)return res.status(404).json({sucesso:false,mensagem:"Sugestão não encontrada."});const status=req.body?.action==="confirm"?"confirmed":"dismissed",now=new Date().toISOString();auth.database.prepare("UPDATE toner_change_candidates SET status=?,resolved_at=?,resolved_by=? WHERE id=?").run(status,now,req.user.id,item.id);if(status==="confirmed"){const model=tonerCode(item.supply_name)||"Confirmar modelo",color=tonerColor(item.supply_name),inventory=lerEstoqueToners(),stock=inventory.find(x=>tonerKey(x.modelo,x.cor)===tonerKey(model,color)),printer=activePrinterByIp(item.printer_ip),unidade=normalizarUnidadeToner(printer&&printer.unit),used=lerTonersUsados(),usedItem=used.find(x=>tonerKey(x.modelo,x.cor)===tonerKey(model,color)&&x.unidade===unidade);if(stock&&stock.quantidade>0)stock.quantidade--;if(usedItem)usedItem.quantidade++;else used.push({modelo:model,cor:color,unidade,quantidade:1});auth.setSetting("toner_inventory",JSON.stringify(inventory),req.user.id);auth.setSetting("used_toners",JSON.stringify(used),req.user.id);auth.database.prepare("INSERT INTO toner_exchanges (printer_ip,printer_name,printer_model,toner_model,color,previous_level,performed_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(item.printer_ip,item.printer_name,item.printer_model,model,color,item.previous_level,req.user.id,now);auth.addAudit(req.user.id,"create","toner_exchange",String(item.id),"Troca detectada: "+model+" em "+item.printer_ip);}res.json({sucesso:true,status});});

app.get("/api/toner", auth.requirePermission("toner"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    sucesso: true,
    executando: tonerExecutando,
    ...lerTonerAtual(),
  });
});

app.post(
  "/api/toner/atualizar",
  auth.requirePermission("toner"),
  async (req, res) => {
    if (tonerExecutando) {
      return res.status(409).json({
        sucesso: false,
        mensagem: "A consulta das impressoras já está em andamento.",
      });
    }

    tonerExecutando = true;

    try {
      const impressoras = auth.getPrinters()
        .filter((item) => item.active)
        .map((item) => [item.ip, item.model, item.location || "", item.unit || ""]);
      const relatorioLido = await tonerMonitor.scan({
        threshold: Math.max(1, Math.min(99, Number(auth.getSetting("toner_threshold", "20")) || 20)),
        printers: impressoras,
      });
      const relatorio = contingencyTonerReport(relatorioLido);

      fs.mkdirSync(path.dirname(arquivoToner), { recursive: true });
      fs.writeFileSync(
        arquivoToner,
        JSON.stringify(relatorio, null, 2),
        "utf8"
      );
      auth.recordTonerSnapshot(relatorio);
    recordPrinterPages(relatorio);
    detectTonerChanges(relatorio);

      return res.json({
        sucesso: true,
        executando: false,
        ...relatorio,
      });
    } catch (erro) {
      return res.status(500).json({
        sucesso: false,
        mensagem: "Não foi possível consultar as impressoras: " + erro.message,
      });
    } finally {
      tonerExecutando = false;
    }
  }
);

/*
 * Retorna os dados da planilha para o dashboard.
 */
app.get("/api/estoque", auth.requirePermission("stock"), async (req, res) => {
  try {
    const dados = await lerPlanilha();

    res.setHeader("Cache-Control", "no-store");
    res.json(dados);
  } catch (erro) {
    console.error(
      "Erro ao ler a planilha:",
      erro.message
    );

    res.status(500).json({
      sucesso: false,
      mensagem: erro.message,
    });
  }
});

/*
 * Informa se a automação ainda está trabalhando.
 */
app.get("/api/atualizacao", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(estadoAtualizacao);
});

/*
 * Inicia o Playwright.
 *
 * O dashboard recebe a resposta imediatamente e acompanha
 * o andamento pela rota /api/atualizacao.
 */
app.post(
  "/api/atualizar",
  auth.requireUpdatePermission,
  (req, res) => {
  if (estadoAtualizacao.executando) {
    return res.status(409).json({
      sucesso: false,
      mensagem: "A atualização já está em andamento.",
    });
  }

  if (!fs.existsSync(arquivoAutomacao)) {
    return res.status(500).json({
      sucesso: false,
      mensagem: "O arquivo automacao.js não foi encontrado.",
    });
  }

  if (
    !process.env.NXT_EMAIL ||
    !process.env.NXT_PASSWORD
  ) {
    return res.status(400).json({
      sucesso: false,
      mensagem:
        "As credenciais do NXT não estão carregadas nesta janela do PowerShell.",
    });
  }

  estadoAtualizacao = {
    executando: true,
    sucesso: null,
    mensagem:
      "Abrindo o NXT4Insight e atualizando a planilha...",
    inicio: new Date().toISOString(),
    fim: null,
    log: [],
  };

  console.log("");
  console.log("Iniciando atualização pelo dashboard...");

  const processo = spawn(
    process.execPath,
    [arquivoAutomacao],
    {
      cwd: pastaProjeto,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : process.env.ELECTRON_RUN_AS_NODE,
      },
      windowsHide: process.env.NXT_AUTOMATION_HEADLESS === "1",
      shell: false,
    }
  );

  let finalizado = false;

  const limiteTempo = setTimeout(() => {
    if (finalizado) {
      return;
    }

    adicionarLog(
      "O tempo máximo da automação foi atingido."
    );

    processo.kill();

    estadoAtualizacao = {
      ...estadoAtualizacao,
      executando: false,
      sucesso: false,
      mensagem:
        "A automação ultrapassou o tempo máximo de 15 minutos.",
      fim: new Date().toISOString(),
    };
  }, 15 * 60 * 1000);

  processo.stdout.on("data", (dados) => {
    adicionarLog(dados.toString());
  });

  processo.stderr.on("data", (dados) => {
    adicionarLog(dados.toString());
  });

  processo.on("error", (erro) => {
    finalizado = true;
    clearTimeout(limiteTempo);

    estadoAtualizacao = {
      ...estadoAtualizacao,
      executando: false,
      sucesso: false,
      mensagem: `Não foi possível iniciar a automação: ${erro.message}`,
      fim: new Date().toISOString(),
    };

    console.error(estadoAtualizacao.mensagem);
  });

  processo.on("close", (codigo) => {
    if (finalizado) {
      return;
    }

    finalizado = true;
    clearTimeout(limiteTempo);

    if (codigo === 0) {
      estadoAtualizacao = {
        ...estadoAtualizacao,
        executando: false,
        sucesso: true,
        mensagem:
          "Planilha atualizada com sucesso. Atualizando o dashboard...",
        fim: new Date().toISOString(),
      };

      console.log(
        "Atualização finalizada com sucesso."
      );
      captureStockSnapshot("manual").catch(function(error){console.error("Snapshot:",error.message);});
    } else {
      estadoAtualizacao = {
        ...estadoAtualizacao,
        executando: false,
        sucesso: false,
        mensagem:
          "A automação não conseguiu concluir o download. Consulte o histórico apresentado no dashboard.",
        fim: new Date().toISOString(),
      };

      console.error(
        `Automação encerrada com o código ${codigo}.`
      );
    }
  });

  return res.status(202).json({
    sucesso: true,
    mensagem: "Atualização iniciada.",
  });
  }
);

function localDateKey(value){const d=value||new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function stockAssetKey(item,index){return String(item.code||[item.category,item.model,index].join("|")).trim().toUpperCase();}
function stockAssetMap(items){
  const counters=new Map(),result=new Map();
  (items||[]).forEach(function(item){
    const code=String(item.code||"").trim().toUpperCase(),signature=[String(item.category||"").trim().toUpperCase(),String(item.model||"").trim().toUpperCase(),String(item.owner||"").trim().toUpperCase()].join("|");
    const occurrence=(counters.get(signature)||0)+1;counters.set(signature,occurrence);
    result.set(code||signature+"#"+occurrence,item);
  });
  return result;
}
function stockLocation(item){return item.allocatedTo||item.owner||item.category||"Estoque";}
function recordStockMovementEvents(previousRow,assets,capturedAt,source){
  if(!previousRow)return 0;
  let previous=[];try{previous=JSON.parse(previousRow.assetsJson||"[]");}catch{}
  const beforeMap=stockAssetMap(previous);
  const afterMap=stockAssetMap(assets);
  const insert=auth.database.prepare("INSERT OR IGNORE INTO stock_movement_events (event_key,movement_type,asset_code,category,previous_location,new_location,detected_at,source) VALUES (?,?,?,?,?,?,?,?)");
  let total=0;
  function save(type,item,key,from,to){
    const eventKey=[type,key,previousRow.capturedAt,capturedAt].join("|");
    const result=insert.run(eventKey,type,item.code||item.model||"Ativo sem identificação",item.category||"Sem categoria",from||"",to||"",capturedAt,source||"");
    total+=Number(result.changes||0);
  }
  afterMap.forEach(function(item,key){
    const before=beforeMap.get(key);
    if(!before)save("entry",item,key,"",stockLocation(item));
    else if(stockLocation(before)!==stockLocation(item)||before.category!==item.category)save("transfer",item,key,stockLocation(before),stockLocation(item));
  });
  beforeMap.forEach(function(item,key){if(!afterMap.has(key))save("exit",item,key,stockLocation(item),"");});
  return total;
}
function reconcileStockMovementHistory(){
  const snapshots=auth.database.prepare("SELECT assets_json AS assetsJson,captured_at AS capturedAt,source FROM stock_snapshots ORDER BY captured_at").all();
  let recovered=0;
  for(let index=1;index<snapshots.length;index++){
    let assets=[];try{assets=JSON.parse(snapshots[index].assetsJson||"[]");}catch{}
    recovered+=recordStockMovementEvents(snapshots[index-1],assets,snapshots[index].capturedAt,snapshots[index].source||"reconciled");
  }
  if(recovered)console.log("Movimentações recuperadas pela reconciliação:",recovered);
  return recovered;
}
function pendingStockMovements(){
  reconcileStockMovementHistory();
  return auth.database.prepare("SELECT id,movement_type AS type,asset_code AS code,category,previous_location AS previousLocation,new_location AS newLocation,detected_at AS detectedAt FROM stock_movement_events WHERE reported_at='' ORDER BY detected_at,id").all();
}
function markStockMovementsReported(items,slot){
  const ids=(items||[]).map(function(item){return Number(item.id);}).filter(Boolean);if(!ids.length)return;
  const update=auth.database.prepare("UPDATE stock_movement_events SET reported_slot=?,reported_at=? WHERE id=? AND reported_at=''");
  const now=new Date().toISOString();ids.forEach(function(id){update.run(slot,now,id);});
}
async function captureStockSnapshot(source) {
  const previous=auth.database.prepare("SELECT assets_json AS assetsJson,captured_at AS capturedAt FROM stock_snapshots ORDER BY captured_at DESC LIMIT 1").get();
  const stock=await lerPlanilha(),categories=(stock.categorias||[]).map(function(item){return{name:String(item.nome||""),quantity:Number(item.atual)||0};}).filter(function(item){return item.name;});
  const assets=(stock.ativos||[]).map(function(item){return{code:String(item.codigo||""),category:String(item.categoria||""),owner:String(item.proprietario||""),allocatedTo:String(item.alocadoPara||""),model:String(item.modelo||"")};});
  const now=new Date(),date=localDateKey(now),capturedAt=now.toISOString();
  auth.database.prepare("INSERT INTO stock_snapshots (snapshot_date,captured_at,categories_json,assets_json,source) VALUES (?,?,?,?,?)").run(date,capturedAt,JSON.stringify(categories),JSON.stringify(assets),source||"manual");
  const movements=recordStockMovementEvents(previous,assets,capturedAt,source||"manual");
  if(movements)console.log("Movimentações de estoque detectadas:",movements);
  auth.database.prepare("DELETE FROM stock_snapshots WHERE captured_at < datetime('now','-60 days')").run();
  auth.database.prepare("DELETE FROM stock_movement_events WHERE reported_at!='' AND reported_at < datetime('now','-180 days')").run();
  return categories;
}
function scheduledNxtUpdate(trigger) {
  if(estadoAtualizacao.executando||!fs.existsSync(arquivoAutomacao)||!process.env.NXT_EMAIL||!process.env.NXT_PASSWORD)return false;
  const automationRun=automationStart("nxt",trigger||"scheduled");
  estadoAtualizacao={executando:true,sucesso:null,mensagem:"Atualização automática do NXT em andamento...",inicio:new Date().toISOString(),fim:null,log:[]};
  auth.setSetting("nxt_auto_update_last_attempt",new Date().toISOString(),null);
  const child=spawn(process.execPath,[arquivoAutomacao],{cwd:pastaProjeto,env:{...process.env,ELECTRON_RUN_AS_NODE:process.versions.electron?"1":process.env.ELECTRON_RUN_AS_NODE,NXT_AUTOMATION_HEADLESS:"1"},windowsHide:true,shell:false});
  const timeout=setTimeout(function(){child.kill();},15*60*1000);
  child.stdout.on("data",function(data){adicionarLog(data.toString());});
  child.stderr.on("data",function(data){adicionarLog(data.toString());});
  child.on("error",function(error){clearTimeout(timeout);estadoAtualizacao={...estadoAtualizacao,executando:false,sucesso:false,mensagem:"Falha na atualização automática: "+error.message,fim:new Date().toISOString()};automationFinish(automationRun,false,error.message,"");});
  child.on("close",function(code){
    clearTimeout(timeout);
    estadoAtualizacao={...estadoAtualizacao,executando:false,sucesso:code===0,mensagem:code===0?"Atualização automática concluída.":"A atualização automática não foi concluída.",fim:new Date().toISOString()};
    automationFinish(automationRun,code===0,estadoAtualizacao.mensagem,estadoAtualizacao.log.slice(-20).join("\n"));
    if(code===0){auth.setSetting("nxt_auto_update_last_success",new Date().toISOString(),null);captureStockSnapshot("automatic").catch(function(error){console.error("Snapshot automático:",error.message);});}
  });
  return true;
}
async function sendDailyStockMovementReport(forceSend) {
  if(auth.getSetting("notifications_enabled","0")!=="1"||auth.getSetting("daily_stock_report","0")!=="1")return false;
  const date=localDateKey(),eventKey=(forceSend?"daily-stock-manual:"+date+":"+Date.now():"daily-stock:"+date),alreadySent=auth.database.prepare("SELECT id FROM notification_log WHERE event_key=? AND status=\'sent\'").get(eventKey);
  if(alreadySent)return "already_sent";
  const rows=auth.database.prepare("SELECT categories_json AS categoriesJson,captured_at AS capturedAt FROM stock_snapshots WHERE snapshot_date=? AND source!=\'startup\' ORDER BY captured_at").all(date),pending=pendingStockMovements();
  function parseJson(value){try{return JSON.parse(value||"[]");}catch{return[];}}
  function time(value){return new Date(value).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});}
  const movements=pending.map(function(item){return{...item,detectedAt:time(item.detectedAt)};});
  const firstCategories=rows.length?parseJson(rows[0].categoriesJson):[],lastCategories=rows.length?parseJson(rows[rows.length-1].categoriesJson):[],names=new Set(firstCategories.concat(lastCategories).map(function(item){return item.name;})),changedCategories=[],unchanged=[];
  names.forEach(function(name){const before=Number((firstCategories.find(function(item){return item.name===name;})||{quantity:0}).quantity)||0,after=Number((lastCategories.find(function(item){return item.name===name;})||{quantity:0}).quantity)||0,item={name:name,before:before,after:after,difference:after-before};(item.difference?changedCategories:unchanged).push(item);});
  const entries=movements.filter(function(item){return item.type==="entry";}),exits=movements.filter(function(item){return item.type==="exit";}),transfers=movements.filter(function(item){return item.type==="transfer";});
  const firstTime=rows.length?rows[0].capturedAt:(pending[0]&&pending[0].detectedAt),lastTime=rows.length?rows[rows.length-1].capturedAt:(pending[pending.length-1]&&pending[pending.length-1].detectedAt),period=firstTime&&lastTime?time(firstTime)+" até "+time(lastTime):"Sem sincronizações concluídas",balance=entries.length-exits.length;
  const operational=await buildOperationalSummaryEvents(true,["stock","toner"]),stockEvent=operational.find(function(item){return item.type==="stock-summary";}),tonerEvent=operational.find(function(item){return item.type==="toner-summary";}),tonerNow=lerTonerAtual();
  const dailyReport={date:new Date().toLocaleDateString("pt-BR"),period:period,lastSync:lastTime?time(lastTime):"Não realizada",entries:entries,exits:exits,transfers:transfers,balance:balance,changedCategories:changedCategories,unchangedCount:unchanged.length,snapshotCount:rows.length,sufficient:rows.length>=2,stockLow:stockEvent?stockEvent.details.stockItems.length:0,criticalToners:tonerEvent?tonerEvent.details.printerGroups.reduce(function(total,item){return total+item.supplies.length;},0):0,offlineCount:(tonerNow.printers||[]).filter(function(item){return item.online===false;}).length,openRequests:auth.getRestockRequests().filter(function(item){return item.status!=="finished";}).length};
  const lines=["Fechamento diário do estoque — "+dailyReport.date,"Período monitorado: "+period,"Entradas detectadas: "+entries.length,"Saídas detectadas: "+exits.length,exits.length?exits.map(function(item){return "Saída · "+item.code+" · "+item.category+" · detectada às "+item.detectedAt;}).join("\n"):"Nenhuma saída foi detectada.",entries.length?entries.map(function(item){return "Entrada · "+item.code+" · "+item.category+" · detectada às "+item.detectedAt;}).join("\n"):"Nenhuma entrada foi detectada."];
  const sent=await dispatchNotification(eventKey,"daily-stock","Fechamento diário do estoque",lines.join("\n"),false,{dailyReport:dailyReport});
  if(!sent){const failure=auth.database.prepare("SELECT error FROM notification_log WHERE event_key=? ORDER BY id DESC LIMIT 1").get(eventKey);throw new Error(failure&&failure.error?"Falha no Teams: "+failure.error:"O fechamento diário não foi entregue ao canal.");}
  markStockMovementsReported(pending,"close:"+date);
  if(!forceSend)auth.setSetting("daily_stock_report_last_date",date,null);
  return true;
}
setTimeout(function(){captureStockSnapshot("startup").catch(function(error){console.error("Snapshot inicial:",error.message);});},10000).unref();
setInterval(function(){
  const now=new Date(),enabled=auth.getSetting("nxt_auto_update","0")==="1",last=Date.parse(auth.getSetting("nxt_auto_update_last_attempt",""))||0;
  if(enabled&&Date.now()-last>=15*60*1000)scheduledNxtUpdate();

},60000).unref();

async function scheduledTonerScan(trigger) {
  if(tonerExecutando)return false;
  tonerExecutando=true;
  const automationRun=automationStart("snmp",trigger||"scheduled");
  try{
    const printers=auth.getPrinters().filter(function(item){return item.active;}).map(function(item){return[item.ip,item.model];});
    if(!printers.length){automationFinish(automationRun,true,"Nenhuma impressora ativa para consultar.","");return false;}
    const scannedReport=await tonerMonitor.scan({threshold:Math.max(1,Math.min(99,Number(auth.getSetting("toner_threshold","20"))||20)),printers:printers});
    const report=contingencyTonerReport(scannedReport);
    fs.mkdirSync(path.dirname(arquivoToner),{recursive:true});
    fs.writeFileSync(arquivoToner,JSON.stringify(report,null,2),"utf8");
    auth.recordTonerSnapshot(report);
    recordPrinterPages(report);
    detectTonerChanges(report);
    auth.setSetting("toner_last_automatic_scan",new Date().toISOString(),null);
    console.log("Leitura automática de toners concluída.");
    automationFinish(automationRun,true,"Leitura SNMP concluída.",report.contingency&&report.contingency.active?"Dados de "+report.contingency.preserved+" impressora(s) preservados.":"");
    return true;
  }catch(error){
    console.error("Leitura automática de toners:",error.message);
    automationFinish(automationRun,false,error.message,"Nova tentativa automática em 2 minutos.");
    if(!tonerRetryScheduled){tonerRetryScheduled=true;setTimeout(function(){tonerRetryScheduled=false;scheduledTonerScan();},2*60*1000).unref();}
    return false;
  }finally{tonerExecutando=false;}
}
async function sendStartOfActivitiesReport(forceSend) {
  const date=localDateKey(),eventKey=(forceSend?"activity-start-manual:"+date+":"+Date.now():"activity-start:"+date),alreadySent=auth.database.prepare("SELECT id FROM notification_log WHERE event_key=? AND status=\'sent\'").get(eventKey);
  if(alreadySent)return "already_sent";
  const events=await buildOperationalSummaryEvents(true,["stock","toner"]),pending=pendingStockMovements();
  const stockEvent=events.find(function(item){return item.type==="stock-summary";}),tonerEvent=events.find(function(item){return item.type==="toner-summary";}),toner=lerTonerAtual(),formatTime=function(value){return new Date(value).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});};
  const afterHours=pending.map(function(item){return{...item,detectedAt:formatTime(item.detectedAt),extra:item.type==="transfer"?item.previousLocation+" → "+item.newLocation:""};});
  const startReport={date:new Date().toLocaleDateString("pt-BR"),stockItems:stockEvent?stockEvent.details.stockItems:[],printerGroups:tonerEvent?tonerEvent.details.printerGroups:[],criticalToners:tonerEvent?tonerEvent.details.printerGroups.reduce(function(total,item){return total+item.supplies.length;},0):0,offline:(toner.printers||[]).filter(function(item){return item.online===false;}).map(function(item){return item.hostname||item.model||item.ip;}),openRequests:auth.getRestockRequests().filter(function(item){return item.status!=="finished";}).length,afterHours:afterHours};
  const sent=await dispatchNotification(eventKey,"activity-start","Início das atividades","Resumo operacional de abertura.",false,{startReport:startReport});
  if(!sent){const failure=auth.database.prepare("SELECT error FROM notification_log WHERE event_key=? ORDER BY id DESC LIMIT 1").get(eventKey);throw new Error(failure&&failure.error?"Falha no Teams: "+failure.error:"O relatório de início das atividades não foi entregue ao canal.");}
  markStockMovementsReported(pending,"open:"+date);
  return true;
}
async function scheduledActivityReport() {
  const now=new Date(),day=now.getDay(),date=localDateKey(now);
  if(day===0||day===6||tonerDigestExecutando)return false;
  const startConfigured=auth.getSetting("activity_start_report_time","07:00"),closingConfigured=auth.getSetting("daily_stock_report_time","17:00");
  const startParts=startConfigured.split(":").map(Number),closingParts=closingConfigured.split(":").map(Number),startMinute=(startParts[0]||0)*60+(startParts[1]||0),closingMinute=(closingParts[0]||0)*60+(closingParts[1]||0),currentMinute=now.getHours()*60+now.getMinutes();
  const startDue=currentMinute>=startMinute&&auth.getSetting("activity_start_last_date","")!==date;
  const closingDue=currentMinute>=closingMinute&&auth.getSetting("daily_stock_report_last_date","")!==date;
  if(!startDue&&!closingDue)return false;
  if(auth.getSetting("notifications_enabled","0")!=="1"||auth.getSetting("daily_stock_report","0")!=="1")return false;
  const mode=startDue?"activity_start":"closing",slot=date+"-"+mode;
  tonerDigestExecutando=true;
  const automationRun=automationStart(mode,"scheduled");
  try{
    await scheduledTonerScan("scheduled");
    const delivery=startDue?await sendStartOfActivitiesReport():await sendDailyStockMovementReport(false);
    if(startDue)auth.setSetting("activity_start_last_date",date,null);
    auth.setSetting("activity_report_last_slot",slot,null);
    const duplicate=delivery==="already_sent",successMessage=duplicate?(startDue?"Início das atividades já havia sido enviado hoje.":"Fechamento diário já havia sido enviado hoje."):(startDue?"Início das atividades enviado às "+startConfigured+".":"Fechamento diário enviado às "+closingConfigured+".");
    console.log(successMessage,slot);
    automationFinish(automationRun,true,successMessage,slot);
    return true;
  }catch(error){automationFinish(automationRun,false,error.message,slot);throw error;}finally{tonerDigestExecutando=false;}
}
setTimeout(function(){scheduledTonerScan();scheduledActivityReport().catch(function(error){console.error("Relatório operacional programado:",error.message);});},30000).unref();
setInterval(function(){scheduledTonerScan();},15*60*1000).unref();
setInterval(function(){scheduledActivityReport().catch(function(error){console.error("Relatório operacional programado:",error.message);});},60*1000).unref();

setInterval(function(){
  const now=new Date(),enabled=auth.getSetting("backup_auto_enabled","1")==="1",configured=auth.getSetting("backup_auto_time","02:00"),today=localDateKey(now);
  const current=String(now.getHours()).padStart(2,"0")+":"+String(now.getMinutes()).padStart(2,"0");
  if(enabled&&current>=configured&&auth.getSetting("backup_last_date","")!==today){
    try{createAutomaticBackup("scheduled");auth.setSetting("backup_last_date",today,null);}
    catch(error){console.error("Backup automático:",error.message);}
  }
},60*1000).unref();

/*
 * Se a pessoa digitar uma rota inexistente,
 * retorna o dashboard principal.
 */
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ sucesso: false, mensagem: "Endpoint não encontrado." });
  }
  if (req.method !== "GET") return next();
  return res.sendFile(path.join(pastaPublica, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error && error.type === "entity.too.large") {
    return res.status(413).json({ sucesso: false, mensagem: "O arquivo ou conteúdo enviado excede o limite permitido." });
  }
  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({ sucesso: false, mensagem: "O conteúdo JSON enviado é inválido." });
  }
  if (Number(error && error.status) === 404) {
    return res.status(404).json({ sucesso: false, mensagem: "Arquivo não encontrado." });
  }
  console.error("Erro não tratado:", error && error.stack ? error.stack : error);
  return res.status(500).json({ sucesso: false, mensagem: "Ocorreu um erro interno. Consulte o histórico do servidor." });
});

const servidor = app.listen(PORTA, HOST, () => {
  const endereco = servidor.address();
  const portaAtiva = typeof endereco === "object" && endereco
    ? endereco.port
    : PORTA;

  console.log("");
  console.log("Servidor do dashboard iniciado.");
  const hostAcesso = HOST === "0.0.0.0" ? "IP-DO-SERVIDOR" : HOST;
  console.log(`Acesse: http://${hostAcesso}:${portaAtiva}`);
  console.log(`Dados: ${pastaDados}`);
  console.log(`Planilha: ${arquivoPlanilha}`);
  console.log("");
});

module.exports = { app, servidor };
