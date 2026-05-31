'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const vscode = require('vscode');
const {
    parseSettingsSource,
    getAppearances,
    getAppearanceKey,
    normalizeFrame,
    cleanStoragePath,
    storageToFilePath,
    parseTatieTag,
    formatTatieTag,
} = require('./settingsParser');

let currentPanel = null;
let activePreviewProcess = null;
let diagnosticCollection = null;
const previewEntryStorage = '_vscode_preview.ks';
const previewSystemStorage = 'system/_vscode_preview.ks';
const previewFirstMarker = '; @tatie-preview generated first.ks';
const previewOutput = vscode.window.createOutputChannel('Tatie Preview');

function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.open', () => {
        openPreview(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.previewFromCursor', () => {
        openPreview(context, selectionFromActiveEditor());
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.refresh', () => {
        if (currentPanel) {
            currentPanel.refresh();
        } else {
            openPreview(context);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.openTag', (attrs) => {
        openPreview(context, attrs || {});
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.launchFromCurrentLine', () => {
        launchTyranoPreviewFromCurrentLine();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('tatiePreview.restorePreviewEntry', () => {
        const folder = resolveWorkspaceFolder();
        if (folder) {
            restorePreviewEntry(folder, true);
        }
    }));

    context.subscriptions.push(vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/*.ks' }, new TatieCodeLensProvider()));
    context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme: 'file', pattern: '**/*.ks' }, new TatieHoverProvider()));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
        { scheme: 'file', pattern: '**/*.ks' },
        new TatieCompletionProvider(),
        '"',
        "'",
        '=',
        ' ',
    ));

    diagnosticCollection = vscode.languages.createDiagnosticCollection('tatiePreview');
    context.subscriptions.push(diagnosticCollection);
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => validateTatieDocument(document)));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => validateTatieDocument(event.document)));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((document) => diagnosticCollection.delete(document.uri)));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('tatiePreview')) {
            validateAllOpenDocuments();
        }
    }));
    const settingsWatcher = vscode.workspace.createFileSystemWatcher('**/data/others/plugin/tatie/settings.js');
    settingsWatcher.onDidChange(validateAllOpenDocuments);
    settingsWatcher.onDidCreate(validateAllOpenDocuments);
    settingsWatcher.onDidDelete(validateAllOpenDocuments);
    context.subscriptions.push(settingsWatcher);
    validateAllOpenDocuments();
}

function deactivate() {
}

