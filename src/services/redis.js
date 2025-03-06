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
 * @param {string} userId - Telegram user ID
 * @param {Object} reminder - Reminder object with timezone
 * @returns {Promise<string>} - Reminder ID
 */
async function saveReminder(userId, reminder) {
  try {
    // Generate unique ID
    const id = Date.now().toString();

    // Store in Redis hash: reminders:userId -> {id: reminderObject}
    await redisClient.hSet(
        `reminders:${userId}`,
        id,
        JSON.stringify(reminder)
    );

    // Store IDs in a sorted set by next run time for efficient querying
    await redisClient.zAdd('reminder_schedule', {
      score: new Date(reminder.nextRun).getTime(),
      value: `${userId}:${id}`
    });

    return id;
  } catch (error) {
    logger.error('Error saving reminder:', error);
    throw new Error('Failed to save reminder');
  }
}

/**
 * Updates a reminder's next run time
 * @param {string} userId - User ID
 * @param {string} reminderId - Reminder ID
 * @param {Date} nextRun - Next scheduled run time
 * @param {string} timezone - User's timezone (optional)
 */
async function updateReminderNextRun(userId, reminderId, nextRun, timezone) {
  try {
    // Get current reminder
    const reminderJson = await redisClient.hGet(`reminders:${userId}`, reminderId);
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
        `reminders:${userId}`,
        reminderId,
        JSON.stringify(reminder)
    );

    // Update in sorted set
    await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);
    await redisClient.zAdd('reminder_schedule', {
      score: new Date(nextRun).getTime(),
      value: `${userId}:${reminderId}`
    });

    return reminder;
  } catch (error) {
    logger.error(`Error updating reminder ${reminderId}:`, error);
    throw error;
  }
}

/**
 * Gets due reminders that should be sent now
 * @returns {Promise<Array>} - Array of due reminders with user and reminder IDs
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
      const [userId, reminderId] = key.split(':');

      // Get reminder details
      const reminderJson = await redisClient.hGet(`reminders:${userId}`, reminderId);
      if (reminderJson) {
        reminders.push({
          userId,
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
 * Saves user timezone preference
 * @param {string} userId - Telegram user ID
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 */
async function saveUserTimezone(userId, timezone) {
  try {
    await redisClient.set(`user:${userId}:timezone`, timezone);
    logger.info(`Saved timezone ${timezone} for user ${userId}`);
    return true;
  } catch (error) {
    logger.error(`Error saving timezone for user ${userId}:`, error);
    return false;
  }
}

/**
 * Gets user timezone preference
 * @param {string} userId - Telegram user ID
 * @returns {Promise<string>} - User's timezone or default
 */
async function getUserTimezone(userId) {
  try {
    const timezone = await redisClient.get(`user:${userId}:timezone`);
    return timezone || config.USER_TIMEZONE_DEFAULT;
  } catch (error) {
    logger.error(`Error getting timezone for user ${userId}:`, error);
    return config.USER_TIMEZONE_DEFAULT;
  }
}

/**
 * Deletes a reminder
 * @param {string} userId - User ID
 * @param {string} reminderId - Reminder ID
 */
async function deleteReminder(userId, reminderId) {
  try {
    await redisClient.hDel(`reminders:${userId}`, reminderId);
    await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);
    logger.info(`Deleted reminder ${reminderId} for user ${userId}`);
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