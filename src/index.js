// src/index.js

// Main application entry point
const { Telegraf } = require('telegraf');
const { remindCommandHandler, timezoneCommandHandler } = require('./handlers/messageHandler');
const { setupScheduler } = require('./services/scheduler');
const { redisClient, saveUserTimezone, getUserTimezone, saveReminder } = require('./services/redis');
const config = require('./config');
const logger = require('./utils/logger');
const { DateTime } = require('luxon');

// Initialize bot
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Register commands
bot.command('remind', remindCommandHandler);
bot.command('timezone', timezoneCommandHandler);

// Set up command descriptions
bot.telegram.setMyCommands([
  {
    command: 'remind',
    description: 'Set a new reminder. Example: /remind drink water in 5 minutes'
  },
  {
    command: 'timezone',
    description: 'Set your timezone. Example: /timezone Europe/Moscow'
  }
]);

// Connect to Redis and start bot
(async () => {
  try {
    await redisClient.connect();
    logger.info('Connected to Redis');

    // Set up the scheduler after Redis connection
    await setupScheduler(bot);

    // Start the bot
    await bot.launch();
    logger.info('Bot started successfully');
  } catch (error) {
    logger.error('Failed to start services:', error);
    process.exit(1);
  }
})();

bot.command('start', async (ctx) => {
  const firstName = ctx.from.first_name || 'there';
  const chatId = ctx.chat.id.toString();

  // Check if timezone is set for this chat
  const chatTimezone = await getUserTimezone(chatId);
  const timezoneMessage = chatTimezone === config.USER_TIMEZONE_DEFAULT
    ? "\n⚠️ IMPORTANT: Please set your timezone first using /timezone command."
    : `\n✅ Your timezone is set to: ${chatTimezone}`;

  ctx.reply(
      `Hello ${firstName}! 👋\n\n` +
      `I'm your personal reminder assistant powered by AI. I can understand natural language requests to set reminders.${timezoneMessage}\n\n` +
      `Try these commands:\n` +
      `/remind - Set a new reminder\n` +
      `/list - View all your active reminders\n` +
      `/delete [id] - Delete a specific reminder\n` +
      `/timezone - Set your timezone\n` +
      `/mytimezone - Check your current timezone\n` +
      `/help - Show more example commands\n\n` +
      `Examples:\n` +
      `• /remind drink water in 5 minutes\n` +
      `• /remind take medicine every day at 9am\n` +
      `• /remind exercise every Monday and Wednesday at 6pm`
  );
});

bot.command('list', async (ctx) => {
  try {
    const chatId = ctx.chat.id.toString();
    const reminders = await redisClient.hGetAll(`reminders:${chatId}`);

    if (!reminders || Object.keys(reminders).length === 0) {
      return ctx.reply('You have no active reminders.');
    }

    // Send each reminder as a separate message with delete button
    for (const [id, reminderJson] of Object.entries(reminders)) {
      const reminder = JSON.parse(reminderJson);
      const timezone = reminder.timezone || await getUserTimezone(chatId);
      const nextRunTime = DateTime.fromISO(reminder.nextRun).setZone(timezone);

      let message = `🔔 <b>${reminder.message}</b>\n\n`;

      switch (reminder.schedule.frequency) {
        case 'once':
          message += `📅 Once on ${nextRunTime.toFormat('MMMM d, yyyy')}\n`;
          message += `⏰ At ${nextRunTime.toFormat('HH:mm')} ${timezone}`;
          break;
        case 'daily':
          message += `📆 Every day at ${reminder.schedule.time} ${timezone}`;
          break;
        case 'weekly':
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          message += `📆 Every ${days[reminder.schedule.dayOfWeek]} at ${reminder.schedule.time} ${timezone}`;
          break;
        case 'monthly':
          message += `📆 Every month on day ${reminder.schedule.dayOfMonth} at ${reminder.schedule.time} ${timezone}`;
          break;
      }

      message += `\n\nNext reminder: ${nextRunTime.toFormat('MMMM d, yyyy HH:mm')} ${timezone}`;
      message += `\nTimezone: ${timezone}`;
      message += `\nID: ${id}`;

      await ctx.replyWithHTML(message, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "❌ Delete Reminder", callback_data: `delete_${id}` }
            ]
          ]
        }
      });
    }
  } catch (error) {
    logger.error('Error listing reminders:', error);
    ctx.reply('Failed to retrieve reminders. Please try again later.');
  }
});

