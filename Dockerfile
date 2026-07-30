# Single stage: smtp-server is pure JavaScript with zero native
# dependencies, there is no build step for the vanilla-JS/CSS frontend, and
# `npm ci --omit=dev` already excludes the only devDependency (nodemailer,
# used solely as a test client). A build stage here would copy node_modules
# from one layer to another and save nothing.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# /data is created and owned by uid 1000 (the `node` image user) here so a
# fresh named volume — which Docker seeds from the image's directory
# ownership — is writable without extra setup. Bind mounts don't get this
# treatment; see the README for the chown workaround.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]

# 2525, not 25/587: binding a privileged port needs root, which is a bad
# trade for a LAN relay. Map "25:2525" at the host if you need port 25.
EXPOSE 2525 8080

# Node's built-in fetch instead of curl/wget — saves the extra package and
# avoids busybox wget quirks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "src/index.js"]
