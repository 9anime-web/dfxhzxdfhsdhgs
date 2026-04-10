const express = require("express");
const app = express();

const PORT   = process.env.PORT || 3000;
const HOST   = "https://dm.1024terabox.com";
const APP_ID = "250528";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PING_URL = "https://dfxhzxdfhsdhgs.onrender.com";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  next();
});

app.options("*", (req, res) => res.status(200).end());

const respond = (res, data, status = 200) =>
  res.status(status).json(data);

const fmtBytes = (b) =>
  b >= 1099511627776 ? (b / 1099511627776).toFixed(2) + " TB" :
  b >= 1073741824    ? (b / 1073741824).toFixed(2)    + " GB" :
                       (b / 1048576).toFixed(2)        + " MB";

const apiHeaders = (cookie) => ({
  "User-Agent":      UA,
  "Cookie":          cookie,
  "Accept":          "application/json",
  "Referer":         `${HOST}/main`,
  "X-Requested-With": "XMLHttpRequest",
});

const baseParams = (jsToken) => ({
  app_id: APP_ID,
  web: "1",
  channel: "dubox",
  clienttype: "0",
  jsToken,
  "dp-logid": Date.now().toString(),
});

async function getTokens(ndus) {
  const cookie = `ndus=${ndus}; PANWEB=1; lang=en`;
  const urls = [`${HOST}/main?category=all`, `${HOST}/`];

  for (const url of urls) {
    try {
      const res  = await fetch(url, {
        headers: { "User-Agent": UA, "Cookie": cookie, "Accept": "text/html,*/*" },
        redirect: "follow",
      });
      const html = await res.text();
      const match = html.match(/var\s+templateData\s*=\s*(\{[\s\S]*?\})\s*;/);
      if (!match) continue;

      const td = JSON.parse(match[1]);
      const jt = td.jsToken && decodeURIComponent(td.jsToken).match(/fn\("([^"]+)"\)/)?.[1];
      if (jt && td.bdstoken) return { jsToken: jt, bdstoken: td.bdstoken, cookie };
    } catch (_) {}
  }

  throw new Error("Auth failed — ndus cookie may be expired");
}

async function getQuota(jsToken, cookie) {
  const params = new URLSearchParams({
    ...baseParams(jsToken),
    checkexpire: "1",
    checkfree: "1",
  });

  const res = await fetch(`${HOST}/api/quota?${params}`, { headers: apiHeaders(cookie) });
  const d   = await res.json();

  if (d.errno !== 0) throw new Error(`quota errno=${d.errno}`);

  return {
    total:    fmtBytes(d.total),
    used:     fmtBytes(d.used),
    free:     fmtBytes(d.free),
    used_pct: (d.used / d.total * 100).toFixed(1) + "%",
  };
}

async function listFiles(jsToken, cookie, dir) {
  const all = [];
  for (let pg = 1; ; pg++) {
    const params = new URLSearchParams({
      ...baseParams(jsToken),
      order: "time",
      desc: "1",
      dir,
      num: "100",
      page: String(pg),
      showempty: "0",
    });

    const res = await fetch(`${HOST}/api/list?${params}`, { headers: apiHeaders(cookie) });
    const d   = await res.json();

    if (d.errno !== 0) throw new Error(`list errno=${d.errno}`);
    all.push(...(d.list || []));
    if ((d.list?.length ?? 0) < 100) break;
  }
  return all;
}

async function deleteFiles(paths, jsToken, bdstoken, cookie) {
  const results = [];

  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const params = new URLSearchParams({
      ...baseParams(jsToken),
      async: "2",
      onnest: "fail",
      bdstoken,
      opera: "delete",
    });

    const res = await fetch(`${HOST}/api/filemanager?${params}`, {
      method: "POST",
      headers: {
        ...apiHeaders(cookie),
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": HOST,
      },
      body: `filelist=${encodeURIComponent(JSON.stringify(batch))}`,
    });

    const d = await res.json();
    results.push({ batch: Math.floor(i / 100) + 1, count: batch.length, errno: d.errno });
  }

  return results;
}

app.get("/", async (req, res) => {
  const ndus = req.query.cookie || "";

  if (!ndus) {
    return respond(res, {
      error: "Missing required parameter: cookie",
      endpoints: [
        "/?cookie=NDUS&keep=60",
        "/?cookie=NDUS&keep=60&dry=1",
        "/?cookie=NDUS&action=info",
      ],
    }, 400);
  }

  let jsToken, bdstoken, cookie;
  try {
    ({ jsToken, bdstoken, cookie } = await getTokens(ndus));
  } catch (e) {
    return respond(res, { error: e.message }, 401);
  }

  const action  = req.query.action;
  const keepMin = parseInt(req.query.keep || "60", 10);
  const dry     = req.query.dry === "1";
  const dir     = req.query.dir || "/";
  const t0      = Date.now();

  try {
    if (action === "info") {
      const storage = await getQuota(jsToken, cookie);
      return respond(res, { errno: 0, storage, elapsed_ms: Date.now() - t0 });
    }

    const files    = await listFiles(jsToken, cookie, dir);
    const cutoff   = Math.floor(Date.now() / 1000) - keepMin * 60;
    const toDelete = files.filter(f => f.server_mtime < cutoff);
    const kept     = files.length - toDelete.length;

    if (dry) {
      const storage = await getQuota(jsToken, cookie);
      return respond(res, {
        errno: 0,
        dry_run: true,
        keep_min: keepMin,
        summary: { total: files.length, to_delete: toDelete.length, to_keep: kept },
        storage,
        files: toDelete.map(f => ({
          name:  f.server_filename,
          path:  f.path,
          mtime: f.server_mtime,
        })),
        elapsed_ms: Date.now() - t0,
      });
    }

    const batches = await deleteFiles(toDelete.map(f => f.path), jsToken, bdstoken, cookie);
    const deleted = batches.filter(b => b.errno === 0).reduce((s, b) => s + b.count, 0);
    const failed  = batches.filter(b => b.errno !== 0).reduce((s, b) => s + b.count, 0);
    const storage = await getQuota(jsToken, cookie);

    return respond(res, {
      errno:    failed === 0 ? 0 : deleted === 0 ? 1 : 2,
      status:   failed === 0 ? "success" : deleted === 0 ? "all_failed" : "partial",
      keep_min: keepMin,
      summary:  { total: files.length, deleted, failed, kept },
      storage,
      batches,
      elapsed_ms: Date.now() - t0,
    });

  } catch (e) {
    return respond(res, { error: e.message }, 500);
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Pinger logic to keep the service alive
setInterval(async () => {
  try {
    console.log(`[${new Date().toLocaleTimeString()}] Pinging ${PING_URL}...`);
    const response = await fetch(PING_URL);
    console.log(`[${new Date().toLocaleTimeString()}] Ping successful: ${response.status}`);
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] Ping failed:`, err.message);
  }
}, 25 * 1000); // 25 seconds

app.listen(PORT, () => {
  console.log(`\n  TeraBox Delete Server running on port ${PORT}`);
  console.log(`\n  Endpoints:`);
  console.log(`    GET /?cookie=NDUS&keep=60         → delete files older than 60 min`);
  console.log(`    GET /?cookie=NDUS&keep=60&dry=1   → preview only`);
  console.log(`    GET /?cookie=NDUS&action=info     → storage quota`);
  console.log(`    GET /health                       → server health\n`);
  console.log(`  Background Task:`);
  console.log(`    Pinging ${PING_URL} every 25 seconds.\n`);
});
