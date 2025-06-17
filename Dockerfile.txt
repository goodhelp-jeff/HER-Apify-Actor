# Use Apify SDK Docker image with Playwright
FROM apify/actor-node-playwright-chrome:18-beta

# Copy source code
COPY package*.json ./
COPY src ./src/
COPY input_schema.json ./

# Install dependencies
RUN npm install --production

# Run the actor
CMD npm start