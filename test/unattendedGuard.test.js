// node --test test/unattendedGuard.test.js  (npm run test:guard)
// 가짜 발행 기록으로 하루 상한 · 중복 방지 · 로그인 만료 · 게이트 선별을 검증한다. DB·네트워크·브라우저 미사용.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  kstDateString, countPublishedToday, checkDailyLimit, findDuplicate, filterDuplicates,
  selectFinalPost, preflight, isGroundedCourse, MAX_CANDIDATES_PER_RUN,
} from '../src/utils/unattendedGuard.js';

// 테스트용 지역 추출 (실제는 tradule_source.extractRegion)
const REGIONS = ['오사카', '세부', '도쿄', '경주'];
const extractRegion = (t) => REGIONS.find((r) => String(t ?? '').includes(r)) ?? null;

// 2026-11-03 09:30 KST = 2026-11-03T00:30Z (첫 예약 09:20 직후)
const NOW = new Date('2026-11-03T00:30:00Z');
const row = (keyword, published_at, extra = {}) => ({ keyword, title: keyword, status: 'published', published_at, ...extra });

test('KST 날짜: UTC 15:00 이후는 다음 날', () => {
  assert.equal(kstDateString(new Date('2026-11-02T14:59:00Z')), '2026-11-02');
  assert.equal(kstDateString(new Date('2026-11-02T15:00:00Z')), '2026-11-03');
});

test('하루 상한: 오늘 2편이면 중단, 어제 2편이면 통과', () => {
  const today2 = [row('오사카 2박3일', '2026-11-03 09:00:00'), row('세부 3박4일', '2026-11-03 09:30:00')];
  assert.equal(checkDailyLimit(today2, NOW).ok, false);
  assert.equal(checkDailyLimit(today2, NOW).count, 2);
  const yesterday2 = [row('오사카 2박3일', '2026-11-02 19:00:00'), row('세부 3박4일', '2026-11-02 21:00:00')];
  assert.equal(checkDailyLimit(yesterday2, NOW).ok, true);
  const one = [row('오사카 2박3일', '2026-11-03 09:00:00')];
  assert.equal(checkDailyLimit(one, NOW).ok, true);
  // 발행 아님(failed)은 세지 않는다
  assert.equal(countPublishedToday([row('x', '2026-11-03 09:00:00', { status: 'failed' })], NOW), 0);
});

test('하루 상한: ISO(UTC) 기록은 KST 날짜로 환산', () => {
  // 2026-11-02T16:00Z = KST 11-03 01:00 → 오늘
  assert.equal(countPublishedToday([row('a', '2026-11-02T16:00:00Z')], NOW), 1);
  // 2026-11-02T10:00Z = KST 11-02 19:00 → 어제
  assert.equal(countPublishedToday([row('a', '2026-11-02T10:00:00Z')], NOW), 0);
});

test('중복: 같은 키워드(공백·대소문자 무시) · 원본 키워드', () => {
  const rows = [row('오사카 2박3일', '2026-01-01 10:00:00')]; // 오래된 기록도 대조
  assert.equal(findDuplicate({ keyword: '오사카 2박 3일' }, rows, extractRegion).duplicate, true);
  assert.equal(findDuplicate({ keyword: '다른글', original_keyword: '오사카 2박3일' }, rows, extractRegion).duplicate, true);
});

test('중복: 같은 지역+일수는 키워드가 달라도 차단, 일수나 지역이 다르면 통과', () => {
  const rows = [row('오사카 2박3일, USJ와 도톤보리', '2026-10-01 10:00:00')];
  assert.equal(findDuplicate({ keyword: '오사카 2박3일 코스' }, rows, extractRegion).duplicate, true);
  assert.equal(findDuplicate({ keyword: '오사카 3박4일 코스' }, rows, extractRegion).duplicate, false);
  assert.equal(findDuplicate({ keyword: '도쿄 2박3일 코스' }, rows, extractRegion).duplicate, false);
  assert.equal(findDuplicate({ keyword: '엉뚱', trip_data: { region: '오사카' }, original_keyword: '오사카 2박3일' }, rows, extractRegion).duplicate, true);
});

test('중복: filterDuplicates 는 사유와 함께 걸러낸다', () => {
  const rows = [row('세부 3박4일', '2026-10-20 10:00:00')];
  const { kept, dropped } = filterDuplicates([{ keyword: '세부 3박4일 일정' }, { keyword: '경주 1박2일' }], rows, extractRegion);
  assert.deepEqual(kept.map((c) => c.keyword), ['경주 1박2일']);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /같은 지역\+일수/);
});

