FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=21120 STATE_PATH=/data/devices.json
USER node
EXPOSE 21120
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:21120/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.cjs"]
