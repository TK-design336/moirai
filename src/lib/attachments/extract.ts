/**
 * File attachment extraction utilities.
 * - Images: pass through as base64
 * - txt/md/csv/json: read as text
 * - PDF: extract text via pdfjs-dist; if < PDF_MIN_TEXT_CHARS, flag for direct-send
 * - DOCX: extract text via mammoth
 */

import * as pdfjsLib from "pdfjs-dist";
import mammoth from "mammoth";

// Configure PDF.js worker (Vite resolves the URL at build time)
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).href;

/** Minimum extracted character count to consider a PDF "text-extractable" */
const PDF_MIN_TEXT_CHARS = 100;

export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
export const TEXT_EXTS = new Set(["txt", "md", "csv", "json"]);
export const DOC_EXTS = new Set(["pdf", "docx", "doc"]);

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_FILE_COUNT = 5;

export interface ExtractionResult {
  /** Extracted plain text (for text-based files) */
  text?: string;
  /** True if PDF text extraction yielded too little content (likely scanned) */
  pdfExtractionFailed?: boolean;
}

/** Get MIME type from extension if browser cannot detect it */
export function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Read file as base64 DataURL */
export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Strip the "data:<mime>;base64," prefix from a DataURL */
export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Extract text content from a document file */
export async function extractDocumentText(
  file: File,
  ext: string,
): Promise<ExtractionResult> {
  try {
    if (TEXT_EXTS.has(ext)) {
      const text = await file.text();
      return { text };
    }

    if (ext === "pdf") {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      const parts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        parts.push(pageText);
      }
      const text = parts.join("\n").trim();
      if (text.length < PDF_MIN_TEXT_CHARS) {
        return { pdfExtractionFailed: true };
      }
      return { text };
    }

    if (ext === "docx" || ext === "doc") {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      return { text: result.value.trim() };
    }
  } catch (err) {
    console.warn(`[Attachment] extraction failed for ${file.name}:`, err);
    if (ext === "pdf") return { pdfExtractionFailed: true };
  }

  return {};
}

/** Providers that support native PDF document attachment */
export function providerSupportsPdf(provider: string): boolean {
  return provider === "claude" || provider === "gemini";
}
