"""Closet state, persistence, scheduling and outfit generation."""

from __future__ import annotations

import base64
import binascii
import logging
import random
import uuid
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_time_change, async_track_time_interval
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_LAUNDRY_DAYS,
    CONF_LAUNDRY_TIME,
    CONF_LAUNDRY_WEEKS,
    CONF_DECLUTTER_DAYS,
    CONF_LAYER_THRESHOLD,
    CONF_SUGGESTION_TIME,
    CONF_TEMP_SENSITIVITY,
    CONF_WEARS_PER_WASH,
    CONF_WEATHER_ENTITY,
    DEFAULTS,
    HISTORY_DAYS,
    IMAGE_EXTENSIONS,
    IMAGES_SUBDIR,
    IMAGES_URL,
    MAX_IMAGE_BYTES,
    SEASONAL_MIN_DAYS,
    STORAGE_KEY,
    STORAGE_VERSION,
    VERSION,
    WEEKDAYS,
)
from .engine import OutfitEngine, colour_name
from .forecast import async_get_today_weather
from .models import (
    CATEGORIES,
    FABRICS,
    PATTERN_SCALES,
    PATTERNS,
    effective_max_wears,
    guess_category_from_filename,
    is_seasonal,
    normalize_item,
    tracks_cleanliness,
    wears_remaining,
)

_LOGGER = logging.getLogger(__name__)

IMAGE_MAGIC = {b"\x89PNG": ".png", b"\xff\xd8\xff": ".jpg", b"GIF8": ".gif"}


def _parse_time(value: str) -> tuple[int, int]:
    parts = str(value).split(":")
    return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0


