"""add traceable feedback associations

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-22 20:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("preference_snapshots") as batch_op:
        batch_op.add_column(sa.Column("feedback_cutoff_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "derivation_type",
                sa.String(length=50),
                nullable=False,
                server_default="manual",
            )
        )

    with op.batch_alter_table("newsletter_items") as batch_op:
        batch_op.add_column(sa.Column("source_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("preference_snapshot_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("decision_tags", sa.JSON(), nullable=False, server_default=sa.text("'[]'"))
        )
        batch_op.create_foreign_key(
            "fk_newsletter_items_source_id_sources",
            "sources",
            ["source_id"],
            ["id"],
        )
        batch_op.create_foreign_key(
            "fk_newsletter_items_snapshot_id_preference_snapshots",
            "preference_snapshots",
            ["preference_snapshot_id"],
            ["id"],
        )

    with op.batch_alter_table("feedback") as batch_op:
        batch_op.add_column(sa.Column("newsletter_item_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("decision_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("preference_snapshot_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column("resulting_preference_snapshot_id", sa.Integer(), nullable=True)
        )
        batch_op.add_column(sa.Column("source_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "action_source",
                sa.String(length=50),
                nullable=False,
                server_default="legacy",
            )
        )
        batch_op.add_column(
            sa.Column("tags", sa.JSON(), nullable=False, server_default=sa.text("'[]'"))
        )
        batch_op.create_foreign_key(
            "fk_feedback_newsletter_item_id_newsletter_items",
            "newsletter_items",
            ["newsletter_item_id"],
            ["id"],
        )
        batch_op.create_foreign_key(
            "fk_feedback_decision_id_analysis_results",
            "analysis_results",
            ["decision_id"],
            ["id"],
        )
        batch_op.create_foreign_key(
            "fk_feedback_preference_snapshot_id_preference_snapshots",
            "preference_snapshots",
            ["preference_snapshot_id"],
            ["id"],
        )
        batch_op.create_foreign_key(
            "fk_feedback_resulting_snapshot_id_preference_snapshots",
            "preference_snapshots",
            ["resulting_preference_snapshot_id"],
            ["id"],
        )
        batch_op.create_foreign_key(
            "fk_feedback_source_id_sources",
            "sources",
            ["source_id"],
            ["id"],
        )
        batch_op.create_unique_constraint(
            "uq_feedback_membership_action",
            ["newsletter_item_id", "feedback_type"],
        )
    op.execute(
        sa.text(
            "UPDATE feedback SET source_id = "
            "(SELECT content_items.source_id FROM content_items "
            "WHERE content_items.id = feedback.content_item_id) "
            "WHERE source_id IS NULL"
        )
    )


def downgrade() -> None:
    with op.batch_alter_table("feedback") as batch_op:
        batch_op.drop_constraint("uq_feedback_membership_action", type_="unique")
        batch_op.drop_constraint(
            "fk_feedback_source_id_sources", type_="foreignkey"
        )
        batch_op.drop_constraint(
            "fk_feedback_resulting_snapshot_id_preference_snapshots",
            type_="foreignkey",
        )
        batch_op.drop_constraint(
            "fk_feedback_preference_snapshot_id_preference_snapshots",
            type_="foreignkey",
        )
        batch_op.drop_constraint(
            "fk_feedback_decision_id_analysis_results", type_="foreignkey"
        )
        batch_op.drop_constraint(
            "fk_feedback_newsletter_item_id_newsletter_items", type_="foreignkey"
        )
        batch_op.drop_column("tags")
        batch_op.drop_column("action_source")
        batch_op.drop_column("source_id")
        batch_op.drop_column("resulting_preference_snapshot_id")
        batch_op.drop_column("preference_snapshot_id")
        batch_op.drop_column("decision_id")
        batch_op.drop_column("newsletter_item_id")

    with op.batch_alter_table("newsletter_items") as batch_op:
        batch_op.drop_constraint(
            "fk_newsletter_items_snapshot_id_preference_snapshots",
            type_="foreignkey",
        )
        batch_op.drop_constraint(
            "fk_newsletter_items_source_id_sources", type_="foreignkey"
        )
        batch_op.drop_column("decision_tags")
        batch_op.drop_column("preference_snapshot_id")
        batch_op.drop_column("source_id")

    with op.batch_alter_table("preference_snapshots") as batch_op:
        batch_op.drop_column("derivation_type")
        batch_op.drop_column("feedback_cutoff_id")