async function launchTyranoPreviewFromCurrentLine() {
    if (activePreviewProcess) {
        vscode.window.showWarningMessage('A Tyrano preview launched by Tatie Preview is already running.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || path.extname(editor.document.uri.fsPath) !== '.ks') {
        vscode.window.showWarningMessage('Open a .ks file and place the cursor on the line to preview.');
        return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
        vscode.window.showWarningMessage('Open the TyranoBuilder project as a workspace before launching preview.');
        return;
    }

    const scenarioRoot = path.join(folder.uri.fsPath, 'data', 'scenario');
    const scenarioPath = editor.document.uri.fsPath;
    const storage = path.relative(scenarioRoot, scenarioPath).replace(/\\/g, '/');
    if (storage.startsWith('..') || path.isAbsolute(storage)) {
        vscode.window.showWarningMessage('The current .ks file is not under data/scenario.');
        return;
    }

    try {
        restorePreviewEntry(folder, false);
        writePreviewScenario(folder, editor.document, editor.selection.active.line, storage);
        writePreviewFirstScenario(folder);
        startTyranoPreviewProcess(folder, storage, editor.selection.active.line + 1);
    } catch (error) {
        restorePreviewEntry(folder, false);
        vscode.window.showErrorMessage(`Failed to launch Tyrano preview: ${error.message}`);
    }
}

function writePreviewScenario(folder, document, lineIndex, storage) {
    const scenarioDir = path.join(folder.uri.fsPath, 'data', 'scenario');
    const systemDir = path.join(scenarioDir, 'system');
    const previewPath = path.join(scenarioDir, previewEntryStorage);
    const systemPreviewPath = path.join(scenarioDir, previewSystemStorage);
    fs.mkdirSync(systemDir, { recursive: true });

    const lines = document.getText().split(/\r?\n/);
    const tail = lines.slice(lineIndex).join('\n');
    const prelude = [
        '; Generated by Tatie Preview.',
        `; Source: ${storage}:${lineIndex + 1}`,
        `[_tb_system_call storage=${previewSystemStorage} ]`,
        '[cm]',
        '[tb_show_message_window]',
    ];
    if (isInsideTextBlock(lines, lineIndex)) {
        prelude.push('[tb_start_text mode=1 ]');
    }

    fs.writeFileSync(previewPath, `${prelude.join('\n')}\n${tail}\n`, 'utf8');
    fs.writeFileSync(systemPreviewPath, `[eval exp="f._system_preview_ks='${escapeKsString(storage)}'"] \n[return] \n`, 'utf8');
}

function isInsideTextBlock(lines, lineIndex) {
    let inside = false;
    for (let index = 0; index < lineIndex; index += 1) {
        const line = lines[index];
        if (/\[tb_start_text\b/.test(line)) {
            inside = true;
        }
        if (/\[_tb_end_text\b/.test(line)) {
            inside = false;
        }
    }
    return inside;
}

function writePreviewFirstScenario(folder) {
    const firstPath = path.join(folder.uri.fsPath, 'data', 'scenario', 'first.ks');
    const backupPath = previewBackupPath(folder);
    const firstScenario = fs.readFileSync(firstPath, 'utf8');
    if (!firstScenario.includes(previewFirstMarker)) {
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.writeFileSync(backupPath, firstScenario, 'utf8');
    }

    const jump = `[jump storage="${previewEntryStorage}"]`;
    let previewFirst = firstScenario.replace(/\[jump\s+storage\s*=\s*["']title_screen\.ks["'][^\]]*\]/, jump);
    if (previewFirst === firstScenario) {
        previewFirst = `${firstScenario.trimEnd()}\n\n${jump}\n`;
    }
    previewFirst = `${previewFirstMarker}\n${previewFirst.replace(previewFirstMarker, '').trimStart()}`;
    fs.writeFileSync(firstPath, previewFirst, 'utf8');
}

function startTyranoPreviewProcess(folder, storage, lineNumber) {
    const config = vscode.workspace.getConfiguration('tatiePreview', folder.uri);
    const command = config.get('previewCommand', 'npx');
    const args = config.get('previewArgs', ['nw', '.']);
    previewOutput.clear();
    previewOutput.appendLine(`Launching Tyrano preview from ${storage}:${lineNumber}`);
    previewOutput.appendLine(`$ ${command} ${args.join(' ')}`);
    previewOutput.show(true);

    activePreviewProcess = childProcess.spawn(command, args, {
        cwd: folder.uri.fsPath,
        shell: process.platform === 'win32',
        env: process.env,
    });

    activePreviewProcess.stdout.on('data', (chunk) => previewOutput.append(chunk.toString()));
    activePreviewProcess.stderr.on('data', (chunk) => previewOutput.append(chunk.toString()));
    activePreviewProcess.on('error', (error) => {
        previewOutput.appendLine(`Preview failed: ${error.message}`);
        activePreviewProcess = null;
        restorePreviewEntry(folder, false);
        vscode.window.showErrorMessage(`Failed to launch Tyrano preview: ${error.message}`);
    });
    activePreviewProcess.on('close', (code) => {
        previewOutput.appendLine(`Preview exited with code ${code}.`);
        activePreviewProcess = null;
        restorePreviewEntry(folder, false);
    });
}

function restorePreviewEntry(folder, notify) {
    const firstPath = path.join(folder.uri.fsPath, 'data', 'scenario', 'first.ks');
    const backupPath = previewBackupPath(folder);
    if (!fs.existsSync(firstPath) || !fs.existsSync(backupPath)) {
        if (notify) {
            vscode.window.showInformationMessage('No Tatie preview entry backup was found.');
        }
        return false;
    }

    const firstScenario = fs.readFileSync(firstPath, 'utf8');
    if (!firstScenario.includes(previewFirstMarker)) {
        if (notify) {
            vscode.window.showInformationMessage('first.ks is not using the Tatie preview entry.');
        }
        return false;
    }

    fs.copyFileSync(backupPath, firstPath);
    fs.rmSync(backupPath, { force: true });
    if (notify) {
        vscode.window.showInformationMessage('Restored data/scenario/first.ks from the preview backup.');
    }
    return true;
}

function previewBackupPath(folder) {
    return path.join(folder.uri.fsPath, 'tmp', 'tatie-preview', 'first.ks.bak');
}

function escapeKsString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function validateAllOpenDocuments() {
    for (const document of vscode.workspace.textDocuments) {
        validateTatieDocument(document);
    }
}

function validateTatieDocument(document) {
    if (!diagnosticCollection || document.uri.scheme !== 'file' || path.extname(document.uri.fsPath) !== '.ks') {
        return;
    }

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    const enabled = vscode.workspace.getConfiguration('tatiePreview', folder.uri).get('enableDiagnostics', true);
    if (!enabled) {
        diagnosticCollection.delete(document.uri);
        return;
    }

    let settings;
    try {
        settings = loadSettings(folder);
    } catch (error) {
        diagnosticCollection.set(document.uri, [
            new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1),
                `tatie settings.js could not be loaded: ${error.message}`,
                vscode.DiagnosticSeverity.Error,
            ),
        ]);
        return;
    }

    const diagnostics = [];
    for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
        const line = document.lineAt(lineIndex);
        for (const tag of findTatieTagsInLine(line.text, lineIndex)) {
            diagnostics.push(...validateTatieTag(settings, tag));
        }
    }
    diagnosticCollection.set(document.uri, diagnostics);
}

function validateTatieTag(settings, tag) {
    const diagnostics = [];
    const attrs = tag.attrs;
    const nameRange = attrRangeOrTagRange(tag, 'name');
    const appearanceRange = attrRangeOrTagRange(tag, 'appearance');
    const variantRange = attrRangeOrTagRange(tag, 'variant');

    if (!attrs.name) {
        diagnostics.push(diagnostic(nameRange, 'tatie is missing name.'));
        return diagnostics;
    }

    const character = settings.characters && settings.characters[attrs.name.value];
    if (!character) {
        diagnostics.push(diagnostic(nameRange, `tatie character does not exist: "${attrs.name.value}"`));
        return diagnostics;
    }

    const appearances = getAppearances(character);
    let appearanceKey = getAppearanceKey(character, attrs.appearance && attrs.appearance.value);
    if (attrs.appearance && !appearances[attrs.appearance.value]) {
        diagnostics.push(diagnostic(appearanceRange, `appearance "${attrs.appearance.value}" does not exist for "${attrs.name.value}".`));
        return diagnostics;
    }

    if (!appearanceKey || !appearances[appearanceKey]) {
        diagnostics.push(diagnostic(appearanceRange, `No appearance is defined for "${attrs.name.value}".`));
        return diagnostics;
    }

    if (!attrs.variant) {
        diagnostics.push(diagnostic(variantRange, 'tatie is missing variant.'));
        return diagnostics;
    }

    const variants = appearances[appearanceKey].variants || {};
    if (!variants[attrs.variant.value]) {
        diagnostics.push(diagnostic(
            variantRange,
            `variant "${attrs.variant.value}" does not exist for "${attrs.name.value}" / "${appearanceKey}".`,
        ));
    }

    return diagnostics;
}

function diagnostic(range, message) {
    const item = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    item.source = 'tatie-preview';
    return item;
}

function attrRangeOrTagRange(tag, attrName) {
    return tag.attrs[attrName] ? tag.attrs[attrName].range : tag.range;
}

function findTatieTagsInLine(lineText, lineIndex) {
    const tags = [];
    const pattern = /\[tatie\b[^\]]*\]/g;
    let match;
    while ((match = pattern.exec(lineText)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        tags.push({
            text: match[0],
            range: new vscode.Range(lineIndex, start, lineIndex, end),
            attrs: parseAttrsWithRanges(match[0], lineIndex, start),
        });
    }
    return tags;
}

function parseAttrsWithRanges(tagText, lineIndex, tagStart) {
    const attrs = {};
    const attrPattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/g;
    let match;
    while ((match = attrPattern.exec(tagText)) !== null) {
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        const valueStart = tagStart + match.index + match[0].length - value.length - (match[4] ? 0 : 1);
        const valueEnd = valueStart + value.length;
        attrs[match[1]] = {
            value,
            range: new vscode.Range(lineIndex, valueStart, lineIndex, Math.max(valueEnd, valueStart + 1)),
        };
    }
    return attrs;
}

class TatieCodeLensProvider {
    provideCodeLenses(document) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return [];
        }
        const enabled = vscode.workspace.getConfiguration('tatiePreview', folder.uri).get('enableCodeLens', true);
        if (!enabled) {
            return [];
        }

        const lenses = [];
        for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
            const line = document.lineAt(lineIndex);
            const start = line.text.indexOf('[tatie');
            if (start === -1) {
                continue;
            }
            const attrs = parseTatieTag(line.text);
            if (!attrs) {
                continue;
            }
            const label = [attrs.name, attrs.appearance, attrs.variant].filter(Boolean).join(' / ');
            lenses.push(new vscode.CodeLens(new vscode.Range(lineIndex, start, lineIndex, start + 1), {
                title: label ? `Preview ${label}` : 'Preview tatie',
                command: 'tatiePreview.openTag',
                arguments: [attrs],
            }));
        }
        return lenses;
    }
}

