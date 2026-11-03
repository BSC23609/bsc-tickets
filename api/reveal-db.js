// TEMPORARY (DB migration): delete this file after copying the database URL.
const crypto = require("crypto");
const TOKEN_SHA256 = "e0d292e439e260caf37d4047fed93fad6704c831d7cd54531644120b001bbed6";

module.exports = (req, res) => {
  const given = String(req.headers["x-reveal-token"] || "");
  const digest = crypto.createHash("sha256").update(given).digest("hex");
  const ok = given.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(TOKEN_SHA256));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (!ok) { res.statusCode = 404; return res.end('{"detail":"Not Found"}'); }
  const keys = ["DATABASE", "POSTGRES", "NEON", "PG"];
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (keys.some(s => K.includes(s)) && !K.includes("RIPGREP")) out[k] = v;
  }
  res.statusCode = 200;
  res.end(JSON.stringify(out));
};