class ClosetManager:
    """Owns the closet for the single config entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.items: dict[str, dict[str, Any]] = {}
        self.today: dict[str, Any] | None = None
        self.weather: dict[str, Any] | None = None
        self.history: list[dict[str, Any]] = []
        self.last_wash: str | None = None
        self.laundry_anchor: str | None = None
        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[CALLBACK_TYPE] = []
        self.images_dir = Path(hass.config.path(*IMAGES_SUBDIR))

    # ------------------------------------------------------------------ settings
    @property
    def settings(self) -> dict[str, Any]:
        merged = {**DEFAULTS, **self.entry.data, **self.entry.options}
        unit = self.unit
        threshold = float(merged[CONF_LAYER_THRESHOLD])
        return {
            "weather_entity": merged.get(CONF_WEATHER_ENTITY),
            "wears_per_wash": int(merged[CONF_WEARS_PER_WASH]),
            "laundry_days": list(merged[CONF_LAUNDRY_DAYS]),
            "laundry_every_weeks": int(merged[CONF_LAUNDRY_WEEKS]),
            "laundry_time": merged[CONF_LAUNDRY_TIME],
            "suggestion_time": merged[CONF_SUGGESTION_TIME],
            "temperature_sensitivity": float(merged[CONF_TEMP_SENSITIVITY]),
            "declutter_days": int(merged.get(CONF_DECLUTTER_DAYS, 180)),
            "layering_threshold": threshold,
            "layering_threshold_f": threshold * 1.8 if unit == "°C" else threshold,
            "unit": unit,
        }

    @property
    def unit(self) -> str:
        return self.hass.config.units.temperature_unit

    @property
    def base_wears(self) -> int:
        return self.settings["wears_per_wash"]

    # ------------------------------------------------------------------ lifecycle
    async def async_load(self) -> None:
        await self.hass.async_add_executor_job(self.images_dir.mkdir, 0o755, True, True)
        data = await self._store.async_load() or {}
        base = self.base_wears
        today_iso = dt_util.now().date().isoformat()
        for raw in data.get("items", []):
            item = normalize_item(raw, base)
            item["added"] = item["added"] or today_iso  # older items start counting from now
            self.items[item["id"]] = item
        self.today = data.get("today")
        self.weather = data.get("weather")
        self.history = data.get("history", [])
        self.last_wash = data.get("last_wash")
        today = dt_util.now().date()
        self.laundry_anchor = data.get("laundry_anchor") or (today - timedelta(days=today.weekday())).isoformat()

        s = self.settings
        h, m = _parse_time(s["suggestion_time"])
        self._unsubs.append(async_track_time_change(self.hass, self._on_suggestion_time, hour=h, minute=m, second=0))
        h, m = _parse_time(s["laundry_time"])
        self._unsubs.append(async_track_time_change(self.hass, self._on_laundry_time, hour=h, minute=m, second=0))
        self._unsubs.append(async_track_time_interval(self.hass, self._on_weather_tick, timedelta(minutes=30)))
        self._unsubs.append(async_at_started(self.hass, self._on_started))

    @callback
    def async_unload(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()

    async def _on_started(self, _hass: HomeAssistant) -> None:
        await self.async_ensure_today()

    async def _on_suggestion_time(self, _now: Any) -> None:
        await self.async_generate(refresh_weather=True)

    async def _on_weather_tick(self, _now: Any) -> None:
        await self.async_refresh_weather()
        self._notify()

    async def _on_laundry_time(self, now: Any) -> None:
        if self.is_laundry_day(now.date()):
            _LOGGER.info("Closet Assistant: laundry day - resetting dirty clothes")
            await self.async_wash()

    def is_laundry_day(self, day: date) -> bool:
        s = self.settings
        if WEEKDAYS[day.weekday()] not in s["laundry_days"]:
            return False
        anchor = date.fromisoformat(self.laundry_anchor) if self.laundry_anchor else day
        weeks = max(1, s["laundry_every_weeks"])
        return ((day - anchor).days // 7) % weeks == 0

    def next_laundry_day(self) -> str | None:
        day = dt_util.now().date()
        for _ in range(7 * 5):
            if self.is_laundry_day(day):
                return day.isoformat()
            day += timedelta(days=1)
        return None

    # ------------------------------------------------------------------ persistence & events
    async def _async_save(self) -> None:
        await self._store.async_save(
            {
                "items": list(self.items.values()),
                "today": self.today,
                "weather": self.weather,
                "history": self.history[-HISTORY_DAYS:],
                "last_wash": self.last_wash,
                "laundry_anchor": self.laundry_anchor,
            }
        )

    @callback
    def add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    @callback
    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    async def _commit(self) -> None:
        await self._async_save()
        self._notify()

    # ------------------------------------------------------------------ weather & outfits
    async def async_refresh_weather(self) -> dict[str, Any] | None:
        entity_id = self.settings["weather_entity"]
        if not entity_id:
            return self.weather
        try:
            weather = await async_get_today_weather(self.hass, entity_id, self.unit)
        except Exception:  # noqa: BLE001 - never let a flaky weather provider break the closet
            _LOGGER.exception("Could not read weather from %s", entity_id)
            weather = None
        if weather:
            self.weather = weather
        return self.weather

    async def async_ensure_today(self) -> None:
        today = dt_util.now().date().isoformat()
        if not self.today or self.today.get("date") != today:
            await self.async_generate(refresh_weather=True)
        elif not self.weather:
            await self.async_refresh_weather()
            self._notify()

    async def async_generate(self, refresh_weather: bool = False, randomize: bool = False) -> dict[str, Any] | None:
        if refresh_weather or not self.weather:
            await self.async_refresh_weather()
        today = dt_util.now().date()
        weather = self.weather or {"high_f": 68, "low_f": 55}
        avoid: set[str] = set()
        if randomize and self.today and self.today.get("date") == today.isoformat():
            avoid = {i["id"] for i in self.today.get("items", [])}
        engine = OutfitEngine(
            list(self.items.values()),
            self.settings,
            weather,
            today,
            history=self.history,
            avoid_ids=avoid,
            rng=random.Random(),
            unit=self.unit,
        )
        suggestion = await self.hass.async_add_executor_job(engine.suggest)
        if suggestion is None:
            missing = engine.missing_essentials()
            suggestion = {
                "date": today.isoformat(),
                "items": [],
                "notes": [f"Not enough to build an outfit: no {' or '.join(missing)}."],
                "error": "missing_" + "_".join(m.split()[1] for m in missing),
                "layered": False,
                "worn": False,
            }
        if not self.weather:
            suggestion["notes"].insert(0, "Weather unavailable - assumed a mild day.")
        self.today = suggestion
        await self._commit()
        return suggestion

    async def async_wear(self, item_ids: list[str] | None = None) -> None:
        """Mark today's suggestion (or specific items) as worn."""
        today = dt_util.now().date().isoformat()
        if item_ids is None:
            if not self.today or not self.today.get("items"):
                raise HomeAssistantError("There is no outfit to wear yet")
            if self.today.get("worn"):
                return  # already logged today - don't double count
            item_ids = [i["id"] for i in self.today["items"]]
            self.today["worn"] = True
        worn = []
        for item_id in item_ids:
            item = self.items.get(item_id)
            if not item:
                continue
            item["last_worn"] = today
            item["times_worn"] = item.get("times_worn", 0) + 1
            if tracks_cleanliness(item):
                item["wears_since_wash"] = min(
                    effective_max_wears(item, self.base_wears), item.get("wears_since_wash", 0) + 1
                )
            worn.append(item)
        if worn:
            self.history = [h for h in self.history if h.get("date") != today]
            self.history.append(
                {
                    "date": today,
                    "items": [i["id"] for i in worn],
                    "tops": [i["id"] for i in worn if CATEGORIES[i["category"]]["slot"] == "top"],
                    "bottoms": [i["id"] for i in worn if CATEGORIES[i["category"]]["slot"] == "bottom"],
                }
            )
        await self._commit()

    async def async_wash(self, item_ids: list[str] | None = None) -> int:
        count = 0
        for item in self.items.values():
            if item_ids is not None and item["id"] not in item_ids:
                continue
            if item.get("wears_since_wash"):
                count += 1
            item["wears_since_wash"] = 0
        if item_ids is None:
            self.last_wash = dt_util.now().date().isoformat()
        await self._commit()
        return count

    # ------------------------------------------------------------------ closet CRUD
    async def async_save_item(self, raw: dict[str, Any]) -> dict[str, Any]:
        existing = self.items.get(str(raw.get("id"))) if raw.get("id") else None
        merged = {**existing, **raw} if existing else dict(raw)
        if existing and "needs_review" not in raw:
            merged["needs_review"] = False
        item = normalize_item(merged, self.base_wears)
        item["added"] = item["added"] or dt_util.now().date().isoformat()
        old_image = existing.get("image") if existing else None
        self.items[item["id"]] = item
        if old_image and old_image != item.get("image"):
            await self._async_remove_image_if_unused(old_image)
        await self._commit()
        return item

    async def async_delete_item(self, item_id: str) -> None:
        item = self.items.pop(item_id, None)
        if item is None:
            raise HomeAssistantError(f"Unknown item {item_id}")
        if item.get("image"):
            await self._async_remove_image_if_unused(item["image"])
        regenerate = bool(self.today and any(i["id"] == item_id for i in self.today.get("items", [])))
        if regenerate and not self.today.get("worn"):  # type: ignore[union-attr]
            await self.async_generate()
        else:
            await self._commit()

    async def async_import(self, payload: Any, replace: bool = False) -> int:
        items = payload.get("items") if isinstance(payload, dict) else payload
        if not isinstance(items, list):
            raise HomeAssistantError("Closet JSON must be a list of items or {\"items\": [...]}")
        if replace:
            self.items.clear()
        count = 0
        for raw in items:
            if not isinstance(raw, dict):
                continue
            item = normalize_item(raw, self.base_wears)
            item["added"] = item["added"] or dt_util.now().date().isoformat()
            self.items[item["id"]] = item
            count += 1
        await self._commit()
        if not self.today or not self.today.get("items"):
            await self.async_generate()
        return count

    def export(self) -> dict[str, Any]:
        out = []
        for item in self.items.values():
            row = dict(item)
            row["cleanliness"] = wears_remaining(item, self.base_wears) if tracks_cleanliness(item) else None
            out.append(row)
        return {"version": VERSION, "exported": dt_util.now().isoformat(), "items": out}

    # ------------------------------------------------------------------ images
    def image_url(self, image: str | None) -> str | None:
        if not image:
            return None
        if image.startswith(("/", "http://", "https://", "data:")):
            return image
        return f"{IMAGES_URL}/{image}"

    def _local_image_name(self, image: str) -> str | None:
        if image.startswith(IMAGES_URL + "/"):
            image = image[len(IMAGES_URL) + 1 :]
        if "/" in image or image.startswith(".") or ":" in image:
            return None
        return image

    async def async_save_image(self, data: str) -> str:
        if data.startswith("data:"):
            data = data.split(",", 1)[-1]
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as err:
            raise HomeAssistantError("Image is not valid base64") from err
        if len(raw) > MAX_IMAGE_BYTES:
            raise HomeAssistantError("Image is larger than 4 MB")
        ext = next((e for magic, e in IMAGE_MAGIC.items() if raw.startswith(magic)), None)
        if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
            ext = ".webp"
        if not ext:
            raise HomeAssistantError("Unsupported image type (use PNG, WebP, JPEG or GIF)")
        name = f"{uuid.uuid4().hex}{ext}"
        await self.hass.async_add_executor_job((self.images_dir / name).write_bytes, raw)
        return name

    async def _async_remove_image_if_unused(self, image: str) -> None:
        name = self._local_image_name(image)
        if not name or any(self._local_image_name(i.get("image") or "") == name for i in self.items.values()):
            return
        path = self.images_dir / name

        def _remove() -> None:
            if path.is_file():
                path.unlink()

        await self.hass.async_add_executor_job(_remove)

    async def async_scan_images(self) -> int:
        """Create a draft item for every image in the folder no item uses yet."""
        used = {self._local_image_name(i.get("image") or "") for i in self.items.values()}

        def _list() -> list[str]:
            return sorted(
                p.name for p in self.images_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
            )

        files = await self.hass.async_add_executor_job(_list)
        added = 0
        for name in files:
            if name in used:
                continue
            stem = Path(name).stem
            category = guess_category_from_filename(stem) or "short_sleeve_shirt"
            item = normalize_item(
                {
                    "name": stem.replace("_", " ").replace("-", " ").strip().title()[:80],
                    "category": category,
                    "image": name,
                    "needs_review": True,
                },
                self.base_wears,
            )
            item["added"] = dt_util.now().date().isoformat()
            self.items[item["id"]] = item
            added += 1
        if added:
            await self._commit()
        return added

    # ------------------------------------------------------------------ declutter
    def unworn_info(self, item: dict[str, Any]) -> dict[str, Any]:
        """How long since this item was worn, and whether to suggest letting it go."""
        today = dt_util.now().date()
        ref = item.get("last_worn") or item.get("added")
        try:
            days = (today - date.fromisoformat(ref)).days if ref else 0
        except ValueError:
            days = 0
        limit = self.settings["declutter_days"]
        seasonal = is_seasonal(item)
        threshold = max(limit, SEASONAL_MIN_DAYS) if seasonal else limit
        kept = bool(item.get("keep_until") and item["keep_until"] > today.isoformat())
        return {
            "unworn_days": days,
            "never_worn": not item.get("last_worn"),
            "seasonal": seasonal,
            "declutter": bool(limit) and days >= threshold and not kept,
        }

    def declutter_items(self) -> list[dict[str, Any]]:
        return [i for i in self.items.values() if self.unworn_info(i)["declutter"]]

    async def async_keep(self, item_ids: list[str], days: int | None = None) -> None:
        """'Keep it': hide from the declutter list for another window."""
        span = days or self.settings["declutter_days"] or 180
        until = (dt_util.now().date() + timedelta(days=span)).isoformat()
        for item_id in item_ids:
            if item_id in self.items:
                self.items[item_id]["keep_until"] = until
        await self._commit()

    # ------------------------------------------------------------------ views
    def item_view(self, item: dict[str, Any]) -> dict[str, Any]:
        base = self.base_wears
        tracks = tracks_cleanliness(item)
        mx = effective_max_wears(item, base)
        return {
            **item,
            "slot": CATEGORIES[item["category"]]["slot"],
            "image_url": self.image_url(item.get("image")),
            "color_name": colour_name(item["color"]),
            "tracks_cleanliness": tracks,
            "max_wears_effective": mx if tracks else None,
            "cleanliness": wears_remaining(item, base) if tracks else None,
            "clean": wears_remaining(item, base) > 0,
            **self.unworn_info(item),
        }

    def today_view(self) -> dict[str, Any] | None:
        if not self.today:
            return None
        items = []
        for entry in self.today.get("items", []):
            item = self.items.get(entry["id"])
            if item:
                items.append({**self.item_view(item), "slot": entry["slot"], "removable": entry.get("removable", False)})
        return {**self.today, "items": items}

    def counts(self) -> dict[str, Any]:
        tracked = [i for i in self.items.values() if tracks_cleanliness(i)]
        dirty = [i for i in tracked if wears_remaining(i, self.base_wears) == 0]
        return {
            "total": len(self.items),
            "dirty": len(dirty),
            "clean": len(self.items) - len(dirty),
            "declutter": len(self.declutter_items()),
        }

    def snapshot(self) -> dict[str, Any]:
        s = self.settings
        return {
            "version": VERSION,
            "items": [self.item_view(i) for i in self.items.values()],
            "today": self.today_view(),
            "weather": self.weather,
            "counts": self.counts(),
            "settings": {
                "unit": s["unit"],
                "wears_per_wash": s["wears_per_wash"],
                "laundry_days": s["laundry_days"],
                "laundry_every_weeks": s["laundry_every_weeks"],
                "weather_entity": s["weather_entity"],
                "declutter_days": s["declutter_days"],
            },
            "last_wash": self.last_wash,
            "next_laundry": self.next_laundry_day(),
            "categories": CATEGORIES,
            "patterns": {k: v["label"] for k, v in PATTERNS.items()},
            "pattern_scales": PATTERN_SCALES,
            "fabrics": FABRICS,
        }
