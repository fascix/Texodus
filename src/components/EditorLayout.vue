<template>
  <div
    class="editor-container"
    :class="[layoutMode, { 'column-edge-active': edgeHover || columnDragPointerId !== null }]"
    :style="containerStyle"
    ref="containerRef"
    @pointerdown.capture="startColumnDrag"
    @pointermove="updateEdgeHover"
    @pointerleave="edgeHover = false"
  >
    <Transition name="panel">
      <div v-if="layoutMode !== 'preview'" class="editor-pane" :style="paneStyle">
        <slot name="editor"></slot>
      </div>
    </Transition>
    <div
      v-if="layoutMode === 'split'"
      class="pane-divider"
      role="separator"
      aria-orientation="vertical"
      @pointerdown="startDrag"
    ></div>
    <Transition name="panel">
      <div v-if="layoutMode !== 'focus'" class="preview-pane" :style="paneStyle">
        <slot name="preview"></slot>
      </div>
    </Transition>
    <template v-if="columnGuides">
      <div class="column-guide" :style="{ left: `${columnGuides.left}px` }"></div>
      <div class="column-guide" :style="{ left: `${columnGuides.right}px` }"></div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { type LayoutMode, useSettingsStore } from '../stores/settings';

// Smallest side gutter of the text column in the single-pane layouts. Shared by
// the padding formula (via --column-min-gutter) and the drag's fit limit.
const COLUMN_MIN_GUTTER_REM = 2.5;
// Place resize guides in the gutters, leaving room to select text at its edges.
const COLUMN_EDGE_OFFSET_PX = 16;
// How far from a column edge (either side) the pointer still grabs it.
const COLUMN_EDGE_HIT_PX = 6;

const props = defineProps<{
  layoutMode: LayoutMode;
}>();

const settingsStore = useSettingsStore();
const containerRef = ref<HTMLElement | null>(null);

const paneStyle = computed(() => {
  if (props.layoutMode !== 'split') return {};
  return { flex: `0 0 ${settingsStore.splitRatio * 100}%` };
});

// `100%` makes the padding formula collapse to the minimum gutter, so 'full'
// and 'fixed' share one CSS rule.
const contentMaxWidth = computed(() =>
  settingsStore.contentWidthMode === 'full' ? '100%' : `${settingsStore.contentWidth}px`);

const containerStyle = computed(() => ({
  '--content-max-width': contentMaxWidth.value,
  '--column-min-gutter': `${COLUMN_MIN_GUTTER_REM}rem`,
}));

// ── Draggable divider ────────────────────────────────────────────────────

let dragPointerId: number | null = null;
let dragHandle: HTMLElement | null = null;

