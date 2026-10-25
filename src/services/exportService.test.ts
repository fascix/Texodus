import { beforeEach, describe, expect, it } from 'vitest';
import { buildPdfDocDefinition, getExportTitle, renderExportHtml } from './exportService';
import { resetMockTauri, setMockFile } from '../mock-tauri';
import { COLOR_SCHEMES } from '../themes';
import type { ContentText } from 'pdfmake/interfaces';
import { getInlineMath } from './pdfInlineMath';

// The mock fs reads file content back as UTF-8 bytes, so we can predict the
// base64 the exporter will embed from the seeded text.
const IMG_TEXT = 'PNGDATA';
const IMG_BASE64 = btoa(IMG_TEXT);

describe('getExportTitle', () => {
  it('falls back to Untitled without a path', () => {
    expect(getExportTitle(null)).toBe('Untitled');
  });

  it('uses the file name without its extension', () => {
    expect(getExportTitle('/a/b/report.md')).toBe('report');
    expect(getExportTitle('C:\\docs\\notes.markdown')).toBe('notes');
  });

  it('keeps dotfiles whole instead of producing an empty title', () => {
    expect(getExportTitle('/a/.env')).toBe('.env');
  });
});

describe('renderExportHtml', () => {
  it('produces a self-contained document with the rendered markdown', async () => {
    const html = await renderExportHtml('# Hello\n\nSome *text*.', 'My Doc');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>My Doc</title>');
    expect(html).toContain('<style>');
    expect(html).toContain('Hello');
    expect(html).toContain('<em>text</em>');
  });

  it('escapes the title', async () => {
    const html = await renderExportHtml('x', '<b>"T" & Co</b>');
    expect(html).toContain('<title>&lt;b&gt;&quot;T&quot; &amp; Co&lt;/b&gt;</title>');
  });

  it('sanitizes scripts out of the exported body', async () => {
    const html = await renderExportHtml('safe\n\n<script>alert(1)</script>', 'T');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('keeps rendered TeX as MathML in the exported HTML', async () => {
    const html = await renderExportHtml('Energy: $E=mc^2$', 'Physics');
    expect(html).toContain('<math');
    expect(html).toContain('<msup>');
    expect(html).not.toContain('$E=mc^2$');
  });

  it('exports swatches beside plain-text and inline-code colors, but not fenced code', async () => {
    // AC-COLOR-SWATCH-002: HTML export shows text color swatches and preserves code.
    const html = await renderExportHtml('Palette: #f00 and #AABBCC; `#abc`\n\n```txt\n#def\n```', 'Colors');
    const swatches = html.match(/data-color-swatch/g) ?? [];

    expect(swatches).toHaveLength(3);
    expect(html).toContain('background-color: rgb(255, 0, 0)');
    expect(html).toContain('background-color: rgb(170, 187, 204)');
    expect(html).toContain('<code>#abc</code>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const code = doc.querySelector('pre code')!;
    expect(code.textContent).toBe('#def\n');
    expect(code.querySelector('[data-color-swatch]')).toBeNull();
  });

  it('exports swatches for inline-code colors in table cells', async () => {
    // AC-COLOR-SWATCH-005: HTML export colors backticked hex values in tables.
    const markdown = '| Rôle | Couleur |\n| --- | --- |\n| Primaire | `#315F70` |\n| Secondaire | `#52646C` |';
    const html = await renderExportHtml(markdown, 'Colors');

    expect(html.match(/data-color-swatch/g)).toHaveLength(2);
    expect(html).toContain('background-color: rgb(49, 95, 112)');
    expect(html).toContain('background-color: rgb(82, 100, 108)');
    expect(html).toContain('<code>#315F70</code>');
    expect(html).toContain('<code>#52646C</code>');
  });
});

describe('syntax highlighting in HTML and PDF exports (issue #9)', () => {
  const palette = COLOR_SCHEMES.find((scheme) => scheme.id === 'github')!.light;
  const examples = [
    { language: 'sql', source: "-- rows\nSELECT name, 42 FROM users WHERE name = 'Ada';", keyword: 'SELECT' },
    { language: 'python', source: '# greeting\ndef greet(name):\n    return "Hello " + name', keyword: 'def' },
    { language: 'py', source: 'def greet():\n\treturn "Hello"  ', keyword: 'def' },
  ];

  function findCodeBlocks(node: unknown): ContentText[] {
    if (Array.isArray(node)) return node.flatMap(findCodeBlocks);
    if (!node || typeof node !== 'object') return [];
    if ('style' in node && node.style === 'code') return [node as ContentText];
    return Object.values(node).flatMap(findCodeBlocks);
  }

  function parseExport(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  it.each(examples)('highlights $language with matching, self-contained colors', async ({ language, source, keyword }) => {
    const markdown = `\`\`\`${language}\n${source}\n\`\`\``;
    const html = parseExport(await renderExportHtml(markdown, 'Code'));
    const code = html.querySelector('pre code')!;
    expect(code.textContent).toBe(source + '\n');
    const keywordSpan = Array.from(code.querySelectorAll('span')).find((span) => span.textContent === keyword)!;
    const expectedStyle = document.createElement('span').style;
    expectedStyle.color = palette.syntaxKeyword;
    expect(keywordSpan.style.color).toBe(expectedStyle.color);
    expect(keywordSpan.style.fontWeight).toBe('600');
    expect(html.querySelector('script, link[rel="stylesheet"]')).toBeNull();
    expect(html.querySelector('style')!.textContent).not.toContain('var(--');

    const pdf = await buildPdfDocDefinition(markdown, 'Code', null);
    const [block] = findCodeBlocks(pdf.content);
    const runs = block.text as ContentText[];
    expect(runs.map((run) => run.text).join('')).toBe(source);
    expect(runs.every((run) => typeof run.text === 'string')).toBe(true);
    expect(runs.find((run) => run.text === keyword)).toMatchObject({ color: palette.syntaxKeyword, bold: true });
    expect(runs.some((run) => run.color === palette.syntaxString)).toBe(true);
    expect(block).toMatchObject({ preserveLeadingSpaces: true, preserveTrailingSpaces: true });
    expect(block).not.toHaveProperty('image');
  });

  it.each(['', 'unknown-language'])('preserves code with no supported language (%s)', async (language) => {
    const source = '  value < 2 && value > 0\n\tunchanged  ';
    const markdown = `\`\`\`${language}\n${source}\n\`\`\``;
    const html = parseExport(await renderExportHtml(markdown, 'Plain code'));
    expect(html.querySelector('pre code')!.textContent).toBe(source + '\n');
    const pdf = await buildPdfDocDefinition(markdown, 'Plain code', null);
    const [block] = findCodeBlocks(pdf.content);
    expect(block.text).toEqual([{ text: source, color: palette.codeText, bold: false, italics: false }]);
  });

  it('highlights nested fences in quotes and list items', async () => {
    const markdown = '> ```sql\n> SELECT 1;\n> ```\n\n- Example:\n\n  ```py\n  return 2\n  ```';
    const pdf = await buildPdfDocDefinition(markdown, 'Nested code', null);
    const blocks = findCodeBlocks(pdf.content);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => (block.text as ContentText[]).find((run) => run.bold)?.text))
      .toEqual(['SELECT', 'return']);
    const html = parseExport(await renderExportHtml(markdown, 'Nested code'));
    expect(html.querySelectorAll('pre code span[style*="font-weight: 600"]')).toHaveLength(2);
  });

  it('treats HTML-like code as text and still sanitizes the surrounding document', async () => {
    const source = '<script>alert("x")</script>\n<img src=x onerror=alert(1)> & </code>';
    const markdown = `\`\`\`html\n${source}\n\`\`\`\n\n<script>alert("outside")</script>`;
    const html = parseExport(await renderExportHtml(markdown, 'Safe code'));
    expect(html.querySelector('pre code')!.textContent).toBe(source + '\n');
    expect(html.querySelector('script, img')).toBeNull();
  });
});

describe('renderExportHtml — local image embedding', () => {
  beforeEach(() => {
    resetMockTauri();
  });

  it('inlines a relative local image as a data: URI resolved against the file dir', async () => {
    setMockFile('/notes/pics/logo.png', IMG_TEXT);
    const html = await renderExportHtml('![logo](pics/logo.png)', 'Doc', '/notes/doc.md');
    expect(html).toContain(`src="data:image/png;base64,${IMG_BASE64}"`);
    expect(html).not.toContain('pics/logo.png');
  });

  it('inlines an absolute local image path', async () => {
    setMockFile('/assets/photo.jpg', IMG_TEXT);
    const html = await renderExportHtml('![p](/assets/photo.jpg)', 'Doc', '/notes/doc.md');
    expect(html).toContain(`src="data:image/jpeg;base64,${IMG_BASE64}"`);
  });

  it('leaves remote and data: image sources untouched', async () => {
    const html = await renderExportHtml(
      '![a](https://example.com/a.png)\n\n![b](data:image/png;base64,AAAA)',
      'Doc',
      '/notes/doc.md',
    );
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('skips unsupported extensions (kept as-is, not embedded)', async () => {
    setMockFile('/notes/scan.tiff', IMG_TEXT);
    const html = await renderExportHtml('![d](scan.tiff)', 'Doc', '/notes/doc.md');
    expect(html).toContain('src="scan.tiff"');
    expect(html).not.toContain('base64');
  });

  it('leaves relative images untouched when there is no file path', async () => {
    setMockFile('/notes/pics/logo.png', IMG_TEXT);
    const html = await renderExportHtml('![logo](pics/logo.png)', 'Doc', null);
    expect(html).toContain('src="pics/logo.png"');
    expect(html).not.toContain('base64');
  });

  it('leaves the image alone when the file cannot be read', async () => {
    const html = await renderExportHtml('![x](missing.png)', 'Doc', '/notes/doc.md');
    expect(html).toContain('src="missing.png"');
    expect(html).not.toContain('base64');
  });
});

// PDF internal links: the anchors that make `#section` work in the preview and
// in exported HTML become pdfmake named destinations here, so a table of
// contents survives the export (issue #8).
describe('buildPdfDocDefinition — in-page links', () => {
  /** Every node in the content tree, flattened. */
  function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      out.push(record);
      for (const value of Object.values(record)) walk(value, out);
    }
    return out;
  }

  async function nodesFor(markdown: string) {
    const def = await buildPdfDocDefinition(markdown, 'Doc', '/docs/note.md');
    return walk(def.content);
  }

  it('makes each heading a named destination', async () => {
    const nodes = await nodesFor('# First Heading\n\n## Second\n');
    expect(nodes.filter((n) => 'id' in n).map((n) => n.id)).toEqual(['first-heading', 'second']);
  });

  it('links to the destination instead of opening a URL', async () => {
    const nodes = await nodesFor('[Go](#second)\n\n## Second\n');
    const link = nodes.find((n) => 'linkToDestination' in n);
    expect(link?.linkToDestination).toBe('second');
    expect(link?.link).toBeUndefined();
  });

  it('resolves a percent-encoded fragment', async () => {
    const nodes = await nodesFor('[go](#%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB)\n\n## Раздел\n');
    expect(nodes.find((n) => 'linkToDestination' in n)?.linkToDestination).toBe('раздел');
  });

  it('leaves a fragment that names no heading as plain text', async () => {
    const nodes = await nodesFor('[Nowhere](#nope)\n\n## Second\n');
    expect(nodes.some((n) => 'linkToDestination' in n)).toBe(false);
    expect(nodes.some((n) => 'link' in n)).toBe(false);
  });

  it('still opens external links as URLs', async () => {
    const nodes = await nodesFor('[Site](https://example.com)\n');
    expect(nodes.find((n) => 'link' in n)?.link).toBe('https://example.com');
  });

  it('numbers duplicate headings the same way the renderer does', async () => {
    const nodes = await nodesFor('[second](#dup-1)\n\n## Dup\n\n## Dup\n');
    expect(nodes.filter((n) => 'id' in n).map((n) => n.id)).toEqual(['dup', 'dup-1']);
    expect(nodes.find((n) => 'linkToDestination' in n)?.linkToDestination).toBe('dup-1');
  });

  it('links from inside a table cell and a list item too', async () => {
    const nodes = await nodesFor(
      '- [in a list](#target)\n\n| h |\n| - |\n| [in a cell](#target) |\n\n## Target\n',
    );
    expect(nodes.filter((n) => n.linkToDestination === 'target')).toHaveLength(2);
  });
});

// pdfmake collapses a node's `text` array before measuring it and throws away
// the properties of every wrapper it collapses (its own "TODO: Styling in
// nested text"). Inline markup therefore has to be resolved into flat runs:
// nested wrappers silently produced unstyled text and — for links — no
// annotation at all, which is what made exported table-of-contents entries
// dead even though the document definition looked right.
describe('buildPdfDocDefinition — flat inline runs', () => {
  async function runsFor(markdown: string): Promise<Record<string, unknown>[]> {
    const def = await buildPdfDocDefinition(markdown, 'Doc', '/docs/note.md');
    const paragraph = (def.content as unknown as Record<string, unknown>[])[0];
    return paragraph.text as Record<string, unknown>[];
  }

  it('never nests a text array inside another', async () => {
    const runs = await runsFor('plain **bold** *em* ~~gone~~ `code` [x](https://e.com)\n');
    for (const run of runs) expect(typeof run.text).toBe('string');
  });

  it('puts bold and italics on the run itself', async () => {
    const runs = await runsFor('plain **bold** *em*\n');
    expect(runs.find((r) => r.text === 'bold')?.bold).toBe(true);
    expect(runs.find((r) => r.text === 'em')?.italics).toBe(true);
    expect(runs.find((r) => r.text === 'plain ')?.bold).toBeUndefined();
  });

  it('keeps formatting inside a link together with the jump', async () => {
    const def = await buildPdfDocDefinition('[**bold** link](#target)\n\n## Target\n', 'Doc', null);
    const runs = (def.content as unknown as Record<string, unknown>[])[0].text as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ text: 'bold', bold: true, linkToDestination: 'target' });
    expect(runs[1]).toMatchObject({ text: ' link', linkToDestination: 'target' });
  });

  it('merges decorations rather than replacing them', async () => {
    const runs = await runsFor('~~[gone](https://e.com)~~\n');
    expect(runs[0].decoration).toEqual(['lineThrough', 'underline']);
  });

  it('drops the link props but keeps the text for an unresolvable fragment', async () => {
    const runs = await runsFor('[**nowhere**](#nope)\n');
    expect(runs[0]).toMatchObject({ text: 'nowhere', bold: true });
    expect(runs[0].link).toBeUndefined();
    expect(runs[0].linkToDestination).toBeUndefined();
  });
});

