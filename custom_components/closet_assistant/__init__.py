"""Closet Assistant - rule-based outfit picker and closet manager for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, FRONTEND_FILE, FRONTEND_URL, IMAGES_SUBDIR, IMAGES_URL, VERSION
from .manager import ClosetManager
from .services import async_register_services
from .websocket import async_register_websocket

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.SENSOR, Platform.BUTTON]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type ClosetConfigEntry = ConfigEntry[ClosetManager]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the cards, image folder, websocket API and services once."""
    images_dir = Path(hass.config.path(*IMAGES_SUBDIR))
    await hass.async_add_executor_job(lambda: images_dir.mkdir(parents=True, exist_ok=True))

    frontend_dir = Path(__file__).parent / "frontend"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(FRONTEND_URL, str(frontend_dir), False),
            StaticPathConfig(IMAGES_URL, str(images_dir), False),
        ]
    )
    # Load the cards on every dashboard automatically - no manual resource needed
    add_extra_js_url(hass, f"{FRONTEND_URL}/{FRONTEND_FILE}?v={VERSION}")

    async_register_websocket(hass)
    async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ClosetConfigEntry) -> bool:
    manager = ClosetManager(hass, entry)
    await manager.async_load()
    entry.runtime_data = manager
    hass.data[DOMAIN] = manager

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ClosetConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ClosetConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        entry.runtime_data.async_unload()
        hass.data.pop(DOMAIN, None)
    return unloaded
