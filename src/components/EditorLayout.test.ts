import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { useSettingsStore } from '../stores/settings';
import EditorLayout from './EditorLayout.vue';

function pointerEvent(type: string, clientX: number, pointerId = 7): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('EditorLayout divider', () => {
  it('uses pointer events, current container geometry, and persists the ratio', async () => {
    const wrapper = mount(EditorLayout, {
      props: { layoutMode: 'split' },
      slots: { editor: 'Editor', preview: 'Preview' },
    });
    const store = useSettingsStore();
    const container = wrapper.get('.editor-container').element as HTMLElement;
    let width = 100;
    container.getBoundingClientRect = () => ({
      x: 10, y: 0, left: 10, right: 10 + width, top: 0, bottom: 100,
      width, height: 100, toJSON: () => ({}),
    });

    wrapper.get('.pane-divider').element.dispatchEvent(pointerEvent('pointerdown', 60));
    document.dispatchEvent(pointerEvent('pointermove', 60));
    expect(store.splitRatio).toBe(0.5);

    // Reflow during the gesture: the second move must use the new width.
    width = 200;
    document.dispatchEvent(pointerEvent('pointermove', 160));
    expect(store.splitRatio).toBe(0.75);

    document.dispatchEvent(pointerEvent('pointerup', 160));
    await wrapper.vm.$nextTick();
    expect(JSON.parse(localStorage.getItem('texodus.splitRatio.v1')!)).toBe(0.75);
    expect(wrapper.get('.editor-pane').attributes('style')).toContain('75%');
  });

  it('keeps the ratio when leaving and returning to split mode', async () => {
    const store = useSettingsStore();
    store.setSplitRatio(0.7);
    const wrapper = mount(EditorLayout, { props: { layoutMode: 'split' } });

    await wrapper.setProps({ layoutMode: 'preview' });
    await wrapper.setProps({ layoutMode: 'split' });

    expect(store.splitRatio).toBe(0.7);
    expect(wrapper.get('.editor-pane').attributes('style')).toContain('70%');
  });
});

describe('EditorLayout text column', () => {
  function mountPreview() {
    const wrapper = mount(EditorLayout, {
      props: { layoutMode: 'preview' },
      slots: {
        preview: '<div class="preview-content" style="padding-left: 100px; padding-right: 100px"></div>',
      },
      attachTo: document.body,
    });
    const scroller = wrapper.get('.preview-content').element as HTMLElement;
    Object.defineProperty(scroller, 'clientWidth', { value: 1000 });
    scroller.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, right: 1000, top: 0, bottom: 500,
      width: 1000, height: 500, toJSON: () => ({}),
    });
    return { wrapper, scroller };
  }

  it('exposes the column width to CSS, as 100% in full-width mode', async () => {
    const store = useSettingsStore();
    const wrapper = mount(EditorLayout, { props: { layoutMode: 'preview' } });
    const style = () => wrapper.get('.editor-container').attributes('style');
    expect(style()).toContain('--content-max-width: 780px');

    store.setContentWidth(1040);
    await wrapper.vm.$nextTick();
    expect(style()).toContain('--content-max-width: 1040px');

    store.setContentWidthMode('full');
    await wrapper.vm.$nextTick();
    expect(style()).toContain('--content-max-width: 100%');
  });

  it('resizes the column symmetrically by dragging an edge', async () => {
    const store = useSettingsStore();
    store.setContentWidthMode('full');
    const { wrapper, scroller } = mountPreview();
    const childDown = vi.fn();
    scroller.addEventListener('pointerdown', childDown);

    // Text ends at 900; the resize guide is 16px into the gutter.
    scroller.dispatchEvent(pointerEvent('pointerdown', 919));
    expect(childDown).not.toHaveBeenCalled();
    document.dispatchEvent(pointerEvent('pointermove', 866));
    expect(store.contentWidthMode).toBe('fixed');
    expect(store.contentWidth).toBe(700);

    // Never wider than the pane minus both minimum gutters (2.5rem = 40px).
    document.dispatchEvent(pointerEvent('pointermove', 2000));
    expect(store.contentWidth).toBe(920);

    document.dispatchEvent(pointerEvent('pointerup', 2000));
    document.dispatchEvent(pointerEvent('pointermove', 600));
    expect(store.contentWidth).toBe(920);
    wrapper.unmount();
  });

  it('keeps resize guides and their hit areas outside the text', async () => {
    const { wrapper, scroller } = mountPreview();
    const childDown = vi.fn();
    scroller.addEventListener('pointerdown', childDown);

    // Both text edges and the space just outside them allow selection.
    for (const x of [94, 100, 106, 894, 900, 906]) {
      scroller.dispatchEvent(pointerEvent('pointermove', x));
      await wrapper.vm.$nextTick();
      expect(wrapper.find('.column-guide').exists()).toBe(false);

      const down = pointerEvent('pointerdown', x);
      scroller.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(false);
    }
    expect(childDown).toHaveBeenCalledTimes(6);

    for (const x of [84, 916]) {
      scroller.dispatchEvent(pointerEvent('pointermove', x));
      await wrapper.vm.$nextTick();
      expect(wrapper.findAll('.column-guide').map((guide) => guide.attributes('style')))
        .toEqual(['left: 84px;', 'left: 916px;']);

      const down = pointerEvent('pointerdown', x);
      scroller.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      document.dispatchEvent(pointerEvent('pointerup', x));
      await wrapper.vm.$nextTick();
    }
    wrapper.unmount();
  });

  it('leaves pointer presses away from the edges to the content', () => {
    const store = useSettingsStore();
    const { wrapper, scroller } = mountPreview();
    const childDown = vi.fn();
    scroller.addEventListener('pointerdown', childDown);

    scroller.dispatchEvent(pointerEvent('pointerdown', 500));
    document.dispatchEvent(pointerEvent('pointermove', 700));
    expect(childDown).toHaveBeenCalled();
    expect(store.contentWidth).toBe(780);
    wrapper.unmount();
  });

  it('does not offer column resizing in split view', () => {
    const store = useSettingsStore();
    const wrapper = mount(EditorLayout, {
      props: { layoutMode: 'split' },
      slots: { preview: '<div class="preview-content"></div>' },
    });
    wrapper.get('.preview-content').element.dispatchEvent(pointerEvent('pointerdown', 0));
    document.dispatchEvent(pointerEvent('pointermove', 100));
    expect(store.contentWidth).toBe(780);
  });
});
