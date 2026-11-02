import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.service';

export type AssetCacheConfig = {
  enabled: boolean;
  browserMaxAgeSeconds: number;
  edgeMaxAgeSeconds: number;
};

export type VersionedAsset = {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  content: Buffer;
};

export const DEFAULT_ASSET_CACHE_CONFIG: AssetCacheConfig = {
  enabled: true,
  browserMaxAgeSeconds: 31536000,
  edgeMaxAgeSeconds: 31536000
};

const ASSET_CACHE_SETTING_KEY = 'asset_cache_settings';
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 31536000;
const NO_STORE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Cloudflare-CDN-Cache-Control': 'no-store',
  'Surrogate-Control': 'no-store'
});

function validTtl(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_TTL_SECONDS && Number(value) <= MAX_TTL_SECONDS;
export function normalizeAssetCacheConfig(value: unknown): AssetCacheConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Cache settings must be an object');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean' || !validTtl(candidate.browserMaxAgeSeconds) || !validTtl(candidate.edgeMaxAgeSeconds)) {
    throw new BadRequestException(`Cache settings require a boolean enabled value and TTL values between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS} seconds`);
  }
  return {
    enabled: candidate.enabled,
    browserMaxAgeSeconds: Number(candidate.browserMaxAgeSeconds),
    edgeMaxAgeSeconds: Number(candidate.edgeMaxAgeSeconds)
  };
}

export function buildVersionedAssetManifest(publicRoot: string): VersionedAsset[] {
  const root = path.resolve(publicRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  return entries.map(entry => {
    const content = fs.readFileSync(path.join(root, entry.name));
    const sha256 = createHash('sha256').update(content).digest('hex');
    return { name: entry.name, path: `/_assets/${sha256}/${entry.name}`, sha256, bytes: content.byteLength, content };
  });
}

export function rewriteVersionedAssetReferences(html: string, manifest: VersionedAsset[]): string {
  const versionedPaths = new Map(manifest.map(asset => [`/${asset.name}`, asset.path]));
  return html.replace(/((?:src|href)\s*=\s*)(["'])(\/[^"']+)\2/gi, (whole, prefix: string, quote: string, url: string) => {
    const versioned = versionedPaths.get(url.split(/[?#]/, 1)[0]);
    return versioned ? `${prefix}${quote}${versioned}${quote}` : whole;
  });
}

export function noStoreHeaders(): Readonly<Record<string, string>> {
  return NO_STORE_HEADERS;
}

export function versionedAssetHeaders(config: AssetCacheConfig): Record<string, string> {
  if (!config.enabled) return { ...NO_STORE_HEADERS };
  return {
    'Cache-Control': `public, max-age=${config.browserMaxAgeSeconds}, immutable`,
    'CDN-Cache-Control': `public, max-age=${config.edgeMaxAgeSeconds}`,
    'Cloudflare-CDN-Cache-Control': `public, max-age=${config.edgeMaxAgeSeconds}`,
    'Surrogate-Control': `max-age=${config.edgeMaxAgeSeconds}`
  };
}

function cloudflareHostname(host: unknown): string {
  try {
    const hostname = new URL(`http://${String(host || '')}`).hostname.toLowerCase().replace(/\.$/, '');
    if (hostname.length > 253 || !/^[a-z0-9.-]+$/.test(hostname) || hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) throw new Error('Invalid hostname');
    return hostname;
  } catch {
    return 'your-vaultback-hostname.example';
  }
}

@Injectable()
export class AssetCacheService {
  constructor(private readonly store: DatabaseService) {}

  getConfig(): AssetCacheConfig {
    const row = this.store.db.prepare('SELECT value FROM app_settings WHERE key=?').get(ASSET_CACHE_SETTING_KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULT_ASSET_CACHE_CONFIG };
    try {
      return normalizeAssetCacheConfig(JSON.parse(row.value));
    } catch {
      return { ...DEFAULT_ASSET_CACHE_CONFIG };
    }
  }

  saveConfig(input: unknown): AssetCacheConfig {
    const config = normalizeAssetCacheConfig(input);
    this.store.db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(ASSET_CACHE_SETTING_KEY, JSON.stringify(config));
    return config;
  }

  settings(host: unknown, publicRoot: string): Record<string, unknown> {
    const config = this.getConfig();
    const assets = buildVersionedAssetManifest(publicRoot).map(({ name, path: assetPath, sha256, bytes }) => ({ name, path: assetPath, sha256, bytes }));
    const assetSet = assets.length
      ? `http.request.uri.path in {${assets.map(asset => JSON.stringify(asset.path)).join(' ')}}`
      : 'http.request.uri.path eq "/_assets/no-current-assets"';
    const hostExpression = `http.host eq ${JSON.stringify(cloudflareHostname(host))}`;
    const rules = [
      {
        name: 'Bypass all VaultBack traffic except current versioned assets',
        expression: `(${hostExpression} and not (${assetSet}))`,
        action: 'Bypass cache',
        settings: { cacheEligibility: 'Bypass cache' }
      },
      {
        name: 'Cache only current versioned VaultBack assets',
        expression: `(${hostExpression} and ${assetSet})`,
        action: 'Eligible for cache',
        settings: {
          cacheEligibility: 'Eligible for cache',
          browserTtl: 'Respect origin Cache-Control',
          edgeTtl: 'Use Cache-Control header if present'
        }
      }
    ];
    return {
      config,
      assetPrefix: '/_assets/',
      assets,
      rules,
      instructions: [
        'Create both rules for the VaultBack hostname shown in the expressions. Put the bypass rule first and the versioned-asset rule second.',
        'Paste each generated match expression into Cloudflare’s Expression Editor; these expressions use grouped conditions and the in operator.',
        'Use the rule settings shown, with browser and edge TTLs respecting the origin Cache-Control headers.',
        'Refresh or replace the versioned-asset rule after each VaultBack release because content hashes change.',
        'VaultBack only sends immutable cache headers for exact, existing versioned JavaScript and CSS assets. HTML, APIs, authentication, SSE, downloads, exports, unversioned assets, and unknown hashes are no-store.',
        'Rules are copyable guidance only. VaultBack does not connect to or change your Cloudflare zone.'
      ],
      cloudflareManaged: false
    };
  }
}
