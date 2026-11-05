"""Websocket API used by the Wear Today and Manage Closet cards."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError

from .const import DOMAIN
from .manager import ClosetManager


def _manager(hass: HomeAssistant) -> ClosetManager | None:
    return hass.data.get(DOMAIN)


@callback
def async_register_websocket(hass: HomeAssistant) -> None:
    for handler in (
        ws_subscribe,
        ws_save_item,
        ws_delete_item,
        ws_wash,
        ws_wear,
        ws_randomize,
        ws_upload_image,
        ws_import,
        ws_export,
        ws_scan_images,
        ws_keep,
    ):
        websocket_api.async_register_command(hass, handler)


def _guard(func):
    """Common error handling for the async commands."""

    async def wrapper(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        manager = _manager(hass)
        if manager is None:
            connection.send_error(msg["id"], "not_loaded", "Closet Assistant is not set up")
            return
        try:
            result = await func(manager, msg)
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "closet_error", str(err))
            return
        connection.send_result(msg["id"], result)

    wrapper.__name__ = func.__name__
    return wrapper


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def ws_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Push the full closet snapshot now and on every change."""
    manager = _manager(hass)
    if manager is None:
        connection.send_error(msg["id"], "not_loaded", "Closet Assistant is not set up")
        return

    @callback
    def forward() -> None:
        connection.send_message(websocket_api.event_message(msg["id"], manager.snapshot()))

    connection.subscriptions[msg["id"]] = manager.add_listener(forward)
    connection.send_result(msg["id"])
    forward()


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/item/save", vol.Required("item"): dict}
)
@websocket_api.async_response
@_guard
async def ws_save_item(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, Any]:
    return manager.item_view(await manager.async_save_item(msg["item"]))


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/item/delete", vol.Required("item_id"): str}
)
@websocket_api.async_response
@_guard
async def ws_delete_item(manager: ClosetManager, msg: dict[str, Any]) -> None:
    await manager.async_delete_item(msg["item_id"])


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/wash", vol.Optional("item_ids"): [str]}
)
@websocket_api.async_response
@_guard
async def ws_wash(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, int]:
    return {"washed": await manager.async_wash(msg.get("item_ids"))}


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/wear", vol.Optional("item_ids"): [str]}
)
@websocket_api.async_response
@_guard
async def ws_wear(manager: ClosetManager, msg: dict[str, Any]) -> None:
    await manager.async_wear(msg.get("item_ids"))


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/randomize"})
@websocket_api.async_response
@_guard
async def ws_randomize(manager: ClosetManager, msg: dict[str, Any]) -> None:
    await manager.async_generate(refresh_weather=True, randomize=True)


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/image/upload", vol.Required("data"): str}
)
@websocket_api.async_response
@_guard
async def ws_upload_image(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, str]:
    name = await manager.async_save_image(msg["data"])
    return {"image": name, "url": manager.image_url(name)}  # type: ignore[dict-item]


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/import",
        vol.Required("data"): vol.Any(list, dict),
        vol.Optional("replace", default=False): bool,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
@_guard
async def ws_import(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, int]:
    return {"imported": await manager.async_import(msg["data"], msg["replace"])}


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/export"})
@websocket_api.async_response
@_guard
async def ws_export(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, Any]:
    return manager.export()


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/scan_images"})
@websocket_api.async_response
@_guard
async def ws_scan_images(manager: ClosetManager, msg: dict[str, Any]) -> dict[str, int]:
    return {"added": await manager.async_scan_images()}


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/keep",
        vol.Required("item_ids"): [str],
        vol.Optional("days"): vol.All(int, vol.Range(min=1, max=3650)),
    }
)
@websocket_api.async_response
@_guard
async def ws_keep(manager: ClosetManager, msg: dict[str, Any]) -> None:
    await manager.async_keep(msg["item_ids"], msg.get("days"))
