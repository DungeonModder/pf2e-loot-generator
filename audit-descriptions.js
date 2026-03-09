#!/usr/bin/env node
// @ts-nocheck
/**
 * PF2e Description Auditor
 * Scans the generated description files for any uncleaned Foundry markup
 * so you can identify new patterns needing handling in cleanFoundryHtml().
 *
 * Usage:
 *   node audit-descriptions.js
 *
 * Run this after `node update-data.js --force` to get a full picture.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DESCRIPTIONS_DIR = path.join('item_data', 'descriptions');

// ─── PATTERN DETECTORS ────────────────────────────────────────────────────────

// Extracts the specific @Type from an @Type[...] reference so we can group by type.
const AT_REF_RE   = /@(\w+)\[/g;
// Extracts the /command from [[/command ...]] inline rolls.
const INLINE_RE   = /\[\[\/([\w]+)/g;

// ─── MAIN ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DESCRIPTIONS_DIR)) {
    console.error(`Directory not found: ${DESCRIPTIONS_DIR}`);
    console.error('Run `node update-data.js --force` first to generate description files.');
    process.exit(1);
}

const files = fs.readdirSync(DESCRIPTIONS_DIR).filter(f => f.endsWith('.json'));

if (files.length === 0) {
    console.error('No description files found. Run update-data.js first.');
    process.exit(1);
}

// findings[patternKey] = { count: N, examples: Set<string> }
const findings = {};

function record(key, contextText) {
    if (!findings[key]) findings[key] = { count: 0, examples: [] };
    findings[key].count++;
    if (findings[key].examples.length < 3) {
        // Grab up to 80 chars of context around the match position
        const trimmed = contextText.replace(/\s+/g, ' ').trim();
        const snippet = trimmed.length > 100 ? trimmed.slice(0, 100) + '…' : trimmed;
        if (!findings[key].examples.includes(snippet)) {
            findings[key].examples.push(snippet);
        }
    }
}

function extractContext(text, index, length = 80) {
    const start = Math.max(0, index - 15);
    const end   = Math.min(text.length, index + length);
    return text.slice(start, end);
}

let fileCount = 0;
let errorCount = 0;

for (const file of files) {
    let content;
    try {
        content = JSON.parse(fs.readFileSync(path.join(DESCRIPTIONS_DIR, file), 'utf8'));
    } catch {
        errorCount++;
        continue;
    }

    const text = content.description || '';
    fileCount++;

    // Scan for @Type[ references
    let m;
    AT_REF_RE.lastIndex = 0;
    while ((m = AT_REF_RE.exec(text)) !== null) {
        const key = `@${m[1]}[…]`;
        record(key, extractContext(text, m.index));
    }

    // Scan for [[/command inline rolls
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(text)) !== null) {
        const key = `[[/${m[1]} …]]`;
        record(key, extractContext(text, m.index));
    }
}

// ─── REPORT ───────────────────────────────────────────────────────────────────

console.log(`Scanned ${fileCount} description files.${errorCount ? ` (${errorCount} unreadable)` : ''}\n`);

if (Object.keys(findings).length === 0) {
    console.log('No uncleaned Foundry markup found.');
    process.exit(0);
}

const sorted = Object.entries(findings).sort((a, b) => b[1].count - a[1].count);
const total  = sorted.reduce((s, [, v]) => s + v.count, 0);

console.log(`Found ${total} uncleaned markup occurrence(s) across ${sorted.length} pattern type(s):\n`);
console.log('─'.repeat(60));

for (const [pattern, { count, examples }] of sorted) {
    console.log(`\n  ${pattern.padEnd(30)} ${count} occurrence(s)`);
    for (const ex of examples) {
        console.log(`    …${ex}…`);
    }
}

console.log('\n' + '─'.repeat(60));
console.log('\nAdd handling for any of the above in cleanFoundryHtml() inside update-data.js.');
process.exit(1); // Non-zero so CI can flag it if desired
