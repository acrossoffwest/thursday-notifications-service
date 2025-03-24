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
  confirmationMsg += `📆 Every ${dayNames} at ${analysis.schedule.time} ${chatTimezone}\n\n`;

  // List individual reminders
  confirmationMsg += `Reminders created:\n`;

  for (const reminder of reminderIds) {
    confirmationMsg += `• ${reminder.day}: ID ${reminder.id}\n`;
    confirmationMsg += `  Next: ${reminder.nextRun.toFormat('MMMM d, yyyy HH:mm')} ${chatTimezone}\n`;
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
    
    // Create a promise that rejects after 10 seconds
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timezone detection timed out')), 10000);
    });

    // Race between the API call and the timeout
    const response = await Promise.race([
      openai.chat.completions.create({
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
      }),
      timeoutPromise
    ]);

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
    if (error.message === 'Timezone detection timed out') {
      logger.warn('Timezone detection timed out after 10 seconds');
    }
    return null;
  }
}

// Helper to check if message should be processed
async function shouldProcessMessage(ctx, messageText) {
  // Always process private chats
  if (ctx.chat.type === 'private') {
    return { shouldProcess: true, cleanMessage: messageText };
  }

  // Get bot info for mention check
  const botInfo = await ctx.telegram.getMe();
  const botUsername = botInfo.username;
  const mentionRegex = new RegExp(`@${botUsername}\\b`, 'i');

  // Check for bot mention in group chats
  if (!mentionRegex.test(messageText)) {
    logger.debug('Bot not mentioned in group chat, skipping message');
    return { shouldProcess: false, cleanMessage: null };
  }

  // Remove bot mention and clean the message
  const cleanMessage = messageText.replace(mentionRegex, '').trim();
  return { shouldProcess: true, cleanMessage };
}

/**
 * Handles /remind command
 */
const remindCommandHandler = async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const messageText = ctx.message.text.substring(7).trim(); // Remove "/remind "

  // Get current time in different formats for debugging
  const nowUtc = DateTime.utc();
  const nowLocal = DateTime.local();
  const debugTimeInfo = `
🕒 Debug Time Info:
UTC: ${nowUtc.toFormat('yyyy-MM-dd HH:mm:ss')}
Local: ${nowLocal.toFormat('yyyy-MM-dd HH:mm:ss')}
Timestamp: ${Date.now()}`;

  logger.info(`Received /remind command from chat ${chatId}: ${messageText}${debugTimeInfo}`);

  if (!messageText) {
    await ctx.reply(
      "Please provide a reminder message. Examples:\n" +
      "- /remind drink water in 5 minutes\n" +
      "- /remind take medicine every day at 9am\n" +
      "- /remind exercise every Monday and Wednesday at 3pm\n" +
      "- /remind team meeting every month on day 15 at 14:00"
    );
    return;
  }

  try {
    // Check if user has a timezone set
    const chatTimezone = await getUserTimezone(chatId);
    
    if (!chatTimezone) {
      await ctx.reply(
        "Before I can set reminders, I need to know your timezone. Please:\n\n" +
        "1. Use /timezone command (e.g., /timezone Europe/Moscow)\n" +
        "This helps me set reminders at the correct time for you."
      );
      return;
    }

    // Get chat's timezone for reminder processing
    const nowInChatTz = DateTime.now().setZone(chatTimezone);
    logger.info(`Processing with chat timezone ${chatTimezone}, current time there: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}`);

    // Process message with OpenAI
    const analysis = await analyzeMessage(messageText, chatId);

    // If not a valid reminder request, show help
    if (!analysis || !analysis.isReminder) {
      await ctx.reply(
        "I couldn't understand that reminder format. Please try again with one of these formats:\n" +
        "- /remind drink water in 5 minutes\n" +
        "- /remind take medicine every day at 9am\n" +
        "- /remind exercise every Monday and Wednesday at 3pm\n" +
        "- /remind team meeting every month on day 15 at 14:00"
      );
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
        // Store the reminder data in Redis temporarily
        const rescheduleKey = `reschedule:${chatId}:${Date.now()}`;
        await redisClient.set(rescheduleKey, JSON.stringify({
          message: analysis.message,
          time: analysis.schedule.time
        }), { EX: 300 }); // Expire after 5 minutes

        return ctx.reply(
          "That time has already passed. Would you like to set this reminder for tomorrow at the same time?\n" +
          `Current time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}\n` +
          `Requested time: ${analysis.schedule.time}`,
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
          `Current time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}`
        );
      }
    }

    // Create reminder object
    const reminder = {
      message: analysis.message,
      schedule: analysis.schedule,
      nextRun: nextRun.toISOString(),
      createdAt: new Date().toISOString(),
      timezone: chatTimezone
    };

    // Save to Redis
    const reminderId = await saveReminder(chatId, reminder);

    // Format confirmation message
    let confirmationMsg = `✅ Reminder set: "${analysis.message}"\n`;

    // Format time in chat's timezone
    const reminderTime = DateTime.fromJSDate(nextRun).setZone(chatTimezone);

    switch (analysis.schedule.frequency) {
      case 'once':
        confirmationMsg += `📅 Date: ${reminderTime.toFormat('MMMM d, yyyy')}\n`;
        confirmationMsg += `⏰ Time: ${reminderTime.toFormat('HH:mm')} ${chatTimezone}`;
        break;

      case 'daily':
        confirmationMsg += `📆 Every day at ${analysis.schedule.time} ${chatTimezone}`;
        break;

      case 'weekly':
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        confirmationMsg += `📆 Every ${days[analysis.schedule.dayOfWeek]} at ${analysis.schedule.time} ${chatTimezone}`;
        break;

      case 'monthly':
        confirmationMsg += `📆 Every month on day ${analysis.schedule.dayOfMonth} at ${analysis.schedule.time} ${chatTimezone}`;
        break;
    }

    confirmationMsg += `\n\nNext reminder: ${reminderTime.toFormat('MMMM d, yyyy HH:mm')} ${chatTimezone}`;
    confirmationMsg += `\nReminder ID: ${reminderId}`;
    confirmationMsg += `\nTimezone: ${chatTimezone}`;
    confirmationMsg += `\n\nCurrent time in ${chatTimezone}: ${nowInChatTz.toFormat('yyyy-MM-dd HH:mm:ss')}`;

    // Send confirmation
    await ctx.reply(confirmationMsg);
    logger.info(`Created reminder ${reminderId} for chat ${chatId} with timezone ${chatTimezone}. Next run: ${nextRun.toISOString()}`);

  } catch (error) {
    logger.error('Error handling /remind command:', error);
    await ctx.reply(
      "I'm having trouble setting that reminder. Please try again with a clearer format:\n" +
      "- /remind drink water in 5 minutes\n" +
      "- /remind take medicine every day at 9am\n" +
      "- /remind exercise every Monday and Wednesday at 3pm"
    );
  }
};

