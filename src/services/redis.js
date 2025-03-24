// Updated redis.js with timezone support
const { createClient } = require('redis');
const config = require('../config');
const logger = require('../utils/logger');

const redisClient = createClient({
  url: config.REDIS_URL
});

redisClient.on('error', (err) => {
  logger.error('Redis error:', err);
});

/**
 * Stores a reminder in Redis
 * @param {string} chatId - Telegram chat ID
 * @param {Object} reminder - Reminder object with timezone
 * @returns {Promise<string>} - Reminder ID
 */
async function saveReminder(chatId, reminder) {
  try {
    // Generate unique ID
    const id = Date.now().toString();

    // Store in Redis hash: reminders:chatId -> {id: reminderObject}
    await redisClient.hSet(
        `reminders:${chatId}`,
        id,
        JSON.stringify(reminder)
    );

    // Store IDs in a sorted set by next run time for efficient querying
    await redisClient.zAdd('reminder_schedule', {
      score: new Date(reminder.nextRun).getTime(),
      value: `${chatId}:${id}`
    });

    return id;
  } catch (error) {
    logger.error('Error saving reminder:', error);
    throw new Error('Failed to save reminder');
  }
}

/**
 * Updates a reminder's next run time
 * @param {string} chatId - Chat ID
 * @param {string} reminderId - Reminder ID
 * @param {Date} nextRun - Next scheduled run time
 * @param {string} timezone - Chat's timezone (optional)
 */
async function updateReminderNextRun(chatId, reminderId, nextRun, timezone) {
  try {
    // Get current reminder
    const reminderJson = await redisClient.hGet(`reminders:${chatId}`, reminderId);
    if (!reminderJson) {
      throw new Error('Reminder not found');
    }

    const reminder = JSON.parse(reminderJson);
    reminder.nextRun = nextRun.toISOString();

    // Update timezone if provided
    if (timezone) {
      reminder.timezone = timezone;
    }

    // Update in hash
    await redisClient.hSet(
        `reminders:${chatId}`,
        reminderId,
        JSON.stringify(reminder)
    );

    // Update in sorted set
    await redisClient.zRem('reminder_schedule', `${chatId}:${reminderId}`);
    await redisClient.zAdd('reminder_schedule', {
      score: new Date(nextRun).getTime(),
      value: `${chatId}:${reminderId}`
    });

    return reminder;
  } catch (error) {
    logger.error(`Error updating reminder ${reminderId}:`, error);
    throw error;
  }
}

/**
 * Gets due reminders that should be sent now
 * @returns {Promise<Array>} - Array of due reminders with chat and reminder IDs
 */
async function getDueReminders() {
  try {
    const now = Date.now();

    // Get all reminders due before now
    const dueReminderKeys = await redisClient.zRangeByScore(
        'reminder_schedule',
        0,
        now
    );

    const reminders = [];

    for (const key of dueReminderKeys) {
      const [chatId, reminderId] = key.split(':');

      // Get reminder details
      const reminderJson = await redisClient.hGet(`reminders:${chatId}`, reminderId);
      if (reminderJson) {
        reminders.push({
          chatId,
          reminderId,
          reminder: JSON.parse(reminderJson)
        });
      }
    }

    return reminders;
  } catch (error) {
    logger.error('Error getting due reminders:', error);
    throw error;
  }
}

/**
 * Saves chat timezone preference
 * @param {string} chatId - Telegram chat ID
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 */
async function saveUserTimezone(chatId, timezone) {
  try {
    await redisClient.set(`chat:${chatId}:timezone`, timezone);
    logger.info(`Saved timezone ${timezone} for chat ${chatId}`);
    return true;
  } catch (error) {
    logger.error(`Error saving timezone for chat ${chatId}:`, error);
    return false;
  }
}

/**
 * Gets chat timezone preference
 * @param {string} chatId - Telegram chat ID
 * @returns {Promise<string>} - Chat's timezone or default
 */
async function getUserTimezone(chatId) {
  try {
    const timezone = await redisClient.get(`chat:${chatId}:timezone`);
    return timezone || config.DEFAULT_TIMEZONE;
  } catch (error) {
    logger.error(`Error getting timezone for chat ${chatId}:`, error);
    return config.DEFAULT_TIMEZONE;
  }
}

/**
 * Deletes a reminder
 * @param {string} chatId - Chat ID
 * @param {string} reminderId - Reminder ID
 */
async function deleteReminder(chatId, reminderId) {
  try {
    await redisClient.hDel(`reminders:${chatId}`, reminderId);
    await redisClient.zRem('reminder_schedule', `${chatId}:${reminderId}`);
    logger.info(`Deleted reminder ${reminderId} for chat ${chatId}`);
    return true;
  } catch (error) {
    logger.error(`Error deleting reminder ${reminderId}:`, error);
    throw error;
  }
}

module.exports = {
  redisClient,
  saveReminder,
  updateReminderNextRun,
  getDueReminders,
  saveUserTimezone,
  getUserTimezone,
  deleteReminder
};