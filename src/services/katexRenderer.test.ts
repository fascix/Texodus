import { describe, expect, it } from 'vitest';
import { renderMarkdownToSafeHtml } from './markdownSanitizer';
import { isKatexReady, renderTexToMathml } from './katexRenderer';
import { collectHeadings } from './tableOfContents';
import { buildPdfDocDefinition } from './exportService';

const headingSource = '# Energy $E=mc^2$';
const coldHeading = collectHeadings(headingSource)[0];

describe('katexRenderer', () => {
  it('starts unloaded', () => {
    expect(isKatexReady()).toBe(false);
  });

  it('stays unloaded for a document without TeX', async () => {
    const html = await renderMarkdownToSafeHtml('# Plain\n\nNo formulas here.');

    expect(html).toContain('<h1');
    expect(isKatexReady()).toBe(false);
  });

  it('loads on demand for a document with TeX', async () => {
    const html = await renderMarkdownToSafeHtml('Area: $\\pi r^2$');

    expect(isKatexReady()).toBe(true);
    expect(html).toContain('<math');
    expect(html).toContain('<msup>');
  });

  it('renders TeX in the requested display mode', () => {
    const inline = renderTexToMathml('\\frac{a}{b}', false);
    const block = renderTexToMathml('\\frac{a}{b}', true);

    expect(inline).toContain('<math');
    expect(inline).not.toContain('display="block"');
    expect(block).toContain('<math');
    expect(block).toContain('display="block"');
  });

  it('keeps heading anchors and labels stable across lazy loading and PDF export', async () => {
    const html = await renderMarkdownToSafeHtml(headingSource);
    const heading = new DOMParser().parseFromString(html, 'text/html').querySelector('h1')!;
    expect(heading.id).toBe(coldHeading.slug);
    expect(collectHeadings(headingSource)[0]).toEqual(coldHeading);
    expect(coldHeading.slug).toBe('energy-emc2');
    const pdf = await buildPdfDocDefinition(headingSource, 'Doc', null);
    expect((pdf.content as { id: string }[])[0].id).toBe(coldHeading.slug);
  });

  it('keeps invalid TeX from throwing', () => {
    expect(renderTexToMathml('\\frac{1}', false)).toContain('katex-error');
  });
});