/**
 * Handles /timezone command
 */
const timezoneCommandHandler = async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const timezone = ctx.message.text.substring(9).trim(); // Remove "/timezone "

  if (!timezone) {
    await ctx.reply(
      "Please provide a timezone. Examples:\n" +
      "- /timezone Europe/Warsaw\n" +
      "- /timezone Moscow\n" +
      "- /timezone New York\n" +
      "- /timezone Tokyo\n\n" +
      "You can use city names or standard timezone formats.\n" +
      "I'll help you find the correct timezone format!"
    );
    return;
  }

  try {
    // Validate and normalize timezone using OpenAI
    const { validateTimezone } = require('../services/openai');
    const validation = await validateTimezone(timezone);

    if (!validation.isValid || !validation.suggestedTimezone) {
      await ctx.reply(
        "I couldn't determine your timezone. Please try:\n" +
        "1. Using a major city name (e.g., Moscow, New York, Tokyo)\n" +
        "2. Using the standard format (e.g., Europe/Warsaw, America/New_York)\n\n" +
        "You can find your timezone here: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
      );
      return;
    }

    // If input wasn't exact, show what we're using
    let confirmationPrefix = "";
    if (validation.originalInput !== validation.suggestedTimezone) {
      confirmationPrefix = `I understood "${validation.originalInput}" as "${validation.suggestedTimezone}"\n${validation.explanation}\n\n`;
    }

    // Save the normalized timezone
    await saveUserTimezone(chatId, validation.suggestedTimezone);

    // Get current time in new timezone
    const localTime = DateTime.now().setZone(validation.suggestedTimezone);

    await ctx.reply(
      confirmationPrefix +
      `✅ Timezone set to ${validation.suggestedTimezone}\n` +
      `Your local time should be: ${localTime.toFormat('yyyy-MM-dd HH:mm:ss')}\n\n` +
      `You can now create reminders using the /remind command. For example:\n` +
      `- /remind drink water in 5 minutes\n` +
      `- /remind take medicine every day at 9am\n` +
      `- /remind exercise every Monday and Wednesday at 3pm`
    );

  } catch (error) {
    logger.error('Error handling /timezone command:', error);
    await ctx.reply(
      "Sorry, there was an error setting your timezone. Please try again with a city name or standard timezone format.\n" +
      "Examples:\n" +
      "- /timezone Moscow\n" +
      "- /timezone Europe/Warsaw\n" +
      "- /timezone New York"
    );
  }
};

module.exports = {
  remindCommandHandler,
  timezoneCommandHandler
};