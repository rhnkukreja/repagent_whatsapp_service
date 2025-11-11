# ============================================================
# 💬 WhatsApp Service - Node.js (standalone container)
# ============================================================
FROM node:20-bullseye-slim

# Set working directory
WORKDIR /app

# Copy package files first (for caching layers)
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy all source files
COPY . .

# Expose the internal service port (e.g., 3001)
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production \
    PORT=3001

# Start the WhatsApp service
CMD ["node", "server.js"]