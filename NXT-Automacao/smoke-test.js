"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createAuth } = require("./auth");

const databasePath = path.join(os.tmpdir(), "nxt-smoke-" + process.pid + ".db");
try {
  const auth = createAuth({ databasePath });
  auth.seedPrinters([["127.0.0.1", "Impressora de teste"]]);
  const printers = auth.getPrinters();
  if (printers.length !== 1 || printers[0].ip !== "127.0.0.1") {
    throw new Error("Persistência de impressoras não foi validada.");
  }
  console.log("Banco, migrações e cadastro de impressoras validados.");
} finally {
  ["", "-wal", "-shm"].forEach(function (suffix) {
    try { fs.unlinkSync(databasePath + suffix); } catch {}
  });
}
