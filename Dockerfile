FROM nginx:1.28-alpine
LABEL org.opencontainers.image.source="https://github.com/csnyder256/openrouter-model-picker"
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY index.html app.js styles.css og.png /usr/share/nginx/html/
COPY lib /usr/share/nginx/html/lib
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
