// Local fake FeedMob Admin API for testing without real credentials.
// Usage: node scripts/mock-api.mjs [port]   (default 4010)
// Accepts FEEDMOB_KEY=mock-key / FEEDMOB_SECRET=mock-secret only.
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const PORT = Number(process.argv[2] ?? 4010);
const KEY = "mock-key", SECRET = "mock-secret";
// Example data only — not real FeedMob clients.
const CLIENTS = [
  "Uber Technologies", "Lyft", "DoorDash", "Instacart", "Grubhub", "TextNow", "Possible Finance",
  "Koho Financial", "Privacy Hawk", "Upside", "Jackpocket", "Chime",
].map((name, i) => ({ id: 101 + i, name }));

function validToken(key, token) {
  if (key !== KEY || !token) return false;
  const [h, p, s] = token.split(".");
  return s === createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  console.log(new Date().toISOString(), req.method, url.pathname + url.search);
  if (!validToken(req.headers["feedmob-key"], req.headers["feedmob-token"])) return send(401, { error: "Unauthorized" });
  if (req.method === "GET" && url.pathname === "/ai/api/clients") {
    const q = (url.searchParams.get("client_name") ?? "").toLowerCase();
    return send(200, CLIENTS.filter(c => c.name.toLowerCase().includes(q)));
  }
  send(404, { error: "Not Found" });
}).listen(PORT, () => console.log(`Mock FeedMob API on http://localhost:${PORT}`));
