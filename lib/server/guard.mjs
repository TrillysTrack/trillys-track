// Server-only shared-secret gate. The dashboard has no login, so anything that spends money
// (Claude), fetches arbitrary URLs, or exposes the Kalshi account sits behind DASHBOARD_TOKEN.
// `required` endpoints refuse to run at all until the token is configured.
import crypto from "node:crypto";

export function checkToken(req, { required = false } = {}) {
  const expected = process.env.DASHBOARD_TOKEN || "";
  if (!expected) {
    return required
      ? { ok: false, status: 403, error: "Set DASHBOARD_TOKEN on the server to enable this endpoint — it keeps your Kalshi account data private. See README." }
      : { ok: true };
  }
  const got = Buffer.from(req.headers.get("x-dashboard-token") || "");
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, status: 401, error: "Missing or wrong dashboard token — enter it in the Settings tab." };
  }
  return { ok: true };
}
