import { describe, expect, it } from 'vitest';
import pdfMake from 'pdfmake/build/pdfmake';
import vfs from 'pdfmake/build/vfs_fonts';
import { PDFDocument, PDFDict, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { buildPdfDocDefinition } from './exportService';
import { getInlineMath, renderPdfWithInlineMath } from './pdfInlineMath';

pdfMake.addVirtualFileSystem(vfs);
const render = async (definition: TDocumentDefinitions): Promise<Uint8Array> =>
  new Uint8Array(await pdfMake.createPdf(definition).getBuffer());

describe('inline math in actual PDFs', () => {
  it('keeps inline and nested formulas inside their text paragraphs', async () => {
    const definition = await buildPdfDocDefinition('Energy $E=mc^2$ is conserved. **$\\frac{a}{b}$**', 'Doc', null);
    expect(definition.content).toHaveLength(1);
    expect(getInlineMath(definition).size).toBe(2);
    const paragraph = (definition.content as { text: { text: string }[] }[])[0];
    expect(paragraph.text.map((run) => run.text).join('')).toContain(' is conserved. ');
    expect(JSON.stringify(definition.content)).not.toContain('\\frac');

    const bytes = await renderPdfWithInlineMath(definition, render);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const page = pdf.getPage(0);
    expect(page.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).keys()).toHaveLength(2);
    expect(page.node.Annots()?.size() ?? 0).toBe(0);
  });

  it('lays out formulas in headings, lists, and table cells and preserves links', async () => {
    const markdown = '# Target $x$\n\n- A *$y$* item\n\n| formula | link |\n| --- | --- |\n| $z$ | [$w$](https://example.com) |\n\n[$a$](#target-x)';
    const definition = await buildPdfDocDefinition(markdown, 'Doc', null);
    expect(getInlineMath(definition).size).toBe(5);
    const bytes = await renderPdfWithInlineMath(definition, render);
    const pdf = await PDFDocument.load(bytes);
    const uris: string[] = [];
    let destinations = 0;
    for (const page of pdf.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;
      for (let i = 0; i < annotations.size(); i++) {
        const annotation = annotations.lookup(i, PDFDict);
        if (annotation.has(PDFName.of('Dest'))) destinations++;
        const action = annotation.lookupMaybe(PDFName.of('A'), PDFDict);
        const uri = action?.get(PDFName.of('URI'));
        if (uri instanceof PDFString || uri instanceof PDFHexString) uris.push(uri.decodeText());
      }
    }
    expect(uris).toEqual(['https://example.com']);
    expect(destinations).toBe(1);
  });

  it('leaves PDFs without inline math on the normal rendering path', async () => {
    const definition = await buildPdfDocDefinition('Plain text', 'Doc', null);
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await renderPdfWithInlineMath(definition, async () => bytes)).toBe(bytes);
  });

  it('places a formula on the page selected by normal paragraph pagination', async () => {
    const markdown = 'A long paragraph. '.repeat(1500) + '\n\nFinal $x^2$ formula.';
    const definition = await buildPdfDocDefinition(markdown, 'Doc', null);
    const pdf = await PDFDocument.load(await renderPdfWithInlineMath(definition, render));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    const last = pdf.getPages().at(-1)!;
    expect(last.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).keys()).toHaveLength(1);
    expect(last.node.Annots()?.size() ?? 0).toBe(0);
  });

  it('exports macro definitions followed by inline uses', async () => {
    const markdown = '$\\newcommand{\\testmacro}{123}$\n\nValue $\\testmacro$.';
    const definition = await buildPdfDocDefinition(markdown, 'Doc', null);
    const pdf = await PDFDocument.load(await renderPdfWithInlineMath(definition, render));
    expect(pdf.getPageCount()).toBe(1);
  });
});
