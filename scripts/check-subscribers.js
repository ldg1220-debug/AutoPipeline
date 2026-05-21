/**
 * 구독자 마일스톤 체크 — 수동 실행용
 * npm run youtube:subscribers
 *
 * 파이프라인 자동 실행 시에는 app.js 종료 시점에 자동 호출됨.
 */
import { checkSubscribers } from '../src/utils/subscriberMonitor.js';

const results = await checkSubscribers();
console.log('\n✅ 구독자 체크 완료');
