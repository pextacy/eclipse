/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RELAY_URL?: string;
  readonly VITE_ECLIPSE_SETTLEMENT?: string;
  readonly VITE_ECLIPSE_REGISTRY?: string;
  readonly VITE_FXRP?: string;
  readonly VITE_USDT0?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
