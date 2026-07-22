"""add scheduled job timing and durable idempotency

Revision ID: 0003
Revises: 0002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("job_runs") as batch_op:
        batch_op.add_column(sa.Column("idempotency_key", sa.String(length=200), nullable=True))
        batch_op.add_column(sa.Column("scheduled_for", sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(
            sa.Column("recovered", sa.Boolean(), nullable=False, server_default=sa.false())
        )
        batch_op.create_unique_constraint("uq_job_runs_idempotency_key", ["idempotency_key"])


def downgrade() -> None:
    with op.batch_alter_table("job_runs") as batch_op:
        batch_op.drop_constraint("uq_job_runs_idempotency_key", type_="unique")
        batch_op.drop_column("recovered")
        batch_op.drop_column("scheduled_for")
        batch_op.drop_column("idempotency_key")
