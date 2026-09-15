/* Local trace sink for dsh-think-ux diagnostics.
 *
 * The deployed plugin mirrors every [think-ux] trace line here with a
 * fire-and-forget POST ({t, msg}); this server appends each line as JSONL
 * so the assistant can read the log from disk (the browser console itself
 * is not accessible from the agent).
 *
 * Usage: node trace-sink.cjs   (keep running while the GUI is being tested)
 */
const http = require("http");
const fs = require("fs");
const PORT = 3999;
const FILE = "E:/测试环境/cleanup-review/think-ux-trace.log";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === "POST") {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy(); /* oversized: drop */
    });
    req.on("end", () => {
      try { fs.appendFileSync(FILE, data + "\n"); } catch (e) { /* keep serving */ }
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, CORS));
      res.end("{}");
    });
    return;
  }
  res.writeHead(200, Object.assign({ "Content-Type": "text/plain" }, CORS));
  res.end("think-ux trace sink ok\n");
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("trace sink listening on http://127.0.0.1:" + PORT + " -> " + FILE);
});
