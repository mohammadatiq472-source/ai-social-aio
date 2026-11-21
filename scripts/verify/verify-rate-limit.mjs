// 只测限流：并发打 /api/，应出现 429
const BASE = process.env.BASE || "https://chat.example.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ email: "demo@qqmini.dev", password: "demo-qqmini-2026" }) });
const cookie = (r.headers.getSetCookie?.() || []).map((c) => String(c).split(";")[0]).join("; ");
const results = await Promise.all(Array.from({ length: 600 }, (_, i) => fetch(`${BASE}/api/conversations?rl=${i}`, { headers: { cookie, "user-agent": UA } }).then((x) => x.status).catch(() => 0)));
const counts = results.reduce((m, s) => ((m[s] = (m[s] || 0) + 1), m), {});
console.log(JSON.stringify(counts));
const ok = Boolean(counts[429]);
console.log(ok ? "RATE LIMIT OK" : "RATE LIMIT MISSING");
process.exit(ok ? 0 : 1);
