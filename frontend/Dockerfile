FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_DATA_MODE=mock
ENV VITE_DATA_MODE=${VITE_DATA_MODE}
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_HOST=127.0.0.1 BACKEND_PORT=3000 NGINX_ENVSUBST_FILTER=BACKEND_
EXPOSE 80
