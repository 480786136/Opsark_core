import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { i18n } from "./features/preferences/i18n";
import { usePreferenceStore } from "./features/preferences/preferenceStore";
import router from "./router";
import "./styles.css";

const pinia = createPinia();
usePreferenceStore(pinia).hydrate();

createApp(App).use(pinia).use(router).use(i18n).mount("#app");
