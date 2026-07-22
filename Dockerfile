FROM python:3.12-slim AS builder

WORKDIR /build
COPY pyproject.toml README.md ./
COPY src ./src
RUN python -m pip install --no-cache-dir build \
    && python -m build --wheel --outdir /wheelhouse

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
RUN useradd --create-home --uid 10001 lettermate
COPY --from=builder /wheelhouse /wheelhouse
RUN python -m pip install --no-cache-dir /wheelhouse/*.whl \
    && rm -rf /wheelhouse
COPY alembic.ini ./
COPY migrations ./migrations
COPY configs ./configs
USER lettermate

CMD ["uvicorn", "lettermate.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