// Handle callback queries for delete buttons
bot.action(/delete_(.+)/, async (ctx) => {
  try {
    const reminderId = ctx.match[1];
    const chatId = ctx.chat.id.toString();

    // Delete the reminder
    const deleted = await redisClient.hDel(`reminders:${chatId}`, reminderId);

    if (deleted) {
      // Also remove from scheduler
      await redisClient.zRem('reminder_schedule', `${chatId}:${reminderId}`);

      // Update the message to show it's deleted
      await ctx.editMessageText(`✅ Reminder deleted successfully!`);
      await ctx.answerCbQuery('Reminder deleted');
    } else {
      await ctx.answerCbQuery('Reminder not found');
    }
  } catch (error) {
    logger.error('Error handling delete callback:', error);
    await ctx.answerCbQuery('Error deleting reminder');
  }
});

bot.command('delete', async (ctx) => {
  const reminderId = ctx.message.text.split(' ')[1];
  if (!reminderId) {
    return ctx.reply('Please provide a reminder ID to delete. Use /list to see your reminders.');
  }

  try {
    const chatId = ctx.chat.id.toString();
    const exists = await redisClient.hExists(`reminders:${chatId}`, reminderId);

    if (!exists) {
      return ctx.reply(`Reminder with ID ${reminderId} not found.`);
    }

    await redisClient.hDel(`reminders:${chatId}`, reminderId);
    await redisClient.zRem('reminder_schedule', `${chatId}:${reminderId}`);
    ctx.reply(`Reminder ${reminderId} deleted successfully.`);
  } catch (error) {
    logger.error('Error deleting reminder:', error);
    ctx.reply('Failed to delete reminder. Please try again later.');
  }
});

bot.command('help', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const chatTimezone = await getUserTimezone(chatId);
  const timezoneMessage = chatTimezone === config.USER_TIMEZONE_DEFAULT
    ? "\n⚠️ IMPORTANT: Please set your timezone first using /timezone command."
    : `\n✅ Your timezone is set to: ${chatTimezone}`;

  ctx.reply(
      'Here are the available commands:' + timezoneMessage + '\n\n' +
      '/remind - Set a new reminder\n' +
      '/timezone - Set your timezone\n' +
      '/list - Show all your active reminders\n' +
      '/delete [id] - Delete a specific reminder\n' +
      '/mytimezone - Check your current timezone\n' +
      '/help - Show this help message\n\n' +
      'Example reminders:\n' +
      '• /remind take medicine every day at 9am\n' +
      '• /remind team meeting every Thursday at 3pm\n' +
      '• /remind call mom on Sundays at 6pm\n' +
      '• /remind drink water in 5 minutes\n\n' +
      'Note: Timezone is shared for all users in this chat to ensure consistent reminder times.'
  );
});

// My timezone command
bot.command('mytimezone', async (ctx) => {
  const chatId = ctx.chat.id.toString();
  try {
    const timezone = await getUserTimezone(chatId);
    const localTime = DateTime.now().setZone(timezone).toFormat('yyyy-MM-dd HH:mm:ss');

    ctx.reply(`Your current timezone is set to: ${timezone}\nYour local time should be: ${localTime}`);
  } catch (error) {
    logger.error(`Error getting timezone for chat ${chatId}:`, error);
    ctx.reply('I could not retrieve your timezone. Please try setting it with the /timezone command.');
  }
});

