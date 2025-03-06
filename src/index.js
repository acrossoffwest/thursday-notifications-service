// Telegram notification bot
const { Telegraf } = require('telegraf');
const cron = require('node-cron');
const moment = require('moment-timezone');

// Get bot token and chat ID from environment variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Check if required environment variables are set
if (!BOT_TOKEN || !CHAT_ID) {
    console.error('Error: Required environment variables TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
    process.exit(1);
}

// Create bot instance
const bot = new Telegraf(BOT_TOKEN);

// Moscow timezone
const MOSCOW_TIMEZONE = 'Europe/Moscow';

// Function to send notification
const sendNotification = async () => {
    try {
        const moscowTime = moment().tz(MOSCOW_TIMEZONE).format('YYYY-MM-DD HH:mm:ss');
        await bot.telegram.sendMessage(
            CHAT_ID,
            `Thursday notification: It's 10:00 AM in Moscow! (${moscowTime})`
        );
        console.log(`Notification sent at ${moscowTime}`);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
};

// Schedule task to run at 10:00 AM Moscow time on Thursdays only
// Cron format: Minute Hour Day Month Day-of-week (4 = Thursday)
cron.schedule('0 10 * * 4', sendNotification, {
    timezone: MOSCOW_TIMEZONE
});

// Start bot
bot.launch()
    .then(() => {
        console.log('Bot started successfully!');
        console.log(`Scheduled to send notifications at 10:00 AM Moscow time on Thursdays`);
    })
    .catch((err) => {
        console.error('Failed to start bot:', err);
    });

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));