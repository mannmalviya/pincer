/**
 * POST /api/auth/github/connect
 *
 * Server-side proxy that saves a GitHub Personal Access Token to the
 * agent. Body: { access_token }.
 *
 * Same rationale as the /status and /disconnect proxies: the browser
 * can't talk to the agent directly when the agent lives behind a Brev
 * secure-link (CORS / auth-wall), so a Next.js server fetch forwards
 * the token instead. The token is never persisted on the dashboard
 * side; it's stored only on the agent.
 *
 * The agent validates the token against GitHub's /user before saving,
 * so a bad token comes back as a 400 and the dashboard can surface
 * "GitHub didn't accept that token" instead of "saved successfully".
 */
import { NextResponse, type NextRequest } from "next/server";

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

export async function POST(request: NextRequest) {
  let body: { access_token?: unknown };
  try {
    body = (await request.json()) as { access_token?: unknown };
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid_body" },
      { status: 400 },
    );
  }
  if (typeof body.access_token !== "string" || body.access_token.length < 10) {
    return NextResponse.json(
      { ok: false, error: "invalid_token" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${AGENT_BASE}/integrations/github/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: body.access_token }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; login?: string; error?: { code?: string; message?: string } }
      | null;
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: data?.error?.code ?? "agent_error",
          message: data?.error?.message ?? `Agent returned ${res.status}`,
        },
        { status: res.status },
      );
    }
    return NextResponse.json({ ok: true, login: data?.login ?? null });
  } catch (err) {
    console.error("[github/connect] agent unreachable:", err);
    return NextResponse.json(
      { ok: false, error: "agent_unreachable" },
      { status: 502 },
    );
  }
}
