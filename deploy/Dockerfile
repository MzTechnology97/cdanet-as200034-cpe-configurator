FROM node:22-alpine
RUN apk add --no-cache python3 make g++ iputils traceroute iproute2
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev
COPY server ./server
COPY index.html app.js styles.css manifest.webmanifest sw.js ./public/
COPY assets ./public/assets
WORKDIR /app/server
ENV NODE_ENV=production PORT=8787 STATIC_DIR=/app/public FIRMWARE_874_PATH=/opt/cdanet/firmware/WA-8.7.4.bin
EXPOSE 8787
CMD ["node","src/server.js"]
