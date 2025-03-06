# Intelligent Telegram Reminder Bot

A smart Telegram bot that uses AI to understand natural language reminder requests and set up notifications accordingly.

## Features

- Natural language processing for reminder creation
- Support for one-time, daily, weekly, and monthly reminders
- Redis for persistent storage of reminders
- OpenAI GPT integration for message understanding

## Prerequisites

- Node.js 16+
- Docker and Docker Compose
- Telegram Bot Token (from BotFather)
- OpenAI API Key

## Setup

1. Clone the repository:
   ```
   git clone <repository-url>
   cd notification-service
   ```

2. Create `.env` file by copying `.env.example`:
   ```
   cp .env.example .env
   ```

3. Fill in required credentials in the `.env` file:
   - `TELEGRAM_BOT_TOKEN`: Your Telegram bot token from BotFather
   - `OPENAI_API_KEY`: Your OpenAI API key

## Development

To run the bot in development mode:

```bash
npm install
npm run dev
```

## Deployment

To deploy using Docker:

```bash
docker-compose up -d
```

## Usage

Start a chat with your bot on Telegram and try these examples:

- "Remind me to take my medication tomorrow at 8am"
- "Set a reminder for weekly team meeting every Monday at 10am"
- "Remind me to call mom every Sunday at 6pm"
- "Set a reminder for dentist appointment on March 15, 2025 at 2:30pm"

### Bot Commands

- `/list` - Show all your active reminders
- `/delete <id>` - Delete a specific reminder by ID
- `/help` - Show help message with examples

## Project Structure

```
notification-service/
├── src/
│   ├── config/       # Configuration settings
│   ├── services/     # Core services (OpenAI, Redis, Scheduler)
│   ├── utils/        # Utility functions
│   ├── handlers/     # Message handlers
│   └── index.js      # Main application entry point
├── Dockerfile        # Docker configuration
├── docker-compose.yml # Docker Compose setup
└── package.json      # Dependencies
```
