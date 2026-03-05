#!/usr/bin/env python3
"""
PF2e Loot Generator — GitHub Data Updater
Fetches equipment data directly from the Foundry VTT PF2e GitHub repository.
No manual file downloads needed. Just run this script to update item_data/.

OPTIONAL: Set GITHUB_TOKEN below for authenticated requests (5,000 req/hr vs 60/hr).
Create a free token at: https://github.com/settings/tokens
(No special permissions or scopes needed for public repos.)
"""

import json
import re
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# ─── CONFIGURATION ────────────────────────────────────────────────────────────
GITHUB_TOKEN  = ""                   # Optional but recommended
REPO          = "foundryvtt/pf2e"
BRANCH        = "master"
PACK_PATHS    = ["packs/equipment"]  # Add e.g. "packs/treasure" to include more
OUTPUT_FOLDER = "item_data"
MAX_WORKERS   = 4                    # Parallel downloads; reduce if rate-limited
# ──────────────────────────────────────────────────────────────────────────────

# A keyword-based dictionary to categorize usage types.
USAGE_CATEGORIES = {
    "Armor Modification": ["armor"],
    "Shield Modification": ["shield"],
    "Weapon Modification": ["weapon", "firearm", "crossbow", "etchedontoclandagger", "magicalstaff"],
    "Armwear": ["bracers", "gloves", "armbands", "epaulet", "gauntlets", "bracelet"],
    "Footwear": ["shoes", "boots", "anklets"],
    "Headwear": ["headwear", "circlet", "eyepiece", "eyeglasses", "mask", "helm", "hat"],
    "Neckwear": ["necklace", "amulet", "collar"],
    "Ring": ["ring"],
    "Clothing": ["clothing", "garment", "belt"],
    "Mount Items": ["barding", "saddle", "horseshoes"],
    "Cloak": ["cloak", "cape"],
    "Backpack": ["backpack"],
    "Held": ["held"],
    "Other Modification": ["harness", "vehicle", "creature", "shipsbow", "object", "ground", "innovation", "wall"],
    "Item Modification": ["instrument", "anyitem", "basket", "belt", "footwear", "duelingcape", "mountedonatripodorbracket", "headgear"],
    "Implanted": ["implanted"],
    "Tattoo": ["tattoo"],
    "Carried": ["carried"],
    "Other": ["other"],
}

RARITY_MAP = {
    "common": "Common",
    "uncommon": "Uncommon",
    "rare": "Rare",
    "unique": "Unique",
}

WEAPON_CATEGORY_MAP = {
    "simple": "Simple", "martial": "Martial",
    "advanced": "Advanced", "unarmed": "Unarmed",
}

ARMOR_CATEGORY_MAP = {
    "light": "Light", "medium": "Medium",
    "heavy": "Heavy", "unarmored": "Unarmored", "shield": "Shield",
}

# Foundry item types that are not loot-relevant equipment
SKIP_FOUNDRY_TYPES = {
    "treasure", "kit", "lore", "action", "effect",
    "condition", "affliction", "melee", "spell", "feat", "class",
}


# ─── NETWORK HELPERS ──────────────────────────────────────────────────────────

def _build_headers(accept_json=False):
    h = {"User-Agent": "PF2e-LootGenerator-Updater/2.0"}
    if GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_TOKEN}"
    if accept_json:
        h["Accept"] = "application/vnd.github.v3+json"
    return h

def _fetch(url, accept_json=False):
    req = urllib.request.Request(url, headers=_build_headers(accept_json))
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


# ─── ITEM PARSING ─────────────────────────────────────────────────────────────

def sanitize_for_filename(name):
    s = name.lower()
    s = re.sub(r'[^a-z0-9\s-]', '', s)
    s = re.sub(r'[\s-]+', '-', s)
    return s

def format_price(price_value):
    if not price_value:
        return None
    parts = []
    for coin in ["pp", "gp", "sp", "cp"]:
        amount = price_value.get(coin, 0)
        if amount:
            parts.append(f"{amount} {coin}")
    return ", ".join(parts) if parts else None

def get_usage_categories(raw_usage_text):
    if not raw_usage_text:
        return []
    clean_text = re.sub(r'[^a-zA-Z0-9]', '', raw_usage_text).lower()
    found = []
    for category, keywords in USAGE_CATEGORIES.items():
        for keyword in keywords:
            if keyword in clean_text:
                found.append(category)
                break
    if not found:
        return [raw_usage_text.replace('|', '').strip().capitalize()]
    return list(set(found))

def clean_foundry_html(html):
    """
    Strip Foundry-specific inline markup from description HTML, preserving display text.
      @UUID[...]{Label}  ->  Label
      @Check[...]{Label} ->  Label
      @UUID[...]         ->  (removed)
    """
    if not html:
        return ""
    html = re.sub(r'@\w+\[[^\]]*\]\{([^}]+)\}', r'\1', html)
    html = re.sub(r'@\w+\[[^\]]*\]', '', html)
    return html

