"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { DatabaseSync } = require("node:sqlite");

const SESSION_COOKIE = "nxt_session";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;
const MAX_PASSWORD_LENGTH = 128;
const MAX_LOGIN_KEYS = 5000;

function createAuth(options) {
  const databasePath = options.databasePath;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(
    "CREATE TABLE IF NOT EXISTS users ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "username TEXT NOT NULL UNIQUE COLLATE NOCASE,"
    + "password_hash TEXT NOT NULL,"
    + "password_salt TEXT NOT NULL,"
    + "role TEXT NOT NULL CHECK(role IN ('master','operator','viewer')),"
    + "active INTEGER NOT NULL DEFAULT 1,"
    + "created_at TEXT NOT NULL,"
    + "updated_at TEXT NOT NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS sessions ("
    + "token_hash TEXT PRIMARY KEY,"
    + "user_id INTEGER NOT NULL,"
    + "expires_at INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE"
    + ");"
    + "CREATE TABLE IF NOT EXISTS minimum_stock ("
    + "category_key TEXT PRIMARY KEY,"
    + "category_name TEXT NOT NULL,"
    + "minimum INTEGER NOT NULL CHECK(minimum >= 0),"
    + "monitored INTEGER NOT NULL DEFAULT 0,"
    + "product_url TEXT NOT NULL DEFAULT '',"
    + "product_model TEXT NOT NULL DEFAULT '',"
    + "manufacturer TEXT NOT NULL DEFAULT '',"
    + "preferred_supplier TEXT NOT NULL DEFAULT '',"
    + "last_price REAL NOT NULL DEFAULT 0,"
    + "last_purchase_date TEXT NOT NULL DEFAULT '',"
    + "updated_by INTEGER,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS restock_requests ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "status TEXT NOT NULL CHECK(status IN ('pending','requested','purchasing','received')),"
    + "notes TEXT NOT NULL DEFAULT '',"
    + "sc_number TEXT NOT NULL DEFAULT '',"
    + "opened_at TEXT NOT NULL DEFAULT '',"
    + "buyer TEXT NOT NULL DEFAULT '',"
    + "expected_at TEXT NOT NULL DEFAULT '',"
    + "created_by INTEGER NOT NULL,"
    + "created_at TEXT NOT NULL,"
    + "updated_by INTEGER NOT NULL,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(created_by) REFERENCES users(id),"
    + "FOREIGN KEY(updated_by) REFERENCES users(id)"
    + ");"
    + "CREATE TABLE IF NOT EXISTS restock_request_items ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "request_id INTEGER NOT NULL,"
    + "category_key TEXT NOT NULL,"
    + "category_name TEXT NOT NULL,"
    + "current_stock INTEGER NOT NULL CHECK(current_stock >= 0),"
    + "minimum_stock INTEGER NOT NULL CHECK(minimum_stock >= 0),"
    + "quantity INTEGER NOT NULL CHECK(quantity > 0),"
    + "received_quantity INTEGER NOT NULL DEFAULT 0 CHECK(received_quantity >= 0),"
    + "product_url TEXT NOT NULL DEFAULT '',"
    + "product_model TEXT NOT NULL DEFAULT '',"
    + "manufacturer TEXT NOT NULL DEFAULT '',"
    + "supplier TEXT NOT NULL DEFAULT '',"
    + "unit_price REAL NOT NULL DEFAULT 0,"
    + "last_purchase_date TEXT NOT NULL DEFAULT '',"
    + "FOREIGN KEY(request_id) REFERENCES restock_requests(id) ON DELETE CASCADE"
    + ");"
    + "CREATE TABLE IF NOT EXISTS restock_request_events ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "request_id INTEGER NOT NULL,"
    + "status TEXT NOT NULL,"
    + "notes TEXT NOT NULL DEFAULT '',"
    + "changed_by INTEGER NOT NULL,"
    + "changed_at TEXT NOT NULL,"
    + "FOREIGN KEY(request_id) REFERENCES restock_requests(id) ON DELETE CASCADE,"
    + "FOREIGN KEY(changed_by) REFERENCES users(id)"
    + ");"
    + "CREATE TABLE IF NOT EXISTS system_settings ("
    + "setting_key TEXT PRIMARY KEY,"
    + "setting_value TEXT NOT NULL,"
    + "updated_by INTEGER,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS printers ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "ip TEXT NOT NULL UNIQUE,"
    + "model TEXT NOT NULL DEFAULT '',"
    + "location TEXT NOT NULL DEFAULT '',"
    + "active INTEGER NOT NULL DEFAULT 1,"
    + "created_by INTEGER,"
    + "created_at TEXT NOT NULL,"
    + "updated_by INTEGER,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS vacation_access_plans ("
    + "employee_key TEXT PRIMARY KEY,"
    + "employee_name TEXT NOT NULL DEFAULT '',"
    + "employee_code TEXT NOT NULL DEFAULT '',"
    + "accesses_json TEXT NOT NULL DEFAULT '[]',"
    + "activation_date TEXT NOT NULL DEFAULT '',"
    + "notes TEXT NOT NULL DEFAULT '',"
    + "completed INTEGER NOT NULL DEFAULT 0,"
    + "completed_at TEXT NOT NULL DEFAULT '',"
    + "updated_by INTEGER,"
    + "updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS audit_log ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
    + "action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL DEFAULT '',"
    + "description TEXT NOT NULL DEFAULT '',user_id INTEGER,created_at TEXT NOT NULL,"
    + "FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS user_training_progress ("
    + "user_id INTEGER NOT NULL,lesson_key TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,"
    + "completed_at TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL,"
    + "PRIMARY KEY(user_id,lesson_key),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE"
    + ");"
    + "CREATE TABLE IF NOT EXISTS operational_tasks ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'general',"
    + "source_type TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',"
    + "responsible TEXT NOT NULL DEFAULT '',due_date TEXT NOT NULL DEFAULT '',"
    + "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done')),"
    + "comments TEXT NOT NULL DEFAULT '',created_by INTEGER,created_at TEXT NOT NULL,"
    + "updated_by INTEGER,updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS collaborator_snapshot ("
    + "id INTEGER PRIMARY KEY CHECK(id=1),file_name TEXT NOT NULL DEFAULT '',"
    + "data_json TEXT NOT NULL DEFAULT '[]',row_count INTEGER NOT NULL DEFAULT 0,"
    + "updated_by INTEGER,updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
    + "CREATE TABLE IF NOT EXISTS access_templates ("
    + "access_key TEXT PRIMARY KEY,access_name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,"
    + "updated_by INTEGER,updated_at TEXT NOT NULL,"
    + "FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL"
    + ");"
  );

  const vacationColumns = database.prepare("PRAGMA table_info(vacation_access_plans)")
    .all().map(function (column) { return column.name; });
  [
    ["access_items_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["responsible", "TEXT NOT NULL DEFAULT ''"],
    ["due_date", "TEXT NOT NULL DEFAULT ''"],
    ["comments", "TEXT NOT NULL DEFAULT ''"]
  ].forEach(function (migration) {
    if (!vacationColumns.includes(migration[0])) {
      database.exec("ALTER TABLE vacation_access_plans ADD COLUMN " + migration[0] + " " + migration[1]);
    }
  });
  if (!database.prepare("SELECT access_key FROM access_templates LIMIT 1").get()) {
    const seedAccess = database.prepare(
      "INSERT INTO access_templates (access_key,access_name,active,updated_at) VALUES (?,?,1,?)"
    );
    ["Microsoft 365","VPN","NXT4Insight","ERP","Pastas de rede"].forEach(function (name) {
      seedAccess.run(normalizeSeedKey(name), name, new Date().toISOString());
    });
  }

  const requestItemColumns = database.prepare(
    "PRAGMA table_info(restock_request_items)"
  ).all().map(function (column) { return column.name; });
  if (!requestItemColumns.includes("product_url")) {
    database.exec(
      "ALTER TABLE restock_request_items ADD COLUMN product_url TEXT NOT NULL DEFAULT ''"
    );
  }
  [
    ["received_quantity", "INTEGER NOT NULL DEFAULT 0"],
    ["product_model", "TEXT NOT NULL DEFAULT ''"],
    ["manufacturer", "TEXT NOT NULL DEFAULT ''"],
    ["supplier", "TEXT NOT NULL DEFAULT ''"],
    ["unit_price", "REAL NOT NULL DEFAULT 0"],
    ["last_purchase_date", "TEXT NOT NULL DEFAULT ''"]
  ].forEach(function (migration) {
    if (!requestItemColumns.includes(migration[0])) {
      database.exec("ALTER TABLE restock_request_items ADD COLUMN " + migration[0] + " " + migration[1]);
    }
  });
  const minimumColumns = database.prepare(
    "PRAGMA table_info(minimum_stock)"
  ).all().map(function (column) { return column.name; });
  if (!minimumColumns.includes("monitored")) {
    database.exec("ALTER TABLE minimum_stock ADD COLUMN monitored INTEGER NOT NULL DEFAULT 0");
    database.exec("UPDATE minimum_stock SET monitored = 1 WHERE minimum > 0");
  }
  if (!minimumColumns.includes("product_url")) {
    database.exec(
      "ALTER TABLE minimum_stock ADD COLUMN product_url TEXT NOT NULL DEFAULT ''"
    );
  }
  [
    ["product_model", "TEXT NOT NULL DEFAULT ''"],
    ["manufacturer", "TEXT NOT NULL DEFAULT ''"],
    ["preferred_supplier", "TEXT NOT NULL DEFAULT ''"],
    ["last_price", "REAL NOT NULL DEFAULT 0"],
    ["last_purchase_date", "TEXT NOT NULL DEFAULT ''"]
  ].forEach(function (migration) {
    if (!minimumColumns.includes(migration[0])) {
      database.exec("ALTER TABLE minimum_stock ADD COLUMN " + migration[0] + " " + migration[1]);
    }
  });
  const requestColumns = database.prepare(
    "PRAGMA table_info(restock_requests)"
  ).all().map(function (column) { return column.name; });
  if (!requestColumns.includes("workflow_status")) {
    database.exec("ALTER TABLE restock_requests ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'draft'");
    database.exec("UPDATE restock_requests SET workflow_status=CASE status WHEN 'pending' THEN 'draft' WHEN 'requested' THEN 'sc_open' WHEN 'purchasing' THEN 'purchasing' WHEN 'received' THEN 'finished' ELSE 'draft' END");
  }
  
  [
    ["sc_number", "TEXT NOT NULL DEFAULT ''"],
    ["opened_at", "TEXT NOT NULL DEFAULT ''"],
    ["buyer", "TEXT NOT NULL DEFAULT ''"],
    ["expected_at", "TEXT NOT NULL DEFAULT ''"]
  ].forEach(function (migration) {
    if (!requestColumns.includes(migration[0])) {
      database.exec("ALTER TABLE restock_requests ADD COLUMN " + migration[0] + " " + migration[1]);
    }
  });

  database.exec(
    "CREATE TABLE IF NOT EXISTS notification_log ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,"
    + "title TEXT NOT NULL,message TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL,"
    + "created_at TEXT NOT NULL,sent_at TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT ''"
    + ");"
    + "CREATE TABLE IF NOT EXISTS toner_history ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,printer_ip TEXT NOT NULL,printer_model TEXT NOT NULL DEFAULT '',"
    + "supply_name TEXT NOT NULL,supply_color TEXT NOT NULL DEFAULT '',level INTEGER NOT NULL,"
    + "status TEXT NOT NULL DEFAULT '',recorded_at TEXT NOT NULL"
    + ");"
    + "CREATE INDEX IF NOT EXISTS idx_toner_history_ip_date ON toner_history(printer_ip,recorded_at);"
    + "CREATE TABLE IF NOT EXISTS inventory_counts ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',"
    + "scheduled_date TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_by INTEGER,"
    + "created_at TEXT NOT NULL,closed_at TEXT NOT NULL DEFAULT '',FOREIGN KEY(created_by) REFERENCES users(id)"
    + ");"
    + "CREATE TABLE IF NOT EXISTS inventory_count_items ("
    + "id INTEGER PRIMARY KEY AUTOINCREMENT,count_id INTEGER NOT NULL,category_key TEXT NOT NULL,"
    + "category_name TEXT NOT NULL,system_quantity INTEGER NOT NULL,physical_quantity INTEGER,"
    + "notes TEXT NOT NULL DEFAULT '',FOREIGN KEY(count_id) REFERENCES inventory_counts(id) ON DELETE CASCADE"
    + ");"
  );
  const printerColumns = database.prepare("PRAGMA table_info(printers)").all().map(function (column) { return column.name; });
  if (!printerColumns.includes("unit")) {
    database.exec("ALTER TABLE printers ADD COLUMN unit TEXT NOT NULL DEFAULT ''");
  }

  const userColumns = database.prepare("PRAGMA table_info(users)").all().map(function (column) { return column.name; });
  if (!userColumns.includes("permissions_json")) {
    database.exec("ALTER TABLE users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'");
  }

  const router = express.Router();
  const loginAttempts = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function normalizeSeedKey(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function normalizeUsername(value) {
    return String(value || "").trim();
  }

  function normalizeCategory(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .trim();
  }

  function normalizeProductUrl(value) {
    const text = String(value || "").trim().slice(0, 2000);
    if (!text) return "";
    try {
      const parsed = new URL(text);
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
      return parsed.toString();
    } catch {
      throw new Error("Informe um link válido começando com http:// ou https://.");
    }
  }

  function safeText(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
  }

  function normalizeDate(value) {
    const text = safeText(value, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  }

  function validateUsername(username) {
    return /^[a-zA-Z0-9._-]{3,40}$/.test(username);
  }

  function passwordError(password) {
    const value = String(password || "");
    if (value.length < 10) return "A senha deve ter pelo menos 10 caracteres.";
    if (value.length > MAX_PASSWORD_LENGTH) return "A senha deve ter no máximo 128 caracteres.";
    if (!/[a-z]/.test(value)) return "Inclua ao menos uma letra minúscula.";
    if (!/[A-Z]/.test(value)) return "Inclua ao menos uma letra maiúscula.";
    if (!/\d/.test(value)) return "Inclua ao menos um número.";
    if (!/[^A-Za-z0-9]/.test(value)) return "Inclua ao menos um símbolo.";
    return "";
  }

  function hashPassword(password, salt) {
    return crypto.scryptSync(String(password), salt, 64).toString("hex");
  }

  function createPassword(password) {
    const salt = crypto.randomBytes(24).toString("hex");
    return { salt: salt, hash: hashPassword(password, salt) };
  }

  const dummyPassword = createPassword(crypto.randomBytes(32).toString("hex"));

  function verifyPassword(password, user) {
    const expected = Buffer.from(user.password_hash, "hex");
    const received = Buffer.from(hashPassword(password, user.password_salt), "hex");
    return expected.length === received.length
      && crypto.timingSafeEqual(expected, received);
  }

  function parseCookies(request) {
    const cookies = {};
    String(request.headers.cookie || "").split(";").forEach(function (part) {
      const index = part.indexOf("=");
      if (index < 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) {
        try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = ""; }
      }
    });
    return cookies;
  }

  function tokenHash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  function setSession(response, userId) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_DURATION_MS;
    database.prepare(
      "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)"
    ).run(tokenHash(token), userId, expiresAt, nowIso());
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=" + encodeURIComponent(token)
        + "; Path=/; HttpOnly; SameSite=Strict"
        + (process.env.NXT_SECURE_COOKIE === "1" ? "; Secure" : "")
        + "; Max-Age=" + Math.floor(SESSION_DURATION_MS / 1000)
    );
  }

  function clearSession(request, response) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) {
      database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    }
    response.setHeader(
      "Set-Cookie",
      SESSION_COOKIE + "=; Path=/; HttpOnly; SameSite=Strict"
        + (process.env.NXT_SECURE_COOKIE === "1" ? "; Secure" : "")
        + "; Max-Age=0"
    );
  }

  function currentUser(request) {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (!token) return null;
    database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
    return database.prepare(
      "SELECT users.id,users.username,users.role,users.active,users.permissions_json,sessions.expires_at "
      + "FROM sessions JOIN users ON users.id = sessions.user_id "
      + "WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.active = 1"
    ).get(tokenHash(token), Date.now()) || null;
  }

  const PERMISSION_KEYS = ["stock","toner","collaborators","create_requests","edit_tasks","view_audit"];
  function defaultPermissions(role) {
    if (role === "master") return Object.fromEntries(PERMISSION_KEYS.map(function (key) { return [key, true]; }));
    if (role === "operator") return { stock:true,toner:true,collaborators:true,create_requests:true,edit_tasks:true,view_audit:false };
    return { stock:true,toner:true,collaborators:true,create_requests:false,edit_tasks:false,view_audit:false };
  }
  function userPermissions(user) {
    const defaults = defaultPermissions(user.role);
    try {
      const custom = JSON.parse(user.permissions_json || "{}");
      PERMISSION_KEYS.forEach(function (key) { if (typeof custom[key] === "boolean") defaults[key] = custom[key]; });
    } catch {}
    if (user.role === "master") PERMISSION_KEYS.forEach(function (key) { defaults[key] = true; });
    return defaults;
  }
  function publicUser(user) {
    const permissions = userPermissions(user);
    return {
      id: Number(user.id), username: user.username, role: user.role, active: Boolean(user.active),
      permissions: permissions,
      canEditMinimum: user.role === "master", canManageUsers: user.role === "master",
      canManageNxtCredentials: user.role === "master",
      canManagePrinters: user.role === "master" || (user.role === "operator" && permissions.toner),
      canEditOperationalData: user.role === "master" || (user.role === "operator" && permissions.edit_tasks),
      canUpdateNxt: user.role === "master" || (user.role === "operator" && permissions.stock)
    };
  }

  function requireAuth(request, response, next) {
    const user = currentUser(request);
    if (!user) {
      if (request.originalUrl.startsWith("/api/")) {
        return response.status(401).json({
          sucesso: false,
          mensagem: "Sua sessão expirou. Entre novamente."
        });
      }
      return response.redirect("/login.html");
    }
    request.user = user;
    return next();
  }

  function requireMaster(request, response, next) {
    if (!request.user) {
      const user = currentUser(request);
      if (user) request.user = user;
    }
    if (!request.user || request.user.role !== "master") {
      return response.status(403).json({
        sucesso: false,
        mensagem: "Apenas o Master Admin pode realizar esta alteração."
      });
    }
    return next();
  }

  function requirePermission(permission) {
    return function (request, response, next) {
      if (!request.user) {
        const user = currentUser(request);
        if (user) request.user = user;
      }
      if (!request.user || !userPermissions(request.user)[permission]) {
        return response.status(403).json({ sucesso:false, mensagem:"Seu usuário não possui permissão para esta ação." });
      }
      return next();
    };
  }

  function requireUpdatePermission(request, response, next) {
    if (!request.user) {
      const user = currentUser(request);
      if (user) request.user = user;
    }
    if (!request.user || !["master", "operator"].includes(request.user.role)) {
      return response.status(403).json({
        sucesso: false,
        mensagem: "Seu perfil não pode atualizar o NXT4Insight."
      });
    }
    return next();
  }

  function addAudit(userId, action, entityType, entityId, description) {
    database.prepare(
      "INSERT INTO audit_log (action,entity_type,entity_id,description,user_id,created_at) VALUES (?,?,?,?,?,?)"
    ).run(safeText(action,80),safeText(entityType,80),safeText(entityId,160),
      safeText(description,600),userId ? Number(userId) : null,nowIso());
  }

  function setupRequired() {
    const result = database.prepare("SELECT COUNT(*) AS total FROM users").get();
    return Number(result.total) === 0;
  }

  function attemptKey(request, username) {
    return String(request.ip || request.socket.remoteAddress || "local")
      + "|" + normalizeUsername(username).toLowerCase();
  }

  function blockedAttempt(request, username) {
    const key = attemptKey(request, username);
    const state = loginAttempts.get(key);
    if (!state) return false;
    if (Date.now() - state.startedAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
      return false;
    }
    return state.count >= LOGIN_LIMIT;
  }

  function registerFailure(request, username) {
    if (loginAttempts.size >= MAX_LOGIN_KEYS) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest) loginAttempts.delete(oldest);
    }
    const key = attemptKey(request, username);
    const state = loginAttempts.get(key);
    if (!state || Date.now() - state.startedAt > LOGIN_WINDOW_MS) {
      loginAttempts.set(key, { count: 1, startedAt: Date.now() });
    } else {
      state.count += 1;
    }
  }

  router.get("/status", function (request, response) {
    const user = currentUser(request);
    response.setHeader("Cache-Control", "no-store");
    response.json({
      setupRequired: setupRequired(),
      authenticated: Boolean(user),
      user: user ? publicUser(user) : null
    });
  });

  router.post("/setup", function (request, response) {
    if (!setupRequired()) {
      return response.status(409).json({
        sucesso: false,
        mensagem: "O Master Admin já foi configurado."
      });
    }
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    if (!validateUsername(username)) {
      return response.status(400).json({
        sucesso: false,
        mensagem: "Use de 3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado."
      });
    }
    const error = passwordError(password);
    if (error) {
      return response.status(400).json({ sucesso: false, mensagem: error });
    }
    const created = createPassword(password);
    const timestamp = nowIso();
    const result = database.prepare(
      "INSERT INTO users (username,password_hash,password_salt,role,active,created_at,updated_at) "
      + "VALUES (?,?,?,?,1,?,?)"
    ).run(username, created.hash, created.salt, "master", timestamp, timestamp);
    setSession(response, Number(result.lastInsertRowid));
    return response.status(201).json({
      sucesso: true,
      user: {
        id: Number(result.lastInsertRowid),
        username: username,
        role: "master",
        active: true,
        canEditMinimum: true,
        canManageUsers: true,
        canUpdateNxt: true
      }
    });
  });

  router.post("/login", function (request, response) {
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    if (blockedAttempt(request, username)) {
      return response.status(429).json({
        sucesso: false,
        mensagem: "Muitas tentativas. Aguarde 15 minutos e tente novamente."
      });
    }
    const user = database.prepare(
      "SELECT * FROM users WHERE username = ? COLLATE NOCASE"
    ).get(username);
    const passwordTarget = user || {
      password_hash: dummyPassword.hash,
      password_salt: dummyPassword.salt
    };
    const validPassword = password.length <= MAX_PASSWORD_LENGTH
      && verifyPassword(password, passwordTarget);
    if (!user || !user.active || !validPassword) {
      registerFailure(request, username);
      return response.status(401).json({
        sucesso: false,
        mensagem: "Usuário ou senha inválidos."
      });
    }
    loginAttempts.delete(attemptKey(request, username));
    setSession(response, Number(user.id));
    return response.json({ sucesso: true, user: publicUser(user) });
  });

  router.post("/logout", function (request, response) {
    clearSession(request, response);
    response.json({ sucesso: true });
  });

  router.get("/me", requireAuth, function (request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.json({ sucesso: true, user: publicUser(request.user) });
  });

  const TRAINING_LESSONS = ["getting-started","stock","toner","collaborators","activities","reports","automations"];

  router.get("/training-progress", requireAuth, function (request, response) {
    response.setHeader("Cache-Control", "no-store");
    const rows = database.prepare(
      "SELECT lesson_key AS lessonKey,completed,completed_at AS completedAt,updated_at AS updatedAt FROM user_training_progress WHERE user_id=?"
    ).all(Number(request.user.id));
    const progress = Object.fromEntries(rows.map(function (row) {
      return [row.lessonKey, { completed:Boolean(row.completed), completedAt:row.completedAt || "", updatedAt:row.updatedAt }];
    }));
    const completed = TRAINING_LESSONS.filter(function (key) { return progress[key] && progress[key].completed; }).length;
    response.json({ sucesso:true, lessons:TRAINING_LESSONS, progress:progress, completed:completed, total:TRAINING_LESSONS.length, percentage:Math.round(completed * 100 / TRAINING_LESSONS.length) });
  });

  router.put("/training-progress/:lessonKey", requireAuth, function (request, response) {
    const lessonKey = safeText(request.params.lessonKey, 40);
    if (!TRAINING_LESSONS.concat(["welcome-seen"]).includes(lessonKey)) return response.status(400).json({ sucesso:false, mensagem:"Treinamento inválido." });
    const completed = request.body && request.body.completed === true;
    const now = nowIso();
    database.prepare(
      "INSERT INTO user_training_progress (user_id,lesson_key,completed,completed_at,updated_at) VALUES (?,?,?,?,?) "
      + "ON CONFLICT(user_id,lesson_key) DO UPDATE SET completed=excluded.completed,completed_at=excluded.completed_at,updated_at=excluded.updated_at"
    ).run(Number(request.user.id), lessonKey, completed ? 1 : 0, completed ? now : "", now);
    addAudit(Number(request.user.id), completed ? "training_completed" : "training_reopened", "training", lessonKey,
      completed ? "Guia de treinamento concluído." : "Guia de treinamento marcado para revisão.");
    response.json({ sucesso:true, lessonKey:lessonKey, completed:completed, completedAt:completed ? now : "" });
  });

  router.get("/vacation-access-plans", requireAuth, requirePermission("collaborators"), function (request, response) {
    const plans = database.prepare(
      "SELECT employee_key AS employeeKey,employee_name AS employeeName,"
      + "employee_code AS employeeCode,accesses_json AS accessesJson,access_items_json AS accessItemsJson,"
      + "activation_date AS activationDate,notes,responsible,due_date AS dueDate,comments,completed,completed_at AS completedAt,"
      + "updated_at AS updatedAt FROM vacation_access_plans ORDER BY employee_name"
    ).all().map(function (row) {
      let accesses = [], accessItems = [];
      try { accesses = JSON.parse(row.accessesJson || "[]"); } catch { accesses = []; }
      try { accessItems = JSON.parse(row.accessItemsJson || "[]"); } catch { accessItems = []; }
      if (!Array.isArray(accessItems) || !accessItems.length) accessItems = (Array.isArray(accesses) ? accesses : []).map(function (name) { return { name: name, completed: Boolean(row.completed) }; });
      return {
        employeeKey: row.employeeKey, employeeName: row.employeeName, employeeCode: row.employeeCode,
        accesses: Array.isArray(accesses) ? accesses : [], accessItems: accessItems, activationDate: row.activationDate || "",
        notes: row.notes || "", responsible: row.responsible || "", dueDate: row.dueDate || "", comments: row.comments || "", completed: Boolean(row.completed),
        completedAt: row.completedAt || "", updatedAt: row.updatedAt
      };
    });
    response.setHeader("Cache-Control", "no-store");
    response.json({ sucesso: true, plans: plans });
  });

  router.put("/vacation-access-plans/:employeeKey", requireAuth, requirePermission("collaborators"), function (request, response) {
    const employeeKey = safeText(request.params.employeeKey, 160);
    const employeeName = safeText(request.body.employeeName, 160);
    const employeeCode = safeText(request.body.employeeCode, 80);
    const activationDate = normalizeDate(request.body.activationDate);
    const notes = safeText(request.body.notes, 1000);
    const responsible = safeText(request.body.responsible, 160);
    const dueDate = normalizeDate(request.body.dueDate);
    const comments = safeText(request.body.comments, 1500);
    const completed = request.body.completed ? 1 : 0;
    const accesses = (Array.isArray(request.body.accesses) ? request.body.accesses : [])
      .map(function (item) { return safeText(item, 120); })
      .filter(Boolean).filter(function (item, index, list) { return list.indexOf(item) === index; })
      .slice(0, 30);
    const accessItems = (Array.isArray(request.body.accessItems) ? request.body.accessItems : accesses.map(function (name) { return { name: name, completed: false }; }))
      .map(function (item) { return { name: safeText(item && item.name,120), completed: Boolean(item && item.completed) }; })
      .filter(function (item) { return item.name; }).slice(0,30);
    if (!employeeKey || !employeeName) {
      return response.status(400).json({ sucesso: false, mensagem: "Colaborador inválido." });
    }
    const timestamp = nowIso();
    const completedAt = completed ? timestamp : "";
    database.prepare(
      "INSERT INTO vacation_access_plans "
      + "(employee_key,employee_name,employee_code,accesses_json,access_items_json,activation_date,notes,responsible,due_date,comments,completed,completed_at,updated_by,updated_at) "
      + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
      + "ON CONFLICT(employee_key) DO UPDATE SET employee_name=excluded.employee_name,"
      + "employee_code=excluded.employee_code,accesses_json=excluded.accesses_json,access_items_json=excluded.access_items_json,"
      + "activation_date=excluded.activation_date,notes=excluded.notes,responsible=excluded.responsible,due_date=excluded.due_date,comments=excluded.comments,completed=excluded.completed,"
      + "completed_at=excluded.completed_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at"
    ).run(employeeKey, employeeName, employeeCode, JSON.stringify(accesses), JSON.stringify(accessItems), activationDate, notes,
      responsible, dueDate, comments, completed, completedAt, Number(request.user.id), timestamp);
    addAudit(request.user.id, "update", "vacation_access", employeeKey, "Controle de retorno atualizado para " + employeeName);
    response.json({ sucesso: true, plan: {
      employeeKey: employeeKey, employeeName: employeeName, employeeCode: employeeCode,
      accesses: accesses, accessItems: accessItems, activationDate: activationDate, notes: notes, responsible: responsible, dueDate: dueDate, comments: comments, completed: Boolean(completed),
      completedAt: completedAt, updatedAt: timestamp
    } });
  });


  router.get("/access-templates", requireAuth, requirePermission("collaborators"), function (request, response) {
    const items = database.prepare("SELECT access_key AS accessKey,access_name AS accessName,active,updated_at AS updatedAt FROM access_templates ORDER BY access_name")
      .all().map(function (row) { return { accessKey: row.accessKey, accessName: row.accessName, active: Boolean(row.active), updatedAt: row.updatedAt }; });
    response.json({ sucesso: true, items: items });
  });

  router.put("/access-templates", requireAuth, requireMaster, function (request, response) {
    const items = (Array.isArray(request.body.items) ? request.body.items : []).slice(0,100);
    const upsert = database.prepare("INSERT INTO access_templates (access_key,access_name,active,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(access_key) DO UPDATE SET access_name=excluded.access_name,active=excluded.active,updated_by=excluded.updated_by,updated_at=excluded.updated_at");
    items.forEach(function (item) {
      const name=safeText(item.accessName,120),key=normalizeSeedKey(item.accessKey||name);
      if(name&&key)upsert.run(key,name,item.active===false?0:1,Number(request.user.id),nowIso());
    });
    addAudit(request.user.id,"update","access_templates","","Catálogo de acessos atualizado");
    response.json({ sucesso:true });
  });

  router.get("/collaborators-snapshot", requireAuth, requirePermission("collaborators"), function (request, response) {
    const row=database.prepare("SELECT file_name AS fileName,data_json AS dataJson,row_count AS rowCount,updated_at AS updatedAt FROM collaborator_snapshot WHERE id=1").get();
    if(!row)return response.json({sucesso:true,snapshot:null});
    let data=[];try{data=JSON.parse(row.dataJson||"[]");}catch{data=[];}
    response.setHeader("Cache-Control","no-store");
    response.json({sucesso:true,snapshot:{fileName:row.fileName,data:data,rowCount:Number(row.rowCount),updatedAt:row.updatedAt}});
  });

  router.put("/collaborators-snapshot", requireAuth, requirePermission("collaborators"), function (request, response) {
    const data=(Array.isArray(request.body.data)?request.body.data:[]).slice(0,10000);
    const fileName=safeText(request.body.fileName,240),timestamp=nowIso();
    database.prepare("INSERT INTO collaborator_snapshot (id,file_name,data_json,row_count,updated_by,updated_at) VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET file_name=excluded.file_name,data_json=excluded.data_json,row_count=excluded.row_count,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
      .run(fileName,JSON.stringify(data),data.length,Number(request.user.id),timestamp);
    addAudit(request.user.id,"import","collaborators","",fileName+" · "+data.length+" registros");
    response.json({sucesso:true,updatedAt:timestamp,rowCount:data.length});
  });

  router.get("/tasks", requireAuth, function (request, response) {
    const tasks=database.prepare("SELECT tasks.id,tasks.title,tasks.category,tasks.source_type AS sourceType,tasks.source_id AS sourceId,tasks.responsible,tasks.due_date AS dueDate,tasks.status,tasks.comments,tasks.created_at AS createdAt,tasks.updated_at AS updatedAt,users.username AS updatedBy FROM operational_tasks tasks LEFT JOIN users ON users.id=tasks.updated_by ORDER BY CASE tasks.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,tasks.due_date,tasks.id DESC").all();
    response.json({sucesso:true,tasks:tasks.map(function(t){return {...t,id:Number(t.id)};})});
  });

  router.post("/tasks", requireAuth, requirePermission("edit_tasks"), function (request, response) {
    const title=safeText(request.body.title,200);if(!title)return response.status(400).json({sucesso:false,mensagem:"Informe o título da tarefa."});
    const timestamp=nowIso(),status=["pending","in_progress","done"].includes(request.body.status)?request.body.status:"pending";
    const result=database.prepare("INSERT INTO operational_tasks (title,category,source_type,source_id,responsible,due_date,status,comments,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(title,safeText(request.body.category,80)||"general",safeText(request.body.sourceType,80),safeText(request.body.sourceId,160),safeText(request.body.responsible,160),normalizeDate(request.body.dueDate),status,safeText(request.body.comments,1500),Number(request.user.id),timestamp,Number(request.user.id),timestamp);
    addAudit(request.user.id,"create","task",String(result.lastInsertRowid),title);
    response.status(201).json({sucesso:true,id:Number(result.lastInsertRowid)});
  });

  router.patch("/tasks/:id", requireAuth, requirePermission("edit_tasks"), function (request, response) {
    const id=Number(request.params.id),existing=database.prepare("SELECT * FROM operational_tasks WHERE id=?").get(id);
    if(!existing)return response.status(404).json({sucesso:false,mensagem:"Tarefa não encontrada."});
    const status=["pending","in_progress","done"].includes(request.body.status)?request.body.status:existing.status;
    database.prepare("UPDATE operational_tasks SET title=?,responsible=?,due_date=?,status=?,comments=?,updated_by=?,updated_at=? WHERE id=?")
      .run(safeText(request.body.title===undefined?existing.title:request.body.title,200),safeText(request.body.responsible===undefined?existing.responsible:request.body.responsible,160),request.body.dueDate===undefined?existing.due_date:normalizeDate(request.body.dueDate),status,safeText(request.body.comments===undefined?existing.comments:request.body.comments,1500),Number(request.user.id),nowIso(),id);
    addAudit(request.user.id,"update","task",String(id),"Tarefa atualizada: "+existing.title);
    response.json({sucesso:true});
  });

  router.get("/audit", requireAuth, requirePermission("view_audit"), function (request, response) {
    const items=database.prepare("SELECT audit.id,audit.action,audit.entity_type AS entityType,audit.entity_id AS entityId,audit.description,audit.created_at AS createdAt,users.username FROM audit_log audit LEFT JOIN users ON users.id=audit.user_id ORDER BY audit.id DESC LIMIT 500").all();
    response.json({sucesso:true,items:items.map(function(item){return {...item,id:Number(item.id)};})});
  });


  router.get("/notification-settings", requireAuth, requireMaster, function (request, response) {
    response.json({ sucesso:true, settings:{
      enabled:getSetting("notifications_enabled","0")==="1", channel:getSetting("notifications_channel","teams"),
      teamsWebhook:getSetting("notifications_teams_webhook",""), emailTo:getSetting("notifications_email_to",""),
      smtpHost:getSetting("notifications_smtp_host",""),smtpPort:Number(getSetting("notifications_smtp_port","587"))||587,
      smtpFrom:getSetting("notifications_email_from",""),smtpUser:getSetting("notifications_smtp_user",""),smtpSsl:getSetting("notifications_smtp_ssl","1")==="1",smtpPasswordConfigured:Boolean(getSetting("notifications_smtp_password","")),
      staleDays:Number(getSetting("notifications_stale_days","5"))||5, taskLeadDays:Number(getSetting("notifications_task_lead_days","2"))||2,
      notifyStock:getSetting("notifications_stock","1")==="1",notifyToner:getSetting("notifications_toner","1")==="1",
      autoUpdate:getSetting("nxt_auto_update","0")==="1",autoUpdateHours:Number(getSetting("nxt_auto_update_hours","1"))||1,
      dailyReport:getSetting("daily_stock_report","0")==="1",dailyReportTime:getSetting("daily_stock_report_time","18:00")
    }});
  });
  router.put("/notification-settings", requireAuth, requireMaster, function (request, response) {
    const channel=["teams","email","both"].includes(request.body.channel)?request.body.channel:"teams";
    setSetting("notifications_enabled",request.body.enabled?"1":"0",request.user.id);
    setSetting("notifications_channel",channel,request.user.id);
    setSetting("notifications_teams_webhook",safeText(request.body.teamsWebhook,2000),request.user.id);
    setSetting("notifications_email_to",safeText(request.body.emailTo,500),request.user.id);
    setSetting("notifications_smtp_host",safeText(request.body.smtpHost,300),request.user.id);
    setSetting("notifications_smtp_port",String(Math.max(1,Number(request.body.smtpPort)||587)),request.user.id);
    setSetting("notifications_email_from",safeText(request.body.smtpFrom,300),request.user.id);
    setSetting("notifications_smtp_user",safeText(request.body.smtpUser,300),request.user.id);
    if(request.body.smtpPassword)setSetting("notifications_smtp_password",safeText(request.body.smtpPassword,1000),request.user.id);
    setSetting("notifications_smtp_ssl",request.body.smtpSsl===false?"0":"1",request.user.id);
    setSetting("notifications_stale_days",String(Math.max(1,Number(request.body.staleDays)||5)),request.user.id);
    setSetting("notifications_task_lead_days",String(Math.max(0,Number(request.body.taskLeadDays)||2)),request.user.id);
    setSetting("notifications_stock",request.body.notifyStock===false?"0":"1",request.user.id);
    setSetting("notifications_toner",request.body.notifyToner===false?"0":"1",request.user.id);
    setSetting("nxt_auto_update",request.body.autoUpdate?"1":"0",request.user.id);
    setSetting("nxt_auto_update_hours",String(Math.max(1,Math.min(24,Number(request.body.autoUpdateHours)||1))),request.user.id);
    setSetting("daily_stock_report",request.body.dailyReport?"1":"0",request.user.id);
    setSetting("daily_stock_report_time",/^([01]\d|2[0-3]):[0-5]\d$/.test(String(request.body.dailyReportTime||""))?request.body.dailyReportTime:"18:00",request.user.id);
    addAudit(request.user.id,"update","notifications","","Configurações de notificações atualizadas");
    response.json({sucesso:true});
  });

  router.get("/notification-log", requireAuth, requireMaster, function (request,response) {
    response.json({sucesso:true,items:database.prepare("SELECT * FROM notification_log ORDER BY id DESC LIMIT 200").all()});
  });

  router.get("/toner-history", requireAuth, requirePermission("toner"), function (request,response) {
    const days=Math.max(1,Math.min(365,Number(request.query.days)||30));
    const since=new Date(Date.now()-days*86400000).toISOString();
    const rows=database.prepare("SELECT printer_ip AS printerIp,printer_model AS printerModel,supply_name AS supplyName,supply_color AS supplyColor,level,status,recorded_at AS recordedAt FROM toner_history WHERE recorded_at>=? ORDER BY recorded_at").all(since);
    response.json({sucesso:true,items:rows});
  });

  router.get("/inventory-counts", requireAuth, requirePermission("stock"), function (request,response) {
    const counts=database.prepare("SELECT * FROM inventory_counts ORDER BY id DESC").all();
    const getItems=database.prepare("SELECT id,category_key AS categoryKey,category_name AS categoryName,system_quantity AS systemQuantity,physical_quantity AS physicalQuantity,notes FROM inventory_count_items WHERE count_id=? ORDER BY category_name");
    response.json({sucesso:true,counts:counts.map(function(c){return {...c,items:getItems.all(c.id)};})});
  });
  router.post("/inventory-counts", requireAuth, requirePermission("edit_tasks"), function (request,response) {
    const title=safeText(request.body.title,180)||"Conferência de estoque";
    const rows=(Array.isArray(request.body.items)?request.body.items:[]).slice(0,500);
    const result=database.prepare("INSERT INTO inventory_counts (title,status,scheduled_date,notes,created_by,created_at) VALUES (?,'open',?,?,?,?)").run(title,normalizeDate(request.body.scheduledDate),safeText(request.body.notes,1000),request.user.id,nowIso());
    const insert=database.prepare("INSERT INTO inventory_count_items (count_id,category_key,category_name,system_quantity,physical_quantity,notes) VALUES (?,?,?,?,NULL,'')");
    rows.forEach(function(item){const key=normalizeCategory(item.categoryKey||item.categoryName);if(key)insert.run(result.lastInsertRowid,key,safeText(item.categoryName,160)||key,Math.max(0,Number(item.systemQuantity)||0));});
    addAudit(request.user.id,"create","inventory_count",String(result.lastInsertRowid),title);
    response.status(201).json({sucesso:true,id:Number(result.lastInsertRowid)});
  });
  router.patch("/inventory-counts/:id", requireAuth, requirePermission("edit_tasks"), function (request,response) {
    const id=Number(request.params.id),items=(Array.isArray(request.body.items)?request.body.items:[]);
    const update=database.prepare("UPDATE inventory_count_items SET physical_quantity=?,notes=? WHERE count_id=? AND id=?");
    items.forEach(function(item){update.run(item.physicalQuantity===null?null:Math.max(0,Number(item.physicalQuantity)||0),safeText(item.notes,500),id,Number(item.id));});
    if(request.body.close)database.prepare("UPDATE inventory_counts SET status='closed',closed_at=? WHERE id=?").run(nowIso(),id);
    addAudit(request.user.id,"update","inventory_count",String(id),"Conferência atualizada");
    response.json({sucesso:true});
  });

  router.post("/change-password", requireAuth, function (request, response) {
    const currentPassword = String(request.body.currentPassword || "");
    const newPassword = String(request.body.newPassword || "");
    const user = database.prepare("SELECT * FROM users WHERE id = ?").get(Number(request.user.id));
    if (!user || !verifyPassword(currentPassword, user)) {
      return response.status(400).json({ sucesso: false, mensagem: "A senha atual está incorreta." });
    }
    const error = passwordError(newPassword);
    if (error) return response.status(400).json({ sucesso: false, mensagem: error });
    const created = createPassword(newPassword);
    database.prepare(
      "UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?"
    ).run(created.hash, created.salt, nowIso(), Number(user.id));
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(Number(user.id));
    clearSession(request, response);
    return response.json({ sucesso: true, mensagem: "Senha alterada. Entre novamente." });
  });

  router.get("/users", requireAuth, requireMaster, function (request, response) {
    const users = database.prepare(
      "SELECT id,username,role,active,permissions_json,created_at,updated_at FROM users ORDER BY username"
    ).all().map(publicUser);
    response.json({ sucesso: true, users: users });
  });

  router.post("/users", requireAuth, requireMaster, function (request, response) {
    const username = normalizeUsername(request.body.username);
    const password = String(request.body.password || "");
    const role = ["operator", "viewer"].includes(request.body.role)
      ? request.body.role
      : "viewer";
    if (!validateUsername(username)) {
      return response.status(400).json({
        sucesso: false,
        mensagem: "O usuário deve ter de 3 a 40 caracteres válidos."
      });
    }
    const error = passwordError(password);
    if (error) return response.status(400).json({ sucesso: false, mensagem: error });
    if (database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username)) {
      return response.status(409).json({
        sucesso: false,
        mensagem: "Já existe um usuário com esse nome."
      });
    }
    const created = createPassword(password);
    const timestamp = nowIso();
    const result = database.prepare(
      "INSERT INTO users (username,password_hash,password_salt,role,active,created_at,updated_at) "
      + "VALUES (?,?,?,?,1,?,?)"
    ).run(username, created.hash, created.salt, role, timestamp, timestamp);
    response.status(201).json({
      sucesso: true,
      user: publicUser({
        id: Number(result.lastInsertRowid),
        username: username,
        role: role,
        active: 1
      })
    });
  });

  router.patch("/users/:id", requireAuth, requireMaster, function (request, response) {
    const id = Number(request.params.id);
    const existing = database.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!existing) {
      return response.status(404).json({ sucesso: false, mensagem: "Usuário não encontrado." });
    }
    const role = existing.role === "master"
      ? "master"
      : (["operator", "viewer"].includes(request.body.role) ? request.body.role : existing.role);
    const active = existing.role === "master"
      ? 1
      : (typeof request.body.active === "boolean"
        ? (request.body.active ? 1 : 0)
        : existing.active);
    let passwordHash = existing.password_hash;
    let passwordSalt = existing.password_salt;
    if (request.body.password) {
      const error = passwordError(request.body.password);
      if (error) return response.status(400).json({ sucesso: false, mensagem: error });
      const created = createPassword(request.body.password);
      passwordHash = created.hash;
      passwordSalt = created.salt;
      database.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    const permissions = defaultPermissions(role);
    const requestedPermissions = request.body.permissions && typeof request.body.permissions === "object" ? request.body.permissions : {};
    PERMISSION_KEYS.forEach(function (key) {
      if (typeof requestedPermissions[key] === "boolean") permissions[key] = requestedPermissions[key];
    });
    database.prepare(
      "UPDATE users SET role=?,active=?,password_hash=?,password_salt=?,permissions_json=?,updated_at=? WHERE id=?"
    ).run(role, active, passwordHash, passwordSalt, JSON.stringify(permissions), nowIso(), id);
    const updated = database.prepare(
      "SELECT id,username,role,active,permissions_json,created_at,updated_at FROM users WHERE id=?"
    ).get(id);
    response.json({ sucesso: true, user: publicUser(updated) });
  });


  function validIp(value) {
    const ip = String(value || "").trim();
    const parts = ip.split(".");
    return parts.length === 4 && parts.every(function (part) {
      return /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255;
    });
  }

  function getSetting(key, fallbackValue) {
    const row = database.prepare(
      "SELECT setting_value FROM system_settings WHERE setting_key=?"
    ).get(String(key));
    return row ? row.setting_value : fallbackValue;
  }

  function setSetting(key, value, userId) {
    database.prepare(
      "INSERT INTO system_settings (setting_key,setting_value,updated_by,updated_at) VALUES (?,?,?,?) "
      + "ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,"
      + "updated_by=excluded.updated_by,updated_at=excluded.updated_at"
    ).run(String(key), String(value), Number(userId) || null, nowIso());
    return getSetting(key, value);
  }

  function getPrinters() {
    return database.prepare(
      "SELECT id,ip,model,location,unit,active,created_at AS createdAt,updated_at AS updatedAt FROM printers ORDER BY unit,ip"
    ).all().map(function (row) {
      return { ...row, id: Number(row.id), active: Boolean(row.active) };
    });
  }

  function seedPrinters(items) {
    if (database.prepare("SELECT COUNT(*) AS total FROM printers").get().total > 0) return getPrinters();
    const insert = database.prepare(
      "INSERT OR IGNORE INTO printers (ip,model,location,active,created_at,updated_at) VALUES (?,?,?,1,?,?)"
    );
    const timestamp = nowIso();
    database.exec("BEGIN");
    try {
      (items || []).forEach(function (item) {
        const ip = Array.isArray(item) ? item[0] : item.ip;
        const model = Array.isArray(item) ? item[1] : item.model;
        if (validIp(ip)) insert.run(String(ip).trim(), String(model || "").trim().slice(0, 120), "", timestamp, timestamp);
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return getPrinters();
  }

  function savePrinter(values, userId, id) {
    const ip = String(values.ip || "").trim();
    if (!validIp(ip)) throw new Error("Informe um endereço IPv4 válido.");
    const model = String(values.model || "").trim().slice(0, 120);
    const location = String(values.location || "").trim().slice(0, 160);
    const allowedUnits = ["Osasco", "CD", "Bahia"];
    const unit = allowedUnits.includes(String(values.unit || "").trim()) ? String(values.unit).trim() : "";
    const active = values.active === false ? 0 : 1;
    const timestamp = nowIso();
    try {
      if (id) {
        const result = database.prepare(
          "UPDATE printers SET ip=?,model=?,location=?,unit=?,active=?,updated_by=?,updated_at=? WHERE id=?"
        ).run(ip, model, location, unit, active, userId, timestamp, Number(id));
        if (!result.changes) return null;
      } else {
        const result = database.prepare(
          "INSERT INTO printers (ip,model,location,unit,active,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
        ).run(ip, model, location, unit, active, userId, timestamp, userId, timestamp);
        id = Number(result.lastInsertRowid);
      }
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw new Error("Este IP já está cadastrado.");
      throw error;
    }
    const row = database.prepare(
      "SELECT id,ip,model,location,unit,active,created_at AS createdAt,updated_at AS updatedAt FROM printers WHERE id=?"
    ).get(Number(id));
    return row ? { ...row, id: Number(row.id), active: Boolean(row.active) } : null;
  }

  function deletePrinter(id) {
    return Boolean(database.prepare("DELETE FROM printers WHERE id=?").run(Number(id)).changes);
  }

  function getMinimums() {
    return database.prepare(
      "SELECT category_key AS categoryKey,category_name AS categoryName,minimum,monitored,product_url AS productUrl,"
      + "product_model AS productModel,manufacturer,preferred_supplier AS preferredSupplier,"
      + "last_price AS lastPrice,last_purchase_date AS lastPurchaseDate,updated_at AS updatedAt "
      + "FROM minimum_stock ORDER BY category_name"
    ).all().map(function (row) {
      return {
        categoryKey: row.categoryKey,
        categoryName: row.categoryName,
        minimum: Number(row.minimum),
        monitored: Boolean(row.monitored),
        productUrl: row.productUrl || "",
        productModel: row.productModel || "",
        manufacturer: row.manufacturer || "",
        preferredSupplier: row.preferredSupplier || "",
        lastPrice: Number(row.lastPrice) || 0,
        lastPurchaseDate: row.lastPurchaseDate || "",
        updatedAt: row.updatedAt
      };
    });
  }

  function saveMinimums(items, userId) {
    const upsert = database.prepare(
      "INSERT INTO minimum_stock (category_key,category_name,minimum,monitored,product_url,product_model,manufacturer,"
      + "preferred_supplier,last_price,last_purchase_date,updated_by,updated_at) "
      + "VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(category_key) DO UPDATE SET "
      + "category_name=excluded.category_name,minimum=excluded.minimum,monitored=excluded.monitored,"
      + "product_url=excluded.product_url,product_model=excluded.product_model,"
      + "manufacturer=excluded.manufacturer,preferred_supplier=excluded.preferred_supplier,"
      + "last_price=excluded.last_price,last_purchase_date=excluded.last_purchase_date,"
      + "updated_by=excluded.updated_by,updated_at=excluded.updated_at"
    );
    database.exec("BEGIN");
    try {
      items.forEach(function (item) {
        const name = String(item.categoryName || "").trim();
        const key = normalizeCategory(item.categoryKey || name);
        const minimum = Math.max(0, Number.parseInt(item.minimum, 10) || 0);
        const monitored = item.monitored ? 1 : 0;
        const productUrl = normalizeProductUrl(item.productUrl);
        const productModel = safeText(item.productModel, 200);
        const manufacturer = safeText(item.manufacturer, 160);
        const preferredSupplier = safeText(item.preferredSupplier, 200);
        const lastPrice = Math.max(0, Number(item.lastPrice) || 0);
        const lastPurchaseDate = normalizeDate(item.lastPurchaseDate);
        if (name && key) upsert.run(key, name, minimum, monitored, productUrl, productModel,
          manufacturer, preferredSupplier, lastPrice, lastPurchaseDate, userId, nowIso());
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    addAudit(userId,"update","minimum_stock","",items.length+" regras de estoque atualizadas");
    return getMinimums();
  }

  function getRestockRequests() {
    const requests = database.prepare(
      "SELECT requests.id,requests.workflow_status AS status,requests.notes,requests.sc_number AS scNumber,"
      + "requests.opened_at AS openedAt,requests.buyer,requests.expected_at AS expectedAt,requests.created_at AS createdAt,"
      + "requests.updated_at AS updatedAt,creator.username AS createdBy,editor.username AS updatedBy "
      + "FROM restock_requests requests "
      + "JOIN users creator ON creator.id=requests.created_by "
      + "JOIN users editor ON editor.id=requests.updated_by "
      + "ORDER BY requests.id DESC LIMIT 100"
    ).all().map(function (row) {
      return {
        id: Number(row.id),
        status: row.status,
        notes: row.notes,
        scNumber: row.scNumber || "",
        openedAt: row.openedAt || "",
        buyer: row.buyer || "",
        expectedAt: row.expectedAt || "",
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        items: [],
        history: []
      };
    });
    const byId = new Map(requests.map(function (request) {
      return [request.id, request];
    }));
    if (!requests.length) return requests;
    const ids = requests.map(function (request) { return request.id; });
    const placeholders = ids.map(function () { return "?"; }).join(",");
    database.prepare(
      "SELECT request_id AS requestId,category_key AS categoryKey,category_name AS categoryName,"
      + "current_stock AS currentStock,minimum_stock AS minimumStock,quantity,"
      + "received_quantity AS receivedQuantity,product_url AS productUrl,product_model AS productModel,"
      + "manufacturer,supplier,unit_price AS unitPrice,last_purchase_date AS lastPurchaseDate "
      + "FROM restock_request_items WHERE request_id IN (" + placeholders + ") ORDER BY id"
    ).all(...ids).forEach(function (item) {
      const request = byId.get(Number(item.requestId));
      if (request) request.items.push({
        categoryKey: item.categoryKey,
        categoryName: item.categoryName,
        currentStock: Number(item.currentStock),
        minimumStock: Number(item.minimumStock),
        quantity: Number(item.quantity),
        receivedQuantity: Math.min(Number(item.quantity), Math.max(0, Number(item.receivedQuantity) || 0)),
        productUrl: item.productUrl || "",
        productModel: item.productModel || "",
        manufacturer: item.manufacturer || "",
        supplier: item.supplier || "",
        unitPrice: Number(item.unitPrice) || 0,
        lastPurchaseDate: item.lastPurchaseDate || ""
      });
    });
    database.prepare(
      "SELECT events.request_id AS requestId,events.status,events.notes,"
      + "events.changed_at AS changedAt,users.username AS changedBy "
      + "FROM restock_request_events events JOIN users ON users.id=events.changed_by "
      + "WHERE events.request_id IN (" + placeholders + ") ORDER BY events.id DESC"
    ).all(...ids).forEach(function (event) {
      const request = byId.get(Number(event.requestId));
      if (request) request.history.push({
        status: event.status,
        notes: event.notes,
        changedAt: event.changedAt,
        changedBy: event.changedBy
      });
    });
    return requests;
  }

  function createRestockRequest(items, notes, userId) {
    const validItems = (Array.isArray(items) ? items : []).slice(0, 200).map(function (item) {
      const categoryName = String(item.categoryName || "").trim().slice(0, 160);
      return {
        categoryKey: normalizeCategory(item.categoryKey || categoryName),
        categoryName: categoryName,
        currentStock: Math.max(0, Number.parseInt(item.currentStock, 10) || 0),
        minimumStock: Math.max(0, Number.parseInt(item.minimumStock, 10) || 0),
        quantity: Math.max(0, Number.parseInt(item.quantity, 10) || 0),
        productUrl: normalizeProductUrl(item.productUrl),
        productModel: safeText(item.productModel, 200),
        manufacturer: safeText(item.manufacturer, 160),
        supplier: safeText(item.supplier, 200),
        unitPrice: Math.max(0, Number(item.unitPrice) || 0),
        lastPurchaseDate: normalizeDate(item.lastPurchaseDate)
      };
    }).filter(function (item) {
      return item.categoryKey && item.categoryName && item.quantity > 0;
    });
    if (!validItems.length) throw new Error("Inclua ao menos um item com quantidade maior que zero.");
    const safeNotes = String(notes || "").trim().slice(0, 2000);
    const timestamp = nowIso();
    database.exec("BEGIN");
    try {
      const result = database.prepare(
        "INSERT INTO restock_requests (status,workflow_status,notes,created_by,created_at,updated_by,updated_at) "
        + "VALUES ('pending','draft',?,?,?,?,?)"
      ).run(safeNotes, userId, timestamp, userId, timestamp);
      const requestId = Number(result.lastInsertRowid);
      const insertItem = database.prepare(
        "INSERT INTO restock_request_items "
        + "(request_id,category_key,category_name,current_stock,minimum_stock,quantity,received_quantity,"
        + "product_url,product_model,manufacturer,supplier,unit_price,last_purchase_date) "
        + "VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?)"
      );
      validItems.forEach(function (item) {
        insertItem.run(requestId, item.categoryKey, item.categoryName,
          item.currentStock, item.minimumStock, item.quantity, item.productUrl,
          item.productModel, item.manufacturer, item.supplier, item.unitPrice, item.lastPurchaseDate);
      });
      database.prepare(
        "INSERT INTO restock_request_events (request_id,status,notes,changed_by,changed_at) "
        + "VALUES (?,'pending',?,?,?)"
      ).run(requestId, "Solicitação criada.", userId, timestamp);
      database.exec("COMMIT");
      addAudit(userId,"create","restock_request",String(requestId),"Solicitação de reposição criada");
      return getRestockRequests().find(function (request) { return request.id === requestId; });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function updateRestockRequest(id, values, userId) {
    const existing = database.prepare("SELECT * FROM restock_requests WHERE id=?").get(id);
    if (!existing) return null;
    const allowedStatus = ["draft","awaiting_approval","approved","sc_open","purchasing","partial_received","finished"];
    const currentWorkflow = existing.workflow_status || "draft";
    const status = allowedStatus.includes(values.status) ? values.status : currentWorkflow;
    const legacyStatus = status === "finished" ? "received" : status === "purchasing" || status === "partial_received" ? "purchasing" : status === "sc_open" ? "requested" : "pending";
    const notes = typeof values.notes === "string"
      ? values.notes.trim().slice(0, 2000)
      : existing.notes;
    const scNumber = values.scNumber === undefined ? existing.sc_number : safeText(values.scNumber, 80);
    const openedAt = values.openedAt === undefined ? existing.opened_at : normalizeDate(values.openedAt);
    const buyer = values.buyer === undefined ? existing.buyer : safeText(values.buyer, 160);
    const expectedAt = values.expectedAt === undefined ? existing.expected_at : normalizeDate(values.expectedAt);
    const itemUpdates = (Array.isArray(values.items) ? values.items : []).slice(0, 200).map(function (item) {
      return {
        categoryKey: normalizeCategory(item.categoryKey || item.categoryName),
        productUrl: normalizeProductUrl(item.productUrl),
        receivedQuantity: Math.max(0, Number.parseInt(item.receivedQuantity, 10) || 0)
      };
    }).filter(function (item) { return item.categoryKey; });
    const timestamp = nowIso();
    database.exec("BEGIN");
    try {
      database.prepare(
        "UPDATE restock_requests SET status=?,workflow_status=?,notes=?,sc_number=?,opened_at=?,buyer=?,expected_at=?,"
        + "updated_by=?,updated_at=? WHERE id=?"
      ).run(legacyStatus, status, notes, scNumber, openedAt, buyer, expectedAt, userId, timestamp, id);
      const updateProduct = database.prepare(
        "UPDATE restock_request_items SET product_url=?,received_quantity=MIN(quantity,?) "
        + "WHERE request_id=? AND category_key=?"
      );
      itemUpdates.forEach(function (item) {
        updateProduct.run(item.productUrl, item.receivedQuantity, id, item.categoryKey);
      });
      database.prepare(
        "INSERT INTO restock_request_events (request_id,status,notes,changed_by,changed_at) "
        + "VALUES (?,?,?,?,?)"
      ).run(id, status, notes, userId, timestamp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    addAudit(userId,"update","restock_request",String(id),"Solicitação de reposição atualizada");
    return getRestockRequests().find(function (request) { return request.id === id; });
  }

  function deleteRestockRequest(id) {
    const result = database.prepare(
      "DELETE FROM restock_requests WHERE id=?"
    ).run(id);
    return Number(result.changes) > 0;
  }

  function recordTonerSnapshot(report) {
    const insert=database.prepare("INSERT INTO toner_history (printer_ip,printer_model,supply_name,supply_color,level,status,recorded_at) VALUES (?,?,?,?,?,?,?)");
    const timestamp=report && report.updatedAt ? report.updatedAt : nowIso();
    database.exec("BEGIN");
    try {
      (report && Array.isArray(report.printers) ? report.printers : []).forEach(function(printer) {
        (Array.isArray(printer.supplies)?printer.supplies:[]).forEach(function(supply) {
          const level=Number(supply.percent ?? supply.level);
          if(Number.isFinite(level))insert.run(safeText(printer.ip,80),safeText(printer.model,160),safeText(supply.name||supply.description,160),safeText(supply.color,80),Math.max(0,Math.min(100,Math.round(level))),safeText(printer.status,60),timestamp);
        });
      });
      database.exec("DELETE FROM toner_history WHERE recorded_at < datetime('now','-400 days')");
      database.exec("COMMIT");
    } catch(error) { database.exec("ROLLBACK"); throw error; }
  }

  return {
    router: router,
    requireAuth: requireAuth,
    requireMaster: requireMaster,
    requireUpdatePermission: requireUpdatePermission,
    requirePermission: requirePermission,
    userPermissions: userPermissions,
    database: database,
    databasePath: databasePath,
    getMinimums: getMinimums,
    getSetting: getSetting,
    setSetting: setSetting,
    saveMinimums: saveMinimums,
    getPrinters: getPrinters,
    seedPrinters: seedPrinters,
    savePrinter: savePrinter,
    deletePrinter: deletePrinter,
    getRestockRequests: getRestockRequests,
    createRestockRequest: createRestockRequest,
    updateRestockRequest: updateRestockRequest,
    deleteRestockRequest: deleteRestockRequest,
    recordTonerSnapshot: recordTonerSnapshot,
    addAudit: addAudit,
    setupRequired: setupRequired
  };
}

module.exports = { createAuth };
