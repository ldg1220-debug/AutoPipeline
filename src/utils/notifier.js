import axios from 'axios';
import logger from './logger.js';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * 텔레그램 봇으로 메시지를 전송한다.
 * TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없으면 로그만 출력하고 넘어간다.
 */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn('[notifier] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Skipping notification.');
    return;
  }

  try {
    await axios.post(
      `${TELEGRAM_API}/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
    logger.info('[notifier] Telegram notification sent.');
  } catch (err) {
    // 알림 실패는 파이프라인을 중단시키지 않는다
    logger.warn('[notifier] Telegram send failed.', { message: err.message });
  }
}

/**
 * 파이프라인 실행 결과를 텔레그램으로 전송한다.
 * @param {object} summary - { date, elapsed_sec, total, approved, rejected, skipped, dry_run, publishResults }
 */
export async function sendDailyReport(summary) {
  const dryRunMark = summary.dry_run ? ' _(DRY RUN)_' : '';
  const publishedCount = summary.publishResults?.results?.length ?? 0;

  const lines = [
    `📊 *AutoPipeline 일일 리포트*${dryRunMark}`,
    `📅 ${summary.date}`,
    ``,
    `✅ 승인: ${summary.approved}건`,
    `❌ 탈락: ${summary.rejected}건`,
    `⏭️ 스킵: ${summary.skipped}건`,
    `📤 발행: ${publishedCount}건`,
    `⏱️ 소요: ${summary.elapsed_sec}초`,
  ];

  if (summary.publishResults?.results?.length > 0) {
    lines.push('');
    lines.push('*발행된 콘텐츠:*');
    for (const r of summary.publishResults.results) {
      const ytStatus = r.youtube?.url ? `[YouTube](${r.youtube.url})` : r.youtube?.status ?? '-';
      const wpStatus = r.wordpress?.url ? `[WordPress](${r.wordpress.url})` : r.wordpress?.status ?? '-';
      lines.push(`• ${r.keyword} — ${ytStatus} / ${wpStatus}`);
    }
  }

  await sendTelegram(lines.join('\n'));
}

/**
 * 파이프라인 치명적 오류를 텔레그램으로 즉시 알린다.
 */
export async function sendErrorAlert(stage, errorMessage) {
  const text = [
    `🚨 *AutoPipeline 오류 발생*`,
    `📍 단계: ${stage}`,
    `💬 내용: ${errorMessage}`,
  ].join('\n');

  await sendTelegram(text);
}
