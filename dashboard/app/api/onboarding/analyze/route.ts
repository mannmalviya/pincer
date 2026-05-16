import { NextResponse, type NextRequest } from "next/server";

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

export async function POST(request: NextRequest) {
  let body: { repo_url?: unknown; token?: unknown };
  try {
    body = (await request.json()) as { repo_url?: unknown; token?: unknown };
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "invalid_body",
          message: "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${AGENT_BASE}/onboarding/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text.length > 0 ? safeJsonParse(text) : null;
    if (data !== null) {
      return NextResponse.json(data, { status: res.status });
    }
    return NextResponse.json(
      {
        error: {
          code: "agent_non_json_response",
          message: `Agent returned ${res.status}: ${text.slice(0, 200)}`,
        },
      },
      { status: res.status },
    );
  } catch (err) {
    console.error("[onboarding/analyze] agent unreachable:", err);
    return NextResponse.json(
      {
        error: {
          code: "agent_unreachable",
          message: "Could not reach the Pincer agent.",
        },
      },
      { status: 502 },
    );
  }
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
