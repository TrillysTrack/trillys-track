import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signKalshi, kalshiAuthHeaders, normalizePem } from "../../lib/server/kalshiAuth.mjs";
import { isPrivateIp, assertPublicUrl, safeFetchText } from "../../lib/server/net.mjs";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });

const verify = (msg, sig) => crypto.verify("sha256", Buffer.from(msg), {
  key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
}, Buffer.from(sig, "base64"));

test("Kalshi signature: RSA-PSS over ts+METHOD+path, query string excluded", () => {
  const sig = signKalshi({ privateKeyPem: pem, timestampMs: "1700000000000", method: "get", path: "/trade-api/v2/portfolio/positions?limit=100" });
  assert.ok(verify("1700000000000GET/trade-api/v2/portfolio/positions", sig));
  assert.ok(!verify("1700000000000GET/trade-api/v2/portfolio/positions?limit=100", sig));
});

test("auth headers carry key id, ms timestamp and a verifiable signature", () => {
  const h = kalshiAuthHeaders({ keyId: "kid", privateKeyPem: pem, method: "GET", path: "/trade-api/v2/portfolio/balance", now: 1234 });
  assert.equal(h["KALSHI-ACCESS-KEY"], "kid");
  assert.equal(h["KALSHI-ACCESS-TIMESTAMP"], "1234");
  assert.ok(verify("1234GET/trade-api/v2/portfolio/balance", h["KALSHI-ACCESS-SIGNATURE"]));
});

test("normalizePem repairs escaped and flattened PEMs", () => {
  const escaped = pem.trim().replace(/\n/g, "\\n");
  assert.equal(normalizePem(escaped), pem.trim());
  const flat = pem.trim().replace(/\n/g, " ");
  const sig = signKalshi({ privateKeyPem: flat, timestampMs: "1", method: "GET", path: "/p" });
  assert.ok(verify("1GET/p", sig));
});

test("isPrivateIp", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.ok(!isPrivateIp(ip), ip);
});

const publicLookup = async () => [{ address: "93.184.216.34" }];
const privateLookup = async () => [{ address: "10.0.0.5" }];

test("assertPublicUrl rejects non-http, credentials, odd ports, private hosts", async () => {
  await assert.rejects(assertPublicUrl("file:///etc/passwd", publicLookup), /http/);
  await assert.rejects(assertPublicUrl("http://u:p@example.com/", publicLookup), /credentials/);
  await assert.rejects(assertPublicUrl("http://example.com:8080/", publicLookup), /ports/);
  await assert.rejects(assertPublicUrl("http://internal.example/", privateLookup), /private/);
  await assert.rejects(assertPublicUrl("http://127.0.0.1/", publicLookup), /private/);
  assert.equal((await assertPublicUrl("https://www.fool.com/x", publicLookup)).hostname, "www.fool.com");
});

test("safeFetchText re-checks every redirect hop", async () => {
  const lookup = async (host) => (host === "evil.internal" ? [{ address: "10.0.0.9" }] : [{ address: "93.184.216.34" }]);
  const fetchImpl = async (url) => url.includes("start")
    ? new Response(null, { status: 302, headers: { location: "http://evil.internal/meta" } })
    : new Response("secret", { status: 200 });
  await assert.rejects(safeFetchText("https://ok.example/start", { fetchImpl, lookup }), /private/);
  const ok = await safeFetchText("https://ok.example/page", { fetchImpl: async () => new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } }), lookup });
  assert.equal(ok.body, "<p>hi</p>");
  await assert.rejects(safeFetchText("https://ok.example/big", { fetchImpl: async () => new Response("x".repeat(100), { status: 200 }), lookup, maxBytes: 10 }), /too large/);
});

test("Kalshi signature: Ed25519 keys (Kalshi's recommended type) sign the text directly", () => {
  const ed = crypto.generateKeyPairSync("ed25519");
  const edPem = ed.privateKey.export({ type: "pkcs8", format: "pem" });
  const sig = signKalshi({ privateKeyPem: edPem, timestampMs: "1700000000000", method: "GET", path: "/trade-api/v2/portfolio/balance?x=1" });
  assert.ok(crypto.verify(null, Buffer.from("1700000000000GET/trade-api/v2/portfolio/balance"), ed.publicKey, Buffer.from(sig, "base64")));
  assert.equal(Buffer.from(sig, "base64").length, 64);
  // An RSA key in PKCS#8 form (same "BEGIN PRIVATE KEY" header) still signs with RSA-PSS.
  const rsa8 = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.ok(verify("1GET/p", signKalshi({ privateKeyPem: rsa8, timestampMs: "1", method: "GET", path: "/p" })));
});
