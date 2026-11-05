"""Config flow: weather source, how dirty clothes get, laundry schedule."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_DECLUTTER_DAYS,
    CONF_LAUNDRY_DAYS,
    CONF_LAUNDRY_TIME,
    CONF_LAUNDRY_WEEKS,
    CONF_LAYER_THRESHOLD,
    CONF_SUGGESTION_TIME,
    CONF_TEMP_SENSITIVITY,
    CONF_WEARS_PER_WASH,
    CONF_WEATHER_ENTITY,
    DEFAULTS,
    DOMAIN,
    NAME,
    WEEKDAYS,
)


def _schema(current: dict[str, Any]) -> vol.Schema:
    def d(key: str) -> Any:
        return current.get(key, DEFAULTS.get(key))

    weather_key = (
        vol.Required(CONF_WEATHER_ENTITY, default=current[CONF_WEATHER_ENTITY])
        if current.get(CONF_WEATHER_ENTITY)
        else vol.Required(CONF_WEATHER_ENTITY)
    )
    return vol.Schema(
        {
            weather_key: selector.EntitySelector(selector.EntitySelectorConfig(domain="weather")),
            vol.Required(CONF_WEARS_PER_WASH, default=str(d(CONF_WEARS_PER_WASH))): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=["1", "2", "3"],
                    mode=selector.SelectSelectorMode.LIST,
                    translation_key="wears_per_wash",
                )
            ),
            vol.Required(CONF_LAUNDRY_DAYS, default=d(CONF_LAUNDRY_DAYS)): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=WEEKDAYS,
                    multiple=True,
                    mode=selector.SelectSelectorMode.LIST,
                    translation_key="weekday",
                )
            ),
            vol.Required(CONF_LAUNDRY_WEEKS, default=d(CONF_LAUNDRY_WEEKS)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=4, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Required(CONF_LAUNDRY_TIME, default=d(CONF_LAUNDRY_TIME)): selector.TimeSelector(),
            vol.Required(CONF_SUGGESTION_TIME, default=d(CONF_SUGGESTION_TIME)): selector.TimeSelector(),
            vol.Required(CONF_TEMP_SENSITIVITY, default=d(CONF_TEMP_SENSITIVITY)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=-5, max=5, step=1, mode=selector.NumberSelectorMode.SLIDER)
            ),
            vol.Required(CONF_LAYER_THRESHOLD, default=d(CONF_LAYER_THRESHOLD)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=4, max=40, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Required(CONF_DECLUTTER_DAYS, default=d(CONF_DECLUTTER_DAYS)): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=0, max=730, step=1, unit_of_measurement="days", mode=selector.NumberSelectorMode.BOX
                )
            ),
        }
    )


def _validate(user_input: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    if not user_input.get(CONF_LAUNDRY_DAYS):
        errors[CONF_LAUNDRY_DAYS] = "no_laundry_day"
    return errors


def _clean(user_input: dict[str, Any]) -> dict[str, Any]:
    data = dict(user_input)
    data[CONF_LAUNDRY_WEEKS] = int(data[CONF_LAUNDRY_WEEKS])
    data[CONF_TEMP_SENSITIVITY] = int(data[CONF_TEMP_SENSITIVITY])
    data[CONF_LAYER_THRESHOLD] = int(data[CONF_LAYER_THRESHOLD])
    data[CONF_DECLUTTER_DAYS] = int(data.get(CONF_DECLUTTER_DAYS, 180))
    return data


class ClosetAssistantConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(title=NAME, data=_clean(user_input))
        return self.async_show_form(step_id="user", data_schema=_schema(user_input or {}), errors=errors)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return ClosetAssistantOptionsFlow()


class ClosetAssistantOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(data=_clean(user_input))
        current = {**self.config_entry.data, **self.config_entry.options, **(user_input or {})}
        return self.async_show_form(step_id="init", data_schema=_schema(current), errors=errors)
