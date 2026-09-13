<script setup lang="ts">
/**
 * 应用外壳
 *
 * 两条完全分开的壳：
 *   · 孩子端（/ /math /chinese /story /wrong）：顶栏 + 底部导航 + 特效层
 *   · 家长后台（/admin/**）：独立版式，不出现任何孩子端的导航
 * 这样「孩子看不到后台入口」是靠结构保证的，不是靠藏按钮。
 */
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import AppNav from "@/components/AppNav.vue";
import DiagDrawer from "@/components/DiagDrawer.vue";
import FxLayer from "@/components/FxLayer.vue";
import { unlockAudioPlayback } from "@/composables/useAudio";
import { bindDayRollover, bootstrap, bootError, bootState } from "@/composables/useBootstrap";
import { useUiStore } from "@/stores/ui";

const route = useRoute();
const ui = useUiStore();

const isAdmin = computed(() => route.path.startsWith("/admin"));

function onFirstGesture(): void {
  unlockAudioPlayback();
  window.removeEventListener("pointerdown", onFirstGesture);
  window.removeEventListener("keydown", onFirstGesture);
}

onMounted(() => {
  bindDayRollover();
  void bootstrap();
  // iOS / Android 都要求音频解锁发生在真实的用户手势里
  window.addEventListener("pointerdown", onFirstGesture, { once: false });
  window.addEventListener("keydown", onFirstGesture, { once: false });
});

onUnmounted(() => {
  window.removeEventListener("pointerdown", onFirstGesture);
  window.removeEventListener("keydown", onFirstGesture);
});
</script>

<template>
  <!-- 家长内容后台：独立版式 -->
  <RouterView v-if="isAdmin" />

  <!-- 孩子端 -->
  <template v-else>
    <AppHeader />
    <AppNav />

    <main class="wrap">
      <div v-if="bootState === 'loading'" class="card">
        <div class="loading-card">
          正在打开学习台…
          <div class="skeleton" style="height: 14px; margin: 14px auto 0; max-width: 320px"></div>
        </div>
      </div>

      <div v-else-if="bootState === 'error'" class="fatal-box">
        <b>学习台暂时打不开</b>
        <p style="margin: 10px 0 0">{{ bootError }}</p>
        <p style="margin: 10px 0 0">
          常见原因：后端服务没启动、这台设备与服务器不在同一个 Wi-Fi、或者后端启动时报了配置错误。
        </p>
        <div class="row" style="margin-top: 14px">
          <button class="btn primary" type="button" @click="bootstrap()">重试</button>
          <button class="btn ghost" type="button" @click="ui.openDiag()">看看运行日志</button>
        </div>
      </div>

      <template v-else>
        <!--
          注意：这里必须包一层单根 div，不能让 Transition 直接挂 component。
          原因：部分视图（如 HomeView）模板有多个根节点，渲染出来是 Fragment。
          而 Transition 只认「恰好一个根节点」——遇到多根节点时，
          mode="out-in" 的离开钩子 done 回调不会被触发，isLeaving 永远为 true，
          结果 RouterView 只渲染一个空占位注释节点：URL 变了但页面全白，
          必须手动刷新（刷新走的是首次渲染，不经过 Transition）才能显示。
          包一层带 key 的 div 后，Transition 永远只看到一个根节点，问题根除。
        -->
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <div :key="route.path" class="view">
              <component :is="Component" />
            </div>
          </Transition>
        </RouterView>
      </template>
    </main>

    <FxLayer />
  </template>

  <!-- 诊断抽屉：全局挂载，孩子端（启动失败时的「看看运行日志」）和家长后台
       （「打开运行诊断」）都要能用。抽屉本身是 fixed 覆盖层，不依赖两侧布局。 -->
  <DiagDrawer />
</template>