def parse_foundry_item(data):
    """
    Parse a Foundry VTT PF2e item document into the loot generator's lean format.
    Returns (lean_item dict, description_data dict) or (None, None) if skipped.
    """
    try:
        foundry_type = data.get("type", "")
        if foundry_type in SKIP_FOUNDRY_TYPES:
            return None, None

        system = data.get("system", {})
        name = data.get("name", "Unknown Item")

        level = (system.get("level") or {}).get("value", 0)

        traits     = system.get("traits") or {}
        rarity_raw = (traits.get("rarity") or "common").lower()
        rarity     = RARITY_MAP.get(rarity_raw, "Common")
        tag_values = [t.lower() for t in (traits.get("value") or [])]

        # Ensure consumable-type items carry the "consumable" tag
        if foundry_type == "consumable" and "consumable" not in tag_values:
            tag_values.append("consumable")

        # Sourcebook — pf2e uses "publication" (newer) or "source" (older)
        pub        = system.get("publication") or system.get("source") or {}
        sourcebook = (pub.get("title") or pub.get("value") or "Unknown Source").strip()

        price = format_price((system.get("price") or {}).get("value") or {})

        # Build item_types from usage, weapon/armor category, and group
        usage_raw  = ((system.get("usage") or {}).get("value") or "")
        item_types = get_usage_categories(usage_raw)

        category = ((system.get("category") or "")).strip().lower()
        if category:
            mapped = WEAPON_CATEGORY_MAP.get(category) or ARMOR_CATEGORY_MAP.get(category)
            item_types.append(mapped or category.capitalize())

        group = ((system.get("group") or "")).strip()
        if group:
            item_types.append(group.capitalize())

        if not item_types:
            item_types.append("Miscellaneous")

        description_html = clean_foundry_html(
            ((system.get("description") or {}).get("value") or "")
        )

        aon_link = f"https://2e.aonprd.com/Search.aspx?q={urllib.parse.quote_plus(name)}"

        lean_item = {
            "name":       name,
            "level":      level,
            "rarity":     rarity,
            "sourcebook": sourcebook,
            "price":      price,
            "type":       sorted(set(filter(None, item_types))),
            "tags":       sorted(set(tag_values)),
            "aon_link":   aon_link,
        }
        description_data = {"name": name, "description": description_html}

        return lean_item, description_data

    except Exception as e:
        print(f"\n  [WARN] Could not parse '{data.get('name', '?')}': {e}")
        return None, None


# ─── GITHUB FETCH ─────────────────────────────────────────────────────────────

def get_equipment_file_paths():
    """
    Use the GitHub Git Trees API to list all JSON files inside PACK_PATHS.
    Uses a single API call; does not download any file content.
    """
    url = f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"
    print(f"Fetching file list from GitHub...\n  {url}")
    try:
        response_data = json.loads(_fetch(url, accept_json=True))
    except Exception as e:
        print(f"\n[ERROR] Could not reach GitHub API: {e}")
        sys.exit(1)

    if response_data.get("truncated"):
        print("[WARN] GitHub tree response was truncated — some files may be missing.")

    paths = [
        item["path"]
        for item in response_data.get("tree", [])
        if item["type"] == "blob"
        and item["path"].endswith(".json")
        and any(item["path"].startswith(pack + "/") for pack in PACK_PATHS)
    ]
    return paths

def fetch_and_parse(path):
    """Worker: download one item JSON from raw.githubusercontent.com and parse it."""
    url = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{path}"
    try:
        raw  = _fetch(url)
        data = json.loads(raw.decode("utf-8"))
        return parse_foundry_item(data)
    except Exception as e:
        print(f"\n  [WARN] Failed to fetch {path}: {e}")
        return None, None


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def run():
    if not GITHUB_TOKEN:
        print("Tip: Set GITHUB_TOKEN at the top of this script for higher API rate limits.")
        print("     See: https://github.com/settings/tokens (no scopes required)\n")

    paths = get_equipment_file_paths()
    total = len(paths)
    print(f"Found {total} item files across {PACK_PATHS}.\n")

    descriptions_path = os.path.join(OUTPUT_FOLDER, "descriptions")
    os.makedirs(descriptions_path, exist_ok=True)

    all_items = []
    processed = 0
    skipped   = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_and_parse, p): p for p in paths}
        for future in as_completed(futures):
            lean_item, description_data = future.result()
            processed += 1
            print(
                f"\r  {processed}/{total} fetched — "
                f"{len(all_items)} items, {skipped} skipped     ",
                end=""
            )

            if lean_item and description_data:
                all_items.append(lean_item)
                desc_filename = sanitize_for_filename(lean_item["name"]) + ".json"
                desc_filepath = os.path.join(descriptions_path, desc_filename)
                with open(desc_filepath, "w", encoding="utf-8") as f:
                    json.dump(description_data, f)
            else:
                skipped += 1

    print(f"\n\nSorting {len(all_items)} items...")
    all_items.sort(key=lambda x: x["name"])

    main_output_file = os.path.join(OUTPUT_FOLDER, "PF2e-items.json")
    with open(main_output_file, "w", encoding="utf-8") as f:
        json.dump(all_items, f, indent=2)

    print(f"Done! {len(all_items)} items written to {main_output_file}")
    print(f"Descriptions saved in:                {descriptions_path}")
    if skipped:
        print(f"({skipped} files skipped — non-equipment Foundry types)")

if __name__ == "__main__":
    run()
