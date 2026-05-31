import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = path.join(extensionRoot, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const outDir = path.join(extensionRoot, 'dist');
const stagingDir = path.join(outDir, 'vsix-staging');
const extensionDir = path.join(stagingDir, 'extension');
const vsixName = `${packageJson.publisher}.${packageJson.name}-${packageJson.version}.vsix`;
const vsixPath = path.join(outDir, vsixName);

function xmlEscape(value) {
    return String(value ?? '').replace(/[<>&'"]/g, (char) => ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
    }[char]));
}

function copyFile(relativePath) {
    const source = path.join(extensionRoot, relativePath);
    const target = path.join(extensionDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

function writeFile(relativePath, contents) {
    const target = path.join(stagingDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(extensionDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
fs.rmSync(vsixPath, { force: true });

for (const relativePath of [
    'package.json',
    'README.md',
    'src/extension.js',
    'src/settingsParser.js',
]) {
    copyFile(relativePath);
}

writeFile('[Content_Types].xml', `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="xml" ContentType="application/xml" />
</Types>
`);

writeFile('extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(packageJson.name)}" Version="${xmlEscape(packageJson.version)}" Publisher="${xmlEscape(packageJson.publisher)}" />
    <DisplayName>${xmlEscape(packageJson.displayName || packageJson.name)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(packageJson.description || '')}</Description>
    <Categories>${xmlEscape((packageJson.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Private</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(packageJson.engines.vscode)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`);

childProcess.execFileSync('zip', ['-qr', vsixPath, '[Content_Types].xml', 'extension.vsixmanifest', 'extension'], {
    cwd: stagingDir,
    stdio: 'inherit',
});

console.log(vsixPath);
