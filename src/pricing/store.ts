import { join, resolve } from 'node:path';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Storage, type Bucket } from '@google-cloud/storage';
import { readBoundedJson, updateJsonFile } from '../knowledge/store.js';
import { PlytixError } from '../types.js';
import { isSharedPricingFile, pricingScopeStatus, resolvePricingScope, type PricingScopeStatus } from './scope.js';
import { retainVersionHistory, sameRevisionArchive, type RevisionArchive } from './version-history.js';

const MAX_BYTES = 8 * 1024 * 1024;
const keyPattern = /^(?:rules|dictionary|workflow|rules-revision-\d+|history-(?:workflow|dictionary|rules)-[a-f0-9]{64}|[a-f0-9-]{36})\.json$/;
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
  readonly scope?: PricingScopeStatus;
  read(key: string): Promise<unknown | undefined>;
  create(key: string, value: unknown): Promise<void>;
  /** Change callbacks must be synchronous and side-effect free: CAS may retry. */
  update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T>;
}

/** Share only reusable organization guidance. UUID source/run documents and their
 * execution reservations never move into a shared workspace automatically. */
export class ScopedPricingStore implements PricingStore {
  readonly kind: 'file' | 'gcs';
  constructor(private shared: PricingStore, private personal: PricingStore, readonly scope: PricingScopeStatus) {
    if (shared.kind !== personal.kind) throw new PlytixError('Pricing workspace and private records must use the same backend');
    this.kind = shared.kind;
  }
  private target(key: string) {
    checkKey(key);
    return isSharedPricingFile(key) ? this.shared : this.personal;
  }
  read(key: string) { return this.target(key).read(key); }
  create(key: string, value: unknown) { return this.target(key).create(key, value); }
  update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T) {
    return this.target(key).update(key, parse, change);
  }
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
  private async archive(key: string, value: RevisionArchive) {
    checkKey(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${key}.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(encode(value)); await file.sync(); } finally { await file.close(); }
      // Publish the fully flushed inode without replacing an existing archive.
      // A process interruption can leave a temporary file, never a partial head.
      try { await link(temporary, join(this.directory, key)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!sameRevisionArchive(await this.read(key), value)) throw new PlytixError('Immutable version history conflict');
      }
    } finally { await unlink(temporary); }
  }
  update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T> {
    checkKey(key);
    if (key.startsWith('history-')) throw new PlytixError('Version history archives are immutable');
    return updateJsonFile<unknown>(join(this.directory, key), () => this.read(key), async raw => {
      const value = change(parse(structuredClone(raw))); encode(value);
      return retainVersionHistory(key, raw, value, { read: id => this.read(id), create: (id, archive) => this.archive(id, archive) });
    }) as Promise<T>;
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
    if (/^(workflow|dictionary|rules)\.json$/.test(key)) {
      await this.update(key, value => value, current => {
        if (current !== undefined) throw new PlytixError('Pricing document already exists');
        return value;
      });
      return;
    }
    try { await this.backend.write(this.path(key), encode(value), 0); }
    catch (error) {
      if (error instanceof PricingStoreConflict) throw new PlytixError('Pricing document already exists');
      throw error;
    }
  }
  private async archive(key: string, value: RevisionArchive) {
    try { await this.backend.write(this.path(key), encode(value), 0); }
    catch (error) {
      if (!(error instanceof PricingStoreConflict)) throw error;
      if (!sameRevisionArchive(await this.read(key), value)) throw new PlytixError('Immutable version history conflict');
    }
  }
  async update<T>(key: string, parse: (value: unknown | undefined) => T, change: (value: T) => T): Promise<T> {
    const path = this.path(key);
    if (key.startsWith('history-')) throw new PlytixError('Version history archives are immutable');
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.backend.read(path);
      const raw = this.decode(previous);
      const next = change(parse(structuredClone(raw)));
      const value = await retainVersionHistory(key, raw, next, { read: id => this.read(id), create: (id, archive) => this.archive(id, archive) });
      const bytes = encode(value);
      // Repeated dictionary observations do not need another object generation.
      if (previous?.bytes.equals(bytes)) return value;
      try { await this.backend.write(path, bytes, previous?.generation ?? 0); return value; }
      catch (error) { if (!(error instanceof PricingStoreConflict)) throw error; }
    }
    throw new PlytixError('Cloud pricing file is busy; review current state before retrying');
  }
}

export function createPricingStore(fingerprint: string, localRoot?: string): PricingStore {
  const scope = resolvePricingScope(fingerprint);
  const bucket = process.env.PLYTIX_PRICING_GCS_BUCKET;
  let makeStore: (namespace: string) => PricingStore;
  if (bucket) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new PlytixError('Invalid cloud pricing bucket configuration');
    const backend = new GooglePricingObjects(bucket);
    makeStore = namespace => new GcsPricingStore(backend, namespace);
  } else if (localRoot) makeStore = namespace => new FilePricingStore(join(resolve(localRoot), namespace));
  else throw new PlytixError('Pricing storage is not configured; set PLYTIX_PRICING_DIR or PLYTIX_PRICING_GCS_BUCKET');
  const privateStore = makeStore(scope.private_namespace);
  const sharedStore = scope.shared_namespace === scope.private_namespace ? privateStore : makeStore(scope.shared_namespace);
  return new ScopedPricingStore(sharedStore, privateStore, pricingScopeStatus(scope));
}
