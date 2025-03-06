FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY telegram-notification-bot.js ./

# Environment variables (set default values here if needed)
ENV TELEGRAM_BOT_TOKEN=""
ENV TELEGRAM_CHAT_ID=""

# Command to run the application
CMD ["node", "telegram-notification-bot.js"]