class TatieHoverProvider {
    provideHover(document, position) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return null;
        }

        const tag = findTatieTagAtPosition(document, position);
        if (!tag) {
            return null;
        }

        const resolved = resolveVariantForHover(folder, tag.attrs);
        if (!resolved.ok) {
            return new vscode.Hover(new vscode.MarkdownString(resolved.message), tag.range);
        }

        const markdown = new vscode.MarkdownString('', true);
        markdown.supportHtml = true;
        markdown.appendMarkdown(`**${escapeMarkdown(resolved.selection.name)}**  \n`);
        markdown.appendMarkdown(`${escapeMarkdown(resolved.selection.appearance)} / ${escapeMarkdown(resolved.selection.variant)} / ${escapeMarkdown(resolved.selection.position)}  \n`);
        markdown.appendMarkdown(`\`${escapeCode(resolved.variant.storage)}\``);

        if (resolved.exists) {
            const imageUri = vscode.Uri.file(resolved.filePath).toString();
            markdown.appendMarkdown(`\n\n<img src="${escapeHtmlAttr(imageUri)}" width="260" />`);
        } else {
            markdown.appendMarkdown(`\n\nImage not found: \`${escapeCode(resolved.filePath)}\``);
        }

        return new vscode.Hover(markdown, tag.range);
    }
}

