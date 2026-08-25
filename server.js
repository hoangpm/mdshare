// server.js
// Dich vu paste markdown toi gian: khong can auth
// Dung Turso (libSQL) lam noi luu tru thay vi SQLite file local,
// vi nhieu nen tang free (Render...) khong co persistent disk.
//
// POST /            -> body la noi dung markdown (text/plain hoac raw body)
//                       tra ve JSON { key, url, raw_url }
// GET  /p/:key       -> trang xem (escape HTML, khong render markdown)
// GET  /p/:key/raw   -> tra ve dung noi dung markdown goc (Content-Type: text/plain)

const express = require("express");
const { createClient } = require("@libsql/client");
const rateLimit = require("express-rate-limit");
const { customAlphabet } = require("nanoid");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 200 * 1024; // gioi han 200KB moi file
const KEY_LEN = 8;

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error(
    "Thieu bien moi truong TURSO_DATABASE_URL hoac TURSO_AUTH_TOKEN. " +
      "Xem README de biet cach tao database Turso mien phi."
  );
  process.exit(1);
}

const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN,
});

// Bang chu cai: chu thuong + so, giong vi du 88md3c3l
const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", KEY_LEN);

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS pastes (
      key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

const app = express();
app.disable("x-powered-by");

app.use(
  express.text({
    type: ["text/plain", "text/markdown", "application/octet-stream", "*/*"],
    limit: MAX_BYTES,
  })
);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Qua nhieu yeu cau, vui long thu lai sau." },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

async function keyExists(key) {
  const res = await db.execute({
    sql: "SELECT 1 FROM pastes WHERE key = ?",
    args: [key],
  });
  return res.rows.length > 0;
}

async function genUniqueKey() {
  let key;
  do {
    key = nanoid();
  } while (await keyExists(key));
  return key;
}

function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

// --- Tao paste moi ---
app.post("/", writeLimiter, async (req, res) => {
  try {
    const content = req.body;

    if (typeof content !== "string" || content.trim().length === 0) {
      return res.status(400).json({ error: "Noi dung markdown trong hoac khong hop le." });
    }
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
      return res.status(413).json({ error: `Noi dung vuot qua gioi han ${MAX_BYTES} bytes.` });
    }

    const key = await genUniqueKey();
    await db.execute({
      sql: "INSERT INTO pastes (key, content, created_at) VALUES (?, ?, ?)",
      args: [key, content, Date.now()],
    });

    const url = `${baseUrl(req)}/p/${key}`;
    const rawUrl = `${url}/raw`;
    res.status(201).json({ key, url, raw_url: rawUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Loi server noi bo." });
  }
});

// --- Lay noi dung raw ---
app.get("/p/:key/raw", readLimiter, async (req, res) => {
  try {
    const result = await db.execute({
      sql: "SELECT content FROM pastes WHERE key = ?",
      args: [req.params.key],
    });
    const row = result.rows[0];
    if (!row) return res.status(404).type("text/plain").send("Not found");

    res.type("text/plain; charset=utf-8").send(row.content);
  } catch (err) {
    console.error(err);
    res.status(500).type("text/plain").send("Loi server noi bo.");
  }
});

// --- Trang xem toi gian (khong render HTML tu markdown de tranh XSS) ---
app.get("/p/:key", readLimiter, async (req, res) => {
  try {
    const result = await db.execute({
      sql: "SELECT content FROM pastes WHERE key = ?",
      args: [req.params.key],
    });
    const row = result.rows[0];
    if (!row) return res.status(404).send("Not found");

    const escaped = row.content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    res.type("text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Paste ${req.params.key}</title>
<style>
  body { font-family: ui-monospace, monospace; max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; background: #f6f8fa; padding: 1rem; border-radius: 6px; }
  a { color: #0969da; }
</style>
</head>
<body>
  <p><a href="/p/${req.params.key}/raw">Xem raw text</a></p>
  <pre>${escaped}</pre>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Loi server noi bo.");
  }
});

app.get("/", (req, res) => {
  res.type("text/plain").send(
    "mdshare - dich vu chia se markdown\n\n" +
      "POST / (body la noi dung markdown) -> tra ve { key, url, raw_url }\n" +
      "GET /p/:key -> xem\n" +
      "GET /p/:key/raw -> raw text\n"
  );
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`mdshare dang chay tai http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Khong the khoi tao database:", err);
    process.exit(1);
  });
