import { join, resolve } from 'node:path';
import { Storage, type Bucket } from '@google-cloud/storage';
import { readBoundedJson, updateJsonFile } from '../knowledge/store.js';
import { PlytixError } from '../types.js';

const MAX_BYTES = 8 * 1024 * 1024;
const keyPattern = /^(?:rules|rules-revision-\d+|[a-f0-9-]{36})\.json$/;
function checkKey(key: string) {
  if (!keyPattern.test(key)) throw new PlytixError('Invalid pricing storage key');
}
function encode(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  if (bytes.length > MAX_BYTES) throw new PlytixError('Pricing file exceeds size limit');
  return bytes;
}
export interface PricingStore {
  readonly kind: 'file' | 'gcs';
  read(key: string): Promise<unknown | undefined>;
  create(key: string, value: unknown): Promise<void>;
  /** Change callbacks must be synchronous and side-effect free: CAS may retry. */
  update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T>;
}
export class FilePricingStore implements PricingStore {
  readonly kind = 'file';
  constructor(private directory: string) {}
  async read(key: string) {
    checkKey(key);
    try { return await readBoundedJson(join(this.directory, key)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new PlytixError('Pricing file could not be read');
    }
  }
  async create(key: string, value: unknown) {
    checkKey(key); encode(value);
    await this.update(key, current => current, current => {
      if (current !== undefined) throw new PlytixError('Pricing document already exists');
      return value;
    });
  }
  update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    checkKey(key);
    return updateJsonFile(join(this.directory, key), async () => parse(await this.read(key)), current => {
      const value = change(current); encode(value); return value;
    });
  }
}

export interface VersionedObject { generation: string; bytes: Buffer }
/** Narrow adapter seam for deterministic race tests without cloud credentials. */
export interface PricingObjectBackend {
  read(key: string): Promise<VersionedObject | undefined>;
  write(key: string, bytes: Buffer, expectedGeneration: string | 0): Promise<void>;
}
export class PricingStoreConflict extends Error {}

export class GooglePricingObjects implements PricingObjectBackend {
  private bucket: Bucket;
  constructor(bucket: string, storage = new Storage({ retryOptions: { autoRetry: false, maxRetries: 0 } })) {
    this.bucket = storage.bucket(bucket);
  }
  async read(key: string): Promise<VersionedObject | undefined> {
    // Pin the download to the metadata generation so body and CAS token cannot diverge.
    for (let attempt = 0; attempt < 3; attempt++) {
      let metadata;
      try { [metadata] = await this.bucket.file(key).getMetadata(); }
      catch (error) {
        if (Number((error as { code?: unknown }).code) === 404) return undefined;
        throw new PlytixError('Cloud pricing storage is unavailable');
      }
      const generation = String(metadata.generation ?? '');
      if (!/^\d+$/.test(generation) || Number(metadata.size) > MAX_BYTES) throw new PlytixError('Cloud pricing object metadata is invalid or oversized');
      const stream = this.bucket.file(key, { generation }).createReadStream();
      const chunks: Buffer[] = []; let bytes = 0;
      const timeout = setTimeout(() => stream.destroy(new Error('Storage deadline exceeded')), 15_000);
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > MAX_BYTES) { stream.destroy(); throw new PlytixError('Cloud pricing file exceeds size limit'); }
          chunks.push(buffer);
        }
        return { generation, bytes: Buffer.concat(chunks) };
      } catch (error) {
        if (Number((error as { code?: unknown }).code) === 404) continue;
        throw new PlytixError('Cloud pricing file could not be read');
      } finally { clearTimeout(timeout); }
    }
    throw new PlytixError('Cloud pricing file changed while reading; retry');
  }
  async write(key: string, bytes: Buffer, expectedGeneration: string | 0) {
    try {
      await this.bucket.file(key).save(bytes, {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: expectedGeneration },
        metadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
        timeout: 15_000,
      });
    } catch (error) {
      if (Number((error as { code?: unknown }).code) === 412) throw new PricingStoreConflict();
      throw new PlytixError('Cloud pricing write failed; inspect saved state before retrying');
    }
  }
}

export class GcsPricingStore implements PricingStore {
  readonly kind = 'gcs';
  constructor(private backend: PricingObjectBackend, private prefix: string) {
    if (!/^[a-f0-9]{64}$/.test(prefix)) throw new PlytixError('Invalid pricing storage scope');
  }
  private path(key: string) { checkKey(key); return `pricing/${this.prefix}/${key}`; }
  private decode(object?: VersionedObject) {
    if (!object) return undefined;
    if (object.bytes.length > MAX_BYTES) throw new PlytixError('Cloud pricing file exceeds size limit');
    try { return JSON.parse(object.bytes.toString('utf8')) as unknown; }
    catch { throw new PlytixError('Cloud pricing file is not valid JSON'); }
  }
  async read(key: string) { return this.decode(await this.backend.read(this.path(key))); }
  async create(key: string, value: unknown) {
    try { await this.backend.write(this.path(key), encode(value), 0); }
    catch (error) {
      if (error instanceof PricingStoreConflict) throw new PlytixError('Pricing document already exists');
      throw error;
    }
  }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T> {
    const path = this.path(key);
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.backend.read(path);
      const value = change(parse(this.decode(previous)));
      try { await this.backend.write(path, encode(value), previous?.generation ?? 0); return value; }
      catch (error) { if (!(error instanceof PricingStoreConflict)) throw error; }
    }
    throw new PlytixError('Cloud pricing file is busy; review current state before retrying');
  }
}

export function createPricingStore(fingerprint: string, localRoot?: string): PricingStore {
  const bucket = process.env.PLYTIX_PRICING_GCS_BUCKET;
  if (bucket) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new PlytixError('Invalid cloud pricing bucket configuration');
    return new GcsPricingStore(new GooglePricingObjects(bucket), fingerprint);
  }
  if (localRoot) return new FilePricingStore(join(resolve(localRoot), fingerprint));
  throw new PlytixError('Pricing storage is not configured; set PLYTIX_PRICING_DIR or PLYTIX_PRICING_GCS_BUCKET');
}
