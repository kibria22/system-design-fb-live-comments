from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    id: UUID | None = None
    name: str = Field(..., min_length=1, max_length=100)


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    created_at: datetime


class PostCreate(BaseModel):
    user_id: UUID
    content: str = Field(..., min_length=1, max_length=5000)


class PostResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    content: str
    created_at: datetime
    updated_at: datetime
    user_name: str | None = None


class PostListResponse(BaseModel):
    items: list[PostResponse]
    next_cursor: str | None = None
