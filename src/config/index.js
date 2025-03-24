// Configuration settings
require('dotenv').config();

module.exports = {
  // Telegram Bot
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,

  // OpenAI
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // Scheduler settings
  SCHEDULER_CHECK_INTERVAL: parseInt(process.env.SCHEDULER_CHECK_INTERVAL) || 60000, // 1 minute

  // Timezone
  DEFAULT_TIMEZONE: process.env.DEFAULT_TIMEZONE || 'UTC',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};
