<script setup lang="ts">
/**
 * 收藏的故事（首页「学习小档案」第三张卡点进来的页面）
 *
 * 收藏发生在童话页（故事树）：读到喜欢的一篇，点一下工具栏上的星星。
 * 收藏时正文一起存进服务器，所以**历史故事被删了也还能照常重读**。
 *
 * 点某一张卡 → 载入那篇 → 跳回童话页接着读（`?from=fav`，
 * 童话页看到这个标记就不会用「今天的那篇」把它顶掉）。
 */
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import { useStoryStore } from "@/stores/story";
import { useUiStore } from "@/stores/ui";

const router = useRouter();
const story = useStoryStore();
const ui = useUiStore();

onMounted(() => {
  void story.loadFavs();
});

function dayOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("zh-CN");
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, "").slice(0, 60);
}

/** 重读：载入这一篇并回童话页（带上 from=fav，别让「今天的那篇」顶掉它） */
function read(favId: string): void {
  const fav = story.favs.find((f) => `${f.id}:${f.title}` === favId);
  if (!fav) return;
  story.load(fav);
  void router.push({ path: "/story", query: { from: "fav" } });
}

async function unfav(title: string): Promise<void> {
  const fav = story.favs.find((f) => f.title === title);
  if (!fav) return;
  try {
    await story.toggleFav(fav);
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "操作失败，请再试一次");
  }
}

const note = [
  "喜欢哪篇童话，就在童话页点那颗星星收进来；正文会一起存着，以后随时重读。",
  "点卡片接着读一遍，再点一次星星就是取消收藏。",
].join("\n");
</script>

<template>
  <PageTool icon="story" tint="#F3EFFF" color="var(--purple-d)" title="收藏的故事" :meta="`${story.favCount} 篇`" :note="note">
    <template #head>
      <span class="pt-pill">点卡片再读一遍</span>
    </template>
  </PageTool>

  <section v-if="story.favCount" class="card">
    <div class="fav-list">
      <div v-for="f in story.favs" :key="f.title" class="fav-row">
        <button class="fav-card" type="button" @click="read(`${f.id}:${f.title}`)">
          <span class="fav-body">
            <b class="fav-title">{{ f.title }}</b>
            <span class="fav-ex">{{ excerpt(f.text) }}…</span>
          </span>
          <span class="fav-date">{{ dayOf(f.favAt) }}</span>
          <Icon name="chevRight" :size="17" :stroke="2.4" />
        </button>
        <button
          class="fav-star"
          type="button"
          :aria-label="`取消收藏《${f.title}》`"
          title="取消收藏"
          @click="unfav(f.title)"
        >
          <Icon name="star" :size="17" :stroke="2" />
        </button>
      </div>
    </div>
  </section>

  <section v-else class="card">
    <div class="wb-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="#B9CCDE" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.4 9.9l6-.9z" />
      </svg>
      <div>还没有收藏的故事</div>
      <div>在童话页读到喜欢的，点一下那颗星星就收进来啦</div>
    </div>
  </section>
</template>

<style scoped>
.fav-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.fav-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
.fav-row .fav-card { flex: 1; min-width: 0; }
.fav-card {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  padding: 12px 14px;
  border-radius: 16px;
  font-family: inherit;
  color: var(--ink2);
  background: linear-gradient(160deg, #ffffff, #f5f2ff);
  border: 1.5px solid #ddd6f8;
  cursor: pointer;
  transition: 0.2s;
}
.fav-card:hover { border-color: #c5bbf2; }
.fav-card:active { transform: scale(0.985); }
.fav-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.fav-title { font-size: 15.5px; font-weight: 800; color: var(--ink); line-height: 1.35; }
.fav-ex {
  font-size: 12.5px;
  color: var(--ink3);
  line-height: 1.55;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.fav-date { flex: none; font-size: 11.5px; color: var(--ink3); }
.fav-star {
  flex: none;
  width: 40px;
  border-radius: 14px;
  border: 1.5px solid #f1e3b8;
  background: #fff9e8;
  color: #d9a400;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: 0.2s;
}
.fav-star:hover { background: #fff1bf; }
</style>
