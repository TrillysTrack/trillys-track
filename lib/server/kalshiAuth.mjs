// Server-only. Kalshi API-key auth signs `${timestampMs}${METHOD}${path}`, where path is the
// full request path (e.g. /trade-api/v2/portfolio/balance) WITHOUT the query string; the
// signature is base64. Kalshi issues two key types and the PEM header doesn't say which:
// Ed25519 (recommended) signs the text directly; RSA uses RSA-PSS (SHA-256, salt = digest
// length). The type is read from the parsed key.
import crypto from "node:crypto";

// Env vars often carry PEMs with literal "\n" escapes or stripped newlines — repair both.
export function normalizePem(pem) {
  let s = String(pem || "").trim().replace(/\\n/g, "\n");
  if (!s.includes("\n")) {
    const m = /^(-----BEGIN [A-Z ]+-----)\s*(.+?)\s*(-----END [A-Z ]+-----)$/.exec(s);
    if (m) s = `${m[1]}\n${m[2].replace(/\s+/g, "").match(/.{1,64}/g).join("\n")}\n${m[3]}`;
  }
  return s;
}

export function signKalshi({ privateKeyPem, timestampMs, method, path }) {
  const msg = Buffer.from(`${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`);
  const key = crypto.createPrivateKey(normalizePem(privateKeyPem));
  if (key.asymmetricKeyType === "ed25519") return crypto.sign(null, msg, key).toString("base64");
  return crypto
    .sign("sha256", msg, {
      key,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
}

export function kalshiAuthHeaders({ keyId, privateKeyPem, method, path, now = Date.now() }) {
  const ts = String(now);
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signKalshi({ privateKeyPem, timestampMs: ts, method, path }),
  };
}
