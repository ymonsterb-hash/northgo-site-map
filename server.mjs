import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "./lib/db.mjs";
import adminHtml from "./lib/admin-html.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
// Auth + CORS come only from env / Cursor app secrets (no shipped defaults).
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 20_000;
const ALLOWED_STATUSES = new Set(["new", "in_progress", "completed", "archived"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function originAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Local browser / smoke tests only (never a production allowlist).
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(origin)) return true;
  return false;
}

function authConfigured() {
  return Boolean(ADMIN_USERNAME && ADMIN_PASSWORD && SESSION_SECRET);
}

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  };
  if (originAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
  }
  return headers;
}

function sendJson(req, res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function issueToken(username) {
  const payload = toBase64Url(JSON.stringify({
    sub: username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  }));
  return `${payload}.${sign(payload, SESSION_SECRET)}`;
}

function safeEqualText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function verifyToken(req) {
  if (!authConfigured()) return null;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return null;
  if (!safeEqualText(sign(payload, SESSION_SECRET), signature)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.sub || session.sub !== ADMIN_USERNAME || session.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
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
  const limits = { first_name: 80, last_name: 80, company: 160, email: 254, phone: 60 };
  for (const field of Object.keys(limits)) {
    if (!validText(input[field], limits[field])) return null;
  }
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return null;
  const services = Array.isArray(input.services)
    ? [...new Set(input.services.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean))].slice(0, 10)
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

function safeParseServices(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapRow(row) {
  return {
    ...row,
    services: safeParseServices(row.services),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function routeId(pathname) {
  const match = pathname.match(/^\/api\/inquiries\/(\d+)$/u);
  return match ? Number(match[1]) : null;
}

async function publicCreate(req, res) {
  const body = await readJson(req);
  if (!body) return sendJson(req, res, { error: "請提供有效的 JSON 詢問資料。" }, 400);
  if (typeof body.website === "string" && body.website.trim()) {
    return sendJson(req, res, { ok: true, message: "詢問已送出。" }, 201);
  }
  const inquiry = cleanInquiry(body);
  if (!inquiry) {
    return sendJson(req, res, { error: "必填資料格式不正確，請檢查姓名、公司、Email 與電話。" }, 400);
  }
  const rows = await sql(
    `INSERT INTO inquiries (first_name, last_name, company, email, phone, country, services, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
      inquiry.country, inquiry.services, inquiry.message]
  );
  return sendJson(req, res, { ok: true, id: rows[0].id, message: "詢問已送出。" }, 201);
}

async function adminLogin(req, res) {
  if (!authConfigured()) {
    return sendJson(req, res, { error: "管理登入尚未設定，請綁定 ADMIN_USERNAME / ADMIN_PASSWORD / SESSION_SECRET。" }, 503);
  }
  const body = await readJson(req);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return sendJson(req, res, { error: "請輸入帳號與密碼。" }, 400);
  }
  if (body.username !== ADMIN_USERNAME || !safeEqualText(body.password, ADMIN_PASSWORD)) {
    return sendJson(req, res, { error: "帳號或密碼錯誤。" }, 401);
  }
  return sendJson(req, res, {
    ok: true,
    username: ADMIN_USERNAME,
    token: issueToken(ADMIN_USERNAME)
  });
}

async function listInquiries(req, res, url) {
  const status = url.searchParams.get("status") || "";
  const search = (url.searchParams.get("q") || "").trim().slice(0, 160);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "25", 10) || 25));
  const offset = (page - 1) * limit;
  const where = [];
  const values = [];
  if (status && ALLOWED_STATUSES.has(status)) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (search) {
    const term = `%${search.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const start = values.length + 1;
    values.push(term, term, term, term, term);
    where.push(`(company ILIKE $${start} OR first_name ILIKE $${start + 1} OR last_name ILIKE $${start + 2} OR email ILIKE $${start + 3} OR phone ILIKE $${start + 4})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const listValues = [...values, limit, offset];
  const [rows, countRows, countGroups] = await Promise.all([
    sql(
      `SELECT * FROM inquiries ${clause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      listValues
    ),
    sql(`SELECT COUNT(*)::int AS total FROM inquiries ${clause}`, values),
    sql("SELECT status, COUNT(*)::int AS total FROM inquiries GROUP BY status")
  ]);
  return sendJson(req, res, {
    items: rows.map(mapRow),
    total: countRows[0]?.total || 0,
    page,
    limit,
    counts: Object.fromEntries(countGroups.map((row) => [row.status, row.total]))
  });
}

async function adminCreate(req, res) {
  const body = await readJson(req);
  const inquiry = cleanInquiry(body);
  if (!inquiry) return sendJson(req, res, { error: "請檢查必填欄位與 Email 格式。" }, 400);
  const status = ALLOWED_STATUSES.has(body?.status) ? body.status : "new";
  const rows = await sql(
    `INSERT INTO inquiries (first_name, last_name, company, email, phone, country, services, message, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
      inquiry.country, inquiry.services, inquiry.message, status]
  );
  return sendJson(req, res, { ok: true, id: rows[0].id }, 201);
}

async function updateInquiry(req, res, id) {
  const body = await readJson(req);
  if (!body) return sendJson(req, res, { error: "請提供有效的 JSON 資料。" }, 400);
  const existingRows = await sql("SELECT * FROM inquiries WHERE id = $1", [id]);
  const existing = existingRows[0];
  if (!existing) return sendJson(req, res, { error: "找不到這筆詢問。" }, 404);
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
  if (!inquiry) return sendJson(req, res, { error: "請檢查必填欄位與 Email 格式。" }, 400);
  const status = body.status === undefined ? existing.status : body.status;
  if (!ALLOWED_STATUSES.has(status)) return sendJson(req, res, { error: "詢問狀態不正確。" }, 400);
  await sql(
    `UPDATE inquiries SET first_name = $1, last_name = $2, company = $3, email = $4, phone = $5, country = $6,
     services = $7, message = $8, status = $9, updated_at = NOW() WHERE id = $10`,
    [inquiry.first_name, inquiry.last_name, inquiry.company, inquiry.email, inquiry.phone,
      inquiry.country, inquiry.services, inquiry.message, status, id]
  );
  return sendJson(req, res, { ok: true });
}

const STATIC_ROOTS = [
  __dirname,
  process.cwd()
];

async function readStaticFile(relative) {
  for (const root of STATIC_ROOTS) {
    const resolvedRoot = path.resolve(root);
    const filePath = path.resolve(resolvedRoot, relative);
    const rel = path.relative(resolvedRoot, filePath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    try {
      return { data: await readFile(filePath), filePath };
    } catch {
      // try next root
    }
  }
  return null;
}

function sendHtml(req, res, html) {
  const body = Buffer.from(html, "utf8");
  res.writeHead(200, {
    ...corsHeaders(req),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  // Bundled admin page — survives Cursor hosts that omit loose HTML files.
  if (pathname === "/admin.html" || pathname === "/admin") {
    return sendHtml(req, res, adminHtml);
  }
  if (pathname === "/api-config.js") {
    const body = Buffer.from('window.NORTHGO_API_BASE="";\n', "utf8");
    res.writeHead(200, {
      ...corsHeaders(req),
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": body.byteLength
    });
    return res.end(body);
  }
  let relative = pathname === "/" ? "/index.html" : pathname;
  relative = decodeURIComponent(relative).replace(/^\/+/u, "");
  if (!relative || relative.includes("..") || path.isAbsolute(relative)) {
    res.writeHead(400, corsHeaders(req));
    return res.end("Bad path");
  }
  const found = await readStaticFile(relative);
  if (!found) {
    res.writeHead(404, { ...corsHeaders(req), "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const ext = path.extname(found.filePath).toLowerCase();
  res.writeHead(200, {
    ...corsHeaders(req),
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" || ext === ".js" ? "no-store" : "public, max-age=3600"
  });
  res.end(found.data);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (pathname === "/health" && req.method === "GET") {
    try {
      await sql("SELECT 1 AS ok");
      return sendJson(req, res, { ok: true, database: "connected" });
    } catch {
      return sendJson(req, res, { ok: false, database: "unavailable" }, 503);
    }
  }
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/inquiries/public" && req.method === "POST") {
    try {
      await publicCreate(req, res);
    } catch {
      sendJson(req, res, { error: "儲存詢問時發生錯誤，請稍後再試。" }, 500);
    }
    return true;
  }
  if (pathname === "/api/login" && req.method === "POST") {
    await adminLogin(req, res);
    return true;
  }
  const session = verifyToken(req);
  if (!session) {
    sendJson(req, res, { error: "登入已逾時，請重新登入。" }, 401);
    return true;
  }
  if (pathname === "/api/me" && req.method === "GET") {
    sendJson(req, res, { ok: true, username: session.sub });
    return true;
  }
  if (pathname === "/api/logout" && req.method === "POST") {
    sendJson(req, res, { ok: true });
    return true;
  }
  if (pathname === "/api/inquiries" && req.method === "GET") {
    try {
      await listInquiries(req, res, url);
    } catch {
      sendJson(req, res, { error: "讀取詢問資料失敗。" }, 500);
    }
    return true;
  }
  if (pathname === "/api/inquiries" && req.method === "POST") {
    try {
      await adminCreate(req, res);
    } catch {
      sendJson(req, res, { error: "新增詢問失敗。" }, 500);
    }
    return true;
  }
  const id = routeId(pathname);
  if (id && req.method === "GET") {
    const rows = await sql("SELECT * FROM inquiries WHERE id = $1", [id]);
    if (!rows[0]) return sendJson(req, res, { error: "找不到這筆詢問。" }, 404), true;
    sendJson(req, res, mapRow(rows[0]));
    return true;
  }
  if (id && req.method === "PATCH") {
    try {
      await updateInquiry(req, res, id);
    } catch {
      sendJson(req, res, { error: "更新詢問失敗。" }, 500);
    }
    return true;
  }
  if (id && req.method === "DELETE") {
    const rows = await sql("DELETE FROM inquiries WHERE id = $1 RETURNING id", [id]);
    if (!rows[0]) return sendJson(req, res, { error: "找不到這筆詢問。" }, 404), true;
    sendJson(req, res, { ok: true });
    return true;
  }
  sendJson(req, res, { error: "找不到 API 路徑。" }, 404);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (await handleApi(req, res, url)) return;
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(req, res, { error: "伺服器錯誤。" }, 500);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NorthGo inquiry API listening on http://127.0.0.1:${PORT}`);
});
