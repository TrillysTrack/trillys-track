// Server-only. Kalshi API-key auth: RSA-PSS (SHA-256, salt = digest length) over
// `${timestampMs}${METHOD}${path}`, where path is the full request path (e.g.
// /trade-api/v2/portfolio/balance) WITHOUT the query string. Signature is base64.
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
  const msg = `${timestampMs}${method.toUpperCase()}${path.split("?")[0]}`;
  return crypto
    .sign("sha256", Buffer.from(msg), {
      key: normalizePem(privateKeyPem),
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
