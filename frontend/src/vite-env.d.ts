/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DEMO_NOW?: string;
  readonly DEMO_NOW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
