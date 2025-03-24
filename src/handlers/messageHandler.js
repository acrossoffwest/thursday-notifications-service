// src/handlers/messageHandler.js
const { analyzeMessage } = require('../services/openai');
const { saveReminder, getUserTimezone, saveUserTimezone, redisClient } = require('../services/redis');
const { calculateNextRun } = require('../services/scheduler');
const { Composer } = require('telegraf');
const { DateTime } = require('luxon');
const logger = require('../utils/logger');
const config = require('../config');

// Helper to convert time and date to user's timezone
async function getDateFromSchedule(schedule, userTimezone) {
  // Use Luxon for better timezone handling
  const now = DateTime.now().setZone(userTimezone);
  logger.info('Getting date from schedule:', {
    schedule,
    userTimezone,
    currentTime: now.toISO()
  });

  // For relative time reminders, calculate from current time
  if (schedule.isRelative && schedule.relativeMinutes) {
    const reminderDate = now.plus({ minutes: schedule.relativeMinutes });
    logger.info('Calculated relative time:', {
      relativeMinutes: schedule.relativeMinutes,
      fromTime: now.toISO(),
      calculatedTime: reminderDate.toISO()
    });
    return reminderDate.toJSDate();
  }

  if (schedule.frequency === 'once' && schedule.date) {
    // Parse date and time
    const [year, month, day] = schedule.date.split('-').map(Number);
    const [hours, minutes] = schedule.time.split(':').map(Number);

    // Create date in user's timezone
    const reminderDate = DateTime.fromObject({
      year, month, day, hour: hours, minute: minutes
    }, { zone: userTimezone });

    // Verify it's in the future
    if (reminderDate <= now) {
      logger.info('Reminder time is in the past:', {
        reminderTime: reminderDate.toISO(),
        currentTime: now.toISO()
      });
      return null; // Past time, can't set reminder
    }

    return reminderDate.toJSDate();
  }

  // For recurring schedules
  const [hours, minutes] = schedule.time.split(':').map(Number);

  // Start with today at the requested time
  let reminderDate = now.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

  // If time today has passed, set for next occurrence
  if (reminderDate <= now) {
    switch (schedule.frequency) {
      case 'daily':
        reminderDate = reminderDate.plus({ days: 1 });
        break;

      case 'weekly':
        const currentDay = now.weekday % 7; // Convert to 0-6 format (0 = Sunday)
        const targetDay = schedule.dayOfWeek;
        let daysUntil = (targetDay - currentDay + 7) % 7;

        // If same day but time passed, add a week
        if (daysUntil === 0) {
          daysUntil = 7;
        }

        reminderDate = reminderDate.plus({ days: daysUntil });
        break;

      case 'monthly':
        // Set day of month
        let targetMonth = now.month;
        let targetYear = now.year;

        // Move to next month if current day has passed
        if (now.day > schedule.dayOfMonth ||
            (now.day === schedule.dayOfMonth && reminderDate <= now)) {
          targetMonth++;
          if (targetMonth > 12) {
            targetMonth = 1;
            targetYear++;
          }
        }

        reminderDate = DateTime.fromObject({
          year: targetYear,
          month: targetMonth,
          day: schedule.dayOfMonth,
          hour: hours,
          minute: minutes
        }, { zone: userTimezone });

        // Handle invalid dates (e.g., February 30)
        if (!reminderDate.isValid) {
          // Get last day of the month
          reminderDate = DateTime.fromObject({
            year: targetYear,
            month: targetMonth + 1,
            day: 0,
            hour: hours,
            minute: minutes
          }, { zone: userTimezone });
        }
        break;
    }
  }

  logger.info('Calculated reminder date:', {
    frequency: schedule.frequency,
    calculatedTime: reminderDate.toISO()
  });

  return reminderDate.toJSDate();
}

