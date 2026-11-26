const ALLOWED_STATUSES = new Set(["new", "in_progress", "completed", "archived"]);
const ALLOWED_ROLES = new Set(["owner", "editor"]);
const MAX_BODY_BYTES = 20_000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const PBKDF2_ITERATIONS = 100_000;

/** Best-effort per-isolate rate buckets (not shared across isolates). */
const rateBuckets = new Map();
/** Revoked bearer signatures → expiry unix seconds. */
const revokedTokenSigs = new Map();

function clientKey(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function rateLimited(bucket, key, limit, windowMs) {
  const now = Date.now();
  const mapKey = `${bucket}:${key}`;
  let stamps = rateBuckets.get(mapKey);
  if (!stamps) {
    stamps = [];
    rateBuckets.set(mapKey, stamps);
  }
  const cutoff = now - windowMs;
  while (stamps.length && stamps[0] < cutoff) stamps.shift();
  if (stamps.length >= limit) return true;
  stamps.push(now);
  return false;
}

function pruneRevokedTokens(nowSec = Math.floor(Date.now() / 1000)) {
  for (const [sig, exp] of revokedTokenSigs) {
    if (exp <= nowSec) revokedTokenSigs.delete(sig);
  }
}

function revokeBearer(request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    const exp = Number(session.exp) || Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    revokedTokenSigs.set(signature, exp);
    pruneRevokedTokens();
  } catch {
    revokedTokenSigs.set(signature, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS);
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGIN || env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const headers = new Headers({
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  });
  if (origin && allowed.includes(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function json(request, env, data, status = 200, extra = {}) {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function utf8(value) {
  return new TextEncoder().encode(value);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(value))));
}

async function equalSignature(value, supplied, secret) {
  const expected = await sign(value, secret);
  const left = utf8(expected);
  const right = utf8(supplied);
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

function constantTimeTextEqual(leftValue, rightValue) {
  const left = utf8(leftValue);
  const right = utf8(rightValue);
  let difference = left.length ^ right.length;
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) difference |= (left[i] || 0) ^ (right[i] || 0);
  return difference === 0;
}

function adminUsername(env) {
  return String(env.ADMIN_USERNAME || "").trim();
}

function adminPassword(env) {
  return String(env.ADMIN_PASSWORD || "");
}

function sessionSecret(env) {
  return String(env.SESSION_SECRET || "");
}

function authConfigured(env) {
  return Boolean(sessionSecret(env));
}

async function derivePasswordBits(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePasswordBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(derived)}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !stored.startsWith("pbkdf2$")) {
    return constantTimeTextEqual(password, String(stored || ""));
  }
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const actual = await derivePasswordBits(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
  return difference === 0;
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    display_name: row.display_name || row.username,
    role: row.role,
    disabled: Boolean(Number(row.disabled)),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function ensureAdminUsersSchema(env) {
  if (!env.DB || ensureAdminUsersSchema.ready) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_admin_users_role ON admin_users(role)"
  ).run();
  ensureAdminUsersSchema.ready = true;
}

async function ensureBootstrapOwner(env) {
  if (!env.DB) return null;
  await ensureAdminUsersSchema(env);
  const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM admin_users").first();
  if (Number(count?.total || 0) > 0) return null;
  const username = adminUsername(env);
  const password = adminPassword(env);
  if (!username || !password) return null;
  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO admin_users (username, password_hash, display_name, role)
     VALUES (?, ?, ?, 'owner')`
  ).bind(username, passwordHash, username).run();
  return {
    id: result.meta.last_row_id,
    username,
    display_name: username,
    role: "owner",
    disabled: 0
  };
}

async function findUserByUsername(env, username) {
  return env.DB.prepare(
    "SELECT * FROM admin_users WHERE username = ? COLLATE NOCASE LIMIT 1"
  ).bind(String(username || "").trim()).first();
}

async function findUserById(env, id) {
  return env.DB.prepare("SELECT * FROM admin_users WHERE id = ?").bind(id).first();
}

async function issueToken(user, env) {
  const payload = toBase64Url(utf8(JSON.stringify({
    sub: user.username,
    uid: Number(user.id),
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })));
  return `${payload}.${await sign(payload, sessionSecret(env))}`;
}

async function verifyToken(request, env) {
  if (!authConfigured(env) || !env.DB) return null;
  await ensureAdminUsersSchema(env);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!(await equalSignature(payload, signature, sessionSecret(env)))) return null;
  pruneRevokedTokens();
  if (revokedTokenSigs.has(signature)) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!session.sub || !session.uid || session.exp < Math.floor(Date.now() / 1000)) return null;
    const user = await findUserById(env, Number(session.uid));
    if (!user || Number(user.disabled)) return null;
    if (String(user.username).toLowerCase() !== String(session.sub).toLowerCase()) return null;
    return {
      sub: user.username,
      uid: Number(user.id),
      role: user.role,
      display_name: user.display_name || user.username,
      exp: session.exp
    };
  } catch {
    return null;
  }
}

function validText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function cleanInquiry(input) {
  if (!input || typeof input !== "object") return null;
  const fields = ["first_name", "last_name", "company", "email", "phone"];
  const limits = { first_name: 80, last_name: 80, company: 160, email: 254, phone: 60 };
  for (const field of fields) if (!validText(input[field], limits[field])) return null;
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  const services = Array.isArray(input.services)
    ? [...new Set(input.services.filter(value => typeof value === "string").map(value => value.trim()).filter(Boolean))].slice(0, 10)
    : [];
  return {
    first_name: input.first_name.trim(),
    last_name: input.last_name.trim(),
    company: input.company.trim(),
    email,
    phone: input.phone.trim(),
    country: typeof input.country === "string" ? input.country.trim().slice(0, 100) : "",
    services: JSON.stringify(services),
    message: typeof input.message === "string" ? input.message.trim().slice(0, 4000) : ""
  };
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) return null;
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function routeId(pathname) {
  const match = pathname.match(/^\/api\/inquiries\/(\d+)$/u);
  return match ? Number(match[1]) : null;
}

function routeUserId(pathname) {
  const match = pathname.match(/^\/api\/users\/(\d+)$/u);
  return match ? Number(match[1]) : null;
}

async function publicCreate(request, env) {
  const body = await readJson(request);
  if (!body) return json(request, env, { error: "請提供有效的 JSON 詢問資料。" }, 400);
  if (typeof body.website === "string" && body.website.trim()) {
    return json(request, env, { ok: true, message: "詢問已送出。" }, 201);
  }
  const inquiry = cleanInquiry(body);
  if (!inquiry) return json(request, env, { error: "必填資料格式不正確，請檢查姓名、公司、Email 與電話。" }, 400);
  const result = await env.DB.prepare(
    `INSERT INTO inquiries (first_name, last_name, company, email, phone, country, services, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
    inquiry.country, inquiry.services, inquiry.message).run();
  return json(request, env, { ok: true, id: result.meta.last_row_id, message: "詢問已送出。" }, 201);
}

async function adminLogin(request, env) {
  if (!authConfigured(env) || !env.DB) {
    return json(request, env, { error: "管理登入尚未設定，請設定 Worker secrets 與 D1。" }, 503);
  }
  await ensureBootstrapOwner(env);
  const body = await readJson(request);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return json(request, env, { error: "請輸入帳號與密碼。" }, 400);
  }
  const username = body.username.trim();
  const user = await findUserByUsername(env, username);
  if (!user || Number(user.disabled) || !(await verifyPassword(body.password, user.password_hash))) {
    return json(request, env, { error: "帳號或密碼錯誤。" }, 401);
  }
  return json(request, env, {
    ok: true,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role,
    token: await issueToken(user, env)
  });
}

