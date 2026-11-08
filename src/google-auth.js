import './env.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = path.join(ROOT, 'tokens', 'google.json');
const REDIRECT_URI = 'http://localhost';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

async function readTokens() {
  try {
    return JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeTokens(t) {
  await mkdir(path.dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(t, null, 2));
}

function client() {
  const cid = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!cid || !secret) {
    throw new Error('.env の GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です');
  }
  return new google.auth.OAuth2(cid, secret, REDIRECT_URI);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

export async function runGoogleFlow() {
  const oauth = client();
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\n=== Google にサインイン ===\n');
  console.log('次の URL をブラウザで開いてください:\n');
  console.log(url, '\n');
  console.log('許可すると「http://localhost/?code=...&scope=...」に飛びます（ページが開けなくてもOK）。');
  console.log('その URL の code= の値（&scope の前まで）を貼り付けてください。\n');

  const code = (await ask('code: ')).trim();
  if (!code) throw new Error('code が入力されていません');
  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'refresh_token が取得できませんでした。Google Cloud 側でこのアプリの認証を一度取り消してから、もう一度お試しください。'
    );
  }
  await writeTokens(tokens);
  console.log('Google の認証に成功しました（トークンを保存済み）');
}

export async function getGoogleClient() {
  const tokens = await readTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('Google トークンがありません。`npm run auth:google` を実行してください。');
  }
  const oauth = client();
  oauth.setCredentials(tokens);
  oauth.on('tokens', (t) => {
    writeTokens({ ...tokens, ...t }).catch(() => {});
  });
  return oauth;
}

// CLI 実行（npm run auth:google）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await runGoogleFlow();
  } catch (e) {
    console.error('認証エラー:', e.message);
    process.exit(1);
  }
}
