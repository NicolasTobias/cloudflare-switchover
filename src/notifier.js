'use strict';

async function sendTelegram(token, chatId, message) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error: ${res.status} - ${body}`);
  }
}

async function sendSlack(webhookUrl, message) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook error: ${res.status} - ${body}`);
  }
}

async function notify(config, message, log) {
  const promises = [];

  if (config.telegramBotToken && config.telegramChatId) {
    promises.push(
      sendTelegram(config.telegramBotToken, config.telegramChatId, message)
        .catch(err => log.error({ err }, 'telegram_notification_failed'))
    );
  }

  if (config.slackWebhookUrl) {
    promises.push(
      sendSlack(config.slackWebhookUrl, message)
        .catch(err => log.error({ err }, 'slack_notification_failed'))
    );
  }

  await Promise.allSettled(promises);
}

module.exports = { sendTelegram, sendSlack, notify };
