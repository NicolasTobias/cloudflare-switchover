'use strict';

function loadConfig() {
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) throw new Error('CLOUDFLARE_API_TOKEN is required');

  const domainRecordsRaw = process.env.DOMAIN_RECORDS;
  if (!domainRecordsRaw) throw new Error('DOMAIN_RECORDS is required');

  let domainRecords;
  try {
    domainRecords = JSON.parse(domainRecordsRaw);
  } catch (err) {
    throw new Error(`DOMAIN_RECORDS must be valid JSON: ${err.message}`);
  }

  if (!Array.isArray(domainRecords) || domainRecords.length === 0) {
    throw new Error('DOMAIN_RECORDS must be a non-empty array');
  }

  for (const rec of domainRecords) {
    if (!rec.zone_id || !rec.record_name) {
      throw new Error('Each DOMAIN_RECORDS entry must have zone_id, record_name');
    }
    if (!rec.fallback_content || !rec.fallback_type) {
      throw new Error('Each DOMAIN_RECORDS entry must have fallback_content, fallback_type');
    }
  }

  return {
    cloudflareApiToken: cfToken,
    domainRecords,
    pollInterval: parseInt(process.env.POLL_INTERVAL, 10) || 300_000,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    telegramThreadId: process.env.TELEGRAM_THREAD_ID ? parseInt(process.env.TELEGRAM_THREAD_ID, 10) : null,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,
    hayahoraUrl: process.env.HAYAHORA_URL || 'https://hayahora.futbol/estado/data.json',
    healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT, 10) || 8080,
    footballThreshold: parseFloat(process.env.FOOTBALL_THRESHOLD) || 0.5,
  };
}

module.exports = { loadConfig };