async function listInquiries(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const search = (url.searchParams.get("q") || "").trim().slice(0, 160);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const offset = (page - 1) * limit;
  const where = [];
  const values = [];
  if (status && ALLOWED_STATUSES.has(status)) { where.push("status = ?"); values.push(status); }
  if (search) {
    where.push("(company LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)");
    const term = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    values.push(term, term, term, term, term);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count, counts] = await Promise.all([
    env.DB.prepare(`SELECT * FROM inquiries ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(...values, limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM inquiries ${clause}`).bind(...values).first(),
    env.DB.prepare("SELECT status, COUNT(*) AS total FROM inquiries GROUP BY status").all()
  ]);
  return json(request, env, {
    items: (rows.results || []).map(row => ({ ...row, services: safeParseServices(row.services) })),
    total: count?.total || 0,
    page,
    limit,
    counts: Object.fromEntries((counts.results || []).map(row => [row.status, row.total]))
  });
}

function safeParseServices(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

async function adminCreate(request, env) {
  const body = await readJson(request);
  const inquiry = cleanInquiry(body);
  if (!inquiry) return json(request, env, { error: "請檢查必填欄位與 Email 格式。" }, 400);
  const status = ALLOWED_STATUSES.has(body.status) ? body.status : "new";
  const result = await env.DB.prepare(
    `INSERT INTO inquiries (first_name, last_name, company, email, phone, country, services, message, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
    inquiry.country, inquiry.services, inquiry.message, status).run();
  return json(request, env, { ok: true, id: result.meta.last_row_id }, 201);
}

async function updateInquiry(request, env, id) {
  const body = await readJson(request);
  if (!body) return json(request, env, { error: "請提供有效的 JSON 資料。" }, 400);
  const existing = await env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first();
  if (!existing) return json(request, env, { error: "找不到這筆詢問。" }, 404);
  const merged = {
    first_name: body.first_name ?? existing.first_name,
    last_name: body.last_name ?? existing.last_name,
    company: body.company ?? existing.company,
    email: body.email ?? existing.email,
    phone: body.phone ?? existing.phone,
    country: body.country ?? existing.country,
    services: body.services ?? safeParseServices(existing.services),
    message: body.message ?? existing.message
  };
  const inquiry = cleanInquiry(merged);
  if (!inquiry) return json(request, env, { error: "請檢查必填欄位與 Email 格式。" }, 400);
  const status = body.status === undefined ? existing.status : body.status;
  if (!ALLOWED_STATUSES.has(status)) return json(request, env, { error: "詢問狀態不正確。" }, 400);
  await env.DB.prepare(
    `UPDATE inquiries SET first_name = ?, last_name = ?, company = ?, email = ?, phone = ?, country = ?,
     services = ?, message = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  ).bind(inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
    inquiry.country, inquiry.services, inquiry.message, status, id).run();
  return json(request, env, { ok: true });
}

async function listUsers(request, env, session) {
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") || "").trim().slice(0, 80);
  let rows;
  if (search) {
    const term = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    rows = await env.DB.prepare(
      `SELECT id, username, display_name, role, disabled, created_at, updated_at
       FROM admin_users
       WHERE username LIKE ? OR display_name LIKE ?
       ORDER BY role ASC, username ASC`
    ).bind(term, term).all();
  } else {
    rows = await env.DB.prepare(
      `SELECT id, username, display_name, role, disabled, created_at, updated_at
       FROM admin_users ORDER BY role ASC, username ASC`
    ).all();
  }
  const items = (rows.results || []).map(publicUser);
  return json(request, env, {
    items,
    me: {
      id: session.uid,
      username: session.sub,
      display_name: session.display_name,
      role: session.role
    },
    counts: {
      total: items.length,
      owners: items.filter((item) => item.role === "owner").length,
      editors: items.filter((item) => item.role === "editor").length,
      disabled: items.filter((item) => item.disabled).length
    }
  });
}

async function createUser(request, env, session) {
  if (session.role !== "owner") {
    return json(request, env, { error: "僅擁有者可新增成員。" }, 403);
  }
  const body = await readJson(request);
  if (!body) return json(request, env, { error: "請提供有效的 JSON 資料。" }, 400);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 80) : username;
  const role = body.role === "owner" ? "owner" : "editor";
  if (!/^[A-Za-z0-9._-]{3,40}$/u.test(username)) {
    return json(request, env, { error: "帳號需為 3–40 字元，僅英數、點、底線或連字號。" }, 400);
  }
  if (password.length < 8 || password.length > 120) {
    return json(request, env, { error: "密碼長度需為 8–120 字元。" }, 400);
  }
  if (!ALLOWED_ROLES.has(role)) {
    return json(request, env, { error: "角色不正確。" }, 400);
  }
  const existing = await findUserByUsername(env, username);
  if (existing) return json(request, env, { error: "此帳號已存在。" }, 409);
  const passwordHash = await hashPassword(password);
  const result = await env.DB.prepare(
    `INSERT INTO admin_users (username, password_hash, display_name, role)
     VALUES (?, ?, ?, ?)`
  ).bind(username, passwordHash, displayName || username, role).run();
  const created = await findUserById(env, result.meta.last_row_id);
  return json(request, env, { ok: true, user: publicUser(created) }, 201);
}

