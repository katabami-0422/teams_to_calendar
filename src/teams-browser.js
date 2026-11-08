import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = path.join(ROOT, 'profile');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function headlessMode() {
  return process.env.TEAMS_HEADLESS !== '0';
}

export async function openTeams() {
  const options = {
    headless: headlessMode(),
    viewport: { width: 1366, height: 900 },
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };
  const channel = process.env.TEAMS_BROWSER || 'msedge';
  if (channel !== 'bundled') options.channel = channel;

  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options);
  } catch (e) {
    if (channel !== 'bundled') {
      delete options.channel;
      return chromium.launchPersistentContext(PROFILE_DIR, options);
    }
    e.message =
      'ブラウザを起動できません。`npx playwright install chromium` を実行するか、TEAMS_BROWSER=msedge を試してください。元のエラー: ' +
      e.message;
    throw e;
  }
}

export function isLoginPage(url) {
  return /teams\.live\.com|login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|microsoftonline\.com\/oauth2/.test(url);
}

export async function waitForLogin(page, { timeoutMs = 600000 } = {}) {
  const start = Date.now();
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    await sleep(3000);
    const url = page.url();
    const onTeams =
      url.startsWith('https://teams.microsoft.com') || url.startsWith('https://teams.cloud.microsoft');
    if (onTeams && !isLoginPage(url)) {
      const pw = await page.locator('input[type="password"], input[name="passwd"]').count().catch(() => 0);
      if (pw === 0) {
        stable += 1;
        if (stable >= 2) return true;
      } else {
        stable = 0;
      }
    } else {
      stable = 0;
    }
  }
  return false;
}

// 新 Teams は Graph を呼ばず、チャネルファイルの実体である SharePoint へ直接 Bearer を送る。
// そのリクエストからトークンと site / drive を拾う。
export function attachCollector(page) {
  const collector = { sp: null, seen: [] };

  page.on('request', (req) => {
    const u = req.url();
    const auth = req.headers()['authorization'];
    if (/\.sharepoint\.com\//.test(u) && !collector.seen.includes(u)) collector.seen.push(u);
    if (collector.sp || !auth || !auth.startsWith('Bearer ')) return;
    const m = u.match(/^(https:\/\/[^/]+)(\/sites\/[^/]+)?\/_api\/v2\.[01]\/drives\/([^/]+)\/items\/([^/]+)/);
    if (m && /\.sharepoint\.com$/.test(new URL(m[1]).host)) {
      collector.sp = { token: auth.slice(7), host: m[1], site: m[2] || '', drive: m[3] };
    }
  });

  return collector;
}

async function spGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json;odata=nometadata' },
  });
  if (!res.ok) return null;
  return res.json();
}

async function spGetAll(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const json = await spGet(next, token);
    if (!json) return null;
    out.push(...(json.value || []));
    next = json['@odata.nextLink'] || null;
  }
  return out;
}

// Teams ホームを開いて SharePoint トークンを拾う。ログイン済みならファイルサムネイル等で必ず飛ぶ。
export async function collectSharePoint(page, collector, { timeoutMs = 45000 } = {}) {
  await page.goto('https://teams.microsoft.com/v2/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (collector.sp) break;
    await sleep(1500);
  }
  return collector.sp;
}

/**
 * チームサイトのドキュメントライブラリを辿り、チャネルフォルダ内のファイルを返す。
 * @returns {{entries:Array, error:string|null}}
 */
export async function fetchSharePointFiles(sp, { sinceIso = null, onlyTeams = [], onlyChannels = [] } = {}) {
  const base = sp.host + sp.site;
  const titleJson = await spGet(`${base}/_api/web/title`, sp.token);
  const teamName =
    (typeof titleJson === 'string' ? titleJson : titleJson?.Title || titleJson?.d?.Title || titleJson?.value) ||
    sp.site.replace(/^\//, '') ||
    'Teams';
  if (!titleJson) {
    return { entries: [], error: 'SharePoint サイトのタイトルを取得できませんでした（トークン権限不足の可能性）' };
  }
  const want = (name, list) => !list.length || list.some((x) => String(name).includes(x));
  if (!want(teamName, onlyTeams)) return { entries: [], error: null };

  const entries = [];
  const driveBase = `${base}/_api/v2.0/drives/${sp.drive}`;

  async function walk(itemId, channelName, depth) {
    const url = itemId ? `${driveBase}/items/${itemId}/children` : `${driveBase}/root/children`;
    const items = await spGetAll(url, sp.token);
    if (!items) return;
    for (const it of items) {
      if (it.folder) {
        if (depth < 4) await walk(it.id, channelName ? `${channelName}/${it.name}` : it.name, depth + 1);
        continue;
      }
      if (!it.file) continue;
      if (sinceIso && it.lastModifiedDateTime && it.lastModifiedDateTime < sinceIso) continue;
      const ch = channelName || '一般';
      if (!want(ch, onlyChannels)) continue;
      entries.push({
        teamName,
        channelName: ch,
        driveId: sp.drive,
        fileId: it.id,
        fileName: it.name || '',
        lastModified: it.lastModifiedDateTime || '',
        contentType: it.file?.mimeType || '',
        contentUrl: `${driveBase}/items/${it.id}/content`,
        webUrl: it.webUrl || '',
      });
    }
  }

  await walk(null, '', 0);
  return { entries, error: null };
}

/**
 * SharePoint の /content を Bearer 付きで取得（リダイレクト先は署名付き URL）。
 * @returns {{buffer:Buffer, contentType:string}|null}
 */
export async function downloadFile(sp, entry) {
  const res = await fetch(entry.contentUrl, { headers: { Authorization: `Bearer ${sp.token}` } });
  if (!res.ok) return null;
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || entry.contentType || '',
  };
}