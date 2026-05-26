import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // 更新前のコメント: なし
  // 更新理由: GitHub Pagesのサブディレクトリ配下（notebooklm0716-dev.github.io/srt-translator/）で資産が正しく読み込めるようにベースパスを設定
  base: '/srt-translator/',
  plugins: [react()],
});
