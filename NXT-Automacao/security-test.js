"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectDir = __dirname;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxt-security-"));
process.env.NXT_DATA_DIR = tempDir;
process.env.NXT_HOST = "127.0.0.1";
process.env.PORT = "0";
process.env.NXT_JSON_LIMIT = "1kb";
process.env.NXT_SNMP_COMMUNITY = "security-test-only";

function source(relativePath) {
  return fs.readFileSync(path.join(projectDir, relativePath), "utf8");
}

async function run() {
  const scanned = ["server.js", "auth.js", "toner-monitor.js", "check_toner.py", "automacao.js", "desktop.js"]
    .map(source).join("\n");
  assert.doesNotMatch(scanned, /requestPacket\(\s*["']public["']/i, "Comunidade SNMP fixa encontrada.");
  assert.doesNotMatch(scanned, /NXT_PASSWORD\s*=\s*["'][^"'\r\n]+["']/i, "Senha NXT fixa encontrada.");
  assert.doesNotMatch(scanned, /NXT_EMAIL\s*=\s*["'][^"'\r\n]+["']/i, "Usuário NXT fixo encontrado.");
  assert.doesNotMatch(source("package.json"), /"dunder-proto"\s*:/, "Dependência direta sem uso encontrada.");

  const { servidor } = require("./server");
  if (!servidor.listening) await new Promise((resolve) => servidor.once("listening", resolve));
  const port = servidor.address().port;
  const base = "http://127.0.0.1:" + port;

  try {
    let response = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ username: "admin", password: "SenhaSegura@123" })
    });
    assert.equal(response.status, 403, "Requisição cross-site deveria ser bloqueada.");

    response = await fetch(base + "/api/auth/setup", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ username: "admin", password: "SenhaSegura@123" })
    });
    assert.equal(response.status, 201, "Configuração local do administrador falhou.");
    const cookie = response.headers.get("set-cookie") || "";
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    response = await fetch(base + "/api/auth/training-progress", { headers: { cookie } });
    assert.equal(response.status, 200, "Progresso do treinamento não pôde ser consultado.");
    let training = await response.json();
    assert.equal(training.total, 7);
    assert.equal(training.completed, 0);

    response = await fetch(base + "/api/auth/training-progress/getting-started", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ completed: true })
    });
    assert.equal(response.status, 200, "Conclusão do treinamento não pôde ser registrada.");

    response = await fetch(base + "/api/auth/training-progress/invalid-lesson", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ completed: true })
    });
    assert.equal(response.status, 400, "Identificador de treinamento inválido deveria ser rejeitado.");

    response = await fetch(base + "/api/system/health");
    assert.equal(response.status, 401, "Rota protegida aceitou acesso sem sessão.");

    response = await fetch(base + "/api/endpoint-inexistente", { headers: { cookie } });
    assert.equal(response.status, 404, "Endpoint de API inexistente não retornou 404 JSON.");
    assert.match(response.headers.get("content-type") || "", /application\/json/i);

    response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: "x".repeat(2048)
    });
    assert.equal(response.status, 413, "Limite do corpo da requisição não foi aplicado.");

    response = await fetch(base + "/login.html");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") || "", /object-src 'none'/);

    console.log("Controles de origem, sessão, autorização, limites e cabeçalhos validados.");
  } finally {
    await new Promise((resolve) => servidor.close(resolve));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (path.basename(tempDir).startsWith("nxt-security-")) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      if (process.platform !== "win32") throw error;
    }
  }
});
