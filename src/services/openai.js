// OpenAI integration service
const { OpenAI } = require('openai');
const config = require('../config');
const logger = require('../utils/logger');
const { DateTime } = require('luxon');
const {saveUserTimezone} = require("./redis");

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  timeout: 10000, // 10 seconds timeout for all requests
});

// Helper function to create a timeout promise
const createTimeout = (ms) => {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('OpenAI request timed out')), ms);
  });
};

/**
 * Analyzes a reminder message from /remind command
 */
async function analyzeMessage(message, userId) {
  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `
          You are a reminder analysis assistant. Extract reminder information from the message.
          The message comes from a /remind command, so it's already a reminder request.
          
          Return your response as JSON with the following structure:
          {
            "isReminder": boolean,
            "message": string, // the reminder message
            "schedule": {
              "frequency": string, // "once", "daily", "weekly", "monthly", or "multiple_days"
              "time": string, // HH:mm format
              "date": string, // YYYY-MM-DD format (for "once" only)
              "dayOfWeek": number, // 0-6 for Sunday-Saturday (for "weekly" only)
              "dayOfMonth": number, // 1-31 (for "monthly" only)
              "daysOfWeek": number[], // array of 0-6 for multiple days
              "isRelative": boolean, // true for "after X minutes/hours"
              "relativeMinutes": number // number of minutes for relative time
            }
          }
          
          For relative time reminders (e.g., "in 5 minutes", "after 2 hours"):
          - Set isRelative to true
          - Convert the time to minutes and set in relativeMinutes
          - Leave other schedule fields null
          
          Example responses:
          1. "drink water in 5 minutes"
          {
            "isReminder": true,
            "message": "drink water",
            "schedule": {
              "frequency": "once",
              "isRelative": true,
              "relativeMinutes": 5,
              "time": null,
              "date": null
            }
          }
          
          2. "exercise every Monday and Wednesday at 3pm"
          {
            "isReminder": true,
            "message": "exercise",
            "schedule": {
              "frequency": "multiple_days",
              "time": "15:00",
              "daysOfWeek": [1, 3],
              "isRelative": false
            }
          }
          
          3. "take medicine every day at 9am"
          {
            "isReminder": true,
            "message": "take medicine",
            "schedule": {
              "frequency": "daily",
              "time": "09:00",
              "isRelative": false
            }
          }
          
          4. "team meeting on the 15th of every month at 14:00"
          {
            "isReminder": true,
            "message": "team meeting",
            "schedule": {
              "frequency": "monthly",
              "time": "14:00",
              "dayOfMonth": 15,
              "isRelative": false
            }
          }
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
    logger.debug('Message analysis result:', result);
    return result;

  } catch (error) {
    logger.error('Error analyzing message:', error);
    return null;
  }
}

/**
 * Detects timezone from a message
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
          The message has already been cleaned of any bot mentions.
          
          If the message explicitly mentions a timezone or city/location, determine the IANA timezone.
          
          For example:
          - "по варшавскому времени" should be detected as "Europe/Warsaw"
          - "remind me at 5pm Berlin time" should be detected as "Europe/Berlin"
          - "Tokyo time" should be detected as "Asia/Tokyo"
          
          Return your response as JSON with the following structure:
          {
            "hasTimezoneInfo": boolean,
            "location": string, // the detected location (city, country, etc.)
            "timezone": string, // the IANA timezone string (e.g., "Europe/Moscow")
            "confidence": number // 0-1 value indicating confidence
          }
          
          If no timezone or location is mentioned:
          - Set hasTimezoneInfo to false
          - Set other fields to null
          
          Only return valid IANA timezone strings.
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
      // Validate timezone
      try {
        DateTime.now().setZone(result.timezone);
        return result.timezone;
      } catch (error) {
        logger.error('Invalid timezone detected:', error);
        return null;
      }
    }

    return null;

  } catch (error) {
    logger.error('Error detecting timezone:', error);
    return null;
  }
}

/**
 * Validates and normalizes timezone input to correct IANA timezone
 */
async function validateTimezone(input) {
  try {
    const response = await openai.chat.completions.create({
      model: config.OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: `
          You are a timezone validation assistant. Convert user input into a valid IANA timezone.
          
          Common corrections:
          - "Europa/Warsaw" → "Europe/Warsaw"
          - "Moscow" → "Europe/Moscow"
          - "New York" → "America/New_York"
          - "Tokyo" → "Asia/Tokyo"
          - "GMT+2" or "UTC+2" → closest major city timezone
          
          Return your response as JSON with the following structure:
          {
            "isValid": boolean,
            "originalInput": string,
            "suggestedTimezone": string, // valid IANA timezone or null
            "confidence": number, // 0-1 value
            "explanation": string // why this timezone was chosen
          }
          
          Only return valid IANA timezone strings.
          If you can't determine a timezone with high confidence, set isValid to false.
          `
        },
        {
          role: 'user',
          content: input
        }
      ],
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    logger.debug('Timezone validation result:', result);

    // Verify the suggested timezone is valid using Luxon
    if (result.suggestedTimezone) {
      try {
        DateTime.now().setZone(result.suggestedTimezone);
        return result;
      } catch (error) {
        logger.error('Invalid timezone suggested by OpenAI:', error);
        result.isValid = false;
        result.explanation += " (Invalid IANA timezone)";
      }
    }

    return result;

  } catch (error) {
    logger.error('Error validating timezone:', error);
    return {
      isValid: false,
      originalInput: input,
      suggestedTimezone: null,
      confidence: 0,
      explanation: "Error processing timezone"
    };
  }
}

module.exports = {
  openai,
  analyzeMessage,
  detectTimezone,
  validateTimezone
};
