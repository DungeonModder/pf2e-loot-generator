#!/usr/bin/env node
// @ts-nocheck
/**
 * PF2e Loot Generator — GitHub Data Updater
 * Replaces the Python script. Uses only Node.js built-in modules — no npm install needed.
 *
 * Usage:
 *   node update-data.js
 *
 * Optional: set GITHUB_TOKEN below for authenticated requests.
 * Create a free token at https://github.com/settings/tokens (no scopes needed).
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CONFIGURATION ────────────────────────────────────────────────────────────
// Token priority: hardcoded value → GITHUB_TOKEN_OVERRIDE env var (used by CI)
const GITHUB_TOKEN   = '' || process.env.GITHUB_TOKEN_OVERRIDE || '';  // Optional but recommended
const REPO           = 'foundryvtt/pf2e';
let   BRANCH         = '';  // Leave empty to auto-detect the repo's default branch, or hardcode e.g. 'v13-dev'
const PACK_PATHS     = ['packs/pf2e/equipment'];  // Add e.g. 'packs/pf2e/treasure' if needed
const OUTPUT_FOLDER  = 'item_data';
const MAX_CONCURRENT = 10;                   // Parallel downloads
// ──────────────────────────────────────────────────────────────────────────────

const USAGE_CATEGORIES = {
    'Armor Modification':  ['armor'],
    'Shield Modification': ['shield'],
    'Weapon Modification': ['weapon', 'firearm', 'crossbow', 'etchedontoclandagger', 'magicalstaff'],
    'Armwear':             ['bracers', 'gloves', 'armbands', 'epaulet', 'gauntlets', 'bracelet'],
    'Footwear':            ['shoes', 'boots', 'anklets'],
    'Headwear':            ['headwear', 'circlet', 'eyepiece', 'eyeglasses', 'mask', 'helm', 'hat'],
    'Neckwear':            ['necklace', 'amulet', 'collar'],
    'Ring':                ['ring'],
    'Clothing':            ['clothing', 'garment', 'belt'],
    'Mount Items':         ['barding', 'saddle', 'horseshoes'],
    'Cloak':               ['cloak', 'cape'],
    'Backpack':            ['backpack'],
    'Held':                ['held'],
    'Other Modification':  ['harness', 'vehicle', 'creature', 'shipsbow', 'object', 'ground', 'innovation', 'wall'],
    'Item Modification':   ['instrument', 'anyitem', 'basket', 'belt', 'footwear', 'duelingcape', 'mountedonatripodorbracket', 'headgear'],
    'Implanted':           ['implanted'],
    'Tattoo':              ['tattoo'],
    'Carried':             ['carried'],
    'Other':               ['other'],
};

const RARITY_MAP = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', unique: 'Unique' };

const WEAPON_CATEGORY_MAP = { simple: 'Simple', martial: 'Martial', advanced: 'Advanced', unarmed: 'Unarmed' };
const ARMOR_CATEGORY_MAP  = { light: 'Light', medium: 'Medium', heavy: 'Heavy', unarmored: 'Unarmored', shield: 'Shield' };

const SKIP_FOUNDRY_TYPES = new Set([
    'treasure', 'kit', 'lore', 'action', 'effect',
    'condition', 'affliction', 'melee', 'spell', 'feat', 'class',
]);


// ─── NETWORK ──────────────────────────────────────────────────────────────────

function buildHeaders(acceptJson = false) {
    const h = { 'User-Agent': 'PF2e-LootGenerator-Updater/2.0' };
    if (GITHUB_TOKEN) h['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
    if (acceptJson)   h['Accept'] = 'application/vnd.github.v3+json';
    return h;
}

function fetchUrl(url, acceptJson = false) {
    return new Promise((resolve, reject) => {
        const options = { headers: buildHeaders(acceptJson) };
        const req = https.get(url, options, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchUrl(res.headers.location, acceptJson).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  ()  => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30_000, () => req.destroy(new Error('Request timed out')));
    });
}

/** Run an async task over an array with a maximum concurrency limit. */
async function pooledMap(items, concurrency, fn) {
    const results  = new Array(items.length);
    let   nextIdx  = 0;
    async function worker() {
        while (nextIdx < items.length) {
            const i = nextIdx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
}


// ─── PARSING HELPERS ──────────────────────────────────────────────────────────

function sanitizeForFilename(name) {
    return name.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/[\s-]+/g, '-');
}

function formatPrice(priceValue) {
    if (!priceValue) return null;
    const parts = [];
    for (const coin of ['pp', 'gp', 'sp', 'cp']) {
        const amount = priceValue[coin];
        if (amount) parts.push(`${amount} ${coin}`);
    }
    return parts.length ? parts.join(', ') : null;
}

function getUsageCategories(rawUsage) {
    if (!rawUsage) return [];
    const clean = rawUsage.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const found = [];
    for (const [category, keywords] of Object.entries(USAGE_CATEGORIES)) {
        if (keywords.some(kw => clean.includes(kw))) found.push(category);
    }
    return found.length ? [...new Set(found)] : [rawUsage.replace('|', '').trim()];
}

function cleanFoundryHtml(html) {
    if (!html) return '';

    // --- Foundry inline rolls: [[/command formula]]{label} and [[/command formula]] ---
    // e.g. [[/r 1d20+16]]{+16} → "+16"
    html = html.replace(/\[\[\/[^\]]*\]\]\{([^}]+)\}/g, '$1');
    // e.g. [[/r 1d20+16]] (no label) → show the formula part after the command
    html = html.replace(/\[\[\/\w+\s+([^\]]+)\]\]/g, '$1');
    // Catch-all for any remaining [[...]] constructs
    html = html.replace(/\[\[[^\]]*\]\]/g, '');

    // --- @Something[ref]{Label} → Label ---
    // Nested brackets handled so @Damage[1d4[persistent,fire]]{fire} → "fire"
    html = html.replace(/@\w+\[(?:[^\[\]]*|\[[^\]]*\])*\]\{([^}]+)\}/g, '$1');

    // --- @UUID[Compendium...Type.Item Name] without a label → extract the item name ---
    // e.g. @UUID[Compendium.pf2e.equipment-srd.Item.Staff of Fire (Greater)] → "Staff of Fire (Greater)"
    // Greedy backtracking on [^\]]+\. reliably lands on the document-type segment.
    html = html.replace(
        /@UUID\[(?:[^\]]+\.)(?:Item|Spell|Actor|JournalEntry(?:Page)?|RollTable|Macro|Scene)\.([^\]]+)\](?!\{)/g,
        '$1'
    );

    // --- @Something[ref] with no label → remove entirely ---
    html = html.replace(/@\w+\[(?:[^\[\]]*|\[[^\]]*\])*\]/g, '');

    return html;
}


