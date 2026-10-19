/**
 * Single source of truth for converting markdown to safe HTML.
 *
 * Both the live preview (MarkdownPreview.vue) and the HTML/PDF export
 * pipeline (exportService.ts) used to duplicate the DOMPurify whitelist
 * and the `marked` options. Keeping them in one place ensures sanitization
 * rules can't quietly drift between the two surfaces.
 */
import { marked, type MarkedExtension, type MarkedOptions, type Token, type Tokens } from 'marked';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import DOMPurify from 'dompurify';
import { detectFrontmatterState, extractFrontmatterBody, splitFrontmatter } from '../utils/frontmatter';
import { createHeadingSlugger, htmlToPlainText } from '../utils/headingSlug';

export const MARKED_OPTIONS = {
  breaks: true,
  gfm: true,
  async: false,
} satisfies MarkedOptions & { async: false };

// Heading anchors: marked has emitted plain `<h2>` since v7, so `#section`
// links had no target and clicking a table-of-contents entry did nothing in
// the preview *and* in exported HTML (issue #8). Slugs are GitHub-compatible
// and de-duplicated per document, so the slugger has to be reset at the start
// of every render — see `startDocument` below.
const slugger = createHeadingSlugger();

// GFM task-list checkboxes carry a `data-task` marker so the preview can map
// a clicked checkbox back to its source `[ ]`/`[x]` by index. Without it, a
// raw-HTML `<input type="checkbox">` in the document shifts the DOM index
// against `collectMarkdownTaskCheckboxes` and clicks toggle the wrong item.
// (`disabled` is emitted like stock marked but stripped by the sanitizer —
// that's what makes the checkboxes clickable in the preview.)
//
// MARKED_OPTIONS is folded into the defaults here, and lexMarkdown /
// parseMarkdownTokens below call marked without an options argument: marked's
// `lexer(src, options)` / `parser(tokens, options)` *replace* the defaults
// with explicit options (`options ?? this.defaults`, no merge), which silently
// drops this renderer override — data-task disappears and preview checkbox
// clicks stop mapping back to source markers.
// MathML only: it needs no KaTeX stylesheet or font files, so the same output
// works in the live preview and in self-contained HTML exports.
marked.use(markedKatex({ throwOnError: false, output: 'mathml' }));

interface MultilineKatexToken extends Tokens.Generic {
  type: 'inlineKatexMultiline' | 'blockKatexDollar';
  text: string;
  displayMode: boolean;
}

// The upstream extension refuses newlines inside `$...$`, and treats `$` on
// its own line as inline rather than display math. Both are easy to hit while
// writing TeX in a prose document, so this extension runs first and handles
// those two shapes; upstream still covers `$$...$$`.
const INLINE_TEX = /^\$((?:\\[\s\S]|(?!\n[ \t]*\n)[^\\$])+?)\$(?=[\s?!.,:;？！。，：)\]}]|$)/;
const BLOCK_DOLLAR_TEX = /^\$\n([\s\S]+?)\n\$(?:\n|$)/;

function renderKatexToken(token: MultilineKatexToken): string {
  const html = katex.renderToString(token.text.trim(), {
    throwOnError: false,
    output: 'mathml',
    displayMode: token.displayMode,
  });
  return token.type === 'blockKatexDollar' ? `${html}\n` : html;
}

function multilineKatex(): MarkedExtension {
  return {
    extensions: [
      {
        name: 'blockKatexDollar',
        level: 'block',
        tokenizer(src) {
          const match = BLOCK_DOLLAR_TEX.exec(src);
          if (!match) return;
          return {
            type: 'blockKatexDollar',
            raw: match[0],
            text: match[1],
            displayMode: true,
          };
        },
        renderer(token) {
          return renderKatexToken(token as MultilineKatexToken);
        },
      },
      {
        name: 'inlineKatexMultiline',
        level: 'inline',
        start(src) {
          for (let index = src.indexOf('$'); index >= 0; index = src.indexOf('$', index + 1)) {
            if (index === 0 || src[index - 1] !== '\\') return index;
          }
          return undefined;
        },
        tokenizer(src) {
          const match = INLINE_TEX.exec(src);
          if (!match) return;
          return {
            type: 'inlineKatexMultiline',
            raw: match[0],
            text: match[1],
            displayMode: false,
          };
        },
        renderer(token) {
          return renderKatexToken(token as MultilineKatexToken);
        },
      },
    ],
  };
}

marked.use(multilineKatex());

marked.use({
  ...MARKED_OPTIONS,
  renderer: {
    checkbox({ checked }: Tokens.Checkbox): string {
      return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox" data-task="">`;
    },
    heading({ tokens, depth }: Tokens.Heading): string {
      const inlineHtml = this.parser.parseInline(tokens);
      const id = slugger.slug(htmlToPlainText(inlineHtml));
      // Emitted as data-anchor, promoted to `id` by the hook below — DOMPurify
      // drops an `id` outright when its value names a document property
      // ("title", "body", "images", …), and a heading called "Title" losing
      // its anchor is exactly the case a table of contents hits first.
      return `<h${depth} data-anchor="${escapeHtmlAttribute(id)}">${inlineHtml}</h${depth}>\n`;
    },
  },
});

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

const ALLOWED_TAGS = [
  'h1','h2','h3','h4','h5','h6','p','br','hr',
  'ul','ol','li','blockquote','pre','code',
  // 'u' backs the Underline formatting command (useFormatting inserts <u>…</u>).
  'strong','em','del','u','a','img','table','thead',
  'tbody','tr','th','td','sup','sub','span','div',
  'input',
  // KaTeX MathML output.
  'math','semantics','annotation','mrow','mi','mn','mo','mtext','mspace',
  'msup','msub','msubsup','mfrac','msqrt','mroot','mover','munder',
  'munderover','mtable','mtr','mtd','mstyle','mpadded','mphantom','menclose',
  'mmultiscripts','mprescripts','none',
];

