import cron from 'node-cron';
import { config } from '../config/index.js';
import logger from './logger.js';

/**
 * 파이프라인 실행 함수를 CRON_SCHEDULE 주기로 반복 실행한다.
 * @param {Function} task - 비동기 파이프라인 실행 함수
 */
export function startScheduler(task) {
  const schedule = config.runtime.cronSchedule;

  if (!cron.validate(schedule)) {
    logger.error(`[scheduler] Invalid cron expression: "${schedule}"`);
    throw new Error(`Invalid cron expression: "${schedule}"`);
  }

  logger.info(`[scheduler] Starting with schedule: "${schedule}"`);

  cron.schedule(schedule, async () => {
    logger.info('[scheduler] Triggered pipeline run');
    try {
      await task();
    } catch (err) {
      logger.error('[scheduler] Pipeline run failed', { message: err.message });
    }
  });
}
