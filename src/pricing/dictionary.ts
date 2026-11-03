import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PricingMemory, memoryGetInput, memoryUpdateInput } from './memory.js';
import { createPricingStore, type PricingStore } from './store.js';

/** Private advisory context shares the same authentication and storage boundary as pricing. */
export class PricingDictionaryService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {}
  async memory() {
    await this.client.verifyKnowledgeAccess();
    return new PricingMemory(this.storeFactory(this.client.knowledgeFingerprint(), this.root));
  }
  async get(input: z.input<typeof memoryGetInput> = {}) {
    await this.client.verifyKnowledgeAccess();
    const store = this.storeFactory(this.client.knowledgeFingerprint(), this.root);
    return { ...await new PricingMemory(store).get(input), storage_scope: store.scope ?? null, storage_backend: store.kind };
  }
  async update(input: z.input<typeof memoryUpdateInput>) {
    return (await this.memory()).update(input);
  }
}