class TatieCompletionProvider {
    provideCompletionItems(document, position) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) {
            return [];
        }
        const enabled = vscode.workspace.getConfiguration('tatiePreview', folder.uri).get('enableCompletion', true);
        if (!enabled) {
            return [];
        }

        const context = findTatieAttributeAtPosition(document, position);
        if (!context) {
            return [];
        }

        let settings;
        try {
            settings = loadSettings(folder);
        } catch {
            return [];
        }

        if (context.attribute === 'name') {
            return Object.keys(settings.characters || {}).map((name) => completionItem(name, context.range, {
                detail: 'tatie character',
                kind: vscode.CompletionItemKind.Class,
            }));
        }

        const character = settings.characters && settings.characters[context.attrs.name];
        if (context.attribute === 'appearance') {
            if (!character) {
                return [];
            }
            const appearances = getAppearances(character);
            return Object.entries(appearances).map(([key, appearance]) => completionItem(key, context.range, {
                detail: appearance.label && appearance.label !== key ? appearance.label : `${context.attrs.name} appearance`,
                kind: vscode.CompletionItemKind.EnumMember,
            }));
        }

        if (context.attribute === 'variant') {
            if (!character) {
                return [];
            }
            const appearances = getAppearances(character);
            const appearanceKey = getAppearanceKey(character, context.attrs.appearance);
            const appearance = appearances[appearanceKey] || {};
            const variants = appearance.variants || {};
            return Object.entries(variants).map(([key, variant]) => completionItem(key, context.range, {
                detail: `${context.attrs.name} / ${appearanceKey}`,
                documentation: variant.storage || '',
                kind: vscode.CompletionItemKind.EnumMember,
            }));
        }

        const staticCandidates = {
            position: ['left', 'center', 'right'],
            mode: ['show', 'mod'],
            wait: ['false', 'true'],
            reflect: ['false', 'true'],
            page: ['fore', 'back'],
        };
        return (staticCandidates[context.attribute] || []).map((value) => completionItem(value, context.range, {
            detail: `tatie ${context.attribute}`,
            kind: vscode.CompletionItemKind.Value,
        }));
    }
}

function completionItem(label, range, options = {}) {
    const item = new vscode.CompletionItem(label, options.kind || vscode.CompletionItemKind.Value);
    item.insertText = label;
    item.range = range;
    item.detail = options.detail || '';
    if (options.documentation) {
        item.documentation = new vscode.MarkdownString(`\`${escapeCode(options.documentation)}\``);
    }
    return item;
}

function findTatieTagAtPosition(document, position) {
    const line = document.lineAt(position.line);
    const pattern = /\[tatie\b[^\]]*\]/g;
    let match;
    while ((match = pattern.exec(line.text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character < start || position.character > end) {
            continue;
        }
        const attrs = parseTatieTag(match[0]);
        if (!attrs) {
            continue;
        }
        return {
            attrs,
            range: new vscode.Range(position.line, start, position.line, end),
        };
    }
    return null;
}

function findTatieAttributeAtPosition(document, position) {
    const line = document.lineAt(position.line);
    const tagBounds = findTatieBounds(line.text, position.character);
    if (!tagBounds) {
        return null;
    }

    const prefix = line.text.slice(tagBounds.start, position.character);
    const match = prefix.match(/([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)$|'([^']*)$|([^\s\]]*)$)/);
    if (!match) {
        return null;
    }

    const attribute = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const valueStart = tagBounds.start + match.index + match[0].length - value.length;
    const attrs = parseLooseTatieAttrs(line.text.slice(tagBounds.start, tagBounds.end));
    return {
        attribute,
        attrs,
        range: new vscode.Range(position.line, valueStart, position.line, position.character),
    };
}

function findTatieBounds(lineText, character) {
    const start = lineText.lastIndexOf('[tatie', character);
    if (start === -1) {
        return null;
    }
    const previousClose = lineText.lastIndexOf(']', character);
    if (previousClose > start) {
        return null;
    }
    const close = lineText.indexOf(']', start);
    const end = close === -1 ? lineText.length : close + 1;
    if (character > end) {
        return null;
    }
    return { start, end };
}

