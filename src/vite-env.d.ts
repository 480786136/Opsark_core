/// <reference types="vite/client" />

declare module "*?opsark-probe" {
  const source: import("./features/tools/probeDelivery").PackedProbeSource;
  export default source;
}