describe('buildPdfDocDefinition — hex color swatches', () => {
  function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      out.push(record);
      for (const value of Object.values(record)) walk(value, out);
    }
    return out;
  }

  it('adds colored inline runs beside text colors and preserves code literals', async () => {
    // AC-COLOR-SWATCH-003: PDF export shows a colored swatch beside each plain-text color.
    const def = await buildPdfDocDefinition('Palette: #f00 and #AABBCC; `#abc`\n\n```txt\n#def\n```', 'Colors', null);
    const nodes = walk(def.content);
    const paragraph = nodes.find((node) => node.style === 'paragraph');
    const runs = paragraph?.text as Record<string, unknown>[];
    const firstColor = runs.findIndex((run) => run.text === '#f00');
    const secondColor = runs.findIndex((run) => run.text === '#AABBCC');

    expect(runs[firstColor + 1]).toMatchObject({ text: '  ', background: '#ff0000' });
    expect(runs[secondColor + 1]).toMatchObject({ text: '  ', background: '#aabbcc' });
    const inlineCodeColor = runs.findIndex((run) => run.text === '#abc');
    expect(runs[inlineCodeColor + 1]).toMatchObject({ text: '  ', background: '#aabbcc' });
    expect(JSON.stringify(def.content)).toContain('#f00');
    expect(JSON.stringify(def.content)).toContain('#AABBCC');
    expect(JSON.stringify(def.content)).toContain('#abc');
    expect(JSON.stringify(def.content)).toContain('#def');
  });

  it('adds swatches for inline-code colors in table cells', async () => {
    // AC-COLOR-SWATCH-006: PDF export colors backticked hex values in tables.
    const markdown = '| Rôle | Couleur |\n| --- | --- |\n| Primaire | `#315F70` |\n| Secondaire | `#52646C` |';
    const def = await buildPdfDocDefinition(markdown, 'Colors', null);
    const swatches = walk(def.content).filter((node) => typeof node.background === 'string');

    expect(swatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: '  ', background: '#315f70' }),
      expect.objectContaining({ text: '  ', background: '#52646c' }),
    ]));
    expect(JSON.stringify(def.content)).toContain('#315F70');
    expect(JSON.stringify(def.content)).toContain('#52646C');
  });
});

