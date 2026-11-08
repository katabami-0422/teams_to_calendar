import './env.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import {
  openTeams,
  attachCollector,
  collectSharePoint,
  fetchSharePointFiles,
  downloadFile,
  isLoginPage,
  sleep,
} from './teams-browser.js';
import { getGoogleClient } from './google-auth.js';
import { ocrFile, pdfEmbeddedText } from './ocr.js';
import { extractDeadline, toLocalDateTime } from './deadline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'state.json');
const FILES_DIR = path.join(ROOT, 'files');

const CONFIG = {
  calendarId: process.env.CALENDAR_ID || 'primary',
  lookbackDays: Number(process.env.LOOKBACK_DAYS ?? 7),
  durationMinutes: Number(process.env.EVENT_DURATION_MINUTES ?? 30),
  defaultDeadlineTime: process.env.DEFAULT_DEADLINE_TIME || '23:59',
  onlyTeams: (process.env.TEAMS_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
  onlyChannels: (process.env.CHANNEL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean),
  reminderMinutes: (process.env.REMINDER_MINUTES ?? '1440,60')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0),
};

const dryRun = process.argv.includes('--dry-run');
const pad = (n) => String(n).padStart(2, '0');

function jstParts(date) {
  const u = new Date(date.getTime() + 9 * 3600 * 1000);
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}T${pad(u.getUTCHours())}:${pad(u.getUTCMinutes())}:00`;
}

function deadlineToDate(d) {
  return new Date(`${toLocalDateTime(d)}+09:00`);
}

function buildEvent(d, entry, ocrText) {
  const start = deadlineToDate(d);
  const startLocal = toLocalDateTime(d);
  const endLocal = jstParts(new Date(start.getTime() + CONFIG.durationMinutes * 60_000));

  const lines = [
    `チャネル: ${entry.teamName} / ${entry.channelName}`,
    `ファイル: ${entry.fileName}`,
    `検出した締切: ${d.matched}`,
    `URL: ${entry.webUrl}`,
    '',
    '--- 本文(OCR) ---',
    ocrText.slice(0, 2000),
  ];

  const event = {
    summary: `[${entry.teamName}] ${entry.fileName}`,
    description: lines.join('\n'),
    start: { dateTime: startLocal, timeZone: 'Asia/Tokyo' },
    end: { dateTime: endLocal, timeZone: 'Asia/Tokyo' },
    extendedProperties: { private: { msFileKey: `${entry.driveId}|${entry.fileId}` } },
  };
  if (CONFIG.reminderMinutes.length) {
    event.reminders = {
      useDefault: false,
      overrides: CONFIG.reminderMinutes.map((m) => ({ method: 'popup', minutes: m })),
    };
  }
  return event;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(s) {
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

function safeName(s) {
  return String(s || 'noname').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

function extFor(entry, contentType) {
  const dot = entry.fileName.lastIndexOf('.');
  if (dot >= 0) {
    const e = entry.fileName.slice(dot).toLowerCase();
    if (/^\.[a-z0-9]{1,5}$/.test(e)) return e;
  }
  const map = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg' };
  return map[contentType] || '.bin';
}

async function processEntry(sp, entry, state) {
  const key = `${entry.driveId}|${entry.fileId}`;
  const data = await downloadFile(sp, entry);
  if (!data || !data.buffer.length) {
    return { key, ok: false, reason: 'ダウンロード失敗', entry };
  }

  const ext = extFor(entry, data.contentType);
  const tmp = path.join(os.tmpdir(), `tms-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  await writeFile(tmp, data.buffer);

  let text;
  try {
    text = await ocrFile(tmp);
  } catch (e) {
    return { key, ok: false, reason: `OCR失敗: ${e.message}`, entry };
  }

  // PDF は埋め込みテキスト層の ASCII 日付もヒントに併用（OCR が日付を化けさせるため）
  let parseText = text;
  if (entry.fileName.toLowerCase().endsWith('.pdf')) {
    const embedded = await pdfEmbeddedText(tmp);
    if (embedded.trim()) parseText = `${text}\n${embedded}`;
  }

  // 元ファイルを files/ に保存（確認用）
  const dir = path.join(FILES_DIR, safeName(entry.teamName), safeName(entry.channelName));
  await mkdir(dir, { recursive: true });
  const saved = path.join(dir, `${safeName(entry.fileId)}_${safeName(entry.fileName)}`);
  await writeFile(saved, data.buffer).catch(() => {});

  const d = extractDeadline(parseText, { now: new Date(), defaultTime: CONFIG.defaultDeadlineTime });
  return { key, ok: true, deadline: d, ocrText: text, entry };
}

