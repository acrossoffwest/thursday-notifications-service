# Notification Service

A Telegram bot that sends notifications every Thursday at 10 AM Moscow time.

## Prerequisites

- Docker and Docker Compose
- Telegram Bot Token
- Telegram Chat ID

## Setup

### 1. Telegram Bot Setup

1. Talk to [@BotFather](https://t.me/BotFather) on Telegram
2. Create a new bot with `/newbot`
3. Copy the provided token

### 2. Get Chat ID

1. Start a chat with your bot
2. Send any message to it
3. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
4. Copy the `chat.id` value

### 3. Environment Configuration

Copy `.env.example` to `.env` and update:

```
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Deployment

```bash
# Start the bot
docker-compose up -d

# View logs
docker-compose logs -f
```

## Project Structure

```
notification-service/
├── src/
│   └── index.js          # Main bot code
├── logs/                 # Log directory
├── .env                  # Environment variables
├── .env.example          # Template for .env
├── Dockerfile            # Docker configuration
├── docker-compose.yml    # Docker Compose config
├── package.json          # Node.js dependencies
└── README.md             # This file
```

## Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev
```

## Customization

To modify the notification schedule, edit the cron pattern in `src/index.js`:

```javascript
// Current: Thursdays at 10 AM Moscow time
cron.schedule('0 10 * * 4', sendNotification, {
  timezone: MOSCOW_TIMEZONE
});
```