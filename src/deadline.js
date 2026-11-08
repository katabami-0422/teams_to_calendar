// 日本語の OCR テキストから「締切」日時を抽出する。
// Windows OCR は文字間に空白を挟む（例「11 月 10 日」「締 切」）ため、
// キーワード判定は空白除去版(compact)、日付・時刻の解析は空白を1つに潰した版(spaced)で行う。

const STRONG_KEYWORDS = ['締切', '〆切', '必着', '期限', '締め切り', '〆切り'];
const WEAK_KEYWORDS = ['提出', 'まで', 'due', 'deadline'];

function toHalfwidth(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：／]/g, (c) => (c === '：' ? ':' : '/'))
    .replace(/ー/g, '-');
}

function normalizeLine(raw) {
  const h = toHalfwidth(raw);
  return {
    spaced: h.replace(/[\s\u3000\u00a0]+/g, ' ').trim(),
    compact: h.replace(/[\s\u3000\u00a0]+/g, ''),
  };
}

// 日付は compact（空白除去）で解析する。Windows OCR は数字の間にも空白を
// 入れることがある（「1 1 月 1 4 日」）ため、空白を潰してから拾う。
const RE_FULL = /(\d{4})[年\/\-.](\d{1,2})[月\/\-.](\d{1,2})日?/;
const RE_MD = /(\d{1,2})月(\d{1,2})日/;
const RE_DAY = /(\d{1,2})日/;
// スラッシュ日付は spaced（空白保持）で解析する。ASCII の数字列は空白が入らず、
// 直後の時刻（「11/25 23:59」）と区別できるため。
const RE_SLASH = /(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/|\d)/;
const RE_TIME = /(\d{1,2})\s*[:：時]\s*(\d{2})\s*分?/;

function validMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function resolveYear(month, day, now) {
  let year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate.getTime() < now.getTime() - 180 * 24 * 3600 * 1000) year += 1;
  return year;
}

function parseDate(compact, spaced, now) {
  let m = compact.match(RE_FULL);
  if (m && validMonthDay(+m[2], +m[3])) {
    return { year: +m[1], month: +m[2], day: +m[3], matched: m[0] };
  }
  m = compact.match(RE_MD);
  if (m && validMonthDay(+m[1], +m[2])) {
    return { year: resolveYear(+m[1], +m[2], now), month: +m[1], day: +m[2], matched: m[0] };
  }
  m = spaced.match(RE_SLASH);
  if (m && validMonthDay(+m[1], +m[2])) {
    return { year: resolveYear(+m[1], +m[2], now), month: +m[1], day: +m[2], matched: m[0] };
  }
  m = compact.match(RE_DAY);
  if (m && +m[1] >= 1 && +m[1] <= 31) {
    const day = +m[1];
    let month = now.getMonth() + 1;
    let year = now.getFullYear();
    let candidate = new Date(year, month - 1, day);
    if (candidate.getTime() < now.getTime() - 6 * 24 * 3600 * 1000) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return { year, month, day, matched: m[0] };
  }
  return null;
}

function parseTime(spaced) {
  const m = spaced.match(RE_TIME);
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { hour: h, minute: mi };
}

function makeResult(d, time, defaultTime, line) {
  const [dh, dm] = (time ? `${time.hour}:${time.minute}` : defaultTime).split(':').map(Number);
  return {
    year: d.year,
    month: d.month,
    day: d.day,
    hour: dh,
    minute: dm,
    matched: d.matched,
    line: line.slice(0, 60),
  };
}

/**
 * @param {string} text OCR で得た全文（複数行可）
 * @param {{ now?: Date, defaultTime?: string }} opts
 */
export function extractDeadline(text, { now = new Date(), defaultTime = '23:59' } = {}) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l.spaced);

  if (!lines.length) return null;

  for (const kw of [...STRONG_KEYWORDS, ...WEAK_KEYWORDS]) {
    for (const line of lines) {
      if (!line.compact.toLowerCase().includes(kw)) continue;
      const d = parseDate(line.compact, line.spaced, now);
      if (!d) continue;
      return makeResult(d, parseTime(line.spaced), defaultTime, line.spaced);
    }
  }

  for (const line of lines) {
    const d = parseDate(line.compact, line.spaced, now);
    if (!d) continue;
    return makeResult(d, parseTime(line.spaced), defaultTime, line.spaced);
  }

  return null;
}

export function toLocalDateTime(result) {
  const p = (n) => String(n).padStart(2, '0');
  return `${result.year}-${p(result.month)}-${p(result.day)}T${p(result.hour)}:${p(result.minute)}:00`;
}
