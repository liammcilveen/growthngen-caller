'use strict';

/**
 * Telegram — send a message to the GrowthNGen group.
 *
 * Used by postCall.js to deliver post-call summaries after ElevenLabs
 * finishes and Claude summarises the transcript.
 *
 * Requires: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 */

const axios = require('axios');
const logger = require('../logger');

/**
 * Send a plain-text message to the configured Telegram chat.
 * Silent failure — a Telegram error never breaks post-call processing.
 */
async function sendMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping Telegram notification');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' },
      { timeout: 8000 },
    );
  } catch (err) {
    logger.warn({ err: err.message }, 'Telegram notification failed (non-fatal)');
  }
}

module.exports = { sendMessage };
