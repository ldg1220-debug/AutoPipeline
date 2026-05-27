import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import logger from './logger.js';
import { sendSubscriberAlert } from './notifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(__dirname, '../../output/subscriber_state.json');

// 알림을 보낼 구독자 마일스톤
const MILESTONES = [1000, 5000, 10000, 50000, 100000];

async function refreshToken(channelCfg) {
  const res = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id:     channelCfg.clientId,
      client_secret: channelCfg.clientSecret,
      refresh_token: channelCfg.refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
  );
  return res.data.access_token;
}

async function getChannelStats(accessToken) {
  const res = await axios.get(
    'https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&mine=true',
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
  );
  const item = res.data.items?.[0];
  return {
    title:       item?.snippet?.title ?? '알 수 없음',
    subscribers: parseInt(item?.statistics?.subscriberCount ?? '0', 10),
    views:       parseInt(item?.statistics?.viewCount       ?? '0', 10),
    videoCount:  parseInt(item?.statistics?.videoCount      ?? '0', 10),
  };
}

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * 두 채널의 구독자 수를 확인하고 마일스톤 달성 시 텔레그램 알림을 보낸다.
 * 파이프라인 종료 시점에 호출된다 (실패해도 파이프라인에 영향 없음).
 */
export async function checkSubscribers() {
  const state = await loadState();

  const channels = [
    { key: 'main',   name: '경제채널 (매일읽어주는남자)', cfg: config.youtube },
    { key: 'health', name: '건강채널 (매일읽어주는건강)', cfg: config.youtubeChannels?.health },
  ];

  for (const { key, name, cfg } of channels) {
    if (!cfg?.clientId || !cfg?.refreshToken) continue;

    try {
      const accessToken = await refreshToken(cfg);
      const stats       = await getChannelStats(accessToken);

      logger.info(`[subscriberMonitor] ${name}: 구독자 ${stats.subscribers.toLocaleString()}명 | 조회수 ${stats.views.toLocaleString()}`);

      // 달성한 마일스톤 중 아직 알림 안 보낸 것 확인
      for (const milestone of MILESTONES) {
        const milestoneKey = `${key}_milestone_${milestone}`;
        if (stats.subscribers >= milestone && !state[milestoneKey]) {
          await sendSubscriberAlert(name, stats.subscribers, milestone);
          state[milestoneKey] = {
            achieved_at:  new Date().toISOString(),
            count_at_notification: stats.subscribers,
          };
          logger.info(`[subscriberMonitor] 마일스톤 알림 발송: ${name} ${milestone.toLocaleString()}명`);
        }
      }

      // 최신 현황 저장
      state[`${key}_last`] = {
        subscribers: stats.subscribers,
        views:       stats.views,
        videoCount:  stats.videoCount,
        checked_at:  new Date().toISOString(),
      };
      await saveState(state);

    } catch (err) {
      logger.warn(`[subscriberMonitor] ${name} 조회 실패: ${err.message}`);
    }
  }
}
