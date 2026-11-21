// Servidor del probador virtual: tienda, cuentas de clientes, pases de tiempo pagados,
// panel de administración y tokens temporales de Decart (la clave nunca llega al navegador).
// Sin dependencias: solo Node 18+.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(ROOT, "probador");
const DATA = path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const DB_FILE = path.join(DATA, "db.json");
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = "lucy-vton-3.6";
fs.mkdirSync(UPLOADS, { recursive: true });

/* ---------- base de datos en un archivo JSON ---------- */
function loadDb() {
  let db = {};
  try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
  db.admin ??= null;
  db.settings ??= {};
  db.settings.storeName ??= "lana/norte";
  db.settings.decartKey ??= readLegacyKey();
  db.settings.packages ??= [
    { id: "p050", price: 0.5, seconds: 15 },
    { id: "p100", price: 1, seconds: 35 },
  ];
  db.settings.whatsapp ??= "";
  db.settings.bank ??= { bank: "", type: "", number: "", holder: "", idNumber: "" };
  db.users ??= [];
  db.requests ??= [];
  db.sessions ??= {};
  if (!db.products) {
    try { db.products = JSON.parse(fs.readFileSync(path.join(STATIC, "products.seed.json"), "utf8")); }
    catch { db.products = []; }
  }
  return db;
}
function readLegacyKey() {
  try { const m = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DECART_API_KEY=(.+)$/m); return m ? m[1].trim() : ""; }
  catch { return ""; }
}
const db = loadDb();
function save() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}
save();

