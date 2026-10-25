import type { ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';

export interface InlineMath {
  svg: string;
  width: number;
  height: number;
  descent: number;
  fontSize: number;
  link?: string;
  linkToDestination?: string;
}

export const MATH_LINK_PREFIX = 'texodus-math:';
const assets = new WeakMap<TDocumentDefinitions, Map<string, InlineMath>>();

// Metrics of pdfmake's bundled Roboto-Regular.ttf, in ems. The placeholder
// explicitly uses this font so app fonts and inherited bold cannot change it.
const ROBOTO_ASCENT = 1900 / 2048;
const ROBOTO_DESCENT = 500 / 2048;
const ROBOTO_SPACE = 508 / 2048;
const ROBOTO_HEIGHT = ROBOTO_ASCENT + ROBOTO_DESCENT;

/** A nonbreaking text slot follows pdfmake's normal wrapping and pagination.
 *  Its temporary annotation records its final position, including in tables
 *  and lists. finishInlineMath replaces only registered slots with vectors. */
export function inlineMathSlot(math: InlineMath, id: string): ContentText {
  const ascent = math.height - math.descent;
  const size = Math.max(math.fontSize, ascent / ROBOTO_ASCENT);
  const height = size * ROBOTO_ASCENT + Math.max(math.descent, math.fontSize * ROBOTO_DESCENT) + 2;
  return {
    text: '\u00a0\u00a0',
    font: 'Roboto', bold: false, italics: false,
    fontSize: size,
    characterSpacing: math.width - 2 * ROBOTO_SPACE * size,
    lineHeight: height / (ROBOTO_HEIGHT * size),
    noWrap: true,
    preserveLeadingSpaces: true,
    preserveTrailingSpaces: true,
    link: MATH_LINK_PREFIX + id,
  };
}

export function registerInlineMath(definition: TDocumentDefinitions, formulas: Map<string, InlineMath>): void {
  if (formulas.size) assets.set(definition, formulas);
}

export function getInlineMath(definition: TDocumentDefinitions): ReadonlyMap<string, InlineMath> {
  return assets.get(definition) ?? new Map();
}

export type PdfBufferRenderer = (definition: TDocumentDefinitions) => Promise<Uint8Array>;

/** pdfmake cannot put SVG in text arrays. Lay out actual text first, then
 *  embed the separately rendered formula pages at the recorded text slots.
 *  This uses PDF objects and public rendering APIs, not pdfmake internals. */
export async function renderPdfWithInlineMath(
  definition: TDocumentDefinitions,
  render: PdfBufferRenderer,
): Promise<Uint8Array> {
  const formulas = assets.get(definition);
  const bytes = await render(definition);
  if (!formulas?.size) return bytes;

  const { PDFDocument, PDFDict, PDFName, PDFArray, PDFString, PDFHexString } = await import('pdf-lib');
  const output = await PDFDocument.load(bytes);
  const entries = [...formulas.entries()];
  const formulaPdf = await render({
    pageMargins: 0,
    content: entries.map(([, math], index) => ({
      svg: math.svg, width: math.width,
      ...(index ? { pageBreak: 'before' as const } : {}),
    })),
  });
  const source = await PDFDocument.load(formulaPdf);
  const embedded = new Map<string, Awaited<ReturnType<typeof output.embedPage>>>();
  for (let i = 0; i < entries.length; i++) {
    const [id, math] = entries[i];
    const page = source.getPage(i);
    embedded.set(id, await output.embedPage(page, {
      left: 0, right: math.width, top: page.getHeight(), bottom: page.getHeight() - math.height,
    }));
  }

  for (const page of output.getPages()) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    for (let i = annotations.size() - 1; i >= 0; i--) {
      const annotation = annotations.lookup(i, PDFDict);
      const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
      const uri = action?.get(PDFName.of('URI'));
      if (!(uri instanceof PDFString || uri instanceof PDFHexString)) continue;
      const link = uri.decodeText();
      if (!link.startsWith(MATH_LINK_PREFIX)) continue;
      const id = link.slice(MATH_LINK_PREFIX.length);
      const math = formulas.get(id);
      const vector = embedded.get(id);
      if (!math || !vector) continue;
      const rect = annotation.lookup(PDFName.of('Rect'), PDFArray);
      const numbers = rect.asRectangle();
      const slot = inlineMathSlot(math, id);
      const baseline = numbers.y + numbers.height - ROBOTO_ASCENT * Number(slot.fontSize);
      page.drawPage(vector, {
        x: numbers.x, y: baseline - math.descent, width: math.width, height: math.height,
      });
      if (math.link && action) {
        action.set(PDFName.of('URI'), PDFString.of(math.link));
      } else if (math.linkToDestination) {
        annotation.delete(PDFName.of('A'));
        annotation.set(PDFName.of('Dest'), PDFString.of(math.linkToDestination));
      } else {
        annotations.remove(i);
      }
    }
  }
  return output.save();
}
