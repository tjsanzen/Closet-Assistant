"""Constants for Closet Assistant."""

from __future__ import annotations

DOMAIN = "closet_assistant"
NAME = "Closet Assistant"
VERSION = "0.1.1"

STORAGE_KEY = f"{DOMAIN}.closet"
STORAGE_VERSION = 1

# Frontend (the two Lovelace cards ship inside the integration)
FRONTEND_URL = f"/{DOMAIN}/frontend"
FRONTEND_FILE = "closet-assistant-cards.js"

# Closet images live in <config>/closet_assistant/images and are served here
IMAGES_URL = f"/{DOMAIN}/images"
IMAGES_SUBDIR = ("closet_assistant", "images")
IMAGE_EXTENSIONS = (".png", ".webp", ".jpg", ".jpeg", ".gif")
MAX_IMAGE_BYTES = 4 * 1024 * 1024

# Config entry keys
CONF_WEATHER_ENTITY = "weather_entity"
CONF_WEARS_PER_WASH = "wears_per_wash"
CONF_LAUNDRY_DAYS = "laundry_days"
CONF_LAUNDRY_WEEKS = "laundry_every_weeks"
CONF_LAUNDRY_TIME = "laundry_time"
CONF_SUGGESTION_TIME = "suggestion_time"
CONF_TEMP_SENSITIVITY = "temperature_sensitivity"
CONF_LAYER_THRESHOLD = "layering_threshold"

WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

DEFAULTS = {
    CONF_WEARS_PER_WASH: "2",
    CONF_LAUNDRY_DAYS: ["sun"],
    CONF_LAUNDRY_WEEKS: 1,
    CONF_LAUNDRY_TIME: "18:00:00",
    CONF_SUGGESTION_TIME: "05:00:00",
    CONF_TEMP_SENSITIVITY: 0,
    CONF_LAYER_THRESHOLD: 15,
}

HISTORY_DAYS = 60
