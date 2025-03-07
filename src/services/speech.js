// src/services/speech.js - Fixed version
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { finished } = require('stream/promises');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const openai = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
});

/**
 * Transcribe voice message to text using OpenAI's Whisper API
 * @param {string} fileUrl - URL of the voice message file
 * @param {string} userId - Telegram user ID
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribeVoiceMessage(fileUrl, userId) {
    try {
        const tempDir = path.join(__dirname, '../../temp');

        // Create temp directory if it doesn't exist
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Download voice file
        const filePath = path.join(tempDir, `voice_${userId}_${Date.now()}.ogg`);
        const writer = fs.createWriteStream(filePath);

        const response = await axios({
            method: 'get',
            url: fileUrl,
            responseType: 'stream'
        });

        response.data.pipe(writer);
        await finished(writer);

        logger.info(`Voice message downloaded to ${filePath}`);

        // Transcribe using OpenAI's API without specifying language (API will auto-detect)
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-1",
            // Don't use the language parameter at all
        });

        // Clean up temp file
        fs.unlinkSync(filePath);
        const message = transcription.text;
        logger.info(`Voice message transcribed: "${message}"`);
        return message;
    } catch (error) {
        logger.error('Error transcribing voice message:', error);
        throw new Error('Failed to transcribe voice message');
    }
}

module.exports = {
    transcribeVoiceMessage
};