// Handle callbacks for timezone updates
bot.action(/update_tz_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const chatId = ctx.chat.id.toString();

  if (action === 'all') {
    try {
      const chatTimezone = await getUserTimezone(chatId);
      const reminders = await redisClient.hGetAll(`reminders:${chatId}`);

      let updatedCount = 0;

      for (const [reminderId, reminderJson] of Object.entries(reminders)) {
        const reminder = JSON.parse(reminderJson);

        // Update the timezone
        reminder.timezone = chatTimezone;

        // Recalculate next run
        const nextRun = calculateNextRun(reminder);

        if (nextRun) {
          reminder.nextRun = nextRun.toISOString();

          // Save updated reminder
          await redisClient.hSet(`reminders:${chatId}`, reminderId, JSON.stringify(reminder));

          // Update in sorted set
          await redisClient.zRem('reminder_schedule', `${chatId}:${reminderId}`);
          await redisClient.zAdd('reminder_schedule', {
            score: new Date(nextRun).getTime(),
            value: `${chatId}:${reminderId}`
          });

          updatedCount++;
        }
      }

      await ctx.editMessageText(`✅ Updated ${updatedCount} reminders to use your timezone (${chatTimezone}).`);
    } catch (error) {
      logger.error('Error updating reminders timezone:', error);
      await ctx.editMessageText('Sorry, I encountered an error updating your reminders.');
    }
  } else {
    await ctx.editMessageText('Your reminders will keep their current times. You can update individual reminders by deleting and recreating them.');
  }
});

// Reschedule reminder handling
bot.action(/reschedule_(.+)/, async (ctx) => {
  try {
    const rescheduleKey = ctx.match[1];
    const chatId = ctx.chat.id.toString();

    // Get stored data
    const reminderDataJson = await redisClient.get(rescheduleKey);
    if (!reminderDataJson) {
      return ctx.reply("Sorry, this reschedule request has expired. Please set a new reminder.");
    }

    const reminderData = JSON.parse(reminderDataJson);
    const chatTimezone = await getUserTimezone(chatId);

    // Create tomorrow's date
    const tomorrow = DateTime.now().setZone(chatTimezone).plus({ days: 1 });
    const [hours, minutes] = reminderData.time.split(':').map(Number);

    const reminderDate = tomorrow.set({
      hour: hours,
      minute: minutes,
      second: 0,
      millisecond: 0
    });

    // Create reminder object
    const reminder = {
      message: reminderData.message,
      schedule: {
        frequency: 'once',
        time: reminderData.time,
        date: reminderDate.toFormat('yyyy-MM-dd')
      },
      nextRun: reminderDate.toJSDate().toISOString(),
      createdAt: new Date().toISOString(),
      timezone: chatTimezone
    };

    // Save to Redis
    const reminderId = await saveReminder(chatId, reminder);

    // Clean up temporary data
    await redisClient.del(rescheduleKey);

    // Confirm to user
    const confirmationMsg = `✅ Reminder rescheduled: "${reminderData.message}"\n` +
        `📅 Date: ${reminderDate.toFormat('MMMM d, yyyy')}\n` +
        `⏰ Time: ${reminderDate.toFormat('HH:mm')} ${chatTimezone}\n\n` +
        `Next reminder: ${reminderDate.toFormat('MMMM d, yyyy HH:mm')} ${chatTimezone}\n` +
        `Reminder ID: ${reminderId}\n` +
        `Timezone: ${chatTimezone}`;

    await ctx.editMessageText(confirmationMsg);

  } catch (error) {
    logger.error('Error rescheduling reminder:', error);
    await ctx.reply("Sorry, I couldn't reschedule your reminder. Please try setting a new one.");
  }
});

bot.action('cancel_reminder', async (ctx) => {
  await ctx.editMessageText("Reminder cancelled. You can set a new one anytime.");
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));