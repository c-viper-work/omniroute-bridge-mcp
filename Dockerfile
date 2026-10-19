FROM node:20-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
USER node
CMD ["node", "bin/omniroute.js", "mcp"]
