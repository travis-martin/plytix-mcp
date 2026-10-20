import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { knowledgeDocument, type KnowledgeDocument } from './model.js';

const MAX_BYTES = 8 * 1024 * 1024;
export interface KnowledgeStore {
  read(): Promise<KnowledgeDocument>;
  update(change: (document: KnowledgeDocument) => void): Promise<KnowledgeDocument>;
}

export async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > MAX_BYTES) throw new Error('Knowledge file exceeds size limit');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_BYTES) throw new Error('Knowledge file exceeds size limit');
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { await file.close(); }
}

/** Single-volume storage: exclusive writer lock, validated snapshot, atomic rename.
 * Never steal a lock: an interrupted writer requires an operator to inspect it.
 */
export async function updateJsonFile<T>(
  path: string, load: () => Promise<T>, change: (value: T) => T,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  if (!lock) throw new Error('Knowledge store is busy; retry or ask the operator to inspect the lock');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const value = change(await load());
    const text = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Knowledge store exceeds size limit');
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return value;
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export class FileKnowledgeStore implements KnowledgeStore {
  readonly path: string;
  constructor(root: string, private readonly scopeId: string) {
    // Scope IDs never become paths, including IDs containing slashes or "..".
    this.path = join(resolve(root), `${createHash('sha256').update(scopeId).digest('hex')}.json`);
  }
  async read(): Promise<KnowledgeDocument> {
    try {
      const value = knowledgeDocument.parse(await readBoundedJson(this.path));
      if (value.scope_id !== this.scopeId) throw new Error('Knowledge workspace mismatch');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, scope_id: this.scopeId, revision: 0, definitions: [], observations: [] };
      }
      throw new Error('Knowledge store could not be read or validated');
    }
  }
  update(change: (document: KnowledgeDocument) => void): Promise<KnowledgeDocument> {
    return updateJsonFile(this.path, () => this.read(), document => {
      change(document);
      document.revision++;
      if (document.scope_id !== this.scopeId) throw new Error('Knowledge workspace mismatch');
      return knowledgeDocument.parse(document);
    });
  }
}
