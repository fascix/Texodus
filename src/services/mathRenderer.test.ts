import { describe, expect, it } from 'vitest';
import { createMathRenderer, renderMathSvg } from './mathRenderer';

describe('renderMathSvg', () => {
  it('shares macros only inside the same document renderer', () => {
    const first = createMathRenderer();
    const second = createMathRenderer();
    first('\\newcommand{\\reviewMacro}{123}', false);
    expect(first('\\reviewMacro', false)).not.toContain('fill="red"');
    expect(second('\\reviewMacro', false)).toContain('fill="red"');
    expect(renderMathSvg('\\reviewMacro', false)).toContain('fill="red"');
  });
  it('returns a standalone SVG for inline TeX', () => {
    const svg = renderMathSvg('E=mc^2', false);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox=');
  });

  it('renders display math with the same SVG surface', () => {
    const svg = renderMathSvg('\\frac{a}{b}', true);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('<path');
  });

  it('accepts formulas spanning lines', () => {
    const svg = renderMathSvg('\\Theta(n)\n', false);
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('emits an error SVG instead of throwing on invalid TeX', () => {
    const svg = renderMathSvg('\\frac{a}{b', false);
    expect(svg.startsWith('<svg')).toBe(true);
  });
});
