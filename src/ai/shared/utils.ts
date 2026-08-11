import OpenAI from "openai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

let openaiInstance: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!openaiInstance) {
    openaiInstance = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiInstance;
}

export async function extractDocumentText(
  docs: { name: string; mimeType: string; dataUrl: string }[],
): Promise<string> {
  if (!docs.length) return "";
  const MAX_CHARS = 30000;
  const parts: string[] = [];

  for (const doc of docs) {
    try {
      const base64 = doc.dataUrl.includes(",") ? doc.dataUrl.split(",")[1] : doc.dataUrl;
      const buffer = Buffer.from(base64, "base64");
      const ext = doc.name.split(".").pop()?.toLowerCase() ?? "";
      let text = "";

      if (ext === "pdf") {
        const result = await pdfParse(buffer, { max: 50 });
        text = result.text;
      } else if (ext === "docx" || ext === "doc") {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      }

      if (text.trim()) {
        const snippet = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n... (truncated)" : text;
        parts.push(`\n\n---\n**Attached document: ${doc.name}**\n\`\`\`\n${snippet}\n\`\`\``);
      }
    } catch (err) {
      console.error(`Failed to extract text from ${doc.name}:`, err);
      parts.push(`\n\n---\n**Attached document: ${doc.name}** (could not extract text)`);
    }
  }
  return parts.join("");
}

export function injectImages(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  images: { name: string; dataUrl: string }[] | undefined,
) {
  if (!images?.length) return;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;
  const existing = messages[lastUserIdx] as { role: "user"; content: string };
  messages[lastUserIdx] = {
    role: "user",
    content: [
      { type: "text", text: existing.content },
      ...images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: img.dataUrl },
      })),
    ],
  };
}

export function modelForPhase(phase: string): string {
  switch (phase) {
    case "requirements":
    case "documentation":
    case "architecture":
      return "gpt-4o";
    default:
      return "gpt-4o-mini";
  }
}

export function estimateCostUSD(
  model: string,
  usage: { prompt_tokens?: number; completion_tokens?: number },
): number {
  const rates: Record<string, { prompt: number; completion: number }> = {
    "gpt-4o": { prompt: 2.5 / 1_000_000, completion: 10 / 1_000_000 },
    "gpt-4o-mini": { prompt: 0.15 / 1_000_000, completion: 0.6 / 1_000_000 },
  };
  const rate = rates[model] || rates["gpt-4o-mini"];
  return (usage.prompt_tokens || 0) * rate.prompt + (usage.completion_tokens || 0) * rate.completion;
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
