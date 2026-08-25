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
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 200 * 1024; // gioi han 200KB moi file
const KEY_LEN = 8;
// URL cong khai cua chinh service nay, dung khi tool MCP tra ve link
// (khong co req.headers de tu suy ra host nhu route HTTP thuong).
// Uu tien RENDER_EXTERNAL_URL (Render tu dong cap cho moi web service),
// sau do moi den MDSHARE_PUBLIC_URL neu ban tu dat, cuoi cung la localhost.
const MDSHARE_PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.MDSHARE_PUBLIC_URL ||
  `http://localhost:${PORT}`;

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

// Gioi han JSON body cho /mcp phai lon hon MAX_BYTES, vi noi dung markdown
// duoc bao trong JSON-RPC envelope va cac ky tu dac biet (dau nhay, xuong dong)
// bi escape lam tang kich thuoc chuoi. Dat du du de khong bi tu choi oan truoc
// khi toi duoc buoc kiem tra MAX_BYTES cua rieng minh.
app.use("/mcp", express.json({ limit: "1mb" }));

const rawTextParser = express.text({
  type: ["text/plain", "text/markdown", "application/octet-stream", "*/*"],
  limit: MAX_BYTES,
});

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

// Rate limit rieng cho /mcp: endpoint nay xu ly ca ghi (publish_markdown) lan
// doc (fetch_markdown) qua cung 1 route, nen dung 1 muc gioi han vua phai
// thay vi tach writeLimiter/readLimiter nhu cac route HTTP thuong.
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Qua nhieu yeu cau, vui long thu lai sau." },
    id: null,
  },
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

// --- Logic dung chung: ca route HTTP thuong va tool MCP deu goi ham nay ---
// Tach rieng de tool MCP goi truc tiep ham noi bo, khong phai qua fetch() HTTP
// noi bo giua 2 service (tranh loi 502 do cold-start tren Render free tier).

async function publishMarkdown(content, siteBaseUrl) {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { error: "Noi dung markdown trong hoac khong hop le.", status: 400 };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    return { error: `Noi dung vuot qua gioi han ${MAX_BYTES} bytes.`, status: 413 };
  }

  const key = await genUniqueKey();
  await db.execute({
    sql: "INSERT INTO pastes (key, content, created_at) VALUES (?, ?, ?)",
    args: [key, content, Date.now()],
  });

  const url = `${siteBaseUrl}/p/${key}`;
  const rawUrl = `${url}/raw`;
  return { key, url, raw_url: rawUrl };
}

async function fetchMarkdownByKey(key) {
  const result = await db.execute({
    sql: "SELECT content FROM pastes WHERE key = ?",
    args: [key],
  });
  const row = result.rows[0];
  if (!row) return null;
  return row.content;
}

function extractKey(keyOrUrl) {
  let key = keyOrUrl.trim();
  const match = key.match(/\/p\/([a-z0-9]+)/i);
  if (match) key = match[1];
  key = key.replace(/\/raw\/?$/, "").replace(/^\/+|\/+$/g, "");
  // DB chi luu key dang chu thuong (nanoid dung bang chu cai 0-9a-z),
  // nen chuan hoa ve chu thuong truoc khi tra cuu de tranh truong hop
  // AI chat vo tinh paste nham key co chu hoa.
  return /^[a-z0-9]+$/i.test(key) ? key.toLowerCase() : null;
}

// --- Tao paste moi ---
app.post("/", writeLimiter, rawTextParser, async (req, res) => {
  try {
    const result = await publishMarkdown(req.body, baseUrl(req));
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.status(201).json(result);
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

// --- MCP: cho phep AI chat goi tool publish_markdown / fetch_markdown ---
// Goi thang ham noi bo (publishMarkdown, fetchMarkdownByKey) thay vi fetch()
// qua HTTP toi 1 service rieng, de tranh loi 502 do cold-start-kep tren
// Render free tier khi 2 service goi cheo nhau luc ca hai deu dang sleep.

function getMcpServer() {
  const server = new McpServer(
    { name: "mdshare-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "publish_markdown",
    {
      title: "Publish Markdown to mdshare",
      description:
        "Dang mot noi dung markdown len dich vu mdshare va tra ve URL cong khai " +
        "(dang domain/p/key va domain/p/key/raw). Dung khi nguoi dung muon chia se " +
        "hoac luu lai mot ghi chu/bao cao/tai lieu markdown vua duoc tao ra trong cuoc tro chuyen.",
      inputSchema: {
        content: z
          .string()
          .min(1, "Noi dung khong duoc de trong")
          .describe("Toan bo noi dung markdown can dang len (dang van ban thuan, dinh dang .md)"),
      },
    },
    async ({ content }) => {
      try {
        const result = await publishMarkdown(content, MDSHARE_PUBLIC_URL);
        if (result.error) {
          return { content: [{ type: "text", text: `Loi: ${result.error}` }], isError: true };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Da dang markdown thanh cong.\n` +
                `URL xem: ${result.url}\n` +
                `URL raw: ${result.raw_url}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Loi khi dang markdown: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "fetch_markdown",
    {
      title: "Fetch Markdown from mdshare",
      description:
        "Tai ve noi dung markdown tu mot paste da dang tren mdshare, dua vao key hoac URL " +
        "day du (dang domain/p/key hoac domain/p/key/raw). Dung tool nay khi khong the truy " +
        "cap truc tiep URL do cong cu duyet web cua AI chat khong doc duoc noi dung text/plain " +
        "thuan (thuong gap vi URL raw khong co cau truc HTML nen bi coi la file tai xuong).",
      inputSchema: {
        key_or_url: z
          .string()
          .min(1, "Can cung cap key hoac URL")
          .describe(
            "Key 8 ky tu (vi du: 88md3c3l) hoac URL day du tra ve tu tool publish_markdown " +
              "(chap nhan ca dang /p/key va /p/key/raw)"
          ),
      },
    },
    async ({ key_or_url }) => {
      const key = extractKey(key_or_url);
      if (!key) {
        return {
          content: [
            { type: "text", text: `Khong nhan dien duoc key hop le tu: "${key_or_url}"` },
          ],
          isError: true,
        };
      }
      try {
        const content = await fetchMarkdownByKey(key);
        if (content === null) {
          return {
            content: [{ type: "text", text: `Khong tim thay paste voi key "${key}".` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Loi khi tai noi dung: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

app.post("/mcp", mcpLimiter, async (req, res) => {
  try {
    const server = getMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Loi khi xu ly MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

app.get("/", (req, res) => {
  res.type("text/plain").send(
    "mdshare - dich vu chia se markdown\n\n" +
      "POST / (body la noi dung markdown) -> tra ve { key, url, raw_url }\n" +
      "GET /p/:key -> xem\n" +
      "GET /p/:key/raw -> raw text\n" +
      "POST /mcp -> MCP Streamable HTTP endpoint (tool: publish_markdown, fetch_markdown)\n"
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
