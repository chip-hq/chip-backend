FROM node:20-slim

# Install Python3, pip, venv, and build tools
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set up Python venv and install PlatformIO CLI + espressif32 toolchain
ENV PATH="/root/.platformio/penv/bin:$PATH"
RUN python3 -m venv /root/.platformio/penv && \
    /root/.platformio/penv/bin/pip install --no-cache-dir platformio && \
    /root/.platformio/penv/bin/pio pkg install -g -p espressif32

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
