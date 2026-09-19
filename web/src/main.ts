import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import { router } from "@/router";
// 字体声明放在主题样式之前：@font-face 要先注册好，后面的 font-family 才认得出它。
// 全站一套字：方正准圆简体（本地字体切片，中文 + 数字 + 英文全覆盖），
// 拼接规则见 macaron.css 的 --font-round。
import "@/styles/font-fzzhunyuan.css";
import "@/styles/macaron.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");

/**
 * 注册 Service Worker —— 这是「装到桌面后没有浏览器头尾」的必备条件。
 *
 * 只有 manifest 是装不成应用的：安卓 Chrome 要生成 WebAPK（独立窗口），必须
 * 安全上下文（HTTPS）+ manifest + 已注册且带 fetch 事件的 SW 三条同时满足，
 * 否则「添加到主屏幕」只会退化成普通书签快捷方式，打开时地址栏和底栏照样在。
 *
 * 只在生产构建注册：dev 下 Vite 的 HMR 资源和 SW 的缓存策略互相打架，
 * 本地调试除了专门验安装，没必要开。
 * 注册失败不抛错 —— 内网 HTTP 下必然失败（非安全上下文），这属于预期情况。
 */
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
