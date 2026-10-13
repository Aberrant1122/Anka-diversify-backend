import crypto from "crypto";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

export interface RawEvidencePage {
  pageNumber: number;
  text: string;
}

export interface RawEvidenceParagraph {
  paragraphNumber: number;
  text: string;
}

export interface ParsedEvidenceSpan {
  ordinal: number;
  locatorType: "PDF_PAGE" | "DOCX_PARAGRAPH";
  pageNumber?: number | null;
  paragraphNumber?: number | null;
  startOffset: number;
  endOffset: number;
  text: string;
  textHash: string;
}

export const MAX_EXTRACTION_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PDF_PAGES = 1000;
export const DEFAULT_MAX_SPAN_CHARS = 1000;

/**
 * SHA-256 for binary buffers or strings
 */
export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function computeTextHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Determines whether a file is an eligible evidence document (PDF or DOCX).
 */
export function isSupportedEvidenceDocument(filename?: string | null, mimetype?: string | null): boolean {
  if (!filename && !mimetype) return false;
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf" || ext === "docx") return true;
  if (mimetype === "application/pdf") return true;
  if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return true;
  return false;
}

/**
 * Resolves the target evidence document format ('pdf' | 'docx' | null).
 * Strict: does not treat legacy .doc as docx.
 */
export function detectEvidenceFormat(filename?: string | null, mimetype?: string | null): "pdf" | "docx" | null {
  if (!filename && !mimetype) return null;
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  if (ext === "pdf" || mimetype === "application/pdf") return "pdf";
  if (ext === "docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "docx";
  }
  return null;
}

/**
 * Validates actual binary content signature (magic numbers) to prevent
 * disguised or corrupt files from entering extraction.
 */
export function validateDocumentSignature(
  buffer: Buffer,
  expectedFormat: "pdf" | "docx"
): { valid: boolean; reason?: string } {
  if (buffer.length === 0) {
    return { valid: false, reason: "Document is empty (0 bytes)" };
  }

  if (expectedFormat === "pdf") {
    // PDF signature '%PDF-' within the first 1024 bytes
    const header = buffer.subarray(0, Math.min(1024, buffer.length)).toString("latin1");
    if (!header.includes("%PDF-")) {
      return { valid: false, reason: "File lacks a valid PDF signature (%PDF-)" };
    }
    return { valid: true };
  }

  if (expectedFormat === "docx") {
    // DOCX is a zip archive starting with PK\x03\x04 or PK\x05\x06
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      return { valid: false, reason: "File is not a valid DOCX zip package (missing PK header)" };
    }
    return { valid: true };
  }

  return { valid: false, reason: "Unsupported document format" };
}

/**
 * Page-aware PDF text extractor using pdf-parse.
 * Preserves 1-indexed page numbers. Disables the default 50-page cap.
 */
export async function extractPdfPages(buffer: Buffer): Promise<RawEvidencePage[]> {
  const pages: RawEvidencePage[] = [];

  let pageIndexTracker = 0;

  try {
    // Use an unpooled Uint8Array copy so PDF.js does not get confused by Node's internal Buffer pool
    const pdfData = new Uint8Array(buffer);
    const result = await pdfParse(pdfData as unknown as Buffer, {
      max: 0, // no page limit
      pagerender: async (pageData: any) => {
        pageIndexTracker++;
        const textContent = await pageData.getTextContent({
          normalizeWhitespace: false,
          disableCombineTextItems: false,
        });

        let lastY: number | undefined;
        let pageText = "";
        for (const item of textContent.items) {
          if (lastY === item.transform[5] || lastY === undefined) {
            pageText += item.str;
          } else {
            pageText += "\n" + item.str;
          }
          lastY = item.transform[5];
        }

        const pageNumber =
          pageData.pageIndex !== undefined
            ? pageData.pageIndex + 1
            : pageData.pageNumber || pageIndexTracker;

        const trimmed = pageText.trim();
        if (trimmed.length > 0) {
          pages.push({ pageNumber, text: trimmed });
        }
        return pageText;
      },
    });

    if (result.numpages > MAX_PDF_PAGES) {
      const err = new Error(`PDF exceeds maximum supported page limit of ${MAX_PDF_PAGES} pages`);
      (err as any).code = "DOCUMENT_EXCEEDS_PAGE_LIMIT";
      throw err;
    }
  } catch (error: any) {
    if (error.code === "DOCUMENT_EXCEEDS_PAGE_LIMIT") {
      throw error;
    }
    const err = new Error(`Failed to parse PDF: ${error instanceof Error ? error.message : "Unknown error"}`);
    (err as any).code = "MALFORMED_PDF";
    throw err;
  }

  // Sort deterministically by pageNumber
  pages.sort((a, b) => a.pageNumber - b.pageNumber);
  return pages;
}