// ─── ITEM PARSER ──────────────────────────────────────────────────────────────

function parseFoundryItem(data) {
    try {
        const foundryType = data.type || '';
        if (SKIP_FOUNDRY_TYPES.has(foundryType)) return null;

        const sys  = data.system || {};
        const name = data.name || 'Unknown Item';

        const level      = (sys.level || {}).value ?? 0;
        const traits     = sys.traits || {};
        const rarity     = RARITY_MAP[(traits.rarity || 'common').toLowerCase()] ?? 'Common';
        const tagValues  = (traits.value || []).map(t => t.toLowerCase());

        if (foundryType === 'consumable' && !tagValues.includes('consumable')) {
            tagValues.push('consumable');
        }

        const pub        = sys.publication || sys.source || {};
        const sourcebook = (pub.title || pub.value || 'Unknown Source').trim();
        const price      = formatPrice((sys.price || {}).value);

        const usageRaw  = (sys.usage || {}).value || '';
        const itemTypes = getUsageCategories(usageRaw);

        const category = (sys.category || '').trim().toLowerCase();
        if (category) {
            itemTypes.push(WEAPON_CATEGORY_MAP[category] || ARMOR_CATEGORY_MAP[category] || category[0].toUpperCase() + category.slice(1));
        }

        const group = (sys.group || '').trim();
        if (group) itemTypes.push(group[0].toUpperCase() + group.slice(1));

        if (!itemTypes.length) itemTypes.push('Miscellaneous');

        const descriptionHtml = cleanFoundryHtml((sys.description || {}).value || '');
        const aonLink = `https://2e.aonprd.com/Search.aspx?q=${encodeURIComponent(name)}`;

        return {
            lean: {
                name, level, rarity, sourcebook, price,
                type: [...new Set(itemTypes.filter(Boolean))].sort(),
                tags: [...new Set(tagValues)].sort(),
                aon_link: aonLink,
            },
            description: { name, description: descriptionHtml },
        };
    } catch (e) {
        process.stderr.write(`\n  [WARN] Could not parse '${data.name ?? '?'}': ${e.message}\n`);
        return null;
    }
}


