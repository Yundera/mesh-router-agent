FROM node:22-alpine

# Install curl for IP detection and API calls
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm build

# Set build version
ARG BUILD_VERSION=1.0.0
ENV BUILD_VERSION=${BUILD_VERSION}

CMD ["node", "dist/index.js"]
