FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install LibreOffice for office document interaction
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends \
        libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress \
        fonts-liberation fonts-noto-core fonts-noto-cjk && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    fc-cache -f          
    # rebuild fontconfig cache

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY office_to_png.py /app/office_to_png.py
RUN chmod +x /app/office_to_png.py

ENTRYPOINT ["/app/office_to_png.py"]

