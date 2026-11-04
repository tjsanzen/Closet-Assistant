"""Closet item model: categories, patterns and normalisation.

Pure Python (no Home Assistant imports) so the outfit engine can be unit tested.
"""

from __future__ import annotations

import re
import uuid
from datetime import date
from typing import Any

# slot      -> where the piece goes in an outfit
# multiplier-> wears between washes = user's base wears * multiplier
# fixed_max -> always this many wears between washes (underwear/socks)
# tracks    -> False for things that never go in the hamper (belts, shoes...)
CATEGORIES: dict[str, dict[str, Any]] = {
    "underwear": {"label": "Underwear", "slot": "underwear", "icon": "mdi:hanger", "fixed_max": 1, "tracks": True},
    "socks": {"label": "Socks", "slot": "socks", "icon": "mdi:sock", "fixed_max": 1, "tracks": True},
    "short_sleeve_shirt": {"label": "Short Sleeved Shirt", "slot": "top", "icon": "mdi:tshirt-crew", "multiplier": 1, "tracks": True},
    "long_sleeve_shirt": {"label": "Long Sleeved Shirt", "slot": "top", "icon": "mdi:tshirt-crew-outline", "multiplier": 1, "tracks": True},
    "sweater": {"label": "Sweater", "slot": "mid", "icon": "mdi:tshirt-v-outline", "multiplier": 2, "tracks": True},
    "jacket": {"label": "Jacket", "slot": "outer", "icon": "mdi:coat-rack", "multiplier": 4, "tracks": True},
    "coat": {"label": "Coat", "slot": "outer", "icon": "mdi:coat-rack", "multiplier": 6, "tracks": True},
    "shorts": {"label": "Shorts", "slot": "bottom", "icon": "mdi:hanger", "multiplier": 1, "tracks": True},
    "pants": {"label": "Pants", "slot": "bottom", "icon": "mdi:hanger", "multiplier": 2, "tracks": True},
    "skirt": {"label": "Skirt", "slot": "bottom", "icon": "mdi:hanger", "multiplier": 1, "tracks": True},
    "belt": {"label": "Belt", "slot": "belt", "icon": "mdi:hanger", "tracks": False},
    "shoes": {"label": "Shoes", "slot": "shoes", "icon": "mdi:shoe-sneaker", "tracks": False},
    "hat": {"label": "Hat", "slot": "hat", "icon": "mdi:hat-fedora", "tracks": False},
    "accessory": {"label": "Accessory (scarf, gloves...)", "slot": "accessory", "icon": "mdi:sunglasses", "tracks": False},
}

# Words people use in JSON files / image file names -> category key
CATEGORY_SYNONYMS = {
    "short_sleeved_shirt": "short_sleeve_shirt", "short_sleeve": "short_sleeve_shirt", "tshirt": "short_sleeve_shirt",
    "t_shirt": "short_sleeve_shirt", "tee": "short_sleeve_shirt", "polo": "short_sleeve_shirt", "tank": "short_sleeve_shirt",
    "long_sleeved_shirt": "long_sleeve_shirt", "long_sleeve": "long_sleeve_shirt", "shirt": "long_sleeve_shirt",
    "button_down": "long_sleeve_shirt", "oxford": "long_sleeve_shirt", "blouse": "long_sleeve_shirt", "flannel": "long_sleeve_shirt",
    "hoodie": "sweater", "sweatshirt": "sweater", "cardigan": "sweater", "pullover": "sweater", "fleece": "sweater",
    "blazer": "jacket", "raincoat": "jacket", "windbreaker": "jacket", "parka": "coat", "overcoat": "coat", "puffer": "coat",
    "jeans": "pants", "trousers": "pants", "chinos": "pants", "slacks": "pants", "joggers": "pants", "leggings": "pants",
    "boxers": "underwear", "briefs": "underwear", "bra": "underwear", "sock": "socks",
    "sneakers": "shoes", "boots": "shoes", "loafers": "shoes", "sandals": "shoes", "shoe": "shoes",
    "cap": "hat", "beanie": "hat", "scarf": "accessory", "gloves": "accessory", "sunglasses": "accessory",
}

# Pattern -> family. Families drive the "vary the pattern type" rule.
PATTERNS: dict[str, dict[str, Any]] = {
    "solid": {"label": "Solid", "family": None, "default_scale": None},
    "stripe": {"label": "Stripe", "family": "geometric", "default_scale": "medium"},
    "pinstripe": {"label": "Pinstripe", "family": "geometric", "default_scale": "micro"},
    "check": {"label": "Check / Gingham", "family": "geometric", "default_scale": "small"},
    "plaid": {"label": "Plaid / Tartan", "family": "geometric", "default_scale": "large"},
    "houndstooth": {"label": "Houndstooth", "family": "geometric", "default_scale": "medium"},
    "polka_dot": {"label": "Polka dot", "family": "geometric", "default_scale": "small"},
    "geometric": {"label": "Other geometric", "family": "geometric", "default_scale": "medium"},
    "floral": {"label": "Floral", "family": "organic", "default_scale": "medium"},
    "paisley": {"label": "Paisley", "family": "organic", "default_scale": "medium"},
    "abstract": {"label": "Abstract / brushstroke", "family": "organic", "default_scale": "large"},
    "animal": {"label": "Animal print", "family": "organic", "default_scale": "medium"},
    "camo": {"label": "Camo", "family": "organic", "default_scale": "large"},
    "graphic": {"label": "Graphic / logo print", "family": "graphic", "default_scale": "large"},
}
PATTERN_SCALES = ["micro", "small", "medium", "large"]

FABRICS = [
    "cotton", "denim", "linen", "wool", "knit", "fleece", "silk", "satin",
    "leather", "suede", "corduroy", "tweed", "nylon", "synthetic", "other",
]

