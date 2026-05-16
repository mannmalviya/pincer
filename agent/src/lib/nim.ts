// Tiny OpenAI-compatible client for NVIDIA NIM. Used by the suggested-
// reply feature to call Nemotron Super at integrate.api.nvidia.com.
//
// Plain fetch + the chat-completions shape. No SDK dependency: the NIM
// gateway is OpenAI-compatible, and a single endpoint with three fields
// (model, messages, max_tokens) is the entire surface we need.

import { NIM_API_KEY, NIM_BASE_URL } from "../config.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionInput = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
};

export class NimError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_configured"
      | "http_error"
      | "network_error"
      | "empty_response",
    public readonly status?: number,
  ) {
    super(message);
  }
}

export function nimConfigured(): boolean {
  return NIM_API_KEY.length > 0;
}

// Chat completion. Returns just the assistant message text, since none of
// our callers care about the token-usage envelope. Throws NimError with a
// typed code so the HTTP handler can map to an appropriate status code.
export async function chatComplete(
  input: ChatCompletionInput,
): Promise<string> {
  if (!nimConfigured()) {
    throw new NimError(
      "NIM_API_KEY is not set on the agent",
      "not_configured",
    );
  }

  let res: Response;
  try {
    res = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NIM_API_KEY}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        temperature: input.temperature ?? 0.4,
        max_tokens: input.max_tokens ?? 350,
      }),
    });
  } catch (err) {
    throw new NimError(
      err instanceof Error ? err.message : String(err),
      "network_error",
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NimError(
      `NIM returned ${res.status}: ${body.slice(0, 300)}`,
      "http_error",
      res.status,
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new NimError("NIM returned no content", "empty_response");
  }
  return text;
}
