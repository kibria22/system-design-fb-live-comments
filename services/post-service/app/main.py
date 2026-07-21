from datetime import datetime
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.database import Base, engine, get_db
from app.models import Post, User
from app.schemas import (
    PostCreate,
    PostListResponse,
    PostResponse,
    UserCreate,
    UserResponse,
)

app = FastAPI(title="Post Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    Base.metadata.create_all(bind=engine)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/users", response_model=UserResponse, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db)) -> User:
    if payload.id is not None:
        existing = db.get(User, payload.id)
        if existing:
            return existing

    user = User(id=payload.id, name=payload.name) if payload.id else User(name=payload.name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@app.get("/v1/users/{user_id}", response_model=UserResponse)
def get_user(user_id: UUID, db: Session = Depends(get_db)) -> User:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@app.post("/v1/posts", response_model=PostResponse, status_code=201)
def create_post(payload: PostCreate, db: Session = Depends(get_db)) -> PostResponse:
    user = db.get(User, payload.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    post = Post(user_id=payload.user_id, content=payload.content)
    db.add(post)
    db.commit()
    db.refresh(post)

    return PostResponse(
        id=post.id,
        user_id=post.user_id,
        content=post.content,
        created_at=post.created_at,
        updated_at=post.updated_at,
        user_name=user.name,
    )


@app.get("/v1/posts", response_model=PostListResponse)
def list_posts(
    cursor: str | None = Query(default=None, description="ISO timestamp cursor"),
    limit: int = Query(default=10, ge=1, le=50),
    db: Session = Depends(get_db),
) -> PostListResponse:
    query = select(Post).options(joinedload(Post.user)).order_by(Post.created_at.desc())

    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid cursor") from exc
        query = query.where(Post.created_at < cursor_dt)

    posts = db.scalars(query.limit(limit + 1)).unique().all()
    has_more = len(posts) > limit
    items = posts[:limit]

    next_cursor = items[-1].created_at.isoformat() if has_more and items else None

    return PostListResponse(
        items=[
            PostResponse(
                id=post.id,
                user_id=post.user_id,
                content=post.content,
                created_at=post.created_at,
                updated_at=post.updated_at,
                user_name=post.user.name if post.user else None,
            )
            for post in items
        ],
        next_cursor=next_cursor,
    )
