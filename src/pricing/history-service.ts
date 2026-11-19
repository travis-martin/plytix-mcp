import type { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { createPricingStore, type PricingStore } from './store.js';
import { getVersionHistory, historyGetInput } from './version-history.js';

export class PricingHistoryService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {}
  async get(input: z.input<typeof historyGetInput>) {
    await this.client.verifyKnowledgeAccess();
    const store = this.storeFactory(this.client.knowledgeFingerprint(), this.root);
    return { ...await getVersionHistory(store, input), storage_scope: store.scope ?? null, storage_backend: store.kind };
  }
}
