import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AssetCacheService,
  DEFAULT_ASSET_CACHE_CONFIG,
  buildVersionedAssetManifest,
  noStoreHeaders,
  normalizeAssetCacheConfig,
  rewriteVersionedAssetReferences,
  versionedAssetHeaders
} from '../src/system/asset-cache.service';

describe('AssetCacheService', () => {
  let root: string;
  let values: Map<string, string>;
  let store: any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultback-assets-'));
    fs.writeFileSync(path.join(root, 'app.js'), 'window.example = 1;');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body { color: teal; }');
    fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0, 1, 2]));
    values = new Map();
    store = {
      db: {
        prepare: (sql: string) => ({
          get: (key: string) => values.has(key) ? { value: values.get(key) } : undefined,
          run: (key: string, value: string) => values.set(key, value)
        })
      }
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('uses safe defaults and persists only validated cache settings', () => {
    const cache = new AssetCacheService(store);
    expect(cache.getConfig()).toEqual(DEFAULT_ASSET_CACHE_CONFIG);
    expect(cache.saveConfig({ enabled: false, browserMaxAgeSeconds: 60, edgeMaxAgeSeconds: 3600 })).toEqual({
      enabled: false, browserMaxAgeSeconds: 60, edgeMaxAgeSeconds: 3600
    });
    expect(cache.getConfig().enabled).toBe(false);
    expect(() => cache.saveConfig({ enabled: 'true', browserMaxAgeSeconds: 60, edgeMaxAgeSeconds: 3600 })).toThrow();
    expect(() => normalizeAssetCacheConfig({ enabled: true, browserMaxAgeSeconds: 59, edgeMaxAgeSeconds: 3600 })).toThrow();
    expect(() => normalizeAssetCacheConfig({ enabled: true, browserMaxAgeSeconds: 31536001, edgeMaxAgeSeconds: 3600 })).toThrow();
  });

  it('creates content-hashed URLs for JavaScript and CSS only and rewrites exact local references', () => {
    const manifest = buildVersionedAssetManifest(root);
    expect(manifest.map(asset => asset.name)).toEqual(['app.js', 'styles.css']);
    expect(manifest.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256) && asset.path === `/_assets/${asset.sha256}/${asset.name}`)).toBe(true);
    const html = '<script src="/app.js"></script><link href="/styles.css?v=workspace-blue" rel="stylesheet"><img src="/logo.png">';
    const rewritten = rewriteVersionedAssetReferences(html, manifest);
    expect(rewritten).toContain(`src="${manifest.find(asset => asset.name === 'app.js')!.path}"`);
    expect(rewritten).toContain(`href="${manifest.find(asset => asset.name === 'styles.css')!.path}"`);
    expect(rewritten).not.toContain('workspace-blue');
    expect(rewritten).toContain('src="/logo.png"');
  });

  it('limits Cloudflare rules to current exact paths and emits no-store outside versioned assets', () => {
    const cache = new AssetCacheService(store);
    const settings = cache.settings('vaultback.example.com:443', root) as any;
    const exactPaths = settings.assets.map((asset: { path: string }) => JSON.stringify(asset.path));
    expect(settings.cloudflareManaged).toBe(false);
    expect(settings.rules[0].expression).toContain('http.host eq "vaultback.example.com"');
    expect(settings.rules[0].expression).toContain('not (http.request.uri.path in {');
    expect(exactPaths.every((assetPath: string) => settings.rules[1].expression.includes(assetPath))).toBe(true);
    expect(settings.rules[1].settings.edgeTtl).toBe('Use Cache-Control header if present');
    expect(noStoreHeaders()['Cache-Control']).toBe('no-store, max-age=0');
    expect(versionedAssetHeaders({ enabled: false, browserMaxAgeSeconds: 3600, edgeMaxAgeSeconds: 3600 })['Cloudflare-CDN-Cache-Control']).toBe('no-store');
    expect(versionedAssetHeaders({ enabled: true, browserMaxAgeSeconds: 60, edgeMaxAgeSeconds: 3600 })['Cache-Control']).toContain('max-age=60');
    expect(versionedAssetHeaders({ enabled: true, browserMaxAgeSeconds: 60, edgeMaxAgeSeconds: 3600 })['Cloudflare-CDN-Cache-Control']).toContain('max-age=3600');
  });

  it('uses a safe placeholder when a request host cannot be used in a rule', () => {
    const settings = new AssetCacheService(store).settings('bad host"; true', root) as any;
    expect(settings.rules[0].expression).toContain('your-vaultback-hostname.example');
    expect(settings.rules[0].expression).not.toContain('bad host');
  });
});
