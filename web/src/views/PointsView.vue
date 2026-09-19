<script setup lang="ts">
/**
 * 我的积分 · 兑换历史
 *
 * 从顶栏右上角的积分入口点进来：
 *   · 顶部展示当前积分余额
 *   · 中间是累计统计（总共换了多久平板、多少钱）
 *   · 下面是兑换历史，支持分页（每页 10 条，按时间倒序）
 */
import { computed, onMounted, ref } from "vue";
import { api } from "@/api";
import type { Redemption, RedemptionStats } from "@/api/types";
import Icon from "@/components/Icon.vue";
import PageTool from "@/components/PageTool.vue";
import { REWARDS, rewardLabel, useProgressStore } from "@/stores/progress";
import { useUiStore } from "@/stores/ui";

const PAGE_SIZE = 10;
const ui = useUiStore();
const progress = useProgressStore();

const balance = ref(0);
const items = ref<Redemption[]>([]);
const stats = ref<RedemptionStats>({ screenCount: 0, screenMinutes: 0, moneyCount: 0, moneyYuan: 0 });
const total = ref(0);
const page = ref(1);
const loading = ref(false);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 分钟 → 「x 小时 y 分钟」，孩子看得懂 */
function fmtMinutes(min: number): string {
  if (min <= 0) return "0 分钟";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分钟`;
  if (h > 0) return `${h} 小时`;
  return `${m} 分钟`;
}

function fmtDate(iso: string): string {
  return String(iso).slice(0, 10);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await api.listRedemptionHistory(page.value, PAGE_SIZE);
    balance.value = r.balance;
    items.value = r.items;
    total.value = r.total;
    stats.value = r.stats;
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "兑换历史加载失败");
  } finally {
    loading.value = false;
  }
}

function go(p: number): void {
  if (p < 1 || p > totalPages.value || p === page.value) return;
  page.value = p;
  void load();
}

/** 兑换奖励：确认 → 扣积分 → 刷新余额和历史。余额不足后端会返回错误，这里给提示。 */
async function redeem(id: string): Promise<void> {
  const r = REWARDS.find((x) => x.id === id);
  if (!r) return;
  if (balance.value < r.cost) {
    ui.toast(`积分不够哦，换「${r.label}」还要 ${r.cost - balance.value} 分`);
    return;
  }
  if (!window.confirm(`确定要用 ${r.cost} 积分兑换「${r.label}」吗？\n\n兑换后请让家长帮你兑现。`)) return;
  try {
    await progress.redeemPoints(id);
    ui.celebrate({ title: "兑换成功！🎁", sub: `已兑换「${r.label}」，记得让家长兑现哦` });
    await load();
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : "兑换失败，稍后再试");
  }
}

onMounted(load);

/** 备注：原来余额下面那段说明，收进工具栏最右侧的 ⓘ（「返回」交给顶栏的「回小岛」） */
const ptsNote = [
  "完成任务赚积分：口算 10 分、听写 10 分、阅读 20 分、语言 20 分、英文故事 10 分。",
  "全对的项、以及一天把 6 项全做完，都会额外再加分。",
  `攒够 ${REWARDS[0]?.cost ?? 50} 分就能换一次奖励；兑换后请家长帮你兑现（给平板时间 / 给零花钱）。`,
].join("\n");
</script>

<template>
  <!-- 详情页统一工具栏：标题 / 说明 / 备注图标。「返回」不用另外放 —— 顶栏的「回小岛」就是它。
       积分没有「主操作」：能做的动作都在下面各张卡片里（兑换奖励）。 -->
  <PageTool
    icon="star"
    tint="#FFF6E0"
    color="#C97F00"
    title="我的积分"
    meta="攒下的每一分都算数"
    :note="ptsNote"
  />

  <section class="card">
    <div class="pts-balance-lg">
      <span class="pts-num">{{ balance }}</span>
      <span class="pts-unit">分</span>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #F3EFFF; color: var(--purple-d)">
        <Icon name="gift" :size="19" />
      </span>
      <div><h2>兑换统计</h2><span class="sub">一共换了多少好东西</span></div>
    </div>

    <div class="pts-stats">
      <div class="pts-stat" style="background: #FFF6E0">
        <div class="ps-ico">📺</div>
        <div class="ps-val">{{ fmtMinutes(stats.screenMinutes) }}</div>
        <div class="ps-lbl">平板娱乐时间</div>
        <div class="ps-sub">共兑换 {{ stats.screenCount }} 次</div>
      </div>
      <div class="pts-stat" style="background: #E9FBF3">
        <div class="ps-ico">💰</div>
        <div class="ps-val">{{ stats.moneyYuan }} 元</div>
        <div class="ps-lbl">零花钱</div>
        <div class="ps-sub">共兑换 {{ stats.moneyCount }} 次</div>
      </div>
    </div>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #FFF6E0; color: #C97F00">
        <Icon name="gift" :size="19" />
      </span>
      <div><h2>兑换奖励</h2><span class="sub">攒够 50 分就能换</span></div>
    </div>

    <div class="redeem-grid">
      <button
        v-for="r in REWARDS"
        :key="r.id"
        class="redeem-card"
        type="button"
        :class="{ can: balance >= r.cost }"
        :disabled="balance < r.cost"
        @click="redeem(r.id)"
      >
        <span class="rc-label">{{ r.label }}</span>
        <span class="rc-cost">{{ r.cost }} 积分</span>
      </button>
    </div>
    <p class="tip">兑换后请让家长帮你兑现（给平板时间 / 给零花钱）。</p>
  </section>

  <section class="card">
    <div class="card-hd">
      <span class="ico" style="background: #EAF7FF; color: var(--blue-d)">
        <Icon name="list" :size="19" />
      </span>
      <div><h2>兑换历史</h2><span class="sub">共 {{ total }} 条记录</span></div>
    </div>

    <div v-if="loading" class="loading-card">正在加载…</div>

    <div v-else-if="!items.length" class="wb-empty">还没有兑换过任何奖励，快去完成任务攒积分吧！</div>

    <div v-else class="pts-hist">
      <div v-for="rd in items" :key="rd.id" class="ph-row">
        <span class="ph-name">{{ rewardLabel(rd.reward) }}</span>
        <span class="ph-cost">-{{ rd.cost }} 分</span>
        <span class="ph-time">{{ fmtDate(rd.createdAt) }}</span>
      </div>
    </div>

    <div v-if="totalPages > 1" class="pts-pager">
      <button class="btn ghost sm" type="button" :disabled="page <= 1" @click="go(page - 1)">
        <Icon name="arrowLeft" :size="15" />上一页
      </button>
      <span class="pg-info">第 {{ page }} / {{ totalPages }} 页</span>
      <button class="btn ghost sm" type="button" :disabled="page >= totalPages" @click="go(page + 1)">
        下一页<Icon name="arrowRight" :size="15" />
      </button>
    </div>
  </section>
</template>