async function updateUser(request, env, session, id) {
  const body = await readJson(request);
  if (!body) return json(request, env, { error: "請提供有效的 JSON 資料。" }, 400);
  const target = await findUserById(env, id);
  if (!target) return json(request, env, { error: "找不到此帳號。" }, 404);
  const isSelf = Number(session.uid) === Number(id);
  const isOwner = session.role === "owner";
  if (!isOwner && !isSelf) {
    return json(request, env, { error: "權限不足。" }, 403);
  }

  let displayName = target.display_name;
  let role = target.role;
  let disabled = Number(target.disabled);
  let passwordHash = target.password_hash;

  if (typeof body.display_name === "string") {
    displayName = body.display_name.trim().slice(0, 80) || target.username;
  }
  if (typeof body.password === "string" && body.password.length) {
    if (body.password.length < 8 || body.password.length > 120) {
      return json(request, env, { error: "密碼長度需為 8–120 字元。" }, 400);
    }
    passwordHash = await hashPassword(body.password);
  }
  if (body.role !== undefined) {
    if (!isOwner) return json(request, env, { error: "僅擁有者可變更角色。" }, 403);
    if (!ALLOWED_ROLES.has(body.role)) return json(request, env, { error: "角色不正確。" }, 400);
    if (isSelf && body.role !== "owner") {
      const owners = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM admin_users WHERE role = 'owner' AND disabled = 0"
      ).first();
      if (Number(owners?.total || 0) <= 1) {
        return json(request, env, { error: "至少需保留一位啟用中的擁有者。" }, 400);
      }
    }
    role = body.role;
  }
  if (body.disabled !== undefined) {
    if (!isOwner) return json(request, env, { error: "僅擁有者可停用帳號。" }, 403);
    disabled = body.disabled ? 1 : 0;
    if (isSelf && disabled) {
      return json(request, env, { error: "無法停用自己的帳號。" }, 400);
    }
    if (target.role === "owner" && disabled) {
      const owners = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM admin_users WHERE role = 'owner' AND disabled = 0 AND id != ?"
      ).bind(id).first();
      if (Number(owners?.total || 0) < 1) {
        return json(request, env, { error: "至少需保留一位啟用中的擁有者。" }, 400);
      }
    }
  }

  await env.DB.prepare(
    `UPDATE admin_users
     SET display_name = ?, role = ?, disabled = ?, password_hash = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`
  ).bind(displayName, role, disabled, passwordHash, id).run();
  const updated = await findUserById(env, id);
  return json(request, env, { ok: true, user: publicUser(updated) });
}