// ─── GITHUB FETCH ─────────────────────────────────────────────────────────────

async function getEquipmentFilePaths() {
    // Fetching the full repo tree with ?recursive=1 is unreliable for large repos
    // like pf2e because GitHub truncates the response when the tree is too large.
    // Instead, navigate the tree to the specific pack subtree SHA, then fetch
    // only that subtree recursively — it's small enough to never be truncated.

    // Step 1: Get the root tree SHA from the latest branch commit.
    console.log('Fetching branch commit to resolve root tree SHA...');
    const commitUrl  = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
    const commitData = JSON.parse((await fetchUrl(commitUrl, true)).toString('utf8'));
    const rootTreeSha = commitData.commit.tree.sha;

    const allPaths = [];

    for (const packPath of PACK_PATHS) {
        // Step 2: Walk from the root tree down through each path segment to find
        //         the tree SHA for this pack directory.
        const parts = packPath.split('/');
        let currentSha = rootTreeSha;

        for (const part of parts) {
            const treeUrl  = `https://api.github.com/repos/${REPO}/git/trees/${currentSha}`;
            const treeData = JSON.parse((await fetchUrl(treeUrl, true)).toString('utf8'));
            const entry    = (treeData.tree || []).find(e => e.path === part && e.type === 'tree');
            if (!entry) throw new Error(`Could not find '${part}' in tree (sha: ${currentSha})`);
            currentSha = entry.sha;
        }

        // Step 3: Fetch just the equipment subtree recursively.
        //         This is tiny compared to the full repo tree and will not be truncated.
        console.log(`Fetching file list for '${packPath}'...`);
        const packTreeUrl  = `https://api.github.com/repos/${REPO}/git/trees/${currentSha}?recursive=1`;
        const packTreeData = JSON.parse((await fetchUrl(packTreeUrl, true)).toString('utf8'));

        if (packTreeData.truncated) {
            // This would be unexpected for an equipment-only subtree.
            console.warn(`[WARN] Tree for '${packPath}' is still truncated — some files may be missing.`);
        }

        const paths = (packTreeData.tree || [])
            .filter(item => item.type === 'blob' && item.path.endsWith('.json'))
            .map(item => `${packPath}/${item.path}`);

        console.log(`  Found ${paths.length} files in '${packPath}'.`);
        allPaths.push(...paths);
    }

    return allPaths;
}

