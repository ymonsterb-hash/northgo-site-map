const ALLOWED_STATUSES = new Set(["new", "in_progress", "completed", "archived"]);
const MAX_BODY_BYTES = 20_000;
const SESSION_TTL_SECONDS = 8 * 60 * 60;

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
  return Boolean(adminUsername(env) && adminPassword(env) && sessionSecret(env));
}

async function issueToken(username, env) {
  const payload = toBase64Url(utf8(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })));
  return `${payload}.${await sign(payload, sessionSecret(env))}`;
}

async function verifyToken(request, env) {
  if (!authConfigured(env)) return null;
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!(await equalSignature(payload, signature, sessionSecret(env)))) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (!session.sub || session.sub !== adminUsername(env) || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
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
  if (!authConfigured(env)) {
    return json(request, env, { error: "管理登入尚未設定，請設定 Worker secrets。" }, 503);
  }
  const body = await readJson(request);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return json(request, env, { error: "請輸入帳號與密碼。" }, 400);
  }
  const username = adminUsername(env);
  const passwordMatch = constantTimeTextEqual(body.password, adminPassword(env));
  if (body.username !== username || !passwordMatch) {
    return json(request, env, { error: "帳號或密碼錯誤。" }, 401);
  }
  return json(request, env, { ok: true, username, token: await issueToken(username, env) });
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (path === "/health" && request.method === "GET") {
      try { await env.DB.prepare("SELECT 1").first(); return json(request, env, { ok: true, database: "connected" }); }
      catch { return json(request, env, { ok: false, database: "unavailable" }, 503); }
    }
    if (!path.startsWith("/api/")) return new Response("Not found", { status: 404 });
    if (!env.DB) return json(request, env, { error: "D1 尚未設定。" }, 503);
    if (path === "/api/inquiries/public" && request.method === "POST") {
      try { return await publicCreate(request, env); }
      catch { return json(request, env, { error: "儲存詢問時發生錯誤，請稍後再試。" }, 500); }
    }
    if (path === "/api/login" && request.method === "POST") return adminLogin(request, env);
    const session = await verifyToken(request, env);
    if (!session) return json(request, env, { error: "登入已逾時，請重新登入。" }, 401);
    if (path === "/api/me" && request.method === "GET") return json(request, env, { ok: true, username: session.sub });
    if (path === "/api/logout" && request.method === "POST") return json(request, env, { ok: true });
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
