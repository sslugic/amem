/**
 * Detached sender for the usage ping (see telemetry.ts): `node telemetry-send.js <url> <json>`.
 * Gives up after 3 seconds and always exits 0.
 */
import http from "node:http";
import https from "node:https";

function done(): never {
  process.exit(0);
}

try {
  const [url, body] = process.argv.slice(2);
  if (!url || !body) done();
  const target = new URL(url!);
  const client = target.protocol === "http:" ? http : https;
  const req = client.request(
    target,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body!),
        "User-Agent": "amem-cli",
      },
      timeout: 3000,
    },
    (res) => {
      res.resume();
      res.on("end", done);
    },
  );
  req.on("error", done);
  req.on("timeout", () => {
    req.destroy();
    done();
  });
  setTimeout(done, 3500).unref();
  req.end(body);
} catch {
  done();
}
