'use strict';

const path = require('path');

const defaultAppearanceKey = 'default';
const settingsAssignmentPattern = /window\.TYRANO_TATIE_SETTINGS\s*=\s*([\s\S]*?);\s*$/;

function parseSettingsSource(source) {
    const match = String(source || '').match(settingsAssignmentPattern);
    if (!match) {
        throw new Error('window.TYRANO_TATIE_SETTINGS assignment was not found.');
    }

    try {
        return JSON.parse(match[1]);
    } catch (error) {
        throw new Error(`settings.js is not valid JSON assignment: ${error.message}`);
    }
}

function getAppearances(character) {
    if (!character) {
        return {};
    }
    if (character.appearances) {
        return character.appearances;
    }
    if (character.variants) {
        const appearanceKey = character.defaultAppearance || defaultAppearanceKey;
        return {
            [appearanceKey]: {
                label: 'Standard',
                variants: character.variants,
            },
        };
    }
    return {};
}

function getAppearanceKey(character, requestedKey) {
    const appearances = getAppearances(character);
    if (requestedKey && appearances[requestedKey]) {
        return requestedKey;
    }
    if (character && character.defaultAppearance && appearances[character.defaultAppearance]) {
        return character.defaultAppearance;
    }
    if (appearances[defaultAppearanceKey]) {
        return defaultAppearanceKey;
    }
    return Object.keys(appearances)[0] || defaultAppearanceKey;
}

function numberOr(value, fallback) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFrame(frame) {
    const source = frame || {};
    const positions = source.positions || {};
    const normalized = {
        width: numberOr(source.width, 632),
        height: numberOr(source.height, 843),
        positions: {},
    };

    for (const key of ['left', 'center', 'right']) {
        const position = positions[key] || {};
        normalized.positions[key] = {
            left: numberOr(position.left, 0),
            top: numberOr(position.top, 0),
        };
    }

    return normalized;
}

function cleanStoragePath(storage) {
    return String(storage || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '');
}

function storageToFilePath(projectRoot, imageRoot, storage) {
    const cleanStorage = cleanStoragePath(storage);
    if (!cleanStorage) {
        return '';
    }
    if (path.isAbsolute(cleanStorage)) {
        return path.normalize(cleanStorage);
    }
    if (cleanStorage.startsWith('data/fgimage/')) {
        return path.join(projectRoot, cleanStorage);
    }
    if (cleanStorage.startsWith('fgimage/')) {
        return path.join(projectRoot, 'data', cleanStorage);
    }
    return path.join(projectRoot, imageRoot, cleanStorage);
}

function parseTatieTag(text) {
    const tagMatch = String(text || '').match(/\[tatie\b([^\]]*)\]/);
    if (!tagMatch) {
        return null;
    }

    const attrs = {};
    const attrPattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g;
    let match;
    while ((match = attrPattern.exec(tagMatch[1])) !== null) {
        attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attrs;
}

function escapeTagValue(value) {
    return String(value ?? '').replace(/"/g, '&quot;');
}

function formatTatieTag(selection) {
    const source = selection || {};
    const attrs = [
        ['name', source.name || ''],
        ['appearance', source.appearance || ''],
        ['variant', source.variant || ''],
        ['position', source.position || 'center'],
        ['mode', source.mode || 'show'],
        ['time', source.time || '500'],
        ['wait', source.wait || 'false'],
        ['reflect', source.reflect || 'false'],
    ];

    if (source.layer) {
        attrs.push(['layer', source.layer]);
    }
    if (source.page) {
        attrs.push(['page', source.page]);
    }

    const body = attrs
        .filter(([, value]) => value !== '')
        .map(([key, value]) => `${key}="${escapeTagValue(value)}"`)
        .join('  ');

    return `[tatie  ${body}  ]`;
}

module.exports = {
    defaultAppearanceKey,
    parseSettingsSource,
    getAppearances,
    getAppearanceKey,
    normalizeFrame,
    cleanStoragePath,
    storageToFilePath,
    parseTatieTag,
    formatTatieTag,
};
