# Use Node.js 18 as base image
FROM node:18-bullseye

# Install Python and pip
RUN apt-get update && apt-get install -y python3 python3-pip wget unzip && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package.json and install Node dependencies
COPY package*.json ./
RUN npm install

# Install Python dependencies (vosk)
RUN pip3 install vosk

# Download and extract Vosk model
RUN mkdir -p models && wget https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip && unzip vosk-model-small-en-us-0.15.zip -d models/ && rm vosk-model-small-en-us-0.15.zip

# Copy the rest of the application code
COPY . .

# Expose the voice service port
EXPOSE 5000

# Start the application
CMD ["npm", "start"]