// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require("pdfkit");
import JSZip from "jszip";
import {
  extractPdfPages,
  extractDocxParagraphs,
  parseDocumentEvidence,
  isSupportedEvidenceDocument,
  detectEvidenceFormat,
  validateDocumentSignature,
  splitIntoBoundedSpans,
  computeSha256,
  computeTextHash,
} from "../document-parser";

// Helper to generate a real multi-page PDF buffer using pdfkit
function createPdfBuffer(pages: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const buffers: Buffer[] = [];
    doc.on("data", (chunk: any) => buffers.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    pages.forEach((pageText, idx) => {
      if (idx > 0) doc.addPage();
      doc.text(pageText);
    });
    doc.end();
  });
}

// Helper to generate a real valid DOCX buffer using JSZip
async function createDocxBuffer(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  const pXml = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${pXml}</w:body>
</w:document>`
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Document Parser Engine Unit Tests (CP1.1)", () => {
  describe("Format Detection & Content Signatures", () => {
    test("isSupportedEvidenceDocument identifies pdf and docx correctly", () => {
      expect(isSupportedEvidenceDocument("report.pdf")).toBe(true);
      expect(isSupportedEvidenceDocument("REPORT.PDF")).toBe(true);
      expect(isSupportedEvidenceDocument("spec.docx")).toBe(true);
      expect(isSupportedEvidenceDocument("spec.DOCX")).toBe(true);
      expect(isSupportedEvidenceDocument("notes.txt")).toBe(false);
      expect(isSupportedEvidenceDocument("image.png")).toBe(false);
      expect(isSupportedEvidenceDocument("archive.zip")).toBe(false);
      expect(isSupportedEvidenceDocument("legacy.doc")).toBe(false); // Does not treat legacy .doc as docx
    });

    test("detectEvidenceFormat strictly distinguishes pdf, docx, and rejects others", () => {
      expect(detectEvidenceFormat("file.pdf")).toBe("pdf");
      expect(detectEvidenceFormat("file.docx")).toBe("docx");
      expect(detectEvidenceFormat("file.doc")).toBe(null);
      expect(detectEvidenceFormat("file.json")).toBe(null);
    });

    test("validateDocumentSignature validates PDF header %PDF-", () => {
      const validPdfHeader = Buffer.from("%PDF-1.4 sample content");
      expect(validateDocumentSignature(validPdfHeader, "pdf").valid).toBe(true);

      const fakePdf = Buffer.from("NOT_A_PDF_HEADER");
      const res = validateDocumentSignature(fakePdf, "pdf");
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("%PDF-");
    });

    test("validateDocumentSignature validates DOCX PK zip header", () => {
      const validDocxHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
      expect(validateDocumentSignature(validDocxHeader, "docx").valid).toBe(true);

      const fakeDocx = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // Legacy OLE .doc header
      const res = validateDocumentSignature(fakeDocx, "docx");
      expect(res.valid).toBe(false);
      expect(res.reason).toContain("PK");
    });
  });

  describe("SHA-256 Hashing", () => {
    test("same bytes yield the exact same SHA-256 hash", () => {
      const bytesA = Buffer.from("Anka OS persistent evidence verification");
      const bytesB = Buffer.from("Anka OS persistent evidence verification");
      expect(computeSha256(bytesA)).toBe(computeSha256(bytesB));
    });

    test("changed bytes yield a different SHA-256 hash", () => {
      const bytesA = Buffer.from("Version 1 content");
      const bytesB = Buffer.from("Version 2 content");
      expect(computeSha256(bytesA)).not.toBe(computeSha256(bytesB));
    });
  });

  describe("PDF Extraction (Page-Aware, No Silent Truncation)", () => {
    test("valid multi-page PDF extracts exact 1-indexed pages deterministically", async () => {
      const pdfBuffer = await createPdfBuffer([
        "Page one: Requirements specification for user management.",
        "Page two: Architecture design for authentication service.",
        "Page three: Verification and validation plan.",
      ]);

      const pages = await extractPdfPages(pdfBuffer);
      expect(pages).toHaveLength(3);
      expect(pages[0].pageNumber).toBe(1);
      expect(pages[0].text).toContain("Page one");
      expect(pages[1].pageNumber).toBe(2);
      expect(pages[1].text).toContain("Page two");
      expect(pages[2].pageNumber).toBe(3);
      expect(pages[2].text).toContain("Page three");
    });

    test("parses PDFs beyond 50 pages without the old 50-page cap", async () => {
      // Create a 55-page PDF to prove no 50-page truncation occurs
      const pageTexts = Array.from({ length: 55 }, (_, i) => `Content for document page ${i + 1}`);
      const pdfBuffer = await createPdfBuffer(pageTexts);

      const pages = await extractPdfPages(pdfBuffer);
      expect(pages.length).toBe(55);
      expect(pages[54].pageNumber).toBe(55);
      expect(pages[54].text).toContain("page 55");
    });

    test("malformed PDF fails safely with code MALFORMED_PDF", async () => {
      const corruptPdf = Buffer.from("%PDF-1.4\nCorrupted content without xref table or valid trailer %%EOF");
      await expect(extractPdfPages(corruptPdf)).rejects.toMatchObject({
        code: "MALFORMED_PDF",
      });
    });
  });

  describe("DOCX Extraction (Paragraph-Aware)", () => {
    test("valid DOCX produces deterministic paragraph numbers >= 1", async () => {
      const docxBuffer = await createDocxBuffer([
        "First paragraph: System scope and context.",
        "Second paragraph: Functional requirements definition.",
        "Third paragraph: Non-functional constraints and security boundaries.",
      ]);

      const paragraphs = await extractDocxParagraphs(docxBuffer);
      expect(paragraphs).toHaveLength(3);
      expect(paragraphs[0].paragraphNumber).toBe(1);
      expect(paragraphs[0].text).toContain("First paragraph");
      expect(paragraphs[1].paragraphNumber).toBe(2);
      expect(paragraphs[1].text).toContain("Second paragraph");
      expect(paragraphs[2].paragraphNumber).toBe(3);
      expect(paragraphs[2].text).toContain("Third paragraph");
    });

    test("malformed DOCX fails safely with code MALFORMED_DOCX", async () => {
      const corruptDocx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x88, 0x77]);
      await expect(extractDocxParagraphs(corruptDocx)).rejects.toMatchObject({
        code: "MALFORMED_DOCX",
      });
    });
  });

  describe("Bounded Span Splitting", () => {
    test("short page produces single span retaining pageNumber and offset", () => {
      const spans = splitIntoBoundedSpans(
        [{ locatorType: "PDF_PAGE", pageNumber: 4, text: "Short text" }],
        1000
      );
      expect(spans).toHaveLength(1);
      expect(spans[0].ordinal).toBe(1);
      expect(spans[0].locatorType).toBe("PDF_PAGE");
      expect(spans[0].pageNumber).toBe(4);
      expect(spans[0].startOffset).toBe(0);
      expect(spans[0].endOffset).toBe(10);
      expect(spans[0].text).toBe("Short text");
      expect(spans[0].textHash).toBe(computeTextHash("Short text"));
    });

    test("long page exceeding maxSpanChars splits into ordered spans retaining the same pageNumber", () => {
      const longText = "A".repeat(2500);
      const spans = splitIntoBoundedSpans(
        [{ locatorType: "PDF_PAGE", pageNumber: 2, text: longText }],
        1000
      );

      expect(spans).toHaveLength(3);
      // Span 1
      expect(spans[0].ordinal).toBe(1);
      expect(spans[0].pageNumber).toBe(2);
      expect(spans[0].startOffset).toBe(0);
      expect(spans[0].endOffset).toBe(1000);
      expect(spans[0].text.length).toBe(1000);

      // Span 2
      expect(spans[1].ordinal).toBe(2);
      expect(spans[1].pageNumber).toBe(2);
      expect(spans[1].startOffset).toBe(1000);
      expect(spans[1].endOffset).toBe(2000);
      expect(spans[1].text.length).toBe(1000);

      // Span 3
      expect(spans[2].ordinal).toBe(3);
      expect(spans[2].pageNumber).toBe(2);
      expect(spans[2].startOffset).toBe(2000);
      expect(spans[2].endOffset).toBe(2500);
      expect(spans[2].text.length).toBe(500);
    });

    test("high-level parseDocumentEvidence creates valid EvidenceSpans end-to-end", async () => {
      const pdfBuffer = await createPdfBuffer([
        "Executive Summary: Anka OS platform architecture.",
        "Detailed Design: Document evidence extraction foundation.",
      ]);

      const spans = await parseDocumentEvidence(pdfBuffer, "pdf");
      expect(spans.length).toBeGreaterThanOrEqual(2);
      expect(spans[0].ordinal).toBe(1);
      expect(spans[0].pageNumber).toBe(1);
      expect(spans[1].ordinal).toBe(2);
      expect(spans[1].pageNumber).toBe(2);
    });
  });
});
