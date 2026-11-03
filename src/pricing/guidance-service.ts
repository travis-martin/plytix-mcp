import { z } from 'zod';
import type { PlytixClient } from '../client.js';
import { PricingGuidance, guidanceGetInput, guidanceSaveInput } from './guidance.js';
import { createPricingStore, type PricingStore } from './store.js';

export class PricingGuidanceService {
  constructor(private client: PlytixClient, private root = process.env.PLYTIX_PRICING_DIR,
    private storeFactory: (fingerprint: string, root?: string) => PricingStore = createPricingStore) {}
  private async directory() {
    await this.client.verifyKnowledgeAccess();
    return this.storeFactory(this.client.knowledgeFingerprint(), this.root);
  }
  async get(input: z.input<typeof guidanceGetInput> = {}) {
    const store = await this.directory();
    return { ...await new PricingGuidance(store).get(input), storage_scope: store.scope ?? null, storage_backend: store.kind };
  }
  async save(input: z.input<typeof guidanceSaveInput>) {
    const store = await this.directory();
    return { ...await new PricingGuidance(store).save(input), storage_scope: store.scope ?? null, storage_backend: store.kind };
  }
}