function parseLooseTatieAttrs(tagText) {
    const attrs = {};
    const attrPattern = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"?|'([^']*)'?|([^\s\]]+))/g;
    let match;
    while ((match = attrPattern.exec(tagText)) !== null) {
        attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
    return attrs;
}

function resolveVariantForHover(folder, attrs) {
    const selection = {
        name: attrs.name || '',
        appearance: attrs.appearance || '',
        variant: attrs.variant || '',
        position: attrs.position || 'center',
    };

    if (!selection.name || !selection.variant) {
        return {
            ok: false,
            message: 'tatie requires `name` and `variant` to preview.',
        };
    }

    try {
        const config = projectConfig(folder);
        const source = fs.readFileSync(config.settingsPath, 'utf8');
        const settings = parseSettingsSource(source);
        const character = settings.characters && settings.characters[selection.name];
        if (!character) {
            return {
                ok: false,
                message: `Character not found in settings.js: \`${escapeMarkdown(selection.name)}\``,
            };
        }

        const appearances = getAppearances(character);
        selection.appearance = getAppearanceKey(character, selection.appearance);
        const appearance = appearances[selection.appearance];
        const variant = appearance && appearance.variants && appearance.variants[selection.variant];
        if (!variant) {
            return {
                ok: false,
                message: `Variant not found in settings.js: \`${escapeMarkdown(selection.name)} / ${escapeMarkdown(selection.appearance)} / ${escapeMarkdown(selection.variant)}\``,
            };
        }

        const storage = cleanStoragePath(variant.storage || '');
        const filePath = storageToFilePath(folder.uri.fsPath, config.imageRoot, storage);
        return {
            ok: true,
            selection,
            variant: {
                ...variant,
                storage,
                frame: normalizeFrame(variant.frame),
            },
            filePath,
            exists: Boolean(filePath && fs.existsSync(filePath)),
        };
    } catch (error) {
        return {
            ok: false,
            message: error.message,
        };
    }
}

function loadSettings(folder) {
    const config = projectConfig(folder);
    const source = fs.readFileSync(config.settingsPath, 'utf8');
    return parseSettingsSource(source);
}

function selectionFromActiveEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return {};
    }

    const selectedText = editor.document.getText(editor.selection);
    const selectedAttrs = parseTatieTag(selectedText);
    if (selectedAttrs) {
        return selectedAttrs;
    }

    const activeLine = editor.document.lineAt(editor.selection.active.line).text;
    const lineAttrs = parseTatieTag(activeLine);
    return lineAttrs || {};
}

function openPreview(context, requestedSelection = {}) {
    const folder = resolveWorkspaceFolder();
    if (!folder) {
        vscode.window.showErrorMessage('Open a workspace folder before using Tatie Preview.');
        return;
    }

    if (currentPanel) {
        currentPanel.reveal(requestedSelection);
        return;
    }

    currentPanel = new TatiePreviewPanel(context, folder, requestedSelection);
}

function resolveWorkspaceFolder() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const editorFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (editorFolder) {
            return editorFolder;
        }
    }

    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1) {
        return folders[0];
    }

    return folders.find((folder) => {
        const config = projectConfig(folder);
        return fs.existsSync(config.settingsPath);
    }) || folders[0];
}

function projectConfig(folder) {
    const config = vscode.workspace.getConfiguration('tatiePreview', folder.uri);
    const settingsPath = config.get('settingsPath', 'data/others/plugin/tatie/settings.js');
    const imageRoot = config.get('imageRoot', 'data/fgimage');
    return {
        settingsPath: path.join(folder.uri.fsPath, settingsPath),
        settingsPathRelative: settingsPath,
        imageRoot,
    };
}

class TatiePreviewPanel {
    constructor(context, folder, requestedSelection) {
        this.context = context;
        this.folder = folder;
        this.requestedSelection = requestedSelection || {};
        this.panel = vscode.window.createWebviewPanel(
            'tatiePreview',
            'Tatie Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(folder.uri, 'data', 'fgimage'),
                ],
            },
        );

        this.panel.onDidDispose(() => {
            currentPanel = null;
            if (this.watcher) {
                this.watcher.dispose();
            }
        }, null, context.subscriptions);

        this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), null, context.subscriptions);
        this.createWatcher();
        this.refresh(this.requestedSelection);
    }

    reveal(requestedSelection = {}) {
        this.panel.reveal(vscode.ViewColumn.Beside);
        this.refresh(requestedSelection);
    }

    createWatcher() {
        const config = projectConfig(this.folder);
        const pattern = new vscode.RelativePattern(this.folder, config.settingsPathRelative);
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.watcher.onDidChange(() => this.refresh());
        this.watcher.onDidCreate(() => this.refresh());
        this.watcher.onDidDelete(() => this.refresh());
    }

    refresh(requestedSelection = this.requestedSelection) {
        this.requestedSelection = requestedSelection || this.requestedSelection || {};
        const payload = buildCatalog(this.folder, this.panel.webview, this.requestedSelection);
        this.panel.webview.html = renderHtml(this.panel.webview, payload);
    }

    async handleMessage(message) {
        if (!message || typeof message.type !== 'string') {
            return;
        }

        if (message.type === 'refresh') {
            this.refresh(message.selection || this.requestedSelection);
            return;
        }

        if (message.type === 'copyTag') {
            const tag = formatTatieTag(message.selection || {});
            await vscode.env.clipboard.writeText(tag);
            vscode.window.setStatusBarMessage('tatie tag copied.', 2000);
            return;
        }

        if (message.type === 'insertTag') {
            await insertTagAtCursor(message.selection || {});
            return;
        }

        if (message.type === 'openImage') {
            const filePath = message.filePath;
            if (filePath && fs.existsSync(filePath)) {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
            }
        }
    }
}

async function insertTagAtCursor(selection) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a .ks file before inserting a tatie tag.');
        return;
    }

    const tag = formatTatieTag(selection);
    await editor.edit((editBuilder) => {
        if (editor.selection.isEmpty) {
            editBuilder.insert(editor.selection.active, tag);
        } else {
            editBuilder.replace(editor.selection, tag);
        }
    });
}

