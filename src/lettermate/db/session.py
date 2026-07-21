from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from lettermate.config import Settings, get_settings
from lettermate.db.models import Base


def create_session_factory(settings: Settings | None = None) -> sessionmaker[Session]:
    resolved = settings or get_settings()
    engine = create_engine(resolved.database_url, future=True)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)


def get_session() -> Iterator[Session]:
    session_factory = create_session_factory()
    with session_factory() as session:
        yield session
