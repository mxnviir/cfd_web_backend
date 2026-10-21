FROM python:3.11-slim

WORKDIR /app

# cadquery-ocp ships the OCC kernel as wheels but still wants these at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglu1-mesa libxrender1 libxext6 libsm6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# One worker: tessellation is CPU-bound and memory-hungry, so let Cloud Run
# scale out with instances rather than threads inside one.
CMD exec gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 2 --timeout 300 main:app