// Helper function to handle multiple days reminders
async function handleMultipleDaysReminder(ctx, analysis, chatTimezone) {
  const chatId = ctx.chat.id.toString();
  const reminderIds = [];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Create separate reminders for each day
  for (const dayOfWeek of analysis.schedule.daysOfWeek) {
    // Create a weekly schedule for this specific day
    const singleDaySchedule = {
      ...analysis.schedule,
      frequency: 'weekly',
      dayOfWeek: dayOfWeek
    };

    // Calculate next run
    const now = DateTime.now().setZone(chatTimezone);
    const [hours, minutes] = analysis.schedule.time.split(':').map(Number);

    let reminderDate = now.set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

    // Calculate days until next occurrence
    const currentDay = now.weekday % 7; // Convert to 0-6 format (0 = Sunday)
    let daysUntil = (dayOfWeek - currentDay + 7) % 7;

    // If same day but time passed, add a week
    if (daysUntil === 0 && reminderDate <= now) {
      daysUntil = 7;
    }

    reminderDate = reminderDate.plus({ days: daysUntil });

    // Create reminder object
    const reminder = {
      message: analysis.message,
      schedule: singleDaySchedule,
      nextRun: reminderDate.toJSDate().toISOString(),
      createdAt: new Date().toISOString(),
      timezone: chatTimezone
    };

    // Save to Redis
    const reminderId = await saveReminder(chatId, reminder);
    reminderIds.push({ id: reminderId, day: days[dayOfWeek], nextRun: reminderDate });
  }

  // Format confirmation message
  let confirmationMsg = `✅ Reminder set: "${analysis.message}"\n`;

  // List days
  const dayNames = analysis.schedule.daysOfWeek.map(d => days[d]).join(' and ');
  confirmationMsg += `📆 Every ${dayNames} at ${analysis.schedule.time}\n\n`;

  // List individual reminders
  confirmationMsg += `Reminders created:\n`;

  for (const reminder of reminderIds) {
    confirmationMsg += `• ${reminder.day}: ID ${reminder.id}\n`;
    confirmationMsg += `  Next: ${reminder.nextRun.toLocaleString(DateTime.DATETIME_SHORT)}\n`;
  }

  confirmationMsg += `\nTimezone: ${chatTimezone}`;

  // Send confirmation
  await ctx.reply(confirmationMsg);
  logger.info(`Created ${reminderIds.length} reminders for days: ${dayNames}`);
}

// Helper function to detect timezone from message
async function detectTimezone(message, userId) {
  try {
    const openai = require('../services/openai').openai;
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `
          You are a multilingual timezone detection assistant. Extract location or timezone information from the message in any language.
          
          If the message explicitly mentions a timezone or city/location, determine the IANA timezone.
          
          For example:
          - "по варшавскому времени" should be detected as "Europe/Warsaw"
          - "remind me at 5pm Berlin time" should be detected as "Europe/Berlin"
          - "Tokyo time" should be detected as "Asia/Tokyo"
          
          Return your response as JSON with the following structure:
          {
            "hasTimezoneInfo": boolean, // true if the message contains timezone information
            "location": string, // the detected location (city, country, etc.)
            "timezone": string, // the IANA timezone string (e.g., "Europe/Moscow", "America/New_York")
            "confidence": number // 0-1 value indicating confidence in the timezone detection
          }
          
          If no timezone or location is mentioned, set hasTimezoneInfo to false and other fields to null.
          Only return valid IANA timezone strings for the timezone field.
          `
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    logger.debug('Timezone detection result:', result);

    if (result.hasTimezoneInfo && result.timezone && result.confidence > 0.7) {
      // Save the timezone
      await saveUserTimezone(userId, result.timezone);
      return result.timezone;
    }

    return null;
  } catch (error) {
    logger.error('Error detecting timezone:', error);
    return null;
  }
}

/**
 * Handles incoming user messages
 */