async function deleteUser(request, env, session, id) {
  if (session.role !== "owner") {
    return json(request, env, { error: "僅擁有者可刪除成員。" }, 403);
  }
  if (Number(session.uid) === Number(id)) {
    return json(request, env, { error: "無法刪除自己的帳號。" }, 400);
  }
  const target = await findUserById(env, id);
  if (!target) return json(request, env, { error: "找不到此帳號。" }, 404);
  if (target.role === "owner") {
    const owners = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_users WHERE role = 'owner' AND disabled = 0 AND id != ?"
    ).bind(id).first();
    if (Number(owners?.total || 0) < 1) {
      return json(request, env, { error: "至少需保留一位啟用中的擁有者。" }, 400);
    }
  }
  const result = await env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return json(request, env, { error: "找不到此帳號。" }, 404);
  return json(request, env, { ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if ((path === "/" || path === "") && request.method === "GET") {
      const body = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>NorthGo Inquiry API</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:2rem;color:#13264b}code{background:#f4f7fa;padding:.1em .35em}</style></head>
<body><h1>NorthGo Inquiry API</h1>
<p>Cloudflare Worker + D1 已上線（支援多人後台帳號）。</p>
<ul>
<li>管理後台：<a href="https://ymonsterb-hash.github.io/northgo-site-map/admin.html">GitHub Pages admin</a></li>
<li>登入 API：<code>POST /api/login</code></li>
<li>帳號管理：<code>/api/users</code></li>
<li>公開詢問：<code>POST /api/inquiries/public</code></li>
</ul></body></html>`;
      const headers = corsHeaders(request, env);
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(body, { status: 200, headers });
    }
    if (!path.startsWith("/api/") && path !== "/health") return new Response("Not found", { status: 404 });
    if (!env.DB && path !== "/api/login" && path !== "/api/logout") {
      return json(request, env, { error: "D1 尚未設定。" }, 503);
    }
    if (path === "/api/inquiries/public" && request.method === "POST") {
      if (rateLimited("public-create", clientKey(request), 20, 15 * 60 * 1000)) {
        return json(request, env, { error: "送出太頻繁，請稍後再試。" }, 429);
      }
      try { return await publicCreate(request, env); }
      catch { return json(request, env, { error: "儲存詢問時發生錯誤，請稍後再試。" }, 500); }
    }
    if (path === "/api/login" && request.method === "POST") {
      if (rateLimited("login", clientKey(request), 10, 15 * 60 * 1000)) {
        return json(request, env, { error: "嘗試次數過多，請稍後再試。" }, 429);
      }
      return adminLogin(request, env);
    }
    const session = await verifyToken(request, env);
    if (!session) return json(request, env, { error: "登入已逾時，請重新登入。" }, 401);
    if (path === "/health" && request.method === "GET") {
      try { await env.DB.prepare("SELECT 1").first(); return json(request, env, { ok: true, database: "connected" }); }
      catch { return json(request, env, { ok: false, database: "unavailable" }, 503); }
    }
    if (path === "/api/me" && request.method === "GET") {
      return json(request, env, {
        ok: true,
        username: session.sub,
        display_name: session.display_name,
        role: session.role,
        id: session.uid
      });
    }
    if (path === "/api/logout" && request.method === "POST") {
      revokeBearer(request);
      return json(request, env, { ok: true });
    }
    if (path === "/api/users" && request.method === "GET") {
      try { return await listUsers(request, env, session); }
      catch { return json(request, env, { error: "讀取帳號列表失敗。" }, 500); }
    }
    if (path === "/api/users" && request.method === "POST") {
      try { return await createUser(request, env, session); }
      catch { return json(request, env, { error: "新增帳號失敗。" }, 500); }
    }
    const userId = routeUserId(path);
    if (userId && request.method === "PATCH") {
      try { return await updateUser(request, env, session, userId); }
      catch { return json(request, env, { error: "更新帳號失敗。" }, 500); }
    }
    if (userId && request.method === "DELETE") {
      try { return await deleteUser(request, env, session, userId); }
      catch { return json(request, env, { error: "刪除帳號失敗。" }, 500); }
    }
    if (path === "/api/inquiries" && request.method === "GET") {
      try { return await listInquiries(request, env); }
      catch { return json(request, env, { error: "讀取詢問資料失敗。" }, 500); }
    }
    if (path === "/api/inquiries" && request.method === "POST") {
      try { return await adminCreate(request, env); }
      catch { return json(request, env, { error: "新增詢問失敗。" }, 500); }
    }
    const id = routeId(path);
    if (id && request.method === "GET") {
      const row = await env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first();
      if (!row) return json(request, env, { error: "找不到這筆詢問。" }, 404);
      return json(request, env, { ...row, services: safeParseServices(row.services) });
    }
    if (id && request.method === "PATCH") {
      try { return await updateInquiry(request, env, id); }
      catch { return json(request, env, { error: "更新詢問失敗。" }, 500); }
    }
    if (id && request.method === "DELETE") {
      const result = await env.DB.prepare("DELETE FROM inquiries WHERE id = ?").bind(id).run();
      if (!result.meta.changes) return json(request, env, { error: "找不到這筆詢問。" }, 404);
      return json(request, env, { ok: true });
    }
    return json(request, env, { error: "找不到 API 路徑。" }, 404);
  }
};
