import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Which server-side features are configured. Booleans only — never values.
export async function GET() {
  return NextResponse.json({
    db: !!process.env.POSTGRES_URL,
    claude: !!process.env.ANTHROPIC_API_KEY,
    kalshiKeys: !!(process.env.KALSHI_API_KEY_ID && process.env.KALSHI_PRIVATE_KEY),
    tokenRequired: !!process.env.DASHBOARD_TOKEN,
  });
}
