"""Home Assistant services (usable from automations and scripts)."""

from __future__ import annotations

import json
from pathlib import Path

import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .manager import ClosetManager


def _manager(hass: HomeAssistant) -> ClosetManager:
    manager = hass.data.get(DOMAIN)
    if manager is None:
        raise HomeAssistantError("Closet Assistant is not set up")
    return manager


def _config_path(hass: HomeAssistant, path: str) -> Path:
    """Resolve a path relative to /config and refuse anything outside it."""
    config_dir = Path(hass.config.config_dir).resolve()
    full = (config_dir / path).resolve()
    if config_dir not in full.parents:
        raise HomeAssistantError("Path must be inside your Home Assistant config folder")
    return full


@callback
def async_register_services(hass: HomeAssistant) -> None:
    async def randomize(call: ServiceCall) -> None:
        await _manager(hass).async_generate(refresh_weather=True, randomize=True)

    async def wear_outfit(call: ServiceCall) -> None:
        await _manager(hass).async_wear(call.data.get("item_ids"))

    async def wash_closet(call: ServiceCall) -> ServiceResponse:
        return {"washed": await _manager(hass).async_wash(call.data.get("item_ids"))}

    async def import_closet(call: ServiceCall) -> ServiceResponse:
        payload = call.data.get("data")
        if payload is None:
            path = call.data.get("path")
            if not path:
                raise HomeAssistantError("Provide either data or path")
            full = _config_path(hass, path)
            text = await hass.async_add_executor_job(full.read_text, "utf-8")
            payload = json.loads(text)
        return {"imported": await _manager(hass).async_import(payload, call.data.get("replace", False))}

    async def export_closet(call: ServiceCall) -> ServiceResponse:
        data = _manager(hass).export()
        if path := call.data.get("path"):
            full = _config_path(hass, path)
            text = json.dumps(data, indent=2)
            await hass.async_add_executor_job(full.write_text, text, "utf-8")
        return data

    async def scan_images(call: ServiceCall) -> ServiceResponse:
        return {"added": await _manager(hass).async_scan_images()}

    ids_schema = vol.Schema({vol.Optional("item_ids"): vol.All(cv.ensure_list, [cv.string])})
    hass.services.async_register(DOMAIN, "randomize", randomize)
    hass.services.async_register(DOMAIN, "wear_outfit", wear_outfit, schema=ids_schema)
    hass.services.async_register(DOMAIN, "wash_closet", wash_closet, schema=ids_schema, supports_response=SupportsResponse.OPTIONAL)
    hass.services.async_register(
        DOMAIN,
        "import_closet",
        import_closet,
        schema=vol.Schema(
            {
                vol.Optional("path"): cv.string,
                vol.Optional("data"): vol.Any(list, dict),
                vol.Optional("replace", default=False): cv.boolean,
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        "export_closet",
        export_closet,
        schema=vol.Schema({vol.Optional("path"): cv.string}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(DOMAIN, "scan_images", scan_images, supports_response=SupportsResponse.OPTIONAL)
