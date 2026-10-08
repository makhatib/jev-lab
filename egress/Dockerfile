FROM python:3.12-alpine
WORKDIR /app
COPY proxy.py .
USER nobody
CMD ["python", "-u", "proxy.py", "3128"]
