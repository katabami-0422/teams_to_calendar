// 各エントリ（auth:google / teams:login / sync）で .env を読み込む共通処理。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
} catch {
  // .env が無ければ process.env の値を使う
}

export {};
