import { describe, expect, it } from 'vitest';
import { COLOR_SCHEMES } from '../themes';
import { highlightExportCode } from './exportCodeHighlighter';

const palette = COLOR_SCHEMES.find((scheme) => scheme.id === 'github')!.light;

describe('export code highlighting', () => {
  it.each(['sql', 'python', 'py', 'PY title="example"'])(
    'loads %s and preserves the complete source',
    async (language) => {
      const sql = language === 'sql';
      const source = sql
        ? "-- example\nSELECT name, 42 FROM users WHERE name = 'Ada';"
        : '# example\ndef greet(name):\n\treturn "Hello " + name  ';
      const runs = await highlightExportCode(source, language);

      expect(runs.map((run) => run.text).join('')).toBe(source);
      expect(runs.find((run) => run.text === (sql ? 'SELECT' : 'def')))
        .toMatchObject({ color: palette.syntaxKeyword, bold: true });
      expect(runs.find((run) => run.text.startsWith(sql ? '--' : '#')))
        .toMatchObject({ color: palette.syntaxComment, italics: true });
      expect(runs.some((run) => run.color === palette.syntaxString)).toBe(true);
    },
  );

  it('flattens nested template-string tokens without losing inherited styles', async () => {
    const source = 'const greeting = `hello ${user.name}`;';
    const runs = await highlightExportCode(source, 'javascript');
    expect(runs.map((run) => run.text).join('')).toBe(source);
    expect(runs.find((run) => run.text === 'hello ')).toMatchObject({ color: palette.syntaxString });
    expect(runs.every((run) => typeof run.text === 'string')).toBe(true);
  });

  it.each([undefined, '', 'unknown-language', 'constructor', '__proto__', 'extend', 'mermaid'])(
    'keeps %s as plain text',
    async (language) => {
      const source = '<script>\n\t  unchanged & text  \n</script>';
      expect(await highlightExportCode(source, language)).toEqual([
        { text: source, color: palette.codeText, bold: false, italics: false },
      ]);
    },
  );
});
