import type { PrismToken } from 'prismjs';
import { COLOR_SCHEMES } from '../themes';
import { tokenizeCode } from './prismHighlighter';

// Exports use a stable light palette, independent of the app's current theme.
const palette = COLOR_SCHEMES.find((scheme) => scheme.id === 'github')!.light;

export interface ExportCodeRun {
  text: string;
  color: string;
  bold: boolean;
  italics: boolean;
}

type TokenStyle = Partial<Omit<ExportCodeRun, 'text'>>;

// Match the token groups in themes/prism.css. Both export formats consume
// these same flat runs, so their colors and nested-token styling agree.
const TOKEN_STYLES: Record<string, TokenStyle> = {};
function styleTokens(names: string, style: TokenStyle) {
  for (const name of names.split(' ')) TOKEN_STYLES[name] = style;
}
styleTokens('comment prolog doctype cdata', { color: palette.syntaxComment, italics: true });
styleTokens('punctuation', { color: palette.syntaxPunctuation });
styleTokens('property tag constant symbol deleted operator entity url variable', { color: palette.syntaxVariable });
styleTokens('boolean number regex important', { color: palette.syntaxNumber });
styleTokens('selector attr-name string char builtin inserted', { color: palette.syntaxString });
styleTokens('atrule attr-value function class-name', { color: palette.syntaxFunction });
styleTokens('keyword', { color: palette.syntaxKeyword, bold: true });
styleTokens('important', { color: palette.syntaxNumber, bold: true });
styleTokens('bold', { bold: true });
styleTokens('italic', { italics: true });

/** Preserve the source verbatim while resolving nested tokens and aliases
 *  into leaf styles. pdfmake drops styles on nested text-array wrappers. */
export async function highlightExportCode(text: string, language?: string): Promise<ExportCodeRun[]> {
  const tokens = await tokenizeCode(text, language);
  const runs: ExportCodeRun[] = [];
  const walk = (
    value: string | PrismToken | (string | PrismToken)[],
    inherited: Omit<ExportCodeRun, 'text'>,
  ) => {
    if (typeof value === 'string') {
      runs.push({ text: value, ...inherited });
    } else if (Array.isArray(value)) {
      for (const child of value) walk(child, inherited);
    } else {
      const aliases = typeof value.alias === 'string' ? [value.alias] : value.alias ?? [];
      const style = { ...inherited };
      for (const name of [value.type, ...aliases]) Object.assign(style, TOKEN_STYLES[name]);
      walk(value.content, style);
    }
  };
  walk(tokens, { color: palette.codeText, bold: false, italics: false });
  return runs;
}

/** Only create text nodes and spans: source code can never become HTML. */
export async function highlightExportCodeBlocks(container: HTMLElement): Promise<void> {
  for (const code of container.querySelectorAll('pre > code')) {
    // Frontmatter keeps its existing muted metadata presentation.
    if (code.parentElement?.classList.contains('frontmatter')) continue;
    const languageClass = Array.from(code.classList).find((name) => name.startsWith('language-'));
    const runs = await highlightExportCode(code.textContent ?? '', languageClass?.slice('language-'.length));
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      const span = document.createElement('span');
      span.textContent = run.text;
      span.style.color = run.color;
      span.style.fontWeight = run.bold ? '600' : 'normal';
      span.style.fontStyle = run.italics ? 'italic' : 'normal';
      fragment.appendChild(span);
    }
    code.replaceChildren(fragment);
  }
}