async function fetchAndParse(filePath) {
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${filePath}`;
    try {
        const raw  = await fetchUrl(url);
        const data = JSON.parse(raw.toString('utf8'));
        return parseFoundryItem(data);
    } catch (e) {
        process.stderr.write(`\n  [WARN] Failed to fetch ${filePath}: ${e.message}\n`);
        return null;
    }
}


// ─── SHA CHANGE DETECTION ─────────────────────────────────────────────────────
// Stores the last-processed pf2e commit SHA in item_data/.last-pf2e-sha so
// scheduled runs can skip the full download when nothing has changed.

const SHA_CACHE_FILE = path.join(OUTPUT_FOLDER, '.last-pf2e-sha');

async function getLatestSha() {
    const url  = `https://api.github.com/repos/${REPO}/commits/${BRANCH}`;
    const raw  = await fetchUrl(url, true);
    const data = JSON.parse(raw.toString('utf8'));
    return data.sha;
}

function readCachedSha() {
    try { return fs.readFileSync(SHA_CACHE_FILE, 'utf8').trim(); }
    catch { return null; }
}

function writeCachedSha(sha) {
    fs.mkdirSync(OUTPUT_FOLDER, { recursive: true });
    fs.writeFileSync(SHA_CACHE_FILE, sha);
}


// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function run() {
    const force = process.argv.includes('--force');

    if (!GITHUB_TOKEN) {
        console.log('Tip: Set GITHUB_TOKEN at the top of this script for higher API rate limits.');
        console.log('     See: https://github.com/settings/tokens (no scopes required)\n');
    }

    // Resolve branch name if not hardcoded
    if (!BRANCH) {
        const repoInfo = JSON.parse((await fetchUrl(`https://api.github.com/repos/${REPO}`, true)).toString('utf8'));
        BRANCH = repoInfo.default_branch;
        console.log(`Using default branch: ${BRANCH}`);
    }

    // Check whether pf2e has changed since the last run
    console.log('Checking latest pf2e commit SHA...');
    const latestSha = await getLatestSha();
    const cachedSha = readCachedSha();

    if (!force && latestSha === cachedSha) {
        console.log(`No changes detected (SHA: ${latestSha.slice(0, 7)}).`);
        console.log('Run with --force to update anyway.');
        return;
    }

    if (cachedSha) {
        console.log(`Update detected: ${cachedSha.slice(0, 7)} → ${latestSha.slice(0, 7)}`);
    } else {
        console.log(`First run. SHA: ${latestSha.slice(0, 7)}`);
    }
    console.log();

    const paths = await getEquipmentFilePaths();
    console.log(`\nTotal: ${paths.length} item files to process.\n`);

    const descriptionsPath = path.join(OUTPUT_FOLDER, 'descriptions');
    fs.mkdirSync(descriptionsPath, { recursive: true });

    const allItems = [];
    let processed  = 0;
    let skipped    = 0;
    const total    = paths.length;

    await pooledMap(paths, MAX_CONCURRENT, async (filePath) => {
        const result = await fetchAndParse(filePath);
        processed++;
        process.stdout.write(
            `\r  ${processed}/${total} fetched — ${allItems.length} items, ${skipped} skipped     `
        );

        if (result) {
            allItems.push(result.lean);
            const descFilename = sanitizeForFilename(result.lean.name) + '.json';
            fs.writeFileSync(
                path.join(descriptionsPath, descFilename),
                JSON.stringify(result.description)
            );
        } else {
            skipped++;
        }
    });

    console.log(`\n\nSorting ${allItems.length} items...`);
    allItems.sort((a, b) => a.name.localeCompare(b.name));

    const mainOutputFile = path.join(OUTPUT_FOLDER, 'PF2e-items.json');
    fs.writeFileSync(mainOutputFile, JSON.stringify(allItems, null, 2));

    writeCachedSha(latestSha);

    console.log(`Done! ${allItems.length} items written to ${mainOutputFile}`);
    console.log(`Descriptions saved in:              ${descriptionsPath}`);
    if (skipped) console.log(`(${skipped} files skipped — non-equipment Foundry types)`);

    console.log('\nTip: run `node audit-descriptions.js` to check for any uncleaned Foundry markup.');
}

run().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
