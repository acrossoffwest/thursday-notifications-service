// Main application entry point
const { Telegraf } = require('telegraf');
const { messageHandler } = require('./handlers/messageHandler');
const { setupScheduler } = require('./services/scheduler');
const { redisClient, getUserTimezone, saveReminder} = require('./services/redis');
const config = require('./config');
const logger = require('./utils/logger');
const {DateTime} = require("luxon");

// Initialize bot
const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Connect to Redis
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

bot.command('start', (ctx) => {
  const firstName = ctx.from.first_name || 'there';

  ctx.reply(
      `Hello ${firstName}! 👋\n\n` +
      `I'm your personal reminder assistant powered by AI. I can understand natural language requests to set reminders.\n\n` +
      `Try saying something like:\n` +
      `• "Remind me to call Alex tomorrow at 3pm"\n` +
      `• "Set a reminder for gym every Monday and Wednesday at 6pm"\n` +
      `• "Remind me to take medicine daily at 9am"\n\n` +
      `You can also use these commands:\n` +
      `/list - View all your active reminders\n` +
      `/delete [id] - Delete a specific reminder\n` +
      `/help - Show more example commands\n\n` +
      `What would you like me to remind you about?`
  );
});

bot.command('list', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const reminders = await redisClient.hGetAll(`reminders:${userId}`);

    if (!reminders || Object.keys(reminders).length === 0) {
      return ctx.reply('You have no active reminders.');
    }

    // Send each reminder as a separate message with delete button
    for (const [id, reminderJson] of Object.entries(reminders)) {
      const reminder = JSON.parse(reminderJson);

      let message = `🔔 <b>${reminder.message}</b>\n\n`;

      switch (reminder.schedule.frequency) {
        case 'once':
          message += `📅 Once on ${new Date(reminder.nextRun).toLocaleDateString()}\n`;
          message += `⏰ At ${new Date(reminder.nextRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          break;
        case 'daily':
          message += `📆 Every day at ${reminder.schedule.time}`;
          break;
        case 'weekly':
          const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          message += `📆 Every ${days[reminder.schedule.dayOfWeek]} at ${reminder.schedule.time}`;
          break;
        case 'monthly':
          message += `📆 Every month on day ${reminder.schedule.dayOfMonth} at ${reminder.schedule.time}`;
          break;
      }

      message += `\n\nNext reminder: ${new Date(reminder.nextRun).toLocaleString()}`;
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

// Add this callback handler in index.js
bot.action(/reschedule_(.+)/, async (ctx) => {
  try {
    const rescheduleKey = ctx.match[1];
    const userId = ctx.from.id.toString();

    // Get stored data
    const reminderDataJson = await redisClient.get(rescheduleKey);
    if (!reminderDataJson) {
      return ctx.reply("Sorry, this reschedule request has expired. Please set a new reminder.");
    }

    const reminderData = JSON.parse(reminderDataJson);
    const userTimezone = await getUserTimezone(userId);

    // Create tomorrow's date
    const tomorrow = DateTime.now().setZone(userTimezone).plus({ days: 1 });
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
      timezone: userTimezone
    };

    // Save to Redis
    const reminderId = await saveReminder(userId, reminder);

    // Clean up temporary data
    await redisClient.del(rescheduleKey);

    // Confirm to user
    const confirmationMsg = `✅ Reminder rescheduled: "${reminderData.message}"\n` +
        `📅 Date: ${reminderDate.toLocaleString(DateTime.DATE_FULL)}\n` +
        `⏰ Time: ${reminderDate.toLocaleString(DateTime.TIME_SIMPLE)}\n\n` +
        `Next reminder: ${reminderDate.toLocaleString(DateTime.DATETIME_FULL)}\n` +
        `Reminder ID: ${reminderId}\n` +
        `Timezone: ${userTimezone}`;

    await ctx.editMessageText(confirmationMsg);

  } catch (error) {
    logger.error('Error rescheduling reminder:', error);
    await ctx.reply("Sorry, I couldn't reschedule your reminder. Please try setting a new one.");
  }
});

bot.action('cancel_reminder', async (ctx) => {
  await ctx.editMessageText("Reminder cancelled. You can set a new one anytime.");
});

bot.action(/update_tz_(.+)/, async (ctx) => {
  const action = ctx.match[1];
  const userId = ctx.from.id.toString();

  if (action === 'all') {
    try {
      const userTimezone = await getUserTimezone(userId);
      const reminders = await redisClient.hGetAll(`reminders:${userId}`);

      let updatedCount = 0;

      for (const [reminderId, reminderJson] of Object.entries(reminders)) {
        const reminder = JSON.parse(reminderJson);

        // Update the timezone
        reminder.timezone = userTimezone;

        // Recalculate next run
        const { calculateNextRun } = require('./scheduler');
        const nextRun = calculateNextRun(reminder);

        if (nextRun) {
          reminder.nextRun = nextRun.toISOString();

          // Save updated reminder
          await redisClient.hSet(`reminders:${userId}`, reminderId, JSON.stringify(reminder));

          // Update in sorted set
          await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);
          await redisClient.zAdd('reminder_schedule', {
            score: new Date(nextRun).getTime(),
            value: `${userId}:${reminderId}`
          });

          updatedCount++;
        }
      }

      await ctx.editMessageText(`✅ Updated ${updatedCount} reminders to use your timezone (${userTimezone}).`);
    } catch (error) {
      logger.error('Error updating reminders timezone:', error);
      await ctx.editMessageText('Sorry, I encountered an error updating your reminders.');
    }
  } else {
    await ctx.editMessageText('Your reminders will keep their current times. You can update individual reminders by deleting and recreating them.');
  }
});

// Handle callback queries for delete buttons
bot.action(/delete_(.+)/, async (ctx) => {
  try {
    const reminderId = ctx.match[1];
    const userId = ctx.from.id.toString();

    // Delete the reminder
    const deleted = await redisClient.hDel(`reminders:${userId}`, reminderId);

    if (deleted) {
      // Also remove from scheduler
      await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);

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
    const userId = ctx.from.id.toString();
    const exists = await redisClient.hExists(`reminders:${userId}`, reminderId);

    if (!exists) {
      return ctx.reply(`Reminder with ID ${reminderId} not found.`);
    }

    await redisClient.hDel(`reminders:${userId}`, reminderId);
    await redisClient.zRem('reminder_schedule', `${userId}:${reminderId}`);
    ctx.reply(`Reminder ${reminderId} deleted successfully.`);
  } catch (error) {
    logger.error('Error deleting reminder:', error);
    ctx.reply('Failed to delete reminder. Please try again later.');
  }
});

bot.command('help', (ctx) => {
  ctx.reply(
    'I can help you set reminders using natural language.\n\n' +
    'Examples:\n' +
    '• "Remind me to take medicine every day at 9am"\n' +
    '• "Set a reminder for team meeting every Thursday at 3pm"\n' +
    '• "Remind me to call mom on Sundays at 6pm"\n\n' +
    'Commands:\n' +
    '/list - Show all your active reminders\n' +
    '/delete [id] - Delete a specific reminder\n' +
    '/help - Show this help message'
  );
});

// Then handle regular messages
bot.on('message', messageHandler);

// Command handlers are now defined before the message handler

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
