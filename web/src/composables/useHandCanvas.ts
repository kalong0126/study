/**
 * 手写板 & 笔迹渲染
 *
 * 几处刻意的设计：
 *   1. **双层 Canvas**：格线层与笔迹层分开。导出时只取笔迹层，格线不会干扰模型识别。
 *   2. **笔迹存归一化坐标（0~1）**：与画布像素无关。横竖屏旋转、容器尺寸变化后
 *      直接按新尺寸重绘即可，笔迹不会丢也不会变形。
 *   3. **touch-action: none + pointer capture**：写字时页面不跟着滚动，手指滑出格子也不断笔。
 *   4. **合成图带红色序号**：N 个字拼成一张图发给多模态模型，一次请求判完（成本 1/N）。
 *      Prompt 里明确说明了「左上角红色序号」，所以这里必须画出来。
 */
import { onBeforeUnmount, ref, shallowRef, type Ref } from "vue";

export interface Pt {
  x: number;
  y: number;
}
export type Stroke = Pt[];

export interface Cell {
  index: number;
  strokes: Stroke[];
}

const INK_COLOR = "#33415A";

/* ------------------------------------------------------------------ 基础绘制 */

/** 画田字格：虚线十字 + 淡斜线 */
export function paintGrid(ctx: CanvasRenderingContext2D, size: number, dash = true): void {
  const m = 5;
  ctx.save();
  ctx.strokeStyle = "#EFC6C6";
  ctx.lineWidth = Math.max(1, size * 0.006);
  if (dash) ctx.setLineDash([size * 0.022, size * 0.019]);
  ctx.beginPath();
  ctx.moveTo(size / 2, m);
  ctx.lineTo(size / 2, size - m);
  ctx.moveTo(m, size / 2);
  ctx.lineTo(size - m, size / 2);
  ctx.stroke();
  if (dash) ctx.setLineDash([]);
  ctx.strokeStyle = "#F7DFDF";
  ctx.lineWidth = Math.max(0.8, size * 0.0044);
  ctx.beginPath();
  ctx.moveTo(m, m);
  ctx.lineTo(size - m, size - m);
  ctx.moveTo(size - m, m);
  ctx.lineTo(m, size - m);
  ctx.stroke();
  ctx.restore();
}

/** 按归一化笔迹绘制（尺寸无关） */
export function drawInk(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  size: number,
  lineWidthRatio = 0.026,
): void {
  const lw = Math.max(3, size * lineWidthRatio);
  ctx.save();
  ctx.strokeStyle = INK_COLOR;
  ctx.fillStyle = INK_COLOR;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (!s.length) continue;
    const pts = s.map((p) => ({ x: p.x * size, y: p.y * size }));
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let j = 1; j < pts.length - 1; j++) {
      ctx.quadraticCurveTo(pts[j].x, pts[j].y, (pts[j].x + pts[j + 1].x) / 2, (pts[j].y + pts[j + 1].y) / 2);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }
  ctx.restore();
}

function newCanvas(size: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, size, size);
  return { c, ctx };
}

/**
 * 单字导出：白底 + 只含笔迹（不带格线）。
 * 用于批量判卷降级成「逐字判卷」时的单张图 —— 单字 Prompt 里没提格线，
 * 所以这里保持和原版一致：只有字。
 */
