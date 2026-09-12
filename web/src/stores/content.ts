/**
 * 内容 store：课文 / 生字 / 组词 / 拼音
 *
 * 内容来自后端（家长后台可增改），前端只读。
 * 拼音走后端录入时算好的 pinyin 字段；故事注音这类「纯文本分词」才用 pinyin-pro 现算。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { pinyin } from "pinyin-pro";
import { api } from "@/api";
import type { Lesson, LessonChar } from "@/api/types";
import { lsGet, lsSet } from "@/utils/local";

export const useContentStore = defineStore("content", () => {
  const lessons = ref<Lesson[]>([]);
  const loading = ref(false);
  const loadError = ref("");
  const loaded = ref(false);

  const currentId = ref<number>(lsGet("lessonId", 0));

  const current = computed<Lesson | null>(() => {
    if (!lessons.value.length) return null;
    return lessons.value.find((l) => l.id === currentId.value) ?? lessons.value[0];
  });

  /** 可见生字（家长可以把某些字设为 hidden 跳过） */
  const chars = computed<LessonChar[]>(() => (current.value?.chars ?? []).filter((c) => !c.hidden));

  async function load(force = false): Promise<void> {
    if (loading.value) return;
    if (loaded.value && !force) return;
    loading.value = true;
    loadError.value = "";
    try {
      lessons.value = await api.listLessons();
      loaded.value = true;
      if (!lessons.value.some((l) => l.id === currentId.value)) {
        const first = lessons.value[0];
        if (first) selectLesson(first.id);
      }
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  function selectLesson(id: number): void {
    currentId.value = id;
    lsSet("lessonId", id);
  }

  function findLesson(id: number): Lesson | null {
    return lessons.value.find((l) => l.id === id) ?? null;
  }

  /**
   * 生字拼音：优先用后端算好的（带组词语境，多音字更准），
   * 兜底才用 pinyin-pro 现算单字。
   */
  function pinyinOf(ch: string, char?: LessonChar | null): string {
    if (char?.pinyin) return char.pinyin;
    try {
      return pinyin(ch, { toneType: "symbol" });
    } catch {
      return "";
    }
  }

  /** 一段连续汉字的逐字拼音（故事注音用） */
  function pinyinArray(run: string): string[] {
    try {
      const r = pinyin(run, { type: "array", toneType: "symbol" });
      return Array.isArray(r) ? (r as string[]) : [];
    } catch {
      return [];
    }
  }

  return {
    lessons,
    loading,
    loadError,
    loaded,
    currentId,
    current,
    chars,
    load,
    selectLesson,
    findLesson,
    pinyinOf,
    pinyinArray,
  };
});