function startDrag(event: PointerEvent) {
  if (dragPointerId !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault();
  if (!containerRef.value) return;

  dragPointerId = event.pointerId;
  dragHandle = event.currentTarget as HTMLElement;
  dragHandle.setPointerCapture?.(event.pointerId);
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';
  document.addEventListener('pointermove', handleDragMove);
  document.addEventListener('pointerup', stopDrag);
  document.addEventListener('pointercancel', stopDrag);
}

function handleDragMove(event: PointerEvent) {
  if (event.pointerId !== dragPointerId) return;
  const rect = containerRef.value?.getBoundingClientRect();
  if (!rect || rect.width <= 0) return;

  // Read the current rect on every move: the window can be resized while the
  // pointer is held, and using the pointerdown rect makes the ratio drift.
  settingsStore.setSplitRatio((event.clientX - rect.left) / rect.width);
}

function stopDrag(event?: PointerEvent) {
  if (dragPointerId === null) return;
  if (event && event.pointerId !== dragPointerId) return;

  if (dragHandle?.hasPointerCapture?.(dragPointerId)) {
    dragHandle.releasePointerCapture(dragPointerId);
  }
  dragPointerId = null;
  dragHandle = null;
  document.removeEventListener('pointermove', handleDragMove);
  document.removeEventListener('pointerup', stopDrag);
  document.removeEventListener('pointercancel', stopDrag);
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
  settingsStore.persistSplitRatio();
}

// ── Text column width (single-pane layouts) ──────────────────────────────
// The column is the scroller's content box: its side padding centres it (see
// the style block). Dragging either guide in the side gutters resizes it
// symmetrically around the centre. Guides are hit-tested instead of using handle
// elements: an overlay strip would swallow wheel events over the text.

function columnScroller(): HTMLElement | null {
  const selector = props.layoutMode === 'focus'
    ? '.editor-pane .cm-scroller'
    : props.layoutMode === 'preview' ? '.preview-pane .preview-content' : null;
  return selector ? containerRef.value?.querySelector<HTMLElement>(selector) ?? null : null;
}

/** Viewport x of the left/right resize guides, plus the widest column that
 *  still keeps the minimum gutters. */
function columnGeometry(scroller: HTMLElement) {
  const rect = scroller.getBoundingClientRect();
  const style = getComputedStyle(scroller);
  const inner = rect.left + scroller.clientLeft;
  const left = inner + (parseFloat(style.paddingLeft) || 0) - COLUMN_EDGE_OFFSET_PX;
  const right = inner + scroller.clientWidth - (parseFloat(style.paddingRight) || 0)
    + COLUMN_EDGE_OFFSET_PX;
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return {
    left,
    right,
    top: rect.top,
    bottom: rect.bottom,
    maxFit: scroller.clientWidth - 2 * COLUMN_MIN_GUTTER_REM * rootPx,
  };
}

function isOnColumnEdge(event: PointerEvent, scroller: HTMLElement): boolean {
  const g = columnGeometry(scroller);
  if (event.clientY < g.top || event.clientY > g.bottom) return false;
  return Math.abs(event.clientX - g.left) <= COLUMN_EDGE_HIT_PX
    || Math.abs(event.clientX - g.right) <= COLUMN_EDGE_HIT_PX;
}

const edgeHover = ref(false);
const columnDragPointerId = ref<number | null>(null);
let columnDragCenter = 0;
let columnDragMaxFit = 0;
/** Guide lines shown while an edge is hovered or dragged, in container px. */
const columnGuides = ref<{ left: number; right: number } | null>(null);

function refreshColumnGuides() {
  const scroller = columnScroller();
  const container = containerRef.value;
  if (!scroller || !container || (!edgeHover.value && columnDragPointerId.value === null)) {
    columnGuides.value = null;
    return;
  }
  const g = columnGeometry(scroller);
  const origin = container.getBoundingClientRect().left;
  columnGuides.value = { left: g.left - origin, right: g.right - origin };
}

watch(edgeHover, refreshColumnGuides);

function updateEdgeHover(event: PointerEvent) {
  if (columnDragPointerId.value !== null) return;
  const scroller = columnScroller();
  // Buttons held: a text selection is being dragged across the edge.
  edgeHover.value = !!scroller && event.buttons === 0 && isOnColumnEdge(event, scroller);
}

function startColumnDrag(event: PointerEvent) {
  if (columnDragPointerId.value !== null) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const scroller = columnScroller();
  if (!scroller || !isOnColumnEdge(event, scroller)) return;
  // Capture phase + preventDefault: CodeMirror must not start a selection,
  // and the compat mousedown it listens for is suppressed by this.
  event.preventDefault();
  event.stopPropagation();

  const g = columnGeometry(scroller);
  columnDragCenter = (g.left + g.right) / 2;
  columnDragMaxFit = g.maxFit;
  columnDragPointerId.value = event.pointerId;
  containerRef.value?.setPointerCapture?.(event.pointerId);
  document.body.style.userSelect = 'none';
  document.addEventListener('pointermove', handleColumnDragMove);
  document.addEventListener('pointerup', stopColumnDrag);
  document.addEventListener('pointercancel', stopColumnDrag);
  refreshColumnGuides();
}

function handleColumnDragMove(event: PointerEvent) {
  if (event.pointerId !== columnDragPointerId.value) return;
  const width = Math.min(
    2 * (Math.abs(event.clientX - columnDragCenter) - COLUMN_EDGE_OFFSET_PX),
    columnDragMaxFit,
  );
  // Grabbing the edge of a full-width column turns it into a fixed one.
  settingsStore.setContentWidthMode('fixed');
  settingsStore.setContentWidth(width);
  void nextTick(refreshColumnGuides);
}

function stopColumnDrag(event?: PointerEvent) {
  const pointerId = columnDragPointerId.value;
  if (pointerId === null) return;
  if (event && event.pointerId !== pointerId) return;

  if (containerRef.value?.hasPointerCapture?.(pointerId)) {
    containerRef.value.releasePointerCapture(pointerId);
  }
  columnDragPointerId.value = null;
  document.removeEventListener('pointermove', handleColumnDragMove);
  document.removeEventListener('pointerup', stopColumnDrag);
  document.removeEventListener('pointercancel', stopColumnDrag);
  document.body.style.userSelect = '';
  edgeHover.value = false;
  refreshColumnGuides();
}

// Rewrapping the preview moves every block, so the same scrollTop would land
// on different text. Pin the block at the top of the viewport (and the
// fraction of it scrolled past) across the width change. The editor needs no
// help: CodeMirror keeps its own scroll anchor when it re-measures.
let restorePreviewScroll: (() => void) | null = null;

watch(contentMaxWidth, () => {
  restorePreviewScroll = null;
  if (props.layoutMode !== 'preview') return;
  const scroller = columnScroller();
  if (!scroller) return;
  const top = scroller.scrollTop;
  const blocks = scroller.querySelectorAll<HTMLElement>('[data-source-line]');
  const block = Array.from(blocks).find((b) => b.offsetTop + b.offsetHeight > top);
  if (!block) return;
  const fraction = block.offsetHeight > 0 ? (top - block.offsetTop) / block.offsetHeight : 0;
  restorePreviewScroll = () => {
    scroller.scrollTop = block.offsetTop + fraction * block.offsetHeight;
  };
}, { flush: 'pre' });

watch(contentMaxWidth, () => {
  restorePreviewScroll?.();
  restorePreviewScroll = null;
}, { flush: 'post' });

// Leaving split mode must end an in-progress gesture without resetting the
// user's ratio; it will be reused when split mode is selected again.
watch(() => props.layoutMode, (mode) => {
  if (mode !== 'split') stopDrag();
  stopColumnDrag();
  edgeHover.value = false;
});

onUnmounted(() => {
  stopDrag();
  stopColumnDrag();
});
</script>

<style scoped>
.editor-container {
  display: flex;
  flex: 1;
  overflow: hidden;
  width: 100%;
  background: var(--bg-color);
  transition: background 0.25s;
  /* Containing block for the column guides. */
  position: relative;
}

.editor-pane,
.preview-pane {
  flex: 1;
  height: 100%;
  overflow: hidden;
  min-width: 0;
}

/* Resize divider */
.pane-divider {
  width: 5px;
  background: var(--border-color);
  flex-shrink: 0;
  cursor: col-resize;
  touch-action: none;
  transition: background 0.15s;
  position: relative;
  z-index: 1;
}

.pane-divider:hover,
.pane-divider:active {
  background: var(--accent-color);
}

/* Single-pane modes: pane spans the full window so the scroll container
   covers the entire surface (otherwise the side gutters swallow scroll
   events). Content is centered visually via dynamic horizontal padding on
   the inner scrollable element, not via constraining the outer pane.
   --content-max-width is the column width ('100%' in full-width mode); the
   max() keeps the column from ever exceeding the pane minus the gutters. */
.editor-container.preview .preview-pane :deep(.preview-content),
.editor-container.focus .editor-pane :deep(.cm-scroller) {
  padding-left: max(var(--column-min-gutter), calc((100% - var(--content-max-width)) / 2));
  padding-right: max(var(--column-min-gutter), calc((100% - var(--content-max-width)) / 2));
}

/* Column edge hovered or dragged: the resize cursor must beat CodeMirror's
   text cursor on the content underneath. */
.editor-container.column-edge-active,
.editor-container.column-edge-active :deep(*) {
  cursor: col-resize !important;
}

.column-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: var(--accent-color);
  opacity: 0.5;
  pointer-events: none;
}

/* ── Panel transition (§2.3) ── */
.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.panel-enter-from {
  opacity: 0;
  transform: translateX(12px);
}

.panel-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}
</style>
