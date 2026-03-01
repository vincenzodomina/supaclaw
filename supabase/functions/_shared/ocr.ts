import { generateText } from "ai";
import { getConfigString } from "./helpers.ts";
import { LLMProvider, resolveProviderModel } from "./agent.ts";

export const OCR_EXTRACTION_PROMPT =
  `Return the plain-text you can read from the image, preserving structure (headings, lists, tables, key/value layout) and natural reading order.

Rules:
- Extract only visible text. Do not infer or autocomplete missing words.
- Keep sentences exactly as shown even if they continue from/to other pages.
- If no readable text exists, return an empty string.
- Ignore purely decorative visuals, watermarks, and noise. Do not describe images.

Formatting:
- Use Markdown only for lists and tables.
- Do not use Markdown headings (#) or bold.
- Tables must use Markdown table syntax and keep cell text on one line.
- Write explicit key/value pairs only if both label and value are visible.
- Use LaTeX $...$ for equations if present.

Output only the extracted text.`;

export async function ocrPageImage(params: {
  imageBytes: Uint8Array;
  mediaType: string;
}): Promise<string> {
  const ocrProvider = getConfigString("llms.ocr.provider") ?? "google";
  const ocrModel = resolveProviderModel(ocrProvider as LLMProvider, getConfigString("llms.ocr.model"));

  const result = await generateText({
    model: ocrModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: OCR_EXTRACTION_PROMPT },
          {
            type: "image",
            image: params.imageBytes,
            mediaType: params.mediaType,
          },
        ],
      },
    ],
  });

  return (result.text ?? "").trim();
}
