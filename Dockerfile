FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src

# Environment variables
ENV NODE_ENV=production

# Command to run the application
CMD ["node", "src/index.js"]
