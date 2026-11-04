"""Buttons: randomize outfit, wear outfit, wash closet."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .manager import ClosetManager
from .sensor import device_info

BUTTONS = {
    "randomize": "mdi:dice-multiple",
    "wear_outfit": "mdi:check-circle-outline",
    "wash_closet": "mdi:washing-machine",
}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    manager: ClosetManager = entry.runtime_data
    async_add_entities(ClosetButton(manager, entry, key, icon) for key, icon in BUTTONS.items())


class ClosetButton(ButtonEntity):
    _attr_has_entity_name = True

    def __init__(self, manager: ClosetManager, entry: ConfigEntry, key: str, icon: str) -> None:
        self.manager = manager
        self.key = key
        self._attr_translation_key = key
        self._attr_icon = icon
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = device_info(entry)

    async def async_press(self) -> None:
        if self.key == "randomize":
            await self.manager.async_generate(refresh_weather=True, randomize=True)
        elif self.key == "wear_outfit":
            await self.manager.async_wear()
        else:
            await self.manager.async_wash()
