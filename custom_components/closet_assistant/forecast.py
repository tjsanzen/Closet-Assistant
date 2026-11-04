"""Read today's high/low/precipitation/UV/wind from any HA weather entity."""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)


def to_f(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    return float(value) * 9 / 5 + 32 if unit == "°C" else float(value)


def f_to_display(value_f: float | None, unit: str) -> float | None:
    if value_f is None:
        return None
    return round((value_f - 32) * 5 / 9, 1) if unit == "°C" else round(value_f, 1)


def to_mph(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    factor = {"km/h": 0.621371, "m/s": 2.23694, "kn": 1.15078, "ft/s": 0.681818, "mph": 1.0}.get(unit or "km/h", 0.621371)
    return float(value) * factor


def to_mm(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    return float(value) * {"in": 25.4, "cm": 10.0}.get(unit or "mm", 1.0)


async def _forecast(hass: HomeAssistant, entity_id: str, kind: str) -> list[dict[str, Any]]:
    try:
        resp = await hass.services.async_call(
            "weather",
            "get_forecasts",
            {"entity_id": entity_id, "type": kind},
            blocking=True,
            return_response=True,
        )
    except (HomeAssistantError, ValueError) as err:
        _LOGGER.debug("No %s forecast from %s: %s", kind, entity_id, err)
        return []
    return list(((resp or {}).get(entity_id) or {}).get("forecast") or [])


def _local_date(value: Any) -> date | None:
    parsed = dt_util.parse_datetime(str(value)) if value else None
    return dt_util.as_local(parsed).date() if parsed else None


async def async_get_today_weather(hass: HomeAssistant, entity_id: str, display_unit: str) -> dict[str, Any] | None:
    """Return a normalised weather dict, or None if the entity is unavailable."""
    state = hass.states.get(entity_id)
    if state is None or state.state in ("unavailable", "unknown"):
        return None
    attrs = state.attributes
    t_unit = attrs.get("temperature_unit") or hass.config.units.temperature_unit
    p_unit = attrs.get("precipitation_unit")
    w_unit = attrs.get("wind_speed_unit")
    today = dt_util.now().date()

    daily = await _forecast(hass, entity_id, "daily")
    if not daily:
        daily = await _forecast(hass, entity_id, "twice_daily")
    entry = next((f for f in daily if _local_date(f.get("datetime")) == today), daily[0] if daily else {})

    high = entry.get("temperature")
    low = entry.get("templow")
    prob = entry.get("precipitation_probability")
    precip = entry.get("precipitation")

    # Fill gaps from the hourly forecast (some providers have no templow)
    if low is None or high is None or prob is None:
        hourly = [h for h in await _forecast(hass, entity_id, "hourly") if _local_date(h.get("datetime")) == today]
        temps = [h["temperature"] for h in hourly if h.get("temperature") is not None]
        if temps:
            high = high if high is not None else max(temps)
            low = low if low is not None else min(temps)
        probs = [h["precipitation_probability"] for h in hourly if h.get("precipitation_probability") is not None]
        if prob is None and probs:
            prob = max(probs)

    current = attrs.get("temperature")
    if high is None:
        high = current
    if high is None:
        return None
    high_f = to_f(high, t_unit)
    low_f = to_f(low, t_unit) if low is not None else high_f - 12  # type: ignore[operator]

    weather = {
        "entity_id": entity_id,
        "condition": entry.get("condition") or state.state,
        "high_f": round(high_f, 1),  # type: ignore[arg-type]
        "low_f": round(low_f, 1),  # type: ignore[arg-type]
        "current_f": round(to_f(current, t_unit), 1) if current is not None else None,  # type: ignore[arg-type]
        "precip_prob": prob,
        "precip_mm": round(to_mm(precip, p_unit), 1) if precip is not None else None,  # type: ignore[arg-type]
        "uv": entry.get("uv_index", attrs.get("uv_index")),
        "wind_mph": round(to_mph(entry.get("wind_speed", attrs.get("wind_speed")), w_unit) or 0, 1),
        "humidity": entry.get("humidity", attrs.get("humidity")),
        "unit": display_unit,
        "fetched": dt_util.now().isoformat(),
    }
    weather["high"] = f_to_display(weather["high_f"], display_unit)
    weather["low"] = f_to_display(weather["low_f"], display_unit)
    weather["current"] = f_to_display(weather["current_f"], display_unit)
    return weather
