// Updated scheduler.js with timezone support
const { getDueReminders, updateReminderNextRun, deleteReminder, getUserTimezone } = require('./redis');
const config = require('../config');
const logger = require('../utils/logger');
const { DateTime } = require('luxon');

// Calculate next run time based on schedule and timezone
function calculateNextRun(reminder) {
  const now = DateTime.now().setZone(reminder.timezone || config.USER_TIMEZONE_DEFAULT);
  const schedule = reminder.schedule;

  // Skip calculation for one-time reminders
  if (schedule.frequency === 'once') {
    return null;
  }

  // Extract time components
  const [hours, minutes] = schedule.time.split(':').map(Number);
  let nextRun;

  switch (schedule.frequency) {
    case 'daily':
      // Set time for tomorrow in user's timezone
      nextRun = now.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

      // If the calculated time is in the past, move to tomorrow
      if (nextRun <= now) {
        nextRun = nextRun.plus({ days: 1 });
      }
      break;

    case 'weekly':
      // Set time in user's timezone
      nextRun = now.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

      // Calculate days until next occurrence of day of week
      const currentDay = now.weekday % 7; // Convert to 0-6 format (0 = Sunday)
      const targetDay = schedule.dayOfWeek;
      let daysUntil = (targetDay - currentDay + 7) % 7;

      // If it's the same day but time has passed, add a week
      if (daysUntil === 0 && nextRun <= now) {
        daysUntil = 7;
      }

      nextRun = nextRun.plus({ days: daysUntil });
      break;

    case 'monthly':
      // Set day and time
      let targetMonth = now.month;
      let targetYear = now.year;

      // Move to next month if this month's day has passed
      const currentDate = now.day;
      if (currentDate > schedule.dayOfMonth ||
          (currentDate === schedule.dayOfMonth &&
              now.hour > hours ||
              (now.hour === hours && now.minute >= minutes))) {
        targetMonth++;
        if (targetMonth > 12) {
          targetMonth = 1;
          targetYear++;
        }
      }

      // Create date for next run
      nextRun = DateTime.fromObject({
        year: targetYear,
        month: targetMonth,
        day: schedule.dayOfMonth,
        hour: hours,
        minute: minutes,
        second: 0,
        millisecond: 0
      }, { zone: reminder.timezone || config.USER_TIMEZONE_DEFAULT });

      // Handle invalid dates (e.g., February 30)
      if (!nextRun.isValid) {
        // Get last day of the month
        nextRun = DateTime.fromObject({
          year: targetYear,
          month: targetMonth + 1,
          day: 0, // Last day of previous month
          hour: hours,
          minute: minutes,
          second: 0,
          millisecond: 0
        }, { zone: reminder.timezone || config.USER_TIMEZONE_DEFAULT });
      }
      break;

    default:
      logger.error(`Unknown frequency: ${schedule.frequency}`);
      return null;
  }

  return nextRun.toJSDate();
}

/**
 * Sets up the scheduler to check for due reminders
 * @param {Object} bot - Telegraf bot instance
 */
async function setupScheduler(bot) {
  // Track processed reminders to prevent duplicates
  const processedReminders = new Map();

  // Function to process due reminders
  async function processReminders() {
    try {
      const dueReminders = await getDueReminders();

      for (const { chatId, reminderId, reminder } of dueReminders) {
        try {
          // Generate a unique key for this reminder occurrence
          const currentTime = Date.now();
          const reminderKey = `${chatId}:${reminderId}:${Math.floor(currentTime / 60000)}`; // Round to minute

          // Skip if already processed in the last minute
          if (processedReminders.has(reminderKey)) {
            continue;
          }

          // Mark as processed
          processedReminders.set(reminderKey, currentTime);

          // Clean up old processed records (older than 10 minutes)
          for (const [key, timestamp] of processedReminders.entries()) {
            if (currentTime - timestamp > 600000) { // 10 minutes
              processedReminders.delete(key);
            }
          }

          // Format the reminder time in chat's timezone
          const chatTimezone = reminder.timezone || await getUserTimezone(chatId);
          const reminderTime = DateTime.fromJSDate(new Date(reminder.nextRun))
              .setZone(chatTimezone);

          // Send the reminder with properly formatted time
          await bot.telegram.sendMessage(chatId, `⏰ Reminder: ${reminder.message}`);
          logger.info(`Sent reminder ${reminderId} to chat ${chatId} at ${reminderTime.toFormat('HH:mm')} (${chatTimezone})`);

          // Calculate next run time
          const nextRun = calculateNextRun(reminder);

          if (nextRun) {
            // Update reminder with new next run time
            await updateReminderNextRun(chatId, reminderId, nextRun, chatTimezone);
            logger.info(`Rescheduled reminder ${reminderId} for ${nextRun}`);
          } else {
            // Delete one-time reminder that's completed
            await deleteReminder(chatId, reminderId);
            logger.info(`Deleted one-time reminder ${reminderId}`);
          }
        } catch (error) {
          logger.error(`Error processing reminder ${reminderId}:`, error);
        }
      }
    } catch (error) {
      logger.error('Error in scheduler:', error);
    } finally {
      // Schedule next check
      setTimeout(processReminders, config.SCHEDULER_CHECK_INTERVAL);
    }
  }

  // Start the scheduler
  processReminders();
  logger.info(`Scheduler started, checking every ${config.SCHEDULER_CHECK_INTERVAL}ms`);
}

// // Update Redis service to include timezone in updateReminderNextRun
// async function updateReminderNextRun(userId, reminderId, nextRun, timezone) {
//   try {
//     // Get current reminder
//     const reminderJson = await redisClient.hGet(`reminders:${userId}`, reminderId);
//     if (!reminderJson) {
//       throw new Error('Reminder not found');
//     }
//
//     const reminder = JSON.parse(reminderJson);
//     reminder.nextRun = nextRun.toISOString();
//
//     // Ensure timezone is saved with the reminder
//     if (timezone && !reminder.timezone) {
//       reminder.timezone = timezone;
//     }
//
//     // Update in hash
//     await redisClient.hSet(
//         `reminders:${userId}`,
//         reminderId,
//         JSON.stringify(reminder)
//     );
//
//     // Update in sorted set
//     await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);
//     await redisClient.zAdd('reminder_schedule', {
//       score: new Date(nextRun).getTime(),
//       value: `${userId}:${reminderId}`
//     });
//
//     return reminder;
//   } catch (error) {
//     logger.error(`Error updating reminder ${reminderId}:`, error);
//     throw error;
//   }
// }

module.exports = {
  setupScheduler,
  calculateNextRun,
  updateReminderNextRun
};