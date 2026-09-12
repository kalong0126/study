/**
 * 音效：用 Web Audio 纯代码合成，不依赖任何音频文件。
 * 首次点击时会自动 resume（iOS 要求用户手势后才能出声）。
 */

let ac: AudioContext | null = null;

function ctx(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (ac) {
    if (ac.state === "suspended") void ac.resume();
    return ac;
  }
  try {
    ac = new Ctor();
  } catch {
    ac = null;
  }
  return ac;
}

/** 在任意一次用户点击时调用，提前把 AudioContext 解锁 */
export function unlockAudio(): void {
  ctx();
}

type Env = { start: number; attack: number; release: number; peak: number };

function tone(
  c: AudioContext,
  type: OscillatorType,
  freq: number,
  at: number,
  dur: number,
  env: Env,
  freqEnd?: number,
): void {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, at + dur);
  g.gain.setValueAtTime(0.0001, at + env.start);
  g.gain.exponentialRampToValueAtTime(env.peak, at + env.attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + env.release);
  o.connect(g);
  g.connect(c.destination);
  o.start(at + env.start);
  o.stop(at + env.release + 0.02);
}

/** 答对的清脆两声 */
export function playDing(): void {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;
  [880, 1318.5].forEach((f, i) => {
    tone(c, "sine", f, t, 0.32, { start: i * 0.085, attack: i * 0.085 + 0.015, release: i * 0.085 + 0.3, peak: 0.22 });
  });
}

/** 答错的下滑音 */
export function playBuzz(): void {
  const c = ctx();
  if (!c) return;
  tone(c, "square", 250, c.currentTime, 0.24, { start: 0, attack: 0.02, release: 0.24, peak: 0.13 }, 110);
}

/** 庆祝的四连音 */
export function playTada(): void {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    tone(c, "triangle", f, t, 0.36, { start: i * 0.11, attack: i * 0.11 + 0.02, release: i * 0.11 + 0.34, peak: 0.2 });
  });
}
