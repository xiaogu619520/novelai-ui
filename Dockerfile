FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Copy standalone server
COPY .next/standalone ./
# Copy static files
COPY .next/static ./.next/static
# Copy public files
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
