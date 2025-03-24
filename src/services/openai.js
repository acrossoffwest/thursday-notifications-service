// OpenAI integration service
const { OpenAI } = require('openai');
const config = require('../config');
const logger = require('../utils/logger');
const { DateTime } = require('luxon');
const {saveUserTimezone} = require("./redis");

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

/**
 * Analyzes a message to detect reminder details
 * @param {string} message - User message
 * @param {string} chatId - Chat ID
 * @returns {Promise<Object>} - Analyzed reminder details
 */
async function analyzeMessage(message, chatId) {
  try {
    logger.info(`Analyzing message with OpenAI: "${message}"`);
    
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a reminder analysis assistant. Your task is to analyze messages and extract reminder details.
            If the message contains a reminder request, return a JSON object with the following structure:
            {
              "isReminder": true,
              "message": "the reminder message",
              "schedule": {
                "frequency": "once|daily|weekly|monthly|multiple_days",
                "time": "HH:mm",
                "date": "YYYY-MM-DD" (for once),
                "dayOfWeek": 0-6 (for weekly, Sunday=0),
                "daysOfWeek": [0-6] (for multiple_days),
                "dayOfMonth": 1-31 (for monthly),
                "isRelative": false,
                "relativeMinutes": null
              }
            }
            If not a reminder request, return { "isReminder": false }
            For relative times like "in 5 minutes" or "after 2 hours":
            - Set isRelative to true
            - Set relativeMinutes to the number of minutes (e.g. 5 for "5 minutes", 120 for "2 hours")
            - Set frequency to "once"
            - Do not set time or date fields
            For recurring reminders without a specific date, set appropriate frequency and time.
            Time should always be in 24-hour format (HH:mm).`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    logger.info('OpenAI analysis result:', JSON.stringify(result, null, 2));

    // Handle relative time if present
    if (result.isReminder && result.schedule.isRelative && result.schedule.relativeMinutes) {
      logger.info('Processing relative time reminder with input:', {
        isRelative: result.schedule.isRelative,
        relativeMinutes: result.schedule.relativeMinutes,
        currentTime: DateTime.now().toISO()
      });

      const now = DateTime.now();
      const futureTime = now.plus({ minutes: result.schedule.relativeMinutes });

      // Keep isRelative flag and relativeMinutes
      result.schedule = {
        ...result.schedule,
        frequency: 'once',
        time: futureTime.toFormat('HH:mm'),
        date: futureTime.toFormat('yyyy-MM-dd'),
        isRelative: true // Ensure isRelative is preserved
      };

      logger.info('Processed relative time reminder:', {
        originalMinutes: result.schedule.relativeMinutes,
        calculatedTime: result.schedule.time,
        calculatedDate: result.schedule.date,
        futureTimeISO: futureTime.toISO(),
        schedule: result.schedule
      });
    }

    return result;
  } catch (error) {
    logger.error('Error analyzing message with OpenAI:', error);
    return null;
  }
}

/**
 * Detects timezone from a location message
 * @param {string} message - User message with location
 * @param {string} chatId - Chat ID
 * @returns {Promise<string|null>} - Detected timezone or null
 */
async function detectTimezone(message, chatId) {
  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a timezone detection assistant. Your task is to analyze messages and extract IANA timezone identifiers.
            Return only the IANA timezone identifier (e.g., "Europe/London", "America/New_York") if you can detect one.
            Return null if you cannot confidently determine the timezone.
            Be conservative - only return a timezone if you're very confident it's correct.`
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const result = response.choices[0].message.content.trim();
    return result === 'null' ? null : result;
  } catch (error) {
    logger.error('Error detecting timezone with OpenAI:', error);
    return null;
  }
}

module.exports = {
  analyzeMessage,
  detectTimezone,
  openai
};
