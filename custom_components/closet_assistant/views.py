"""HTTP views for the card file and closet images.

These replace plain static paths on purpose: a static path takes its
Content-Type from the host's file-type table, and some hosts map `.js`
to text/plain. Browsers refuse to run a module script labelled that way,
so the cards would never load. Here the types are always set explicitly.
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import FRONTEND_FILE, FRONTEND_URL, IMAGES_URL

IMAGE_TYPES = {
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
}


class ClosetFrontendView(HomeAssistantView):
    """Serve the bundled cards with Content-Type: text/javascript."""

    url = FRONTEND_URL + "/{filename}"
    name = "closet_assistant:frontend"
    requires_auth = False  # module scripts are fetched without HA auth headers

    def __init__(self, hass: HomeAssistant, frontend_dir: Path) -> None:
        self.hass = hass
        self._path = frontend_dir / FRONTEND_FILE
        self._body: bytes | None = None

    async def get(self, request: web.Request, filename: str) -> web.Response:
        if filename != FRONTEND_FILE:
            return web.Response(status=404)
        if self._body is None:
            self._body = await self.hass.async_add_executor_job(self._path.read_bytes)
        return web.Response(
            body=self._body,
            content_type="text/javascript",
            charset="utf-8",
            # always revalidate so an updated card is picked up right after a restart
            headers={"Cache-Control": "no-cache"},
        )


class ClosetImageView(HomeAssistantView):
    """Serve images from <config>/closet_assistant/images with explicit image types."""

    url = IMAGES_URL + "/{filename}"
    name = "closet_assistant:images"
    requires_auth = False  # <img> tags can't send HA auth headers (same as /local)

    def __init__(self, hass: HomeAssistant, images_dir: Path) -> None:
        self.hass = hass
        self._dir = images_dir

    async def get(self, request: web.Request, filename: str) -> web.Response:
        content_type = IMAGE_TYPES.get(Path(filename).suffix.lower())
        if not content_type or "/" in filename or "\\" in filename or filename.startswith("."):
            return web.Response(status=404)
        path = self._dir / filename

        def _read() -> bytes | None:
            return path.read_bytes() if path.is_file() else None

        body = await self.hass.async_add_executor_job(_read)
        if body is None:
            return web.Response(status=404)
        return web.Response(
            body=body,
            content_type=content_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )
