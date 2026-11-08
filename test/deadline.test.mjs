import assert from 'node:assert';
import { extractDeadline, toLocalDateTime } from '../src/deadline.js';

const now = new Date('2026-11-07T12:00:00+09:00');

function t(input, expected) {
  const r = extractDeadline(input, { now });
  const got = r ? toLocalDateTime(r) : null;
  assert.strictEqual(got, expected, `input=${JSON.stringify(input)} got=${got} expected=${expected}`);
}

t('提出期限：11月10日(月)までに提出してください', '2026-11-10T23:59:00');
t('算数の宿題\n教科書P.42をノートにやる\n提出期限:11月10日(月)', '2026-11-10T23:59:00');
t('１１月１０日まで', '2026-11-10T23:59:00');
t('締切 11/25 23:59', '2026-11-25T23:59:00');
t('11月3日(月)23時59分まで', '2026-11-03T23:59:00');
t('2026年12月5日 必着', '2026-12-05T23:59:00');
t('提出日 12/1', '2026-12-01T23:59:00');
t('10日までに提出', '2026-11-10T23:59:00');
t('宿題：12月10日(水)の朝まで', '2026-12-10T23:59:00');
t('期限 2026/1/15', '2026-01-15T23:59:00');
t('なにも日付がない文章', null);
t('提 出 期 限 : 1 1 月 1 4 日 ( 金 )', '2026-11-14T23:59:00');
t('締 切 1 1 月 2 5 日 2 3 時 5 9 分', '2026-11-25T23:59:00');

// 時刻つき（翌日判定はしない。単純に既定時刻）
t('12月10日 17:00 まで', '2026-12-10T17:00:00');

console.log('deadline tests OK');