function buildCatalog(folder, webview, requestedSelection) {
    const config = projectConfig(folder);
    try {
        const source = fs.readFileSync(config.settingsPath, 'utf8');
        const settings = parseSettingsSource(source);
        const characters = Object.entries(settings.characters || {}).map(([name, character]) => {
            const appearances = getAppearances(character);
            return {
                name,
                defaultAppearance: getAppearanceKey(character, character.defaultAppearance),
                appearances: Object.entries(appearances).map(([appearanceKey, appearance]) => {
                    const variants = appearance.variants || {};
                    return {
                        key: appearanceKey,
                        label: appearance.label || '',
                        folder: appearance.folder || character.folder || '',
                        variants: Object.entries(variants).map(([variantKey, variant]) => {
                            const storage = cleanStoragePath(variant.storage || '');
                            const filePath = storageToFilePath(folder.uri.fsPath, config.imageRoot, storage);
                            const exists = Boolean(filePath && fs.existsSync(filePath));
                            return {
                                key: variantKey,
                                storage,
                                cacheKey: variant.cacheKey || '',
                                frame: normalizeFrame(variant.frame),
                                filePath,
                                exists,
                                imageUri: exists ? webview.asWebviewUri(vscode.Uri.file(filePath)).toString() : '',
                            };
                        }),
                    };
                }),
            };
        });

        return {
            ok: true,
            workspace: folder.uri.fsPath,
            settingsPath: config.settingsPath,
            imageRoot: config.imageRoot,
            defaultCharacter: settings.defaultCharacter || (characters[0] && characters[0].name) || '',
            requestedSelection: requestedSelection || {},
            characters,
        };
    } catch (error) {
        return {
            ok: false,
            workspace: folder.uri.fsPath,
            settingsPath: config.settingsPath,
            imageRoot: config.imageRoot,
            error: error.message,
            requestedSelection: requestedSelection || {},
            characters: [],
        };
    }
}