describe('buildPdfDocDefinition — TeX math', () => {
  function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out);
      return out;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      out.push(record);
      for (const value of Object.values(record)) walk(value, out);
    }
    return out;
  }

  async function mathSvgsFor(markdown: string) {
    const def = await buildPdfDocDefinition(markdown, 'Doc', null);
    return [...walk(def.content).filter((node) => typeof node.svg === 'string'), ...getInlineMath(def).values()];
  }

  it('renders inline math as SVG instead of raw TeX', async () => {
    const svgs = await mathSvgsFor('Energy: $E=mc^2$');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
    expect(Number(svgs[0].width)).toBeGreaterThan(5);
    expect(JSON.stringify(svgs)).not.toContain('$E=mc^2$');
  });

  it('renders display math from $$ blocks', async () => {
    const svgs = await mathSvgsFor('$$\n\\frac{a}{b}\n$$');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders a single-dollar display block', async () => {
    const svgs = await mathSvgsFor('$\n\\Theta(n)\n$');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders display math containing inline math inside \\text', async () => {
    const svgs = await mathSvgsFor(
      '$\nC_4(n)=\\Theta(1)+\\Theta(1)+\\cdots+\\Theta(1)\n\\quad\\text{($\\Theta(n)$ termes),}\n$',
    );
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders inline math containing inline math inside \\text', async () => {
    const svgs = await mathSvgsFor('Count: $\\text{($\\Theta(n)$ termes)}$');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders LaTeX inline delimiters', async () => {
    const svgs = await mathSvgsFor('Euler: \\(e^{i\\pi}+1=0\\)');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders LaTeX display delimiters', async () => {
    const svgs = await mathSvgsFor('\\[\n\\frac{a}{b}\n\\]');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].svg).toContain('<svg');
  });

  it('renders equation and align environments', async () => {
    const equation = await mathSvgsFor('\\begin{equation}\nx=1\n\\end{equation}');
    expect(equation).toHaveLength(1);
    expect(equation[0].svg).toContain('<svg');

    const align = await mathSvgsFor('\\begin{align}\na&=b\\\\\nc&=d\n\\end{align}');
    expect(align).toHaveLength(1);
    expect(align[0].svg).toContain('<svg');

    const multline = await mathSvgsFor('\\begin{multline}\na+b+c\\\\\n=d\n\\end{multline}');
    expect(multline).toHaveLength(1);
    expect(multline[0].svg).toContain('<svg');

    const eqnarray = await mathSvgsFor('\\begin{eqnarray}\na&=&b\\\\\nc&=&d\n\\end{eqnarray}');
    expect(eqnarray).toHaveLength(1);
    expect(eqnarray[0].svg).toContain('<svg');
  });

  it('keeps every formula when a paragraph has several', async () => {
    const svgs = await mathSvgsFor('$a$ and $b$');
    expect(svgs).toHaveLength(2);
  });

  it('renders inline formulas that wrap across lines', async () => {
    const svgs = await mathSvgsFor('Runtime is $\\Theta(n)\n$.');
    expect(svgs).toHaveLength(1);
  });
});
