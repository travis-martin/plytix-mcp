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
    return (await this.memory()).get(input);
  }
  async update(input: z.input<typeof memoryUpdateInput>) {
    return (await this.memory()).update(input);
  }
}
