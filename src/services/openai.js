// OpenAI integration service
const OpenAI = require('openai');
const config = require('../config');
const logger = require('../utils/logger');
const {saveUserTimezone} = require("./redis");

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

/**
 * Detects user's timezone from location information
 * @param {string} message - User message text
 * @param {string} userId - Telegram user ID
 * @returns {Promise<string|null>} - Detected timezone or null
 */
async function detectTimezone(message, userId) {
  try {
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

async function analyzeMessage(message, userId) {
  try {
    // First, check if there's timezone information
    const detectedTimezone = await detectTimezone(message, userId);

    // Proceed with normal reminder analysis
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `
          You are a multilingual reminder extraction assistant. Your task is to analyze if a message in any language contains a reminder request.
          If it does, extract the following information in JSON format:
          - isReminder (boolean): true if the message is asking to set a reminder
          - message (string): what the user wants to be reminded about (in the original language)
          - schedule (object):
            - frequency: "once", "daily", "weekly", "monthly", or "multiple_days"
            - dayOfWeek: (number, 0-6, 0 is Sunday) if weekly
            - daysOfWeek: (array of numbers, 0-6, 0 is Sunday) if multiple_days
            - dayOfMonth: (number, 1-31) if monthly
            - time: (string in HH:MM format, always in 24-hour format)
            - date: (string in YYYY-MM-DD format) if once
            - isRelativeTime: (boolean) true if the time was specified as relative ("in X minutes/hours")
            - relativeMinutes: (number) if isRelativeTime is true, the number of minutes from now

          IMPORTANT:
          - If the reminder is for multiple specific days (e.g., "every Monday and Wednesday"), 
            set frequency to "multiple_days" and include an array of day numbers in daysOfWeek.
          - If the time is relative (e.g., "in 30 minutes"), set isRelativeTime to true and calculate relativeMinutes.
          - If the time is in a specific timezone ("at 8pm Warsaw time"), extract the base time without timezone adjustment.
          - Always return time in 24-hour format (e.g., "22:30" not "10:30 PM").
          - If the message is not a reminder request, return { "isReminder": false }.
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
    logger.debug('OpenAI analysis result:', result);

    // If we detected a timezone, add it to the result object
    if (detectedTimezone) {
      result.detectedTimezone = detectedTimezone;
    }

    // Handle relative time if present
    if (result.isReminder && result.schedule.isRelativeTime) {
      const now = new Date();
      now.setMinutes(now.getMinutes() + result.schedule.relativeMinutes);

      // Format as HH:MM
      result.schedule.time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      result.schedule.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      result.schedule.frequency = 'once';
    }

    return result;
  } catch (error) {
    logger.error('OpenAI API error:', error);
    throw new Error('Failed to analyze message');
  }
}

module.exports = {
  analyzeMessage
};
