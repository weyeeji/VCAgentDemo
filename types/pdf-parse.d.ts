declare module "pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfParseResult>;
}