export function singleDataUrl(strokes: Stroke[], size = 640): string {
  const { c, ctx } = newCanvas(size);
  drawInk(ctx, strokes, size, 0.03);
  try {
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

/** 缩略图：白底 + 淡格线 + 笔迹，给孩子和家长看（不发给模型） */
export function thumbDataUrl(strokes: Stroke[], size = 200): string {
  const { c, ctx } = newCanvas(size);
  paintGrid(ctx, size, false);
  drawInk(ctx, strokes, size, 0.03);
  try {
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

export interface SheetOptions {
  cell?: number;
  gap?: number;
  cols?: number;
  /** 是否在每格左上角标红色序号（批量判卷必须有） */
  showIndex?: boolean;
  /** 是否画田字格（批量 Prompt 说明了「包含 N 个田字格」） */
  showGrid?: boolean;
  maxWidth?: number;
}

/**
 * 合成网格图：N 个字的笔迹按序号排布成一张图。
 * 这是「一次请求判 N 个字」的关键 —— 8 个字从 8 次多模态请求降到 1 次。
 */
export function sheetDataUrl(cells: Cell[], opts: SheetOptions = {}): string {
  const n = cells.length;
  if (!n) return "";
  const gap = opts.gap ?? 12;
  const cols = Math.max(1, Math.min(opts.cols ?? (n <= 4 ? n : 4), n));
  const rows = Math.ceil(n / cols);
  const maxWidth = opts.maxWidth ?? 1600;

  let cell = opts.cell ?? 320;
  let total = cols * cell + (cols + 1) * gap;
  if (total > maxWidth) {
    cell = Math.floor((maxWidth - (cols + 1) * gap) / cols);
    total = cols * cell + (cols + 1) * gap;
  }
  const totalH = rows * cell + (rows + 1) * gap;

  const c = document.createElement("canvas");
  c.width = total;
  c.height = totalH;
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, total, totalH);

  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const x = gap + col * (cell + gap);
    const y = gap + row * (cell + gap);

    // 单元格边框（浅灰，告诉模型这是格子）
    ctx.save();
    ctx.strokeStyle = "#D8DEE8";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cell, cell);
    ctx.restore();

    // 田字格线画在单元格内部坐标系里
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, cell, cell);
    ctx.clip();
    if (opts.showGrid !== false) paintGrid(ctx, cell);
    drawInk(ctx, cells[i].strokes, cell);
    ctx.restore();

    if (opts.showIndex !== false) {
      const label = String(i + 1);
      const fs = Math.max(16, Math.round(cell * 0.1));
      ctx.save();
      ctx.font = `700 ${fs}px -apple-system, "Segoe UI", sans-serif`;
      const tw = ctx.measureText(label).width;
      const pad = Math.round(fs * 0.35);
      const bw = tw + pad * 2;
      const bh = fs + pad;
      ctx.fillStyle = "#FFE5E5";
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x + 6, y + 6, bw, bh, 6);
        ctx.fill();
      } else {
        ctx.fillRect(x + 6, y + 6, bw, bh);
      }
      ctx.fillStyle = "#E03131";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 6 + pad, y + 6 + bh / 2 + 1);
      ctx.restore();
    }
  }

  try {
    return c.toDataURL("image/png");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ 手写板 */

export interface HandCanvasElements {
  /** 正方形外层（量宽度用） */
  square: HTMLElement;
  grid: HTMLCanvasElement;
  ink: HTMLCanvasElement;
}

export interface HandCanvasController {
  /** 当前笔迹（归一化坐标） */
  strokes: Ref<Stroke[]>;
  size: Ref<number>;
  isEmpty: Ref<boolean>;
  clear: () => void;
  load: (strokes: Stroke[]) => void;
  /** 尺寸变化后重绘（旋转屏幕 / 从隐藏变可见时调用） */
  refresh: () => void;
  /** 组件挂载后调用：绑定指针事件 + 监听尺寸变化 */
  start: () => void;
  detach: () => void;
}

export function useHandCanvas(getEls: () => HandCanvasElements | null): HandCanvasController {
  const strokes = shallowRef<Stroke[]>([]);
  const size = ref(0);
  const isEmpty = ref(true);

  let dpr = 1;
  let drawing = false;
  let cur: Stroke | null = null;
  let bound: HTMLCanvasElement | null = null;
  let ro: ResizeObserver | null = null;
  let last: Pt | null = null;

  const touch = (): void => {
    isEmpty.value = strokes.value.length === 0;
  };

  function paintAll(): void {
    const els = getEls();
    if (!els || !size.value) return;
    const ctx = els.ink.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.value, size.value);
      drawInk(ctx, strokes.value, size.value);
    }
  }

  function paintGridLayer(): void {
    const els = getEls();
    if (!els || !size.value) return;
    const ctx = els.grid.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.value, size.value);
    paintGrid(ctx, size.value);
  }

  function refresh(): void {
    const els = getEls();
    if (!els) return;
    const w = Math.round(els.square.clientWidth);
    // 视图隐藏时宽度为 0，直接跳过；等切到该视图时再调用一次
    if (!w || w < 80) return;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const needResize = w !== size.value || nextDpr !== dpr;
    if (needResize) {
      size.value = w;
      dpr = nextDpr;
      for (const c of [els.grid, els.ink]) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(w * dpr);
      }
      paintGridLayer();
    }
    // 尺寸没变也要重绘（例如刚切回视图，画布内容可能被清过）
    paintAll();
    touch();
  }

  function pos(e: PointerEvent): Pt {
    const els = getEls();
    if (!els) return { x: 0, y: 0 };
    const r = els.ink.getBoundingClientRect();
    if (!r.width || !r.height) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }

  function onDown(e: PointerEvent): void {
    if (drawing) return;
    const els = getEls();
    if (!els) return;
    e.preventDefault();
    try {
      els.ink.setPointerCapture(e.pointerId);
    } catch {
      /* 某些浏览器不支持，忽略 */
    }
    drawing = true;
    const p = pos(e);
    cur = [p];
    last = p;
    strokes.value = [...strokes.value, cur];
    touch();
    paintAll();
  }

  function onMove(e: PointerEvent): void {
    if (!drawing || !cur) return;
    e.preventDefault();
    const p = pos(e);
    // 过滤极近的点，避免笔迹数组爆掉
    if (last && Math.abs(p.x - last.x) < 0.0025 && Math.abs(p.y - last.y) < 0.0025) return;
    cur.push(p);
    last = p;
    // shallowRef 不会深层追踪，必须整体替换才能触发依赖更新
    strokes.value = [...strokes.value];
    paintAll();
  }

  function onUp(): void {
    if (!drawing) return;
    drawing = false;
    cur = null;
    last = null;
    touch();
  }

  function onContextMenu(e: Event): void {
    e.preventDefault();
  }

  function bind(): void {
    const els = getEls();
    if (!els || bound === els.ink) return;
    unbind();
    bound = els.ink;
    bound.addEventListener("pointerdown", onDown);
    bound.addEventListener("pointermove", onMove);
    bound.addEventListener("pointerup", onUp);
    bound.addEventListener("pointercancel", onUp);
    bound.addEventListener("pointerleave", onUp);
    bound.addEventListener("contextmenu", onContextMenu);
  }

  function unbind(): void {
    if (!bound) return;
    bound.removeEventListener("pointerdown", onDown);
    bound.removeEventListener("pointermove", onMove);
    bound.removeEventListener("pointerup", onUp);
    bound.removeEventListener("pointercancel", onUp);
    bound.removeEventListener("pointerleave", onUp);
    bound.removeEventListener("contextmenu", onContextMenu);
    bound = null;
  }

  function clear(): void {
    drawing = false;
    cur = null;
    last = null;
    strokes.value = [];
    touch();
    const els = getEls();
    const ctx = els?.ink.getContext("2d");
    if (ctx && size.value) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.value, size.value);
    }
  }

  function load(next: Stroke[]): void {
    drawing = false;
    cur = null;
    last = null;
    strokes.value = next.map((s) => s.map((p) => ({ x: p.x, y: p.y })));
    touch();
    paintAll();
  }

  /** 供组件在挂载后调用：绑定事件 + 监听尺寸 */
  function start(): void {
    bind();
    refresh();
    const els = getEls();
    if (els && !ro) {
      ro = new ResizeObserver(() => refresh());
      ro.observe(els.square);
    }
  }

  function detach(): void {
    unbind();
    if (ro) {
      ro.disconnect();
      ro = null;
    }
  }

  onBeforeUnmount(detach);

  return { strokes, size, isEmpty, clear, load, refresh, start, detach };
}
