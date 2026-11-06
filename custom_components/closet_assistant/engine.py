"""Outfit engine: rule-based scoring + weighted randomisation (no generative AI).

How it works
------------
1. Turn the day's weather into warmth *targets* (torso + legs), plus rain/UV needs.
   A big high/low swing switches on "layering mode": the full outfit must be warm
   enough for the low, and some subset of layers (after shedding the jacket and/or
   sweater) must suit the high.
2. Randomly assemble a few hundred candidate outfits from clean clothes.
3. Score each candidate against:
     * warmth fit (under-dressing is penalised harder than over-dressing)
     * rain / UV protection
     * silhouette: tight vs loose contrast (the 2/3 rule), structured vs fluid mix
     * colour: 60-30-10 distribution, tonal dressing needs texture variety,
       hue harmony, number of colour families
     * patterns: vary the scale, vary the type, anchor with a shared colour
     * rotation: recently worn pieces and repeated combos are penalised
4. Pick from the best handful with softmax weights, so "Randomize" gives a
   different but still good outfit.

Pure Python - no Home Assistant imports - so it can be unit tested on its own.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from datetime import date
from itertools import combinations
from typing import Any

try:  # package import inside Home Assistant
    from .models import CATEGORIES, PATTERNS, PATTERN_SCALES, is_clean
except ImportError:  # pragma: no cover - direct import in tests
    from models import CATEGORIES, PATTERNS, PATTERN_SCALES, is_clean  # type: ignore

STYLE_SLOTS = ("top", "mid", "outer", "bottom", "shoes", "belt", "hat", "accessory")
SAMPLES = 700
TOP_K = 6
SOFTMAX_T = 2.5

# --------------------------------------------------------------------------- colour


def hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]


def rgb_to_hsl(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    r, g, b = rgb
    mx, mn = max(rgb), min(rgb)
    light = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, light
    d = mx - mn
    sat = d / (2 - mx - mn) if light > 0.5 else d / (mx + mn)
    if mx == r:
        hue = (g - b) / d + (6 if g < b else 0)
    elif mx == g:
        hue = (b - r) / d + 2
    else:
        hue = (r - g) / d + 4
    return hue * 60, sat, light


def rgb_to_lab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    def lin(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (lin(c) for c in rgb)
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.dist(a, b)


@dataclass(frozen=True)
class Colour:
    hex: str
    lab: tuple[float, float, float]
    hue: float
    sat: float
    light: float
    neutral: bool

    @classmethod
    def from_hex(cls, hex_color: str) -> "Colour":
        rgb = hex_to_rgb(hex_color)
        hue, sat, light = rgb_to_hsl(rgb)
        lab = rgb_to_lab(rgb)
        chroma = math.hypot(lab[1], lab[2])
        neutral = (
            chroma < 14                                   # greys, black, white
            or light < 0.13 or light > 0.93
            or (light < 0.30 and sat < 0.55)              # navy, charcoal, espresso
            or (18 <= hue <= 50 and sat < 0.45)           # khaki, tan, camel, beige, brown
            or (200 <= hue <= 232 and sat < 0.42 and 0.22 < light < 0.62)  # denim
            or (60 <= hue <= 95 and sat < 0.35 and light < 0.45)          # olive
        )
        return cls(hex_color, lab, hue, sat, light, neutral)


COLOUR_NAMES = {
    "black": "#111111", "charcoal": "#36454f", "grey": "#8a8a8a", "light grey": "#c8c8c8",
    "white": "#f7f7f5", "cream": "#f3ead3", "beige": "#d9c7a7", "khaki": "#b5a27a",
    "tan": "#c19a6b", "camel": "#b8865b", "brown": "#6b4a2f", "navy": "#1f2a44",
    "denim": "#4a6a8a", "blue": "#2f62c9", "light blue": "#9cc3e6", "teal": "#1f7a7a",
    "green": "#2f8a4a", "forest green": "#22432c", "olive": "#6b6b3a", "sage": "#9caf88",
    "yellow": "#f2cf3a", "mustard": "#c99a2e", "orange": "#e6782e", "rust": "#a8462a",
    "red": "#c8332f", "burgundy": "#6d1f2c", "pink": "#ef9ab6", "dusty rose": "#c98f8f",
    "terracotta": "#c26a4a", "purple": "#6b3fa0", "lavender": "#b9a6dc",
}
_NAME_LABS = {name: rgb_to_lab(hex_to_rgb(h)) for name, h in COLOUR_NAMES.items()}


def colour_name(hex_color: str) -> str:
    lab = rgb_to_lab(hex_to_rgb(hex_color))
    return min(_NAME_LABS, key=lambda n: delta_e(lab, _NAME_LABS[n]))


def hue_diff(a: float, b: float) -> float:
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


# --------------------------------------------------------------------------- weather


def torso_target(temp_f: float) -> float:
    """Warmth points needed on the torso at a given (feels-like) temperature."""
    return max(1.0, min(26.0, (88.0 - temp_f) / 3.5))


def leg_target(temp_f: float) -> float:
    return max(1.0, min(10.0, (85.0 - temp_f) / 5.0))


@dataclass
class DayPlan:
    high_f: float
    low_f: float
    swing_f: float
    layered: bool
    need_low: float          # torso warmth with every layer on
    need_high: float         # torso warmth after shedding layers
    need_design: float       # torso warmth when not layering
    need_legs: float
    rain: bool
    maybe_rain: bool
    uv: float
    windy: bool
    cold: bool
    hot: bool


def plan_day(weather: dict[str, Any], settings: dict[str, Any]) -> DayPlan:
    high = float(weather.get("high_f", 70))
    low = float(weather.get("low_f", high - 10))
    if low > high:
        high, low = low, high
    sens = float(settings.get("temperature_sensitivity", 0))  # +5 = runs cold
    shift = sens * 2.0
    t_high, t_low = high - shift, low - shift
    swing = high - low
    threshold = float(settings.get("layering_threshold_f", 15))
    layered = swing >= threshold

    wind = float(weather.get("wind_mph") or 0)
    wind_adj = 1.5 if wind >= 15 else 0.7 if wind >= 10 else 0.0
    prob = float(weather.get("precip_prob") or 0)
    mm = float(weather.get("precip_mm") or 0)
    rain = prob >= 50 or mm >= 2.0
    maybe_rain = not rain and (prob >= 30 or mm >= 0.5)
    rain_adj = 1.0 if rain else 0.0

    design = t_low + swing * 0.55
    return DayPlan(
        high_f=high,
        low_f=low,
        swing_f=swing,
        layered=layered,
        need_low=torso_target(t_low) + wind_adj + rain_adj,
        need_high=torso_target(t_high) + wind_adj * 0.5,
        need_design=torso_target(design) + wind_adj + rain_adj,
        need_legs=leg_target(t_low + swing * 0.6) + (0.5 if wind_adj else 0),
        rain=rain,
        maybe_rain=maybe_rain,
        uv=float(weather.get("uv") or 0),
        windy=wind >= 15,
        cold=t_low < 45,
        hot=t_high >= 82,
    )


# --------------------------------------------------------------------------- scoring helpers


def fit_penalty(actual: float, need: float, tol: float = 1.0) -> float:
    d = actual - need
    if abs(d) <= tol:
        return 0.0
    return (abs(d) - tol) * (4.0 if d < 0 else 2.5)  # cold hurts more than warm


VISIBLE_AREA = {"bottom": 0.35, "shoes": 0.07, "belt": 0.02, "hat": 0.05, "accessory": 0.04}


def torso_areas(state: dict[str, dict]) -> dict[str, float]:
    if "outer" in state:
        if "mid" in state:
            return {"outer": 0.32, "mid": 0.06, "top": 0.03}
        return {"outer": 0.32, "top": 0.08}
    if "mid" in state:
        return {"mid": 0.36, "top": 0.06}
    return {"top": 0.42}


@dataclass
class Candidate:
    pieces: dict[str, dict]
    score: float = 0.0
    removable: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def key(self) -> tuple:
        return tuple(sorted(p["id"] for p in self.pieces.values()))


class OutfitEngine:
    """Build one outfit suggestion."""

    def __init__(
        self,
        items: list[dict[str, Any]],
        settings: dict[str, Any],
        weather: dict[str, Any],
        today: date,
        history: list[dict[str, Any]] | None = None,
        avoid_ids: set[str] | None = None,
        rng: random.Random | None = None,
        unit: str = "°F",
    ) -> None:
        self.settings = settings
        self.base_wears = int(settings.get("wears_per_wash", 2))
        self.weather = weather
        self.today = today
        self.history = history or []
        self.avoid = avoid_ids or set()
        self.rng = rng or random.Random()
        self.unit = unit
        self.plan = plan_day(weather, settings)
        self._colours: dict[str, Colour] = {}
        self.jitter = True  # random nudge while generating; off when judging a manual swap

        self.pools: dict[str, list[dict]] = {}
        # Target dressiness for the day (1 lounge ... 10 interview). Fixed for now; a
        # calendar integration can later pass a per-day value in settings.
        self.dressiness = float(settings.get("target_dressiness", settings.get("everyday_dressiness", 5)))
        for item in items:
            if not is_clean(item, self.base_wears):
                continue
            if item.get("home_only"):
                continue  # pajamas / loungewear are never suggested for going out
            slot = CATEGORIES[item["category"]]["slot"]
            self.pools.setdefault(slot, []).append(item)

        self.recent_pairs: set[tuple[str, str]] = set()
        self.recent_sets: set[tuple] = set()
        for entry in self.history:
            try:
                age = (today - date.fromisoformat(entry["date"])).days
            except (KeyError, ValueError):
                continue
            if 0 < age <= 14:
                ids = entry.get("items", [])
                self.recent_sets.add(tuple(sorted(ids)))
                tops = [i for i in ids if i in entry.get("tops", [])]
                bottoms = [i for i in ids if i in entry.get("bottoms", [])]
                for t in tops:
                    for b in bottoms:
                        self.recent_pairs.add((t, b))

    # ------------------------------------------------------------------ public
    def missing_essentials(self) -> list[str]:
        missing = []
        if not self.pools.get("top"):
            missing.append("clean shirts")
        if not self.pools.get("bottom"):
            missing.append("clean pants, shorts or skirts")
        return missing

    def suggest(self) -> dict[str, Any] | None:
        if self.missing_essentials():
            return None
        seen: dict[tuple, Candidate] = {}
        for _ in range(SAMPLES):
            cand = self._sample()
            if cand.key in seen:
                continue
            self._score(cand)
            seen[cand.key] = cand
        ranked = sorted(seen.values(), key=lambda c: c.score, reverse=True)[:TOP_K]
        best = ranked[0].score
        weights = [math.exp((c.score - best) / SOFTMAX_T) for c in ranked]
        chosen = self.rng.choices(ranked, weights=weights, k=1)[0]
        self._score(chosen, explain=True)
        self._add_basics(chosen)
        return self._result(chosen)

    # ------------------------------------------------------------------ sampling
    def _pick(self, slot: str) -> dict | None:
        pool = self.pools.get(slot)
        return self.rng.choice(pool) if pool else None

    def _sample(self) -> Candidate:
        p, rng = self.plan, self.rng
        need = p.need_low if p.layered else p.need_design
        pieces: dict[str, dict] = {"top": self._pick("top"), "bottom": self._pick("bottom")}  # type: ignore[dict-item]

        mid_prob = 0.8 if need > 7 else 0.45 if need > 4.5 else 0.12
        outer_prob = 0.85 if (need > 9 or p.rain) else 0.5 if (need > 5.5 or p.maybe_rain) else 0.12
        if p.layered:
            mid_prob, outer_prob = max(mid_prob, 0.5), max(outer_prob, 0.6)
        for slot, prob in (("mid", mid_prob), ("outer", outer_prob)):
            if self.pools.get(slot) and rng.random() < prob:
                pieces[slot] = self._pick(slot)  # type: ignore[assignment]

        if self.pools.get("shoes"):
            pieces["shoes"] = self._pick("shoes")  # type: ignore[assignment]
        bottom_cat = pieces["bottom"]["category"]
        if self.pools.get("belt") and (bottom_cat == "pants" or rng.random() < 0.35):
            pieces["belt"] = self._pick("belt")  # type: ignore[assignment]
        hat_prob = 0.75 if (p.uv >= 6 or p.cold or p.rain) else 0.1
        if self.pools.get("hat") and rng.random() < hat_prob:
            pieces["hat"] = self._pick("hat")  # type: ignore[assignment]
        acc_prob = 0.65 if p.cold else 0.12
        if self.pools.get("accessory") and rng.random() < acc_prob:
            pieces["accessory"] = self._pick("accessory")  # type: ignore[assignment]
        return Candidate(pieces)

    def _add_basics(self, cand: Candidate) -> None:
        """Underwear and socks: freshest clean pair, no style scoring."""
        for slot in ("underwear", "socks"):
            pool = self.pools.get(slot)
            if not pool:
                continue
            pool = sorted(pool, key=lambda i: (i.get("last_worn") or "0000", self.rng.random()))
            cand.pieces[slot] = pool[0]

    # ------------------------------------------------------------------ scoring
    def _colour(self, hex_color: str) -> Colour:
        if hex_color not in self._colours:
            self._colours[hex_color] = Colour.from_hex(hex_color)
        return self._colours[hex_color]

    @staticmethod
    def _torso_warmth(state: dict[str, dict]) -> float:
        w = sum(state[s]["warmth"] for s in ("top", "mid", "outer") if s in state)
        if "accessory" in state:
            w += state["accessory"]["warmth"] * 0.5
        return w

    def _score(self, cand: Candidate, explain: bool = False) -> None:
        p, pieces = self.plan, cand.pieces
        pen = 0.0
        notes: list[str] = []

        # ---- warmth & layering
        full_warmth = self._torso_warmth(pieces)
        day_state = pieces
        cand.removable = []
        if p.layered:
            pen += fit_penalty(full_warmth, p.need_low)
            options: list[tuple[float, list[str]]] = [(fit_penalty(full_warmth, p.need_high), [])]
            layer_slots = [s for s in ("outer", "mid") if s in pieces]
            removal_sets = [[s] for s in layer_slots]
            if len(layer_slots) == 2:
                removal_sets.append(layer_slots)
            if "accessory" in pieces:
                removal_sets = [r + ["accessory"] for r in removal_sets] + [["accessory"]]
            for rem in removal_sets:
                state = {k: v for k, v in pieces.items() if k not in rem}
                options.append((fit_penalty(self._torso_warmth(state), p.need_high) + 0.3 * len(rem), rem))
            best_pen, best_rem = min(options, key=lambda o: o[0])
            pen += best_pen
            cand.removable = best_rem
            day_state = {k: v for k, v in pieces.items() if k not in best_rem}
            if explain:
                shed = " and ".join(pieces[s]["name"] for s in best_rem if s != "accessory") or "nothing"
                notes.append(
                    f"Layered for a {self._t(p.low_f)} to {self._t(p.high_f)} day: warmth "
                    f"{full_warmth:g} for the morning, shed {shed} to drop to "
                    f"{self._torso_warmth(day_state):g} by the afternoon."
                )
        else:
            pen += fit_penalty(full_warmth, p.need_design)
            if explain:
                notes.append(
                    f"Torso warmth {full_warmth:g} (target about {p.need_design:.0f}) for a "
                    f"{self._t(p.low_f)} to {self._t(p.high_f)} day."
                )
        pen += fit_penalty(pieces["bottom"]["warmth"], p.need_legs) * 0.8

        # ---- rain
        outermost = next(pieces[s] for s in ("outer", "mid", "top") if s in pieces)
        if p.rain:
            pen += max(0, 6 - outermost["waterproof"]) * 3.0
            if "shoes" in pieces:
                pen += max(0, 5 - pieces["shoes"]["waterproof"]) * 0.6
            if explain:
                notes.append(f"Rain likely: outer layer {outermost['name']} is rated {outermost['waterproof']}/10 waterproof.")
        elif p.maybe_rain:
            pen += max(0, 4 - outermost["waterproof"]) * 1.2

        # ---- UV (judged on what you wear at peak sun)
        if p.uv >= 3:
            factor = (p.uv - 2) / 8
            sun_layer = next(day_state[s] for s in ("outer", "mid", "top") if s in day_state)
            pen += max(0, 6 - sun_layer["uv"]) * factor * 1.5
            if p.uv >= 6 and self.pools.get("hat"):
                hat = pieces.get("hat")
                pen += factor * 3 if not hat else max(0, 6 - hat["uv"]) * factor * 0.5
            if explain and p.uv >= 6:
                notes.append(f"UV index {p.uv:g}: {sun_layer['name']} gives UV {sun_layer['uv']}/10" + (f", plus {pieces['hat']['name']}." if "hat" in pieces else "."))

        # ---- style (average of the morning look and the afternoon look)
        states = [pieces] if not cand.removable else [pieces, day_state]
        style_pen = 0.0
        for idx, state in enumerate(states):
            style_pen += self._style_penalty(state, notes if (explain and idx == 0) else None)
        pen += style_pen / len(states)

        # ---- rotation & freshness
        for slot in STYLE_SLOTS:
            item = pieces.get(slot)
            if not item:
                continue
            if item.get("last_worn"):
                try:
                    days = (self.today - date.fromisoformat(item["last_worn"])).days
                except ValueError:
                    days = 30
                pen += 8 if days <= 0 else 4 if days <= 2 else 1.5 if days <= 5 else -1 if days >= 14 else 0
            else:
                pen -= 1.5
            if item["id"] in self.avoid and slot in ("top", "mid", "outer", "bottom"):
                pen += 3
        top_id, bottom_id = pieces["top"]["id"], pieces["bottom"]["id"]
        if (top_id, bottom_id) in self.recent_pairs:
            pen += 4
        if cand.key in self.recent_sets:
            pen += 8

        if self.jitter:
            pen -= self.rng.uniform(0, 3)  # a little chaos keeps the closet in rotation
        cand.score = 100 - pen
        if explain:
            cand.notes = notes

    def _style_penalty(self, state: dict[str, dict], notes: list[str] | None) -> float:
        pen = 0.0
        outermost = next(state[s] for s in ("outer", "mid", "top") if s in state)
        bottom = state["bottom"]

        # 1. Volume & proportion
        tf, bf = outermost["form_fit"], bottom["form_fit"]
        diff = abs(tf - bf)
        if tf >= 7 and bf >= 7:
            pen += 6
        if tf <= 3 and bf <= 3:
            pen += 6
        pen += max(0, 3 - diff) * 1.5
        structures = [state[s]["structure"] for s in ("top", "mid", "outer", "bottom") if s in state]
        struct_range = max(structures) - min(structures)
        pen += max(0, 3 - struct_range) * 1.0
        if notes is not None:
            if diff >= 3:
                fitted, loose = (outermost, bottom) if tf > bf else (bottom, outermost)
                notes.append(f"Proportion: fitted {fitted['name']} balances the looser {loose['name']}.")
            if struct_range >= 3:
                notes.append("Structured and fluid pieces mixed for texture contrast.")

        # 2. Colour architecture
        areas = dict(torso_areas(state))
        for slot, a in VISIBLE_AREA.items():
            if slot in state:
                areas[slot] = a
        swatches: list[tuple[Colour, float]] = []
        for slot, area in areas.items():
            item = state[slot]
            accents = item.get("accent_colors") or []
            main_share = 0.7 if (accents and item["pattern"] != "solid") else 0.9 if accents else 1.0
            swatches.append((self._colour(item["color"]), area * main_share))
            for acc in accents:
                swatches.append((self._colour(acc), area * (1 - main_share) / len(accents)))
        total = sum(a for _, a in swatches) or 1
        clusters: list[list[Any]] = []  # [rep colour, share]
        for col, area in sorted(swatches, key=lambda s: -s[1]):
            for cl in clusters:
                if delta_e(cl[0].lab, col.lab) < 20:
                    cl[1] += area / total
                    break
            else:
                clusters.append([col, area / total])
        clusters.sort(key=lambda c: -c[1])
        props = [c[1] for c in clusters]

        if len(clusters) == 1 or props[0] > 0.85:
            fabrics = {state[s].get("fabric") for s in areas if state[s].get("fabric")}
            textured = len(fabrics) >= 2 or struct_range >= 3
            pen += 2 if textured else 8
            if notes is not None:
                notes.append(
                    f"Tonal {colour_name(clusters[0][0].hex)} look"
                    + (" with mixed textures to keep it from looking flat." if textured else " (add texture to keep it from looking flat).")
                )
        else:
            ideal = [0.6, 0.3, 0.1]
            n = max(len(props), 3)
            err = sum(abs((props[i] if i < len(props) else 0) - (ideal[i] if i < 3 else 0)) for i in range(n))
            pen += err * 10
            if notes is not None:
                names = [colour_name(c[0].hex) for c in clusters[:3]]
                pct = [round(c[1] * 100) for c in clusters[:3]]
                notes.append("Colour split " + ", ".join(f"{nm} {pc}%" for nm, pc in zip(names, pct)) + " (aiming for 60/30/10).")

        chromatic = [c for c in clusters if not c[0].neutral and c[1] >= 0.04]
        if len(chromatic) > 3:
            pen += (len(chromatic) - 3) * 4
        for a, b in combinations(chromatic, 2):
            d = hue_diff(a[0].hue, b[0].hue)
            if not (d <= 35 or 100 <= d <= 140 or d >= 150):
                pen += 3

        # value contrast is informational - both high and low contrast are valid
        if notes is not None:
            dl = abs(self._colour(outermost["color"]).lab[0] - self._colour(bottom["color"]).lab[0])
            if dl > 45:
                notes.append("High value contrast top to bottom: crisp and striking.")
            elif dl < 18 and len(clusters) > 1:
                notes.append("Low value contrast: soft and cohesive.")

        # 3. Pattern mixing
        visible = [state[s] for s in areas if s in state]
        pats = [i for i in visible if i["pattern"] != "solid" and areas.get(CATEGORIES[i["category"]]["slot"], 0) >= 0.05]
        if len(pats) >= 3:
            pen += 10 * (len(pats) - 2)
        neutral_anchor = any(i["pattern"] == "solid" and self._colour(i["color"]).neutral for i in visible)
        for a, b in combinations(pats, 2):
            sa = PATTERN_SCALES.index(a["pattern_scale"] or "medium")
            sb = PATTERN_SCALES.index(b["pattern_scale"] or "medium")
            pen += 6 if sa == sb else 2 if abs(sa - sb) == 1 else 0
            fam_a, fam_b = PATTERNS[a["pattern"]]["family"], PATTERNS[b["pattern"]]["family"]
            if fam_a == fam_b:
                pen += 4
            cols_a = [self._colour(h) for h in [a["color"], *a.get("accent_colors", [])]]
            cols_b = [self._colour(h) for h in [b["color"], *b.get("accent_colors", [])]]
            shared = any(delta_e(x.lab, y.lab) < 20 for x in cols_a for y in cols_b)
            if not shared:
                pen += 1 if neutral_anchor else 5
            if notes is not None:
                notes.append(
                    f"Pattern mix: {a['pattern_scale']} {PATTERNS[a['pattern']]['label'].lower()} with "
                    f"{b['pattern_scale']} {PATTERNS[b['pattern']]['label'].lower()}"
                    + (", tied together by a shared colour." if shared else ", bridged by a neutral.")
                )

        # 4. Dressiness: suit the occasion, and don't mix sweatpants with a blazer
        core = [state[s] for s in ("top", "mid", "outer", "bottom", "shoes") if s in state]
        levels = [i.get("dressiness", 5) for i in core]
        for lvl in levels:
            pen += max(0.0, (self.dressiness - 2) - lvl) * 1.2  # too casual for the day
            pen += max(0.0, lvl - (self.dressiness + 3)) * 0.8  # saving the good stuff
        spread = max(levels) - min(levels)
        pen += max(0, spread - 4) * 1.5
        if notes is not None:
            avg = sum(levels) / len(levels)
            word = "loungy" if avg < 3 else "casual" if avg < 5.5 else "smart casual" if avg < 7.5 else "dressy"
            notes.append(f"Dressiness about {avg:.0f}/10 ({word}), aiming for {self.dressiness:.0f}.")

        # 5. Classic detail: belt roughly matches shoes
        if "belt" in state and "shoes" in state:
            d = delta_e(self._colour(state["belt"]["color"]).lab, self._colour(state["shoes"]["color"]).lab)
            pen += -1.5 if d < 20 else 1.5 if d > 50 else 0
        return pen

    # ------------------------------------------------------------------ manual swaps
    def evaluate(self, pieces: dict[str, dict]) -> dict[str, Any]:
        """Score a hand-picked outfit (no randomness) and explain it like a suggestion."""
        self.jitter = False
        cand = Candidate(dict(pieces))
        self._score(cand, explain=True)
        result = self._result(cand)
        result["issues"] = self.issues(pieces)
        return result

    def issues(self, pieces: dict[str, dict]) -> list[str]:
        """Plain-language reasons an outfit breaks the rules. Empty list = looks fine."""
        p = self.plan
        out: list[str] = []
        if "top" not in pieces or "bottom" not in pieces:
            return ["An outfit needs a top and a bottom."]

        # cleanliness / intent / rotation
        for slot, item in pieces.items():
            if not is_clean(item, self.base_wears):
                out.append(f"{item['name']} is in the hamper (no wears left before washing).")
            if item.get("home_only"):
                out.append(f"{item['name']} is marked as around-the-house only.")
            if slot in STYLE_SLOTS and item.get("last_worn"):
                try:
                    days = (self.today - date.fromisoformat(item["last_worn"])).days
                except ValueError:
                    days = 99
                if days == 1:
                    out.append(f"You wore {item['name']} yesterday.")

        # warmth
        full = self._torso_warmth(pieces)
        need = p.need_low if p.layered else p.need_design
        when = f"the low of {self._t(p.low_f)}" if p.layered else f"a {self._t(p.low_f)} to {self._t(p.high_f)} day"
        if full < need - 2:
            out.append(f"Probably too cold: torso warmth {full:g}, about {need:.0f} is needed for {when}.")
        elif not p.layered and full > need + 4:
            out.append(f"Probably too warm: torso warmth {full:g}, about {need:.0f} is plenty for {when}.")
        elif p.layered:
            sheddable = {k: v for k, v in pieces.items() if k not in ("outer", "mid", "accessory")}
            if self._torso_warmth(sheddable) > p.need_high + 4:
                out.append(f"Hard to cool down: even after taking layers off, it's warm for the {self._t(p.high_f)} afternoon.")
        legs = pieces["bottom"]["warmth"]
        if legs < p.need_legs - 3:
            out.append(f"{pieces['bottom']['name']} may leave your legs cold today.")
        elif legs > p.need_legs + 4:
            out.append(f"{pieces['bottom']['name']} may be too warm today.")

        # rain & UV
        outermost = next(pieces[s] for s in ("outer", "mid", "top") if s in pieces)
        if p.rain and outermost["waterproof"] < 5:
            out.append(f"Rain is likely and {outermost['name']} is only {outermost['waterproof']}/10 waterproof.")
        if p.rain and "shoes" in pieces and pieces["shoes"]["waterproof"] < 3:
            out.append(f"Rain is likely and {pieces['shoes']['name']} aren't water resistant.")
        if p.uv >= 6:
            sun = next(pieces[s] for s in ("top", "mid", "outer") if s in pieces)
            if sun["uv"] < 4:
                out.append(f"UV index is {p.uv:g} and {sun['name']} only blocks {sun['uv']}/10.")

        # proportion
        tf, bf = outermost["form_fit"], pieces["bottom"]["form_fit"]
        if tf >= 7 and bf >= 7:
            out.append(f"{outermost['name']} and {pieces['bottom']['name']} are both tight: pair a fitted piece with a looser one.")
        elif tf <= 3 and bf <= 3:
            out.append(f"{outermost['name']} and {pieces['bottom']['name']} are both loose: the outfit may look shapeless.")

        # colour
        areas = dict(torso_areas(pieces))
        for slot, a in VISIBLE_AREA.items():
            if slot in pieces:
                areas[slot] = a
        visible = [pieces[s] for s in areas if s in pieces]
        chromatic = []
        for item in visible:
            col = self._colour(item["color"])
            if not col.neutral and not any(delta_e(col.lab, c.lab) < 20 for _, c in chromatic):
                chromatic.append((item, col))
        for (ia, a), (ib, b) in combinations(chromatic, 2):
            d = hue_diff(a.hue, b.hue)
            if not (d <= 35 or 100 <= d <= 140 or d >= 150):
                out.append(f"Colours may clash: {colour_name(a.hex)} ({ia['name']}) and {colour_name(b.hex)} ({ib['name']}).")
                break
        if len(chromatic) > 3:
            out.append("A lot of bright colours at once: try swapping one for a neutral.")
        if len(visible) >= 3:
            labs = [self._colour(i["color"]).lab for i in visible]
            if all(delta_e(labs[0], l) < 20 for l in labs):
                fabrics = {i.get("fabric") for i in visible if i.get("fabric")}
                structs = [i["structure"] for i in visible]
                if len(fabrics) < 2 and max(structs) - min(structs) < 3:
                    out.append("Everything is the same colour and texture, so it may look flat.")

        # patterns
        pats = [i for i in visible if i["pattern"] != "solid" and CATEGORIES[i["category"]]["slot"] in ("top", "mid", "outer", "bottom")]
        if len(pats) >= 3:
            out.append(f"{len(pats)} patterns at once is a lot: keep one or two.")
        for a, b in combinations(pats, 2):
            if (a["pattern_scale"] or "medium") == (b["pattern_scale"] or "medium"):
                out.append(f"{a['name']} and {b['name']} are both {a['pattern_scale'] or 'medium'}-scale patterns: vary the scale.")
            elif PATTERNS[a["pattern"]]["family"] == PATTERNS[b["pattern"]]["family"]:
                out.append(f"{a['name']} and {b['name']} are both {PATTERNS[a['pattern']]['family']} patterns: mix a geometric with an organic one.")

        # dressiness
        core = [pieces[s] for s in ("top", "mid", "outer", "bottom", "shoes") if s in pieces]
        lo = min(core, key=lambda i: i.get("dressiness", 5))
        hi = max(core, key=lambda i: i.get("dressiness", 5))
        if hi.get("dressiness", 5) - lo.get("dressiness", 5) > 5:
            out.append(f"{lo['name']} is much more casual than {hi['name']}.")
        for item in core:
            if item.get("dressiness", 5) < self.dressiness - 3:
                out.append(f"{item['name']} is more casual than you usually dress.")
                break
        return list(dict.fromkeys(out))  # de-duplicate, keep order

    # ------------------------------------------------------------------ output
    def _t(self, temp_f: float) -> str:
        if self.unit == "°C":
            return f"{(temp_f - 32) * 5 / 9:.0f}°"
        return f"{temp_f:.0f}°"

    def _result(self, cand: Candidate) -> dict[str, Any]:
        order = ["hat", "outer", "mid", "top", "accessory", "belt", "bottom", "socks", "shoes", "underwear"]
        items = []
        for slot in order:
            item = cand.pieces.get(slot)
            if item:
                items.append({"id": item["id"], "slot": slot, "removable": slot in cand.removable})
        return {
            "date": self.today.isoformat(),
            "items": items,
            "layered": bool(cand.removable),
            "notes": cand.notes,
            "score": round(cand.score, 1),
            "targets": {
                "torso_full": round(self.plan.need_low if self.plan.layered else self.plan.need_design, 1),
                "torso_afternoon": round(self.plan.need_high, 1) if self.plan.layered else None,
                "legs": round(self.plan.need_legs, 1),
            },
            "worn": False,
        }