/**
 * Paragraph-aware DOCX text extractor using mammoth.
 * Numbers nonempty extracted paragraphs from 1. Mammoth's raw-text API does
 * not expose original Word paragraph positions, including empty paragraphs.
 */
export async function extractDocxParagraphs(buffer: Buffer): Promise<RawEvidenceParagraph[]> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const rawText = result.value || "";
    const rawParagraphs = rawText.split(/\r?\n\r?\n/);
    const paragraphs: RawEvidenceParagraph[] = [];

    let pNum = 1;
    for (const raw of rawParagraphs) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        paragraphs.push({ paragraphNumber: pNum++, text: trimmed });
      }
    }

    return paragraphs;
  } catch (error: any) {
    const err = new Error(`Failed to parse DOCX: ${error instanceof Error ? error.message : "Unknown error"}`);
    (err as any).code = "MALFORMED_DOCX";
    throw err;
  }
}

/**
 * Bounded passage splitter: splits long pages or paragraphs into deterministic,
 * bounded spans (at most maxSpanChars each) while retaining their locator identity.
 */
export function splitIntoBoundedSpans(
  items: Array<{ locatorType: "PDF_PAGE" | "DOCX_PARAGRAPH"; pageNumber?: number; paragraphNumber?: number; text: string }>,
  maxSpanChars: number = DEFAULT_MAX_SPAN_CHARS
): ParsedEvidenceSpan[] {
  const spans: ParsedEvidenceSpan[] = [];
  let ordinal = 1;

  for (const item of items) {
    const text = item.text;
    if (text.length <= maxSpanChars) {
      spans.push({
        ordinal: ordinal++,
        locatorType: item.locatorType,
        pageNumber: item.pageNumber ?? null,
        paragraphNumber: item.paragraphNumber ?? null,
        startOffset: 0,
        endOffset: text.length,
        text,
        textHash: computeTextHash(text),
      });
    } else {
      let offset = 0;
      while (offset < text.length) {
        const nextEnd = Math.min(offset + maxSpanChars, text.length);
        const chunk = text.slice(offset, nextEnd);
        spans.push({
          ordinal: ordinal++,
          locatorType: item.locatorType,
          pageNumber: item.pageNumber ?? null,
          paragraphNumber: item.paragraphNumber ?? null,
          startOffset: offset,
          endOffset: nextEnd,
          text: chunk,
          textHash: computeTextHash(chunk),
        });
        offset = nextEnd;
      }
    }
  }

  return spans;
}

/**
 * High-level parse function producing validated, bounded EvidenceSpans
 * for an authorized document buffer.
 */
export async function parseDocumentEvidence(
  buffer: Buffer,
  format: "pdf" | "docx",
  maxSpanChars: number = DEFAULT_MAX_SPAN_CHARS
): Promise<ParsedEvidenceSpan[]> {
  const sigCheck = validateDocumentSignature(buffer, format);
  if (!sigCheck.valid) {
    const err = new Error(sigCheck.reason || "Invalid document signature");
    (err as any).code = "INVALID_DOCUMENT_SIGNATURE";
    throw err;
  }

  if (format === "pdf") {
    const pages = await extractPdfPages(buffer);
    if (pages.length === 0) {
      const err = new Error("No extractable text found in PDF");
      (err as any).code = "NO_EXTRACTABLE_TEXT";
      throw err;
    }
    return splitIntoBoundedSpans(
      pages.map((p) => ({ locatorType: "PDF_PAGE", pageNumber: p.pageNumber, text: p.text })),
      maxSpanChars
    );
  } else {
    const paragraphs = await extractDocxParagraphs(buffer);
    if (paragraphs.length === 0) {
      const err = new Error("No extractable text found in DOCX");
      (err as any).code = "NO_EXTRACTABLE_TEXT";
      throw err;
    }
    return splitIntoBoundedSpans(
      paragraphs.map((p) => ({
        locatorType: "DOCX_PARAGRAPH",
        paragraphNumber: p.paragraphNumber,
        text: p.text,
      })),
      maxSpanChars
    );
  }
}
