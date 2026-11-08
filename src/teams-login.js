import './env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { writeFile, mkdir } from 'node:fs/promises';
import { openTeams, waitForLogin, attachCollector } from './teams-browser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_FILE = path.join(ROOT, 'endpoints.json');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

async function main() {
  process.env.TEAMS_HEADLESS = '0'; // ログイン操作は必ず画面ありで行う
  console.log('ブラウザを起動します（初回は Teams へのサインインと多要素認証が必要です）。');
  const ctx = await openTeams();
  const page = ctx.pages()[0] || (await ctx.newPage());
  const collector = attachCollector(page);

  await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const ok = await waitForLogin(page);
  if (!ok) {
    console.error('時間内にログインを確認できませんでした。もう一度お試しください。');
    await ctx.close();
    process.exit(1);
  }
  console.log('Teams へのログインを確認しました。');

  console.log('\n次に、添付ファイルが投稿されているチャネル（例: クラスのチーム → 「一般」）を1つ開いてください。');
  console.log('開いたら、このターミナルで Enter を押してください。\n');
  await ask('');

  const endpoints = {
    sharepoint: collector.sp ? { host: collector.sp.host, site: collector.sp.site, drive: collector.sp.drive } : null,
    spUrls: collector.seen.slice(0, 50),
    at: new Date().toISOString(),
  };
  await mkdir(ROOT, { recursive: true });
  await writeFile(ENDPOINTS_FILE, JSON.stringify(endpoints, null, 2));

  console.log('\n=== 確認結果 ===');
  console.log(`SharePoint トークン: ${endpoints.sharepoint ? '取得OK' : '未取得（チャネルを開いた状態で Enter を押すと取得できます）'}`);
  console.log(`観測した通信: ${collector.seen.length} 件`);
  console.log(`\n保存: ${ENDPOINTS_FILE}`);
  console.log('\n次の手順:');
  console.log('  1. npm run auth:google   （Google カレンダーへの許可・初回のみ）');
  console.log('  2. npm run sync:dry-run  （ファイルと締切の抽出結果を確認）');
  console.log('  3. npm run sync          （実際にカレンダーへ反映）');

  await ctx.close();
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
