'use strict';

const assert = require('assert');
const path = require('path');
const {
    parseSettingsSource,
    getAppearances,
    getAppearanceKey,
    normalizeFrame,
    storageToFilePath,
    parseTatieTag,
    formatTatieTag,
} = require('../src/settingsParser');

const projectRoot = path.resolve(__dirname, '..');
const source = `window.TYRANO_TATIE_SETTINGS = {
    "schemaVersion": 2,
    "defaultCharacter": "Alice",
    "characters": {
        "Alice": {
            "defaultAppearance": "default",
            "appearances": {
                "default": {
                    "label": "Default",
                    "variants": {
                        "normal": {
                            "storage": "chara/alice/normal.png",
                            "frame": {
                                "width": 640,
                                "height": 960,
                                "positions": {
                                    "center": {
                                        "left": 320,
                                        "top": 24
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
};`;
const settings = parseSettingsSource(source);

assert.ok(settings.characters.Alice);

const alice = settings.characters.Alice;
const appearances = getAppearances(alice);
assert.ok(appearances.default);
assert.strictEqual(getAppearanceKey(alice, 'missing'), 'default');

const frame = normalizeFrame(appearances.default.variants.normal.frame);
assert.strictEqual(frame.positions.center.left, 320);
assert.strictEqual(frame.positions.center.top, 24);
assert.strictEqual(frame.positions.left.left, 0);

const filePath = storageToFilePath(projectRoot, 'data/fgimage', 'chara/alice/normal.png');
assert.ok(filePath.endsWith(path.join('data', 'fgimage', 'chara', 'alice', 'normal.png')));

const attrs = parseTatieTag('[tatie  name="Alice"  appearance="default"  variant="normal"  position="center"  ]');
assert.strictEqual(attrs.name, 'Alice');
assert.strictEqual(attrs.variant, 'normal');

const tag = formatTatieTag({
    name: 'Alice',
    appearance: 'default',
    variant: 'normal',
    position: 'center',
});
assert.strictEqual(tag, '[tatie  name="Alice"  appearance="default"  variant="normal"  position="center"  mode="show"  time="500"  wait="false"  reflect="false"  ]');

console.log('settingsParser tests passed');
