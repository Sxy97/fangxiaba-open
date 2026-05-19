import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webRoot = join(root, 'web');
const assetsDir = join(webRoot, 'assets');

mkdirSync(assetsDir, { recursive: true });
cleanGeneratedAssets();

const style = buildAsset({
  sourcePath: join(webRoot, 'styles.css'),
  prefix: 'styles',
  extension: 'css',
});
const app = buildAsset({
  sourcePath: join(webRoot, 'app.js'),
  prefix: 'app',
  extension: 'js',
});

const manifest = {
  style: style.href,
  app: app.href,
  styleHash: style.hash,
  appHash: app.hash,
  assetVersion: `${app.hash}-${style.hash}`,
};

writeFileSync(join(assetsDir, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`assets built: ${manifest.app} ${manifest.style}`);

function buildAsset({ sourcePath, prefix, extension }) {
  const content = readFileSync(sourcePath);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const fileName = `${prefix}.${hash}.${extension}`;
  const outputPath = join(assetsDir, fileName);
  writeFileSync(outputPath, content);
  return {
    hash,
    href: `/assets/${fileName}`,
  };
}

function cleanGeneratedAssets() {
  if (!existsSync(assetsDir)) return;
  for (const fileName of readdirSync(assetsDir)) {
    if (/^(?:app|styles)\.[a-f0-9]{8}\.(?:js|css)$/.test(fileName) || fileName === 'asset-manifest.json') {
      rmSync(join(assetsDir, fileName), { force: true });
    }
  }
}