function renderHtml(webview, payload) {
    const nonce = getNonce();
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Tatie Preview</title>
<style>
:root {
  color-scheme: light dark;
}
body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
button, select, input {
  font: inherit;
}
.app {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(420px, 1fr);
  min-height: 100vh;
}
.sidebar {
  border-right: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
  background: var(--vscode-sideBar-background);
  padding: 12px;
  box-sizing: border-box;
  overflow: auto;
}
.preview {
  padding: 14px;
  overflow: auto;
}
.title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 12px;
}
.field {
  display: grid;
  gap: 5px;
  margin-bottom: 10px;
}
.field label {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.row > * {
  min-width: 0;
}
select, input[type="search"] {
  width: 100%;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  padding: 5px 7px;
  box-sizing: border-box;
}
button {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 0;
  padding: 6px 10px;
  cursor: pointer;
}
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
}
button:hover {
  background: var(--vscode-button-hoverBackground);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.card {
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
  color: var(--vscode-foreground);
  padding: 0;
  text-align: left;
  overflow: hidden;
}
.card.active {
  outline: 2px solid var(--vscode-focusBorder);
  outline-offset: -2px;
}
.thumb, .stage, .imageBox {
  background-color: var(--vscode-editor-background);
  background-image:
    linear-gradient(45deg, rgba(128,128,128,.18) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(128,128,128,.18) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(128,128,128,.18) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(128,128,128,.18) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.thumb {
  height: 124px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.thumb img {
  display: block;
  max-width: 100%;
  max-height: 124px;
  object-fit: contain;
}
.missing {
  color: var(--vscode-errorForeground);
  font-size: 12px;
  padding: 8px;
  text-align: center;
}
.cardLabel {
  padding: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
}
.stage {
  width: 100%;
  max-width: 960px;
  border: 1px solid var(--vscode-panel-border);
  overflow: hidden;
  position: relative;
}
.stageInner {
  position: relative;
  width: 1280px;
  height: 720px;
  transform-origin: top left;
}
.stageInner::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 148px;
  background: linear-gradient(to top, rgba(0,0,0,.42), transparent);
  pointer-events: none;
}
.stageImage {
  position: absolute;
  display: block;
  object-fit: fill;
  transform-origin: center;
}
.meta {
  margin-top: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
  word-break: break-all;
}
.tagPreview {
  margin-top: 12px;
  padding: 8px;
  color: var(--vscode-textPreformat-foreground);
  background: var(--vscode-textCodeBlock-background);
  white-space: pre-wrap;
  word-break: break-all;
}
.empty, .error {
  padding: 14px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--vscode-editorWidget-background);
}
.error {
  color: var(--vscode-errorForeground);
}
@media (max-width: 840px) {
  .app {
    grid-template-columns: 1fr;
  }
  .sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
}
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
const initialPayload = ${json};
const vscode = acquireVsCodeApi();
let payload = initialPayload;
let selection = normalizeSelection(payload.requestedSelection || {});

function normalizeSelection(source) {
  return {
    name: source.name || '',
    appearance: source.appearance || '',
    variant: source.variant || '',
    position: source.position || 'center',
    mode: source.mode || 'show',
    time: source.time || '500',
    wait: source.wait || 'false',
    reflect: source.reflect || 'false',
    layer: source.layer || '',
    page: source.page || ''
  };
}

function characterByName(name) {
  return (payload.characters || []).find((character) => character.name === name) || null;
}

function appearanceByKey(character, key) {
  return character && character.appearances.find((appearance) => appearance.key === key) || null;
}

function variantByKey(appearance, key) {
  return appearance && appearance.variants.find((variant) => variant.key === key) || null;
}

function ensureSelection() {
  if (!payload.ok) {
    return;
  }
  let character = characterByName(selection.name);
  if (!character) {
    selection.name = payload.defaultCharacter || (payload.characters[0] && payload.characters[0].name) || '';
    character = characterByName(selection.name);
  }
  if (!character) {
    return;
  }
  let appearance = appearanceByKey(character, selection.appearance);
  if (!appearance) {
    selection.appearance = character.defaultAppearance || (character.appearances[0] && character.appearances[0].key) || '';
    appearance = appearanceByKey(character, selection.appearance);
  }
  if (!appearance) {
    return;
  }
  let variant = variantByKey(appearance, selection.variant);
  if (!variant) {
    selection.variant = (appearance.variants[0] && appearance.variants[0].key) || '';
    variant = variantByKey(appearance, selection.variant);
  }
  if (!['left', 'center', 'right'].includes(selection.position)) {
    selection.position = 'center';
  }
  if (!selection.mode) {
    selection.mode = 'show';
  }
  if (!selection.time) {
    selection.time = '500';
  }
  if (!selection.wait) {
    selection.wait = 'false';
  }
  if (!selection.reflect) {
    selection.reflect = 'false';
  }
}

function tagText() {
  const attrs = [
    ['name', selection.name],
    ['appearance', selection.appearance],
    ['variant', selection.variant],
    ['position', selection.position],
    ['mode', selection.mode],
    ['time', selection.time],
    ['wait', selection.wait],
    ['reflect', selection.reflect]
  ];
  if (selection.layer) attrs.push(['layer', selection.layer]);
  if (selection.page) attrs.push(['page', selection.page]);
  return '[tatie  ' + attrs
    .filter((entry) => entry[1] !== '')
    .map((entry) => entry[0] + '="' + String(entry[1]).replace(/"/g, '&quot;') + '"')
    .join('  ') + '  ]';
}

function render() {
  ensureSelection();
  const app = document.getElementById('app');
  if (!payload.ok) {
    app.innerHTML = '<div class="preview"><div class="error">' + escapeHtml(payload.error || 'Failed to load settings.js') + '</div><p class="meta">' + escapeHtml(payload.settingsPath || '') + '</p><button id="refresh">Refresh</button></div>';
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh', selection }));
    return;
  }
  if (!payload.characters.length) {
    app.innerHTML = '<div class="preview"><div class="empty">No characters were found in settings.js.</div></div>';
    return;
  }

  app.className = 'app';
  app.innerHTML = [
    '<aside class="sidebar">',
    '<h1 class="title">Tatie Preview</h1>',
    field('Character', '<select id="character"></select>'),
    field('Appearance', '<select id="appearance"></select>'),
    field('Position', '<select id="position"><option value="left">left</option><option value="center">center</option><option value="right">right</option></select>'),
    field('Tag options', '<div class="row"><select id="mode"><option value="show">show</option><option value="mod">mod</option></select><select id="wait"><option value="false">wait=false</option><option value="true">wait=true</option></select></div>'),
    field('Time / Reflect', '<div class="row"><input id="time" inputmode="numeric" value=""><label class="row"><input id="reflect" type="checkbox"> reflect</label></div>'),
    field('Search', '<input id="search" type="search" placeholder="variant or storage">'),
    '<div class="row"><button id="copyTag">Copy Tag</button><button id="insertTag" class="secondary">Insert</button><button id="refresh" class="secondary">Refresh</button></div>',
    '<div id="grid" class="grid"></div>',
    '</aside>',
    '<main class="preview">',
    '<div id="stage" class="stage"><div id="stageInner" class="stageInner"></div></div>',
    '<div id="meta" class="meta"></div>',
    '<div id="tagPreview" class="tagPreview"></div>',
    '</main>'
  ].join('');

  hydrateControls();
  renderGrid();
  renderPreview();
}

function field(label, html) {
  return '<div class="field"><label>' + label + '</label>' + html + '</div>';
}

function hydrateControls() {
  const characterSelect = document.getElementById('character');
  characterSelect.innerHTML = payload.characters.map((character) => option(character.name, character.name, character.name === selection.name)).join('');
  characterSelect.addEventListener('change', () => {
    selection.name = characterSelect.value;
    selection.appearance = '';
    selection.variant = '';
    render();
  });

  const character = characterByName(selection.name);
  const appearanceSelect = document.getElementById('appearance');
  appearanceSelect.innerHTML = (character.appearances || []).map((appearance) => {
    const label = appearance.label && appearance.label !== appearance.key ? appearance.key + '  ' + appearance.label : appearance.key;
    return option(appearance.key, label, appearance.key === selection.appearance);
  }).join('');
  appearanceSelect.addEventListener('change', () => {
    selection.appearance = appearanceSelect.value;
    selection.variant = '';
    render();
  });

  document.getElementById('position').value = selection.position;
  document.getElementById('position').addEventListener('change', (event) => {
    selection.position = event.target.value;
    renderPreview();
  });

  document.getElementById('mode').value = selection.mode;
  document.getElementById('mode').addEventListener('change', (event) => {
    selection.mode = event.target.value;
    renderPreview();
  });

  document.getElementById('wait').value = selection.wait;
  document.getElementById('wait').addEventListener('change', (event) => {
    selection.wait = event.target.value;
    renderPreview();
  });

  document.getElementById('time').value = selection.time;
  document.getElementById('time').addEventListener('input', (event) => {
    selection.time = event.target.value;
    renderPreview();
  });

  document.getElementById('reflect').checked = selection.reflect === 'true';
  document.getElementById('reflect').addEventListener('change', (event) => {
    selection.reflect = event.target.checked ? 'true' : 'false';
    renderPreview();
  });

  document.getElementById('search').addEventListener('input', renderGrid);
  document.getElementById('copyTag').addEventListener('click', () => vscode.postMessage({ type: 'copyTag', selection }));
  document.getElementById('insertTag').addEventListener('click', () => vscode.postMessage({ type: 'insertTag', selection }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh', selection }));
}

function renderGrid() {
  const character = characterByName(selection.name);
  const appearance = appearanceByKey(character, selection.appearance);
  const variants = (appearance && appearance.variants) || [];
  const query = (document.getElementById('search') && document.getElementById('search').value || '').trim().toLowerCase();
  const filtered = variants.filter((variant) => {
    if (!query) return true;
    return variant.key.toLowerCase().includes(query) || variant.storage.toLowerCase().includes(query);
  });
  document.getElementById('grid').innerHTML = filtered.map((variant) => {
    const active = variant.key === selection.variant ? ' active' : '';
    const image = variant.exists
      ? '<img loading="lazy" src="' + variant.imageUri + '" alt="">'
      : '<div class="missing">missing</div>';
    return '<button class="card' + active + '" data-variant="' + escapeHtml(variant.key) + '">' +
      '<div class="thumb">' + image + '</div>' +
      '<div class="cardLabel" title="' + escapeHtml(variant.storage) + '">' + escapeHtml(variant.key) + '</div>' +
      '</button>';
  }).join('');

  for (const card of document.querySelectorAll('.card[data-variant]')) {
    card.addEventListener('click', () => {
      selection.variant = card.dataset.variant;
      renderGrid();
      renderPreview();
    });
  }
}

function renderPreview() {
  const character = characterByName(selection.name);
  const appearance = appearanceByKey(character, selection.appearance);
  const variant = variantByKey(appearance, selection.variant);
  const inner = document.getElementById('stageInner');
  if (!variant) {
    inner.innerHTML = '<div class="missing">No variant selected.</div>';
    return;
  }

  const frame = variant.frame;
  const position = frame.positions[selection.position] || frame.positions.center || { left: 0, top: 0 };
  const transform = selection.reflect === 'true' ? 'scaleX(-1)' : '';
  inner.innerHTML = variant.exists
    ? '<img class="stageImage" src="' + variant.imageUri + '" alt="">'
    : '<div class="missing">Image not found.</div>';
  const image = inner.querySelector('.stageImage');
  if (image) {
    image.style.left = position.left + 'px';
    image.style.top = position.top + 'px';
    image.style.width = frame.width + 'px';
    image.style.height = frame.height + 'px';
    image.style.transform = transform;
    image.addEventListener('dblclick', () => vscode.postMessage({ type: 'openImage', filePath: variant.filePath }));
  }

  document.getElementById('meta').innerHTML = [
    '<strong>' + escapeHtml(selection.name) + '</strong>',
    escapeHtml(selection.appearance + ' / ' + selection.variant),
    escapeHtml(variant.storage),
    'frame ' + frame.width + 'x' + frame.height + ' / ' + selection.position + ' x=' + position.left + ' y=' + position.top,
    variant.exists ? escapeHtml(variant.filePath) : '<span class="missing">missing: ' + escapeHtml(variant.filePath) + '</span>'
  ].join('<br>');
  document.getElementById('tagPreview').textContent = tagText();
  updateStageScale();
}

function updateStageScale() {
  const stage = document.getElementById('stage');
  const inner = document.getElementById('stageInner');
  if (!stage || !inner) {
    return;
  }
  const width = Math.max(stage.clientWidth, 1);
  const scale = width / 1280;
  inner.style.transform = 'scale(' + scale + ')';
  stage.style.height = Math.round(720 * scale) + 'px';
}

function option(value, label, selected) {
  return '<option value="' + escapeHtml(value) + '"' + (selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

window.addEventListener('resize', updateStageScale);
render();
</script>
</body>
</html>`;
}

function escapeMarkdown(value) {
    return String(value ?? '').replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

function escapeCode(value) {
    return String(value ?? '').replace(/`/g, '\\`');
}

function escapeHtmlAttr(value) {
    return String(value ?? '').replace(/[&"]/g, (char) => ({
        '&': '&amp;',
        '"': '&quot;',
    }[char]));
}

function getNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i += 1) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

module.exports = {
    activate,
    deactivate,
};