const grounded = (kw, status = 'APPROVED') => ({ keyword: kw, trip_data: { spots: [{}, {}, {}] }, blog_draft: { grounded: true }, blog_qa: { status } });

test('게이트: 근거 경로 + QA 통과 1편만, 첫 후보 탈락 시 다음 후보', () => {
  const { selected } = selectFinalPost([grounded('A', 'REJECTED'), grounded('B'), grounded('C')]);
  assert.deepEqual(selected.map((c) => c.keyword), ['B']);
  // 근거 경로가 아닌 글(조립 글·trip_data 없음)은 무인 발행 불가
  const assembled = { keyword: 'D', trip_data: { spots: [{}, {}, {}] }, blog_draft: { assembled: 'code' }, blog_qa: { status: 'APPROVED' } };
  assert.equal(isGroundedCourse(assembled), false);
  assert.equal(selectFinalPost([assembled]).selected.length, 0);
  assert.equal(MAX_CANDIDATES_PER_RUN, 2);
});

test('로그인 만료: 발행 중단 + logs 에 "로그인 필요" 기록', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const origErr = console.error; console.error = () => {};
  try {
    const sent = [];
    const notify = async (m) => { sent.push(m); };
    const r = await preflight({ rows: [], now: NOW, loginCheck: async () => false, logDir: dir, notify });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'login_required');
    const log = fs.readFileSync(path.join(dir, 'login-required.log'), 'utf8');
    assert.match(log, /로그인 필요/);
    assert.match(log, /2026-11-03 09:30:00 KST/);
    // 확인 중 예외도 안전하게 중단 (알림은 보내지 않음 — 만료가 확정된 게 아니므로)
    const r2 = await preflight({ rows: [], now: NOW, loginCheck: async () => { throw new Error('boom'); }, logDir: dir, notify });
    assert.equal(r2.code, 'login_required');
    assert.equal(sent.length, 1);
  } finally { console.error = origErr; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('로그인 만료 알림: 만료당 1회만, 로그인 복구 후 다시 만료되면 다시 알림', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const origErr = console.error; console.error = () => {};
  try {
    const sent = [];
    const notify = async (m) => { sent.push(m); };
    const expired = () => preflight({ rows: [], now: NOW, loginCheck: async () => false, logDir: dir, notify });
    const r1 = await expired();
    const r2 = await expired(); // 같은 만료가 이어지는 다음 예약 실행
    assert.equal(r1.alerted, true);
    assert.equal(r2.alerted, false);
    assert.deepEqual(sent, ['티스토리 로그인 필요']);
    // 로그인 복구(점검 통과) → 상태 초기화
    const ok = await preflight({ rows: [], now: NOW, loginCheck: async () => true, logDir: dir, notify });
    assert.equal(ok.ok, true);
    // 다시 만료 → 다시 1회 알림
    const r3 = await expired();
    assert.equal(r3.alerted, true);
    assert.equal(sent.length, 2);
  } finally { console.error = origErr; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('알림 전송이 실패해도 발행 중단 결과는 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const origErr = console.error; console.error = () => {};
  try {
    const r = await preflight({ rows: [], now: NOW, loginCheck: async () => false, logDir: dir, notify: async () => { throw new Error('telegram down'); } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'login_required');
  } finally { console.error = origErr; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('스케줄 시각: 09:20·17:20 (이전 10:20·19:40 흔적 없음)', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const ps1 = fs.readFileSync(path.join(root, 'scripts/install-schedule.ps1'), 'utf8');
  assert.match(ps1, /'Publish-0920' = '09:20'/);
  assert.match(ps1, /'Publish-1720' = '17:20'/);
  assert.doesNotMatch(ps1, /\$times\s*=.*(10:20|19:40)/);
  const un = fs.readFileSync(path.join(root, 'scripts/uninstall-schedule.cmd'), 'utf8');
  assert.match(un, /Publish-0920/);
  assert.match(un, /Publish-1720/);
});

test('사전 점검: 상한 도달이면 로그인 확인조차 하지 않고 종료', async () => {
  let called = false;
  const rows = [row('a', '2026-11-03 08:00:00'), row('b', '2026-11-03 09:00:00')];
  const r = await preflight({ rows, now: NOW, loginCheck: async () => { called = true; return true; } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'daily_limit');
  assert.equal(called, false);
});

test('사전 점검: 상한 미만 + 로그인 정상이면 통과', async () => {
  const r = await preflight({ rows: [row('a', '2026-11-03 08:00:00')], now: NOW, loginCheck: async () => true });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
});
