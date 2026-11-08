// POST /api/care/sources: {kind:"note"|"voice", text} as JSON, or one multipart "file" PDF (text layer only)
// runs A4 and saves suggested facts, conflicts and suggested events (PRD C2, C3)
import "server-only";
import { z } from "zod";
import { addCareSource } from "../../_lib/care.ts";
import { ApiError, handle, json, parseInput, readJson, writeContext } from "../../_lib/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT_JSON_BYTES = 256 * 1024;
const MAX_PDF_REQUEST_BYTES = 10 * 1024 * 1024;
// a larger pdf is still read for its text layer, but is not attached to the model call
const MAX_PDF_FOR_MODEL_BYTES = 4 * 1024 * 1024;

const schema = z.strictObject({
  kind: z.enum(["note", "voice"]),
  text: z.string().min(1).max(60_000),
});

/** the whole body, bounded on the actual stream, so a missing or false Content-Length can't bypass the limit */
async function readBounded(request: Request, maxBytes: number): Promise<Buffer> {
  if (!request.body) throw new ApiError(400, "invalid_input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText } = await import("unpdf");
  try {
    const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
    return text;
  } catch {
    throw new ApiError(422, "unreadable_pdf");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(async () => {
    const { rt, user } = await writeContext(request);
    const type = request.headers.get("Content-Type") ?? "";
    if (type.toLowerCase().startsWith("multipart/form-data")) {
      const raw = await readBounded(request, MAX_PDF_REQUEST_BYTES);
      let form: FormData;
      try {
        form = await new Response(new Blob([new Uint8Array(raw)]), { headers: { "Content-Type": type } }).formData();
      } catch {
        throw new ApiError(400, "invalid_input");
      }
      const files = form.getAll("file");
      const file = files[0];
      if (files.length !== 1 || typeof file === "string" || file.size === 0) throw new ApiError(400, "invalid_input");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new ApiError(415, "unsupported_media_type");
      const text = await pdfText(bytes);
      const pdfBase64 = bytes.byteLength <= MAX_PDF_FOR_MODEL_BYTES ? Buffer.from(bytes).toString("base64") : undefined;
      return json(await addCareSource(rt, user, { kind: "document", text, pdfBase64 }));
    }
    const input = parseInput(schema, await readJson(request, MAX_TEXT_JSON_BYTES));
    return json(await addCareSource(rt, user, input));
  });
}
