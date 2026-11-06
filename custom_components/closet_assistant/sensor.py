"""Sensors: today's outfit and closet status."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, NAME, VERSION
from .manager import ClosetManager


def device_info(entry: ConfigEntry) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=NAME,
        manufacturer="Closet Assistant",
        sw_version=VERSION,
        entry_type=DeviceEntryType.SERVICE,
    )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    manager: ClosetManager = entry.runtime_data
    async_add_entities([OutfitSensor(manager, entry), ClosetSensor(manager, entry), UnwornSensor(manager, entry)])


class _Base(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, manager: ClosetManager, entry: ConfigEntry) -> None:
        self.manager = manager
        self._attr_device_info = device_info(entry)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.manager.add_listener(self.async_write_ha_state))


class OutfitSensor(_Base):
    _attr_translation_key = "outfit"
    _attr_icon = "mdi:hanger"
    _unrecorded_attributes = frozenset({"items", "notes", "weather"})

    def __init__(self, manager: ClosetManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_outfit"

    @property
    def native_value(self) -> str | None:
        today = self.manager.today_view()
        if not today:
            return None
        if not today["items"]:
            return "Nothing clean to wear"
        names = [i["name"] for i in today["items"] if i["slot"] not in ("underwear", "socks")]
        return " + ".join(names)[:255]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        today = self.manager.today_view() or {}
        weather = self.manager.weather or {}
        return {
            "date": today.get("date"),
            "worn": today.get("worn", False),
            "layered": today.get("layered", False),
            "removable": [i["name"] for i in today.get("items", []) if i.get("removable")],
            "items": [
                {k: i.get(k) for k in ("id", "name", "category", "slot", "color", "image_url", "removable")}
                for i in today.get("items", [])
            ],
            "notes": today.get("notes", []),
            "high": weather.get("high"),
            "low": weather.get("low"),
            "weather": weather,
        }


class ClosetSensor(_Base):
    _attr_translation_key = "clean_items"
    _attr_icon = "mdi:wardrobe"
    _attr_native_unit_of_measurement = "items"

    def __init__(self, manager: ClosetManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_clean_items"

    @property
    def native_value(self) -> int:
        return self.manager.counts()["clean"]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        counts = self.manager.counts()
        return {
            "total_items": counts["total"],
            "in_hamper": counts["dirty"],
            "around_the_house_only": counts["home_only"],
            "last_wash": self.manager.last_wash,
            "next_laundry": self.manager.next_laundry_day(),
        }


class UnwornSensor(_Base):
    """Items you haven't worn in a long time - handy for a monthly declutter reminder."""

    _attr_translation_key = "unworn_items"
    _attr_icon = "mdi:hanger-off"
    _attr_native_unit_of_measurement = "items"
    _unrecorded_attributes = frozenset({"items"})

    def __init__(self, manager: ClosetManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_unworn_items"

    @property
    def native_value(self) -> int:
        return len(self.manager.declutter_items())

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        items = sorted(
            ({**i, **self.manager.unworn_info(i)} for i in self.manager.declutter_items()),
            key=lambda i: -i["unworn_days"],
        )
        return {
            "threshold_days": self.manager.settings["declutter_days"],
            "items": [
                {"id": i["id"], "name": i["name"], "unworn_days": i["unworn_days"], "never_worn": i["never_worn"]}
                for i in items
            ],
        }