/* ---------- utilidades ---------- */
const id = (n = 12) => crypto.randomBytes(n).toString("hex");
const now = () => Date.now();
const emailOk = e => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length < 200;
function hashPw(pw, salt = id(16)) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString("hex") };
}
function checkPw(pw, rec) {
  const h = crypto.scryptSync(String(pw), rec.salt, 64);
  const want = Buffer.from(rec.hash, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function newSession(res, kind, uid) {
  const token = id(24);
  db.sessions[token] = { kind, uid, exp: now() + 30 * 864e5 };
  save();
  res.setHeader("Set-Cookie", `${kind === "admin" ? "aid" : "sid"}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`);
}
function sessionOf(req, kind) {
  const t = cookies(req)[kind === "admin" ? "aid" : "sid"];
  const s = t && db.sessions[t];
  if (!s || s.kind !== kind || s.exp < now()) return null;
  return { token: t, ...s };
}
const currentUser = req => { const s = sessionOf(req, "user"); return s ? db.users.find(u => u.id === s.uid) : null; };
const isAdmin = req => !!(db.admin && sessionOf(req, "admin"));

// un pase empieza a correr cuando el cliente inicia su prueba (tiempo de reloj, controlado por el servidor)
const passLeft = p => p.startedAt ? Math.max(0, p.seconds - (now() - p.startedAt) / 1000) : p.seconds;
const userLeft = u => u.passes.reduce((a, p) => a + passLeft(p), 0);
function activePass(u) {
  return u.passes.find(p => p.startedAt && passLeft(p) >= 1) || u.passes.find(p => !p.startedAt);
}
const publicUser = u => u && ({ email: u.email, secondsLeft: Math.floor(userLeft(u)),
  running: !!u.passes.find(p => p.startedAt && passLeft(p) >= 1),
  pending: db.requests.filter(r => r.userId === u.id && r.status === "pending").map(r => ({ id: r.id, packageId: r.packageId, method: r.method, createdAt: r.createdAt })) });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req, limit = 12e6) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too_big")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { resolve({}); } });
});
async function decart(pathname, init = {}, key = db.settings.decartKey) {
  const r = await fetch("https://api.decart.ai" + pathname, { ...init, headers: { "x-api-key": key, "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, data };
}
function saveImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || "");
  if (!m) throw new Error("La foto debe ser PNG, JPG o WebP.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 8e6) throw new Error("La foto pesa más de 8 MB.");
  const name = `${id(8)}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return "uploads/" + name;
}
const money = n => Math.round(Number(n) * 100) / 100;

/* ---------- rutas ---------- */
const routes = {
  "GET /api/public": (req, res) => send(res, 200, {
    storeName: db.settings.storeName, products: db.products, packages: db.settings.packages,
    whatsapp: db.settings.whatsapp, bank: db.settings.bank, available: !!db.settings.decartKey, model: MODEL }),

  "GET /api/me": (req, res) => send(res, 200, { user: publicUser(currentUser(req)) }),

  "POST /api/register": async (req, res) => {
    const { email, password } = await readBody(req);
    const e = String(email || "").trim().toLowerCase();
    if (!emailOk(e)) return send(res, 400, { error: "Escribe un correo válido." });
    if (String(password || "").length < 6) return send(res, 400, { error: "La contraseña debe tener al menos 6 caracteres." });
    if (db.users.some(u => u.email === e)) return send(res, 400, { error: "Ese correo ya tiene cuenta. Inicia sesión." });
    const u = { id: id(), email: e, ...hashPw(password), createdAt: now(), passes: [] };
    db.users.push(u); save(); newSession(res, "user", u.id);
    send(res, 200, { user: publicUser(u) });
  },
  "POST /api/login": async (req, res) => {
    const { email, password } = await readBody(req);
    const u = db.users.find(x => x.email === String(email || "").trim().toLowerCase());
    if (!u || !checkPw(password, u)) return send(res, 400, { error: "Correo o contraseña incorrectos." });
    newSession(res, "user", u.id); send(res, 200, { user: publicUser(u) });
  },
  "POST /api/logout": (req, res) => {
    const s = sessionOf(req, "user"); if (s) { delete db.sessions[s.token]; save(); }
    res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); send(res, 200, { ok: true });
  },

  // el cliente avisa que pagó (o va a pagar por WhatsApp); el admin lo habilita
  "POST /api/requests": async (req, res) => {
    const u = currentUser(req); if (!u) return send(res, 401, { error: "Inicia sesión primero." });
    const { packageId, method } = await readBody(req);
    const pkg = db.settings.packages.find(p => p.id === packageId);
    if (!pkg) return send(res, 400, { error: "Elige un paquete." });
    if (!["transfer", "whatsapp"].includes(method)) return send(res, 400, { error: "Elige cómo vas a pagar." });
    if (db.requests.filter(r => r.userId === u.id && r.status === "pending").length >= 3) return send(res, 400, { error: "Ya tienes solicitudes pendientes. Espera a que las revisen." });
    const r = { id: id(6), userId: u.id, email: u.email, packageId: pkg.id, price: pkg.price, seconds: pkg.seconds, method, status: "pending", createdAt: now() };
    db.requests.push(r); save(); send(res, 200, { request: r, user: publicUser(u) });
  },

  "POST /api/realtime-token": async (req, res) => {
    const u = currentUser(req); if (!u) return send(res, 401, { error: "Inicia sesión para usar el probador." });
    if (!db.settings.decartKey) return send(res, 503, { error: "El probador no está disponible por ahora." });
    const p = activePass(u);
    if (!p || passLeft(p) < 10) return send(res, 402, { error: "No tienes tiempo disponible. Compra un pase." });
    if (!p.startedAt) { p.startedAt = now(); save(); }
    const left = Math.floor(passLeft(p));
    const r = await decart("/v1/client/tokens", { method: "POST", body: JSON.stringify({
      expiresIn: 60, allowedModels: [MODEL], constraints: { realtime: { maxSessionDuration: Math.max(10, left) } } }) });
    if (!r.ok) return send(res, 502, { error: "Decart no respondió. Intenta de nuevo.", detail: r.data });
    send(res, 200, { apiKey: r.data.apiKey, secondsLeft: left });
  },

  /* ----- administración ----- */
  "GET /api/admin/me": (req, res) => send(res, 200, { setup: !db.admin, admin: isAdmin(req) ? db.admin.email : null }),
  "POST /api/admin/setup": async (req, res) => {
    if (db.admin) return send(res, 400, { error: "El administrador ya existe." });
    const { email, password } = await readBody(req);
    const e = String(email || "").trim().toLowerCase();
    if (!emailOk(e)) return send(res, 400, { error: "Escribe un correo válido." });
    if (String(password || "").length < 8) return send(res, 400, { error: "Usa una contraseña de al menos 8 caracteres." });
    db.admin = { email: e, ...hashPw(password) }; save(); newSession(res, "admin", "admin");
    send(res, 200, { admin: e });
  },
  "POST /api/admin/login": async (req, res) => {
    const { email, password } = await readBody(req);
    if (!db.admin || db.admin.email !== String(email || "").trim().toLowerCase() || !checkPw(password, db.admin))
      return send(res, 400, { error: "Correo o contraseña incorrectos." });
    newSession(res, "admin", "admin"); send(res, 200, { admin: db.admin.email });
  },
  "POST /api/admin/logout": (req, res) => {
    const s = sessionOf(req, "admin"); if (s) { delete db.sessions[s.token]; save(); }
    res.setHeader("Set-Cookie", "aid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); send(res, 200, { ok: true });
  },
};
const adminRoutes = {
  "GET /api/admin/state": async (req, res) => {
    let credits = null;
    if (db.settings.decartKey) { try { const r = await decart("/v1/credits"); if (r.ok) credits = r.data; } catch {} }
    const { decartKey, ...settings } = db.settings;
    send(res, 200, {
      settings: { ...settings, decartConfigured: !!decartKey, decartKeyHint: decartKey ? decartKey.slice(0, 7) + "…" + decartKey.slice(-4) : "" },
      credits, products: db.products,
      requests: [...db.requests].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
      users: db.users.map(u => ({ id: u.id, email: u.email, createdAt: u.createdAt, secondsLeft: Math.floor(userLeft(u)),
        passes: u.passes.length, used: u.passes.filter(p => p.startedAt && passLeft(p) < 1).length })),
    });
  },
  "POST /api/admin/settings": async (req, res) => {
    const b = await readBody(req);
    if (Array.isArray(b.packages)) {
      const pk = b.packages.map(p => ({ id: p.id || "p" + id(3), price: money(p.price), seconds: Math.round(Number(p.seconds)) }))
        .filter(p => p.price > 0 && p.seconds >= 10 && p.seconds <= 3600);
      if (!pk.length) return send(res, 400, { error: "Deja al menos un paquete válido (mínimo 10 segundos)." });
      db.settings.packages = pk;
    }
    if (typeof b.whatsapp === "string") db.settings.whatsapp = b.whatsapp.replace(/[^\d]/g, "");
    if (b.bank && typeof b.bank === "object") for (const k of ["bank", "type", "number", "holder", "idNumber"]) db.settings.bank[k] = String(b.bank[k] || "").slice(0, 120);
    if (typeof b.storeName === "string" && b.storeName.trim()) db.settings.storeName = b.storeName.trim().slice(0, 40);
    save(); send(res, 200, { ok: true });
  },
  "POST /api/admin/key": async (req, res) => {
    const { key } = await readBody(req);
    if (!key || !/^\S{10,}$/.test(key)) return send(res, 400, { error: "La clave no tiene el formato esperado." });
    const check = await decart("/v1/credits", {}, key.trim());
    if (!check.ok) return send(res, 400, { error: "Decart rechazó la clave. Revisa que esté completa y no haya vencido." });
    db.settings.decartKey = key.trim(); save(); send(res, 200, { ok: true, credits: check.data });
  },
  "POST /api/admin/request": async (req, res) => {
    const { requestId, action } = await readBody(req);
    const r = db.requests.find(x => x.id === requestId);
    if (!r || r.status !== "pending") return send(res, 400, { error: "Esa solicitud ya no está pendiente." });
    const u = db.users.find(x => x.id === r.userId);
    if (action === "approve") {
      if (!u) return send(res, 400, { error: "El cliente ya no existe." });
      u.passes.push({ id: id(6), seconds: r.seconds, price: r.price, grantedAt: now(), startedAt: null, via: r.method });
      r.status = "approved";
    } else r.status = "rejected";
    r.reviewedAt = now(); save(); send(res, 200, { ok: true });
  },
  "POST /api/admin/grant": async (req, res) => {
    const { userId, packageId } = await readBody(req);
    const u = db.users.find(x => x.id === userId), pkg = db.settings.packages.find(p => p.id === packageId);
    if (!u || !pkg) return send(res, 400, { error: "Cliente o paquete no válido." });
    u.passes.push({ id: id(6), seconds: pkg.seconds, price: pkg.price, grantedAt: now(), startedAt: null, via: "manual" });
    save(); send(res, 200, { ok: true });
  },
  "POST /api/admin/product": async (req, res) => {
    const b = await readBody(req);
    let p = b.id ? db.products.find(x => x.id === b.id) : null;
    if (b.id && !p) return send(res, 404, { error: "Producto no encontrado." });
    if (!p) { if (!b.imageData) return send(res, 400, { error: "Sube una foto de la prenda." }); p = { id: id(5) }; db.products.push(p); }
    try { if (b.imageData) p.src = saveImage(b.imageData); } catch (e) { return send(res, 400, { error: e.message }); }
    p.part = b.part === "bottom" ? "bottom" : "top";
    p.name = String(b.name || "").trim().slice(0, 120) || "Prenda";
    p.short = String(b.short || "").trim().slice(0, 24) || p.name.split(" ")[0];
    p.cat = String(b.cat || "").trim().slice(0, 60);
    p.price = money(b.price || 0); p.old = b.old ? money(b.old) : null;
    p.desc = String(b.desc || "").trim().slice(0, 600);
    p.look = String(b.look || "").trim().slice(0, 500);
    save(); send(res, 200, { product: p });
  },
  "POST /api/admin/product-delete": async (req, res) => {
    const { id: pid } = await readBody(req);
    db.products = db.products.filter(p => p.id !== pid); save(); send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return await routes[key](req, res);
    if (adminRoutes[key]) { if (!isAdmin(req)) return send(res, 401, { error: "Inicia sesión como administrador." }); return await adminRoutes[key](req, res); }
    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Ruta no encontrada." });

    let p = decodeURIComponent(url.pathname);
    if (p === "/panel") p = "/panel.html";
    if (p.endsWith("/")) p += "index.html";
    const base = p.startsWith("/uploads/") ? DATA : STATIC;
    const file = path.normalize(path.join(base, p));
    if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("No encontrado"); }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(buf);
    });
  } catch (e) {
    send(res, e.message === "too_big" ? 413 : 500, { error: e.message === "too_big" ? "El archivo es demasiado grande." : "Error del servidor." });
    if (e.message !== "too_big") console.error(e);
  }
});
server.listen(PORT, HOST, () => console.log(`Tienda: http://localhost:${PORT}   Panel: http://localhost:${PORT}/panel`));
