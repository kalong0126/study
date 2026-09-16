<script setup lang="ts">
import { computed } from "vue";
import Icon from "@/components/Icon.vue";
import { useMasteryStore } from "@/stores/mastery";
import { useProgressStore } from "@/stores/progress";

const progress = useProgressStore();
const mastery = useMasteryStore();

const items = computed(() => [
  { to: "/", name: "今日", icon: "home", badge: 0 },
  { to: "/math", name: "口算", icon: "math", badge: progress.mathWrongCount },
  { to: "/chinese", name: "语文", icon: "chinese", badge: 0 },
  { to: "/story", name: "童话", icon: "story", badge: 0 },
  { to: "/language", name: "语言", icon: "wand", badge: 0 },
  { to: "/video", name: "英文", icon: "video", badge: 0 },
  { to: "/wrong", name: "错题本", icon: "wrong", badge: mastery.wrongTotal },
]);
</script>

<template>
  <nav class="nav">
    <RouterLink v-for="it in items" :key="it.to" :to="it.to" active-class="active" :aria-label="it.name">
      <Icon :name="it.icon" :size="22" />
      <span>{{ it.name }}</span>
      <span v-if="it.badge" class="badge on">{{ it.badge }}</span>
    </RouterLink>
  </nav>
</template>