async function main() {
  console.log('Teams に接続しています...');
  const ctx = await openTeams();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const collector = attachCollector(page);

    const start = Date.now();
    const sp = await collectSharePoint(page, collector);
    if (!sp) {
      // 未ログイン時は JS リダイレクトで login 等へ飛ぶ。少し待って判定する。
      let login = isLoginPage(page.url());
      const t0 = Date.now();
      while (!login && Date.now() - t0 < 12000) {
        await sleep(1000);
        login = isLoginPage(page.url());
      }
      if (login) {
        throw new Error('Teams にログインしていません。`npm run teams:login` を実行してください。');
      }
      throw new Error('SharePoint トークンを取得できませんでした。Teams の画面が完全に読み込まれてから再実行してください。');
    }

    const sinceIso = new Date(start - CONFIG.lookbackDays * 86_400_000).toISOString();

    const r = await fetchSharePointFiles(sp, {
      sinceIso,
      onlyTeams: CONFIG.onlyTeams,
      onlyChannels: CONFIG.onlyChannels,
    });
    const entries = r.entries;
    if (r.error) console.warn(`警告: ${r.error}`);

    console.log(`チャネル投稿の添付ファイル: ${entries.length} 件（直近 ${CONFIG.lookbackDays} 日）`);

    if (!entries.length) {
      console.log('対象のファイルがありません。');
      return;
    }

    const state = await loadState();
    const seen = new Map(); // key -> { deadline, ocrText, entry }

    for (const entry of entries) {
      const r = await processEntry(sp, entry, state);
      if (!r.ok) {
        console.log(`  スキップ: ${entry.fileName}（${r.reason}）`);
        continue;
      }
      if (!r.deadline) {
        console.log(`  締切なし: [${entry.teamName}] ${entry.fileName}（${(r.ocrText || '').slice(0, 40)}...）`);
        seen.set(r.key, { deadline: null, entry });
        continue;
      }
      seen.set(r.key, { deadline: r.deadline, ocrText: r.ocrText, entry });
      console.log(`  締切 ${toLocalDateTime(r.deadline)} : [${entry.teamName}] ${entry.fileName}（${r.deadline.matched}）`);
    }

    if (dryRun) {
      console.log('\n--dry-run のため Google Calendar は変更していません');
      return;
    }

    const oauth = await getGoogleClient();
    const calendar = google.calendar({ version: 'v3', auth: oauth });

    const changes = { created: [], updated: [], deleted: [], unchanged: 0 };
    const failures = [];
    const now = new Date();

    for (const [key, item] of seen) {
      if (!item.deadline) continue;
      const rec = state[key];
      const event = buildEvent(item.deadline, item.entry, item.ocrText);
      const patchBody = { summary: event.summary, description: event.description, start: event.start, end: event.end };
      try {
        if (rec && rec.eventId) {
          try {
            await calendar.events.patch({
              calendarId: CONFIG.calendarId,
              eventId: rec.eventId,
              requestBody: patchBody,
            });
            const changed = rec.summary !== event.summary || rec.deadline !== event.start.dateTime;
            if (changed) changes.updated.push(event.summary);
            else changes.unchanged += 1;
            state[key] = { eventId: rec.eventId, summary: event.summary, deadline: event.start.dateTime };
            await saveState(state);
            continue;
          } catch (e) {
            if (e.code !== 404 && e.response?.status !== 404) throw e;
            // カレンダー側で削除済み → 作り直す
          }
        }
        const createdEv = await calendar.events.insert({ calendarId: CONFIG.calendarId, requestBody: event });
        state[key] = { eventId: createdEv.data.id, summary: event.summary, deadline: event.start.dateTime };
        await saveState(state);
        changes.created.push(event.summary);
      } catch (e) {
        failures.push(`${item.entry.fileName}: ${e.message}`);
      }
    }

    // 対象外になった既存イベント: 締切が過去のものだけ削除（未来の締切は残す）
    for (const [key, rec] of Object.entries(state)) {
      if (seen.has(key) || !rec.eventId || !rec.deadline) continue;
      const dl = new Date(rec.deadline + '+09:00');
      if (!Number.isNaN(dl.getTime()) && dl.getTime() >= now.getTime()) continue;
      try {
        await calendar.events.delete({ calendarId: CONFIG.calendarId, eventId: rec.eventId });
        changes.deleted.push(rec.summary || key);
      } catch (e) {
        if (e.code !== 404 && e.response?.status !== 404) {
          failures.push(`削除失敗 ${rec.eventId}: ${e.message}`);
        }
      }
      delete state[key];
      await saveState(state);
    }

    console.log(`\n同期完了: 新規 ${changes.created.length} / 変更 ${changes.updated.length} / 削除 ${changes.deleted.length} / 変更なし ${changes.unchanged}`);
    for (const s of changes.created) console.log('  新規:', s);
    for (const s of changes.updated) console.log('  変更:', s);
    for (const s of changes.deleted) console.log('  削除:', s);
    for (const f of failures) console.error('  失敗:', f);
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error('エラー:', e.message);
  process.exit(1);
});
