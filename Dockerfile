FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV DATA_DIR=/data
EXPOSE 5010

CMD ["gunicorn", "--bind", "0.0.0.0:5010", "--workers", "1", "--threads", "8", "--timeout", "120", "app:app"]