const messageHandler = async (ctx) => {
  const messageText = ctx.message.text;
  const chatId = ctx.chat.id.toString();

  // Get current time in different formats for debugging
  const nowUtc = DateTime.utc();
  const nowLocal = DateTime.local();
  const debugTimeInfo = `
🕒 Debug Time Info:
UTC: ${nowUtc.toFormat('yyyy-MM-dd HH:mm:ss')}
Local: ${nowLocal.toFormat('yyyy-MM-dd HH:mm:ss')}
Timestamp: ${Date.now()}`;

  logger.info(`Received message from chat ${chatId}: ${messageText}${debugTimeInfo}`);

  // Skip handling commands
  if (messageText.startsWith('/')) {
    return;
  }

  try {
    // Check if we're in timezone detection mode
    const expectingTimezone = await redisClient.get(`chat:${chatId}:expecting_timezone`);

    if (expectingTimezone === 'true') {
      // Try to detect timezone from this message specifically
      const timezone = await detectTimezone(messageText, chatId);

      if (timezone) {
        // Clear the flag
        await redisClient.del(`chat:${chatId}:expecting_timezone`);

        // Get current time in that timezone
        const localTime = DateTime.now().setZone(timezone);

        await ctx.reply(
          `✅ I've set your timezone to ${timezone}.\n` +
          `Your local time should be: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss')}\n` +
          debugTimeInfo
        );

        // Offer to update existing reminders
        const reminders = await redisClient.hGetAll(`reminders:${chatId}`);

        if (reminders && Object.keys(reminders).length > 0) {
          await ctx.reply(`You have ${Object.keys(reminders).length} existing reminders. Would you like me to update them to use your new timezone?`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Yes, update all reminders", callback_data: `update_tz_all` }
                ],
                [
                  { text: "No, keep current times", callback_data: `update_tz_none` }
                ]
              ]
            }
          });
        }

        return;
      } else {
        await ctx.reply(
          "I couldn't detect a timezone from that message. Please try again with a city or country name, or use the /timezone command to set it directly.\n" +
          debugTimeInfo
        );
        return;
      }
    }

    // Get chat's timezone
    const chatTimezone = await getUserTimezone(chatId);
    const nowInChatTz = DateTime.now().setZone(chatTimezone);
    logger.info(`Processing with chat timezone ${chatTimezone}, current time there: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}`);

    // Process message with OpenAI
    const analysis = await analyzeMessage(messageText, chatId);

    // If not a reminder request, ignore
    if (!analysis || !analysis.isReminder) {
      return;
    }

    // Handle multiple days scenario if needed
    if (analysis.schedule.frequency === 'multiple_days') {
      await handleMultipleDaysReminder(ctx, analysis, chatTimezone);
      return;
    }

    // Create reminder object
    const nextRun = await getDateFromSchedule(analysis.schedule, chatTimezone);
    logger.info(`Calculated next run time: ${nextRun ? new Date(nextRun).toISOString() : 'null'}`);

    if (!nextRun || nextRun < new Date()) {
      // If time is in the past, suggest scheduling for tomorrow
      if (analysis.schedule.frequency === 'once') {
        // Store the reminder data in Redis temporarily instead of in the button
        const rescheduleKey = `reschedule:${chatId}:${Date.now()}`;
        await redisClient.set(rescheduleKey, JSON.stringify({
          message: analysis.message,
          time: analysis.schedule.time
        }), { EX: 300 }); // Expire after 5 minutes

        return ctx.reply(
          "That time has already passed. Would you like to set this reminder for tomorrow at the same time?\n" +
          `Current time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}\n` +
          `Requested time: ${analysis.schedule.time}\n` +
          debugTimeInfo,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Yes, set for tomorrow", callback_data: `reschedule_${rescheduleKey}` }
                ],
                [
                  { text: "No, cancel", callback_data: "cancel_reminder" }
                ]
              ]
            }
          }
        );
      } else {
        return ctx.reply(
          "I couldn't set that reminder. Please specify a future time.\n" +
          `Current time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}\n` +
          debugTimeInfo
        );
      }
    }

    // Create reminder object
    const reminder = {
      message: analysis.message,
      schedule: analysis.schedule,
      nextRun: nextRun.toISOString(),
      createdAt: new Date().toISOString(),
      timezone: chatTimezone // Store timezone with reminder
    };

    // Save to Redis
    const reminderId = await saveReminder(chatId, reminder);

    // Format confirmation message
    let confirmationMsg = `✅ Reminder set: "${analysis.message}"\n`;

    // Format time in chat's timezone
    const reminderTime = DateTime.fromJSDate(nextRun).setZone(chatTimezone);

    switch (analysis.schedule.frequency) {
      case 'once':
        confirmationMsg += `📅 Date: ${reminderTime.toLocaleString(DateTime.DATE_FULL)}\n`;
        confirmationMsg += `⏰ Time: ${reminderTime.toLocaleString(DateTime.TIME_SIMPLE)}`;
        break;

      case 'daily':
        confirmationMsg += `📆 Every day at ${analysis.schedule.time}`;
        break;

      case 'weekly':
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        confirmationMsg += `📆 Every ${days[analysis.schedule.dayOfWeek]} at ${analysis.schedule.time}`;
        break;

      case 'monthly':
        confirmationMsg += `📆 Every month on day ${analysis.schedule.dayOfMonth} at ${analysis.schedule.time}`;
        break;
    }

    confirmationMsg += `\n\nNext reminder: ${reminderTime.toLocaleString(DateTime.DATETIME_FULL)}`;
    confirmationMsg += `\nReminder ID: ${reminderId}`;
    confirmationMsg += `\nTimezone: ${chatTimezone}`;
    confirmationMsg += `\n\nCurrent time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}`;
    confirmationMsg += debugTimeInfo;

    // Send confirmation
    await ctx.reply(confirmationMsg);
    logger.info(`Created reminder ${reminderId} for chat ${chatId} with timezone ${chatTimezone}. Next run: ${nextRun.toISOString()}`);

  } catch (error) {
    logger.error('Error handling message:', error);
    await ctx.reply(
      "I'm having trouble understanding that request. Could you try again with a clearer reminder format?\n" +
      debugTimeInfo
    );
  }
};

module.exports = {
  messageHandler,
  detectTimezone
};