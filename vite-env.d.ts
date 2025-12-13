/// <reference types="vite/client" />

declare interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv;
}
