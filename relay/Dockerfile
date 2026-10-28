FROM node:22-alpine
WORKDIR /app
COPY server.mjs .
USER node
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "server.mjs"]
