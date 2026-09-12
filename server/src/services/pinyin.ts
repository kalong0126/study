/**
 * 拼音工具
 *
 * 关键技巧：**用组词来给单字注音**。
 * 单字注音对多音字会出错（「发」默认给 fā，但《妈妈睡了》里是「头发」fà；
 * 「哄」默认 hōng，课文里是「哄睡」hǒng；「朝」默认 zhāo，课文里是「朝向」cháo）。
 * 拿组词整体注音、再取目标字那一位，就能自动拿到正确读音。
 */
import { pinyin } from "pinyin-pro";

/** 给单字注音；给了组词就借助组词语境消歧 */
export function charPinyin(ch: string, word?: string): string {
  const w = (word || "").trim();
  if (w.length > 1) {
    const idx = w.indexOf(ch);
    if (idx >= 0) {
      try {
        const arr = pinyin(w, { type: "array", toneType: "symbol" }) as string[];
        if (arr[idx]) return arr[idx];
      } catch {
        /* 落到下面的单字注音 */
      }
    }
  }
  try {
    return pinyin(ch, { type: "array", toneType: "symbol" })[0] || "";
  } catch {
    return "";
  }
}

/** 整段文本逐字注音，返回与文本等长的数组（非汉字原样保留） */
export function textPinyin(text: string): string[] {
  try {
    const arr = pinyin(text, { type: "array", toneType: "symbol" }) as string[];
    return arr;
  } catch {
    return String(text).split("");
  }
}

/** 批量：给一批 字+组词 生成拼音 */
export function pinyinForPairs(pairs: { ch: string; word?: string }[]): string[] {
  return pairs.map((p) => charPinyin(p.ch, p.word));
}
