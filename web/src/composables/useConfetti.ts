/**
 * 彩带 / 烟花特效（Canvas 纯代码，单例）
 *
 * 由 FxLayer.vue 注册画布；ui store 在庆祝时调用 burst()。
 * 不抽成 store 的一部分，是因为它纯粹是视图层的东西，不需要参与状态管理。
 */

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  s: number;
  c: string;
  rot: number;
  vr: number;
  shape: "rect" | "circle";
  life: number;
}

const COLORS = ["#FF7AA2", "#FFD93D", "#7ED9C3", "#8ECDF5", "#C9BCFF", "#FFB07C", "#7ED957"];

let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let particles: Particle[] = [];
let raf: number | null = null;

export function attachConfetti(el: HTMLCanvasElement | null): void {
  canvas = el;
  ctx2d = el ? el.getContext("2d") : null;
  if (el) resizeConfetti();
}

export function resizeConfetti(): void {
  if (!canvas || !ctx2d) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function spawn(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (let i = 0; i < 80; i++) {
    particles.push({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.45,
      vx: (Math.random() - 0.5) * 2.4,
      vy: 1.6 + Math.random() * 2.6,
      s: 6 + Math.random() * 7,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      rot: Math.random() * 6.28,
      vr: (Math.random() - 0.5) * 0.28,
      shape: "rect",
      life: 1,
    });
  }
  for (let b = 0; b < 5; b++) {
    const cx = w * (0.14 + 0.72 * Math.random());
    const cy = h * (0.16 + 0.34 * Math.random());
    for (let i = 0; i < 32; i++) {
      const a = Math.random() * 6.2832;
      const sp = 2.4 + Math.random() * 5;
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1.2,
        s: 4 + Math.random() * 4,
        c: COLORS[Math.floor(Math.random() * COLORS.length)],
        rot: 0,
        vr: 0,
        shape: "circle",
        life: 1,
      });
    }
  }
}

function loop(): void {
  if (!ctx2d) return;
  ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += 0.055;
    p.vx *= 0.995;
    p.x += p.vx;
    p.y += p.vy;
    p.rot += p.vr;
    p.life -= 0.0042;
    if (p.life <= 0 || p.y > window.innerHeight + 60) {
      particles.splice(i, 1);
      continue;
    }
    ctx2d.save();
    ctx2d.globalAlpha = Math.max(0, Math.min(1, p.life * 1.7));
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rot);
    ctx2d.fillStyle = p.c;
    if (p.shape === "rect") {
      ctx2d.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
    } else {
      ctx2d.beginPath();
      ctx2d.arc(0, 0, p.s / 2, 0, 6.2832);
      ctx2d.fill();
    }
    ctx2d.restore();
  }
  if (particles.length) {
    raf = requestAnimationFrame(loop);
  } else {
    raf = null;
    ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

export function burst(): void {
  if (!ctx2d) return;
  spawn();
  if (!raf) raf = requestAnimationFrame(loop);
}

/** 满分庆祝：来两轮，营造满屏的感觉 */
export function burstBig(): void {
  burst();
  window.setTimeout(() => {
    resizeConfetti();
    spawn();
    spawn();
    if (!raf) raf = requestAnimationFrame(loop);
  }, 280);
}