const ALLOWED_ATTR = [
  'href','src','alt','title','class','id','rel','type','checked','data-task','data-anchor',
  // MathML attributes emitted by KaTeX. None can carry a URL or a script.
  'xmlns','display','encoding','mathvariant','displaystyle','scriptlevel',
  'stretchy','fence','separator','lspace','rspace','accent','accentunder',
  'columnalign','columnlines','columnspacing','rowlines','rowspacing',
  'frame','framespacing','width','height','depth','voffset','linethickness',
  'notation','mathcolor','mathbackground','mathsize',
];

/** Exactly the shape `slugifyHeadingText` can produce: letters, digits,
 *  combining marks, `_` and `-`. No quotes, no colons, no dots — nothing that
 *  could carry script or a URL scheme. */
const ANCHOR_ID = /^[\p{L}\p{N}\p{M}_-]+$/u;

/**
 * Promotes the heading renderer's `data-anchor` to a real `id`, after
 * DOMPurify has finished with the element.
 *
 * DOMPurify's anti-clobbering rule strips any `id` whose value is a property
 * name on `document` — which silently killed the anchor on every heading
 * called "Title", "Body" or "Images". Re-applying it here is narrow by
 * construction: only h1–h6, only from an attribute our own renderer writes,
 * and only for slug-shaped values, so no user-authored `id` can reach this
 * path and the value can never be anything but an anchor name.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const anchor = element.getAttribute('data-anchor');
  if (anchor === null) return;
  element.removeAttribute('data-anchor');
  if (!/^h[1-6]$/i.test(element.tagName)) return;
  if (!ANCHOR_ID.test(anchor)) return;
  element.setAttribute('id', anchor);
});

export function sanitizeMarkdownHtml(rawHtml: string): string {
  return DOMPurify.sanitize(rawHtml, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export function lexMarkdown(markdown: string): Token[] {
  return marked.lexer(markdown);
}

/**
 * Resets the per-document anchor state. Every entry point that produces HTML
 * calls it first: duplicate heading text is numbered in document order, so a
 * slugger carried over from the previous render would start counting at the
 * wrong place and shift every repeated anchor.
 */
export function startDocument(): void {
  slugger.reset();
}

export function parseMarkdownTokens(tokens: Token[]): string {
  startDocument();
  return marked.parser(tokens) as string;
}

/**
 * The visible text of an inline markdown fragment, produced by the same
 * pipeline the heading renderer uses. Callers that need to reproduce a
 * heading's anchor (the table-of-contents builder) must slug *this* string,
 * or their links drift from the ids in the rendered HTML.
 *
 * Called without an options argument on purpose — see the note above
 * `marked.use`: passing options replaces the configured defaults.
 */
export function inlineMarkdownToPlainText(markdown: string): string {
  return htmlToPlainText(marked.parseInline(markdown) as string);
}

export function renderMarkdownToHtml(markdown: string): string {
  startDocument();
  return marked.parse(markdown, MARKED_OPTIONS);
}

export async function renderMarkdownToSafeHtml(markdown: string): Promise<string> {
  const { frontmatterYaml, body } = splitRenderableFrontmatter(markdown);
  const frontmatterHtml = frontmatterYaml !== null ? renderFrontmatterHtml(frontmatterYaml) : '';
  return sanitizeMarkdownHtml(frontmatterHtml + renderMarkdownToHtml(body));
}

/**
 * YAML frontmatter isn't markdown: fed straight to `marked`, its `---`
 * delimiters parse as `<hr>`s and the `key: value` lines collapse into a
 * setext `<h2>` — giant bold text at the top of the document. Every render
 * surface (live preview, HTML export, PDF export) must split it off first
 * and render it as a dedicated metadata block.
 */
export interface RenderableMarkdown {
  /** Raw YAML between the `---` delimiters, or null when the document has none. */
  frontmatterYaml: string | null;
  /** The markdown that should reach the marked lexer. */
  body: string;
  /** Source lines consumed by the frontmatter block — shift body line anchors by this. */
  bodyLineOffset: number;
  /** Source chars consumed by the frontmatter block — shift body char positions by this. */
  bodyCharOffset: number;
}

const NO_FRONTMATTER: RenderableMarkdown = Object.freeze({
  frontmatterYaml: null,
  body: '',
  bodyLineOffset: 0,
  bodyCharOffset: 0,
});

export function splitRenderableFrontmatter(markdown: string): RenderableMarkdown {
  // Only a block detected as real frontmatter (opens on the first line and
  // has at least one `key:` line) is split off; an empty or key-less block is
  // more likely deliberate markdown (`---` rules) and stays untouched.
  if (detectFrontmatterState(markdown) !== 'valid') {
    return { ...NO_FRONTMATTER, body: markdown };
  }
  const [raw, body] = splitFrontmatter(markdown);
  let lineOffset = 0;
  for (const c of raw) if (c === '\n') lineOffset++;
  return {
    frontmatterYaml: extractFrontmatterBody(markdown) ?? '',
    body,
    bodyLineOffset: lineOffset,
    bodyCharOffset: raw.length,
  };
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Renders split-off frontmatter as a muted metadata block. The
 *  `language-yaml` class lets the preview's lazy Prism loader pick it up for
 *  key/value highlighting; `frontmatter` styles it apart from real code. */
export function renderFrontmatterHtml(frontmatterYaml: string): string {
  return `<pre class="frontmatter"><code class="language-yaml">${escapeHtmlText(frontmatterYaml)}</code></pre>\n`;
}
