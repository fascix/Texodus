import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { useEditorStore } from '../stores/editor';
import MarkdownPreview from './MarkdownPreview.vue';

// The heavy render extras are irrelevant to link handling and pull in large
// lazy chunks.
vi.mock('../services/mermaidRenderer', () => ({
  renderMermaidBlocks: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/prismHighlighter', () => ({
  ensurePrismLanguages: vi.fn().mockResolvedValue(undefined),
  highlightUnder: vi.fn(),
}));

const openInOs = vi.fn();
vi.mock('@tauri-apps/plugin-shell', () => ({ open: (target: string) => openInOs(target) }));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

/** Mounts the preview over `markdown` and waits out the render debounce. */
async function mountPreview(markdown: string) {
  const store = useEditorStore();
  store.loadFile(markdown, '/docs/note.md');
  const wrapper = mount(MarkdownPreview, { attachTo: document.body });
  await vi.advanceTimersByTimeAsync(200);
  await flushPromises();
  return wrapper;
}

describe('in-page anchors', () => {
  it('scrolls to the heading a table-of-contents link points at', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const wrapper = await mountPreview('- [Second Section](#second-section)\n\n# First\n\n## Second Section\n');
    const heading = wrapper.element.querySelector('#second-section');
    expect(heading).not.toBeNull();

    await wrapper.get('a[href="#second-section"]').trigger('click');

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.instances[0]).toBe(heading);
    expect(openInOs).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('resolves a percent-encoded fragment', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const wrapper = await mountPreview('[go](#%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB)\n\n## Раздел\n');
    await wrapper.get('a').trigger('click');

    expect(scrollIntoView.mock.instances[0]).toBe(wrapper.element.querySelector('#раздел'));
    wrapper.unmount();
  });

  it('does nothing for a fragment with no matching heading', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const wrapper = await mountPreview('[go](#nowhere)\n\n## Somewhere\n');
    await wrapper.get('a').trigger('click');

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(openInOs).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe('TeX preview', () => {
  it('renders inline math in the preview DOM', async () => {
    const wrapper = await mountPreview('Area: $\\pi r^2$');
    await vi.waitFor(() => {
      expect(wrapper.element.querySelector('math')).not.toBeNull();
    });
    expect(wrapper.element.querySelector('math msup')).not.toBeNull();
    wrapper.unmount();
  });
});

describe('hex color swatches', () => {
  it('shows swatches beside plain-text and inline-code colors, but not fenced code', async () => {
    // AC-COLOR-SWATCH-001: preview shows each text color as a swatch beside its hex value.
    const wrapper = await mountPreview('Palette: #f00 and #AABBCC; `#abc`\n\n```txt\n#def\n```');
    const swatches = Array.from(wrapper.element.querySelectorAll('[data-color-swatch]'));

    expect(swatches).toHaveLength(3);
    expect(swatches.map((swatch) => (swatch as HTMLElement).style.backgroundColor)).toEqual([
      'rgb(255, 0, 0)',
      'rgb(170, 187, 204)',
      'rgb(170, 187, 204)',
    ]);
    expect(wrapper.text()).toContain('#f00');
    expect(wrapper.text()).toContain('#AABBCC');
    expect(wrapper.element.querySelector('code')?.textContent).toBe('#abc');
    expect(wrapper.element.querySelector('[data-color-swatch] + code')?.textContent).toBe('#abc');
    expect(wrapper.element.querySelector('pre code')?.textContent).toBe('#def\n');
    expect(wrapper.element.querySelector('code [data-color-swatch]')).toBeNull();
    wrapper.unmount();
  });

  it('shows swatches for inline-code colors in table cells', async () => {
    // AC-COLOR-SWATCH-004: preview colors remain visible when hex values use inline code.
    const markdown = '| Rôle | Couleur |\n| --- | --- |\n| Primaire | `#315F70` |\n| Secondaire | `#52646C` |';
    const wrapper = await mountPreview(markdown);
    const swatches = Array.from(wrapper.element.querySelectorAll('td [data-color-swatch]'));

    expect(swatches.map((swatch) => (swatch as HTMLElement).style.backgroundColor)).toEqual([
      'rgb(49, 95, 112)',
      'rgb(82, 100, 108)',
    ]);
    expect(Array.from(wrapper.element.querySelectorAll('td code')).map((code) => code.textContent)).toEqual([
      '#315F70',
      '#52646C',
    ]);
    wrapper.unmount();
  });
});