RATING_FIELDS = ("warmth", "waterproof", "form_fit", "uv", "structure")
RATING_DEFAULTS = {"warmth": 3, "waterproof": 1, "form_fit": 5, "uv": 3, "structure": 5}
# Accept the spellings people are likely to type in a hand-written JSON file
FIELD_ALIASES = {
    "warmpth": "warmth", "warmth_rating": "warmth",
    "waterproof_rating": "waterproof", "water_resistance": "waterproof",
    "form_fitting": "form_fit", "form_fitting_rating": "form_fit", "fit": "form_fit",
    "uv_rating": "uv", "upf": "uv",
    "colour": "color", "secondary_colors": "accent_colors", "colors": "accent_colors",
    "last_worn_date": "last_worn", "photo": "image",
}

HEX_RE = re.compile(r"^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$")


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).strip().lower()).strip("_")


def resolve_category(value: Any) -> str | None:
    """Turn 'Short Sleeved Shirt', 'short_sleeve_shirt' or 'tee' into a category key."""
    if value is None:
        return None
    slug = _slug(value)
    if slug in CATEGORIES:
        return slug
    for key, meta in CATEGORIES.items():
        if _slug(meta["label"]) == slug:
            return key
    if slug in CATEGORY_SYNONYMS:
        return CATEGORY_SYNONYMS[slug]
    if slug.endswith("s") and slug[:-1] in CATEGORY_SYNONYMS:
        return CATEGORY_SYNONYMS[slug[:-1]]
    return None


def guess_category_from_filename(stem: str) -> str | None:
    """Best guess at a category from an image file name like 'jeans_dark-wash'."""
    words = [w for w in re.split(r"[^a-z0-9]+", stem.lower()) if w]
    joined = "_".join(words)
    for key in CATEGORIES:
        if joined.startswith(key):
            return key
    for size in (2, 1):
        for i in range(len(words) - size + 1):
            cat = resolve_category("_".join(words[i : i + size]))
            if cat:
                return cat
    return None


def normalize_hex(value: Any, default: str = "#808080") -> str:
    if not isinstance(value, str):
        return default
    m = HEX_RE.match(value.strip())
    if not m:
        return default
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return "#" + h.lower()


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(round(float(value)))))
    except (TypeError, ValueError):
        return default


def _parse_date(value: Any) -> str | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def normalize_item(raw: dict[str, Any], base_wears: int = 2) -> dict[str, Any]:
    """Validate/clean one closet item. Unknown keys are dropped."""
    data = {FIELD_ALIASES.get(k, k): v for k, v in dict(raw).items()}

    category = resolve_category(data.get("category")) or "short_sleeve_shirt"
    pattern = _slug(data.get("pattern") or "solid")
    pattern = pattern if pattern in PATTERNS else "solid"
    scale = data.get("pattern_scale")
    if pattern == "solid":
        scale = None
    elif scale not in PATTERN_SCALES:
        scale = PATTERNS[pattern]["default_scale"]

    accents = data.get("accent_colors") or []
    if isinstance(accents, str):
        accents = [a for a in re.split(r"[,\s]+", accents) if a]
    accents = [normalize_hex(a) for a in accents if HEX_RE.match(str(a).strip())][:4]

    fabric = data.get("fabric")
    fabric = _slug(fabric) if fabric else None
    if fabric and fabric not in FABRICS:
        fabric = "other"

    max_wears = data.get("max_wears")
    max_wears = _clamp_int(max_wears, 1, 30, 0) or None if max_wears not in (None, "") else None

    item: dict[str, Any] = {
        "id": str(data.get("id") or uuid.uuid4().hex[:12]),
        "name": str(data.get("name") or CATEGORIES[category]["label"]).strip()[:80],
        "category": category,
        "color": normalize_hex(data.get("color")),
        "accent_colors": accents,
        "pattern": pattern,
        "pattern_scale": scale,
        "fabric": fabric,
        "image": str(data["image"]).strip() if data.get("image") else None,
        "max_wears": max_wears,
        "last_worn": _parse_date(data.get("last_worn")),
        "times_worn": _clamp_int(data.get("times_worn", 0), 0, 100000, 0),
        "notes": str(data.get("notes") or "")[:500],
        "needs_review": bool(data.get("needs_review", False)),
    }
    for field in RATING_FIELDS:
        item[field] = _clamp_int(data.get(field), 1, 10, RATING_DEFAULTS[field])

    mx = effective_max_wears(item, base_wears)
    if "wears_since_wash" in data:
        item["wears_since_wash"] = _clamp_int(data["wears_since_wash"], 0, mx, 0)
    elif "cleanliness" in data:  # cleanliness = wears remaining
        item["wears_since_wash"] = mx - _clamp_int(data["cleanliness"], 0, mx, mx)
    else:
        item["wears_since_wash"] = 0
    return item


def effective_max_wears(item: dict[str, Any], base_wears: int) -> int:
    meta = CATEGORIES[item["category"]]
    if item.get("max_wears"):
        return int(item["max_wears"])
    if "fixed_max" in meta:
        return meta["fixed_max"]
    return max(1, int(base_wears) * int(meta.get("multiplier", 1)))


def tracks_cleanliness(item: dict[str, Any]) -> bool:
    return bool(CATEGORIES[item["category"]]["tracks"])


def wears_remaining(item: dict[str, Any], base_wears: int) -> int:
    if not tracks_cleanliness(item):
        return 99
    return max(0, effective_max_wears(item, base_wears) - int(item.get("wears_since_wash", 0)))


def is_clean(item: dict[str, Any], base_wears: int) -> bool:
    return wears_remaining(item, base_wears) > 0
