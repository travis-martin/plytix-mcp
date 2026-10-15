/**
 * Enhanced Plytix API Client
 *
 * Features:
 * - Automatic token refresh with 60s safety margin
 * - Rate limit detection and backoff
 * - Configurable timeouts with AbortController
 * - Retry on 401/429
 * - Helper methods for common operations
 */

import { isReadRequest } from './policy.js';
import type {
  PlytixAuthToken,
  PlytixAuthResponse,
  PlytixClientConfig,
  PlytixResult,
  PlytixSearchBody,
  PlytixProduct,
  PlytixAsset,
  PlytixCategory,
  PlytixFamily,
  PlytixFamilyAttribute,
  PlytixFilterDefinition,
  PlytixAttributeDetail,
  PlytixRelationshipDefinition,
  RateLimitInfo,
} from './types.js';
import { PlytixError } from './types.js';

const DEFAULT_CONFIG = {
  baseUrl: 'https://pim.plytix.com',
  authUrl: 'https://auth.plytix.com/auth/api/get-token',
  timeoutMs: 15000,
};

export class PlytixClient {
  private token?: PlytixAuthToken;
  private tokenRequest?: Promise<string>;
  private operationDeadline = Date.now() + 45_000;
  private requestCount = 0;
  private cancelled = false;
  private readonly controllers = new Set<AbortController>();
  private attributeCacheRequest?: Promise<Map<string, PlytixAttributeDetail>>;

  private activeOperation?: Promise<unknown>;
  runOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeOperation) return Promise.reject(new PlytixError('Another tool operation is in progress'));
    this.operationDeadline = Date.now() + 45_000;
    this.requestCount = 0;
    const pending = Promise.resolve().then(work).finally(() => { this.activeOperation = undefined; });
    this.activeOperation = pending;
    return pending;
  }
  async waitForIdle(): Promise<void> {
    try { await this.activeOperation; } catch { /* The tool reports its own sanitized failure. */ }
  }

  cancel(): void {
    this.cancelled = true;
    for (const controller of this.controllers) controller.abort();
  }

  private requestTimeout(): number {
    if (this.cancelled || Date.now() >= this.operationDeadline) throw new PlytixError('Plytix operation cancelled or exceeded its 45 second budget');
    if (++this.requestCount > 512) throw new PlytixError('Plytix operation exceeded its 512 request budget');
    return Math.min(this.config.timeoutMs, this.operationDeadline - Date.now());
  }
  private config: Required<PlytixClientConfig>;
  private attributeCache?: { byLabel: Map<string, PlytixAttributeDetail>; expires: number };

  constructor(config?: Partial<PlytixClientConfig>) {
    this.config = {
      apiKey: config?.apiKey ?? process.env.PLYTIX_API_KEY ?? '',
      apiPassword: config?.apiPassword ?? process.env.PLYTIX_API_PASSWORD ?? '',
      baseUrl: config?.baseUrl ?? process.env.PLYTIX_API_BASE ?? DEFAULT_CONFIG.baseUrl,
      authUrl: config?.authUrl ?? process.env.PLYTIX_AUTH_URL ?? DEFAULT_CONFIG.authUrl,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      allowWrites: config?.allowWrites ?? false,
    };

    for (const value of [this.config.baseUrl, this.config.authUrl]) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
        throw new Error('Plytix endpoints must be HTTPS URLs without embedded credentials');
      }
    }
    if (!Number.isFinite(this.config.timeoutMs) || this.config.timeoutMs < 1 || this.config.timeoutMs > 30_000) {
      throw new Error('Invalid Plytix request timeout');
    }
    if (!this.config.apiKey || !this.config.apiPassword) {
      throw new Error('Missing PLYTIX_API_KEY or PLYTIX_API_PASSWORD');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────

  private async readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new PlytixError('Empty upstream response');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new PlytixError('Upstream response exceeds size limit');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.authenticate();
    try { return await this.tokenRequest; }
    finally { this.tokenRequest = undefined; }
  }

  private async authenticate(): Promise<string> {
    const timeoutMs = this.requestTimeout();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.authUrl, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.config.apiKey, api_password: this.config.apiPassword }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new PlytixError(`Plytix authentication failed (HTTP ${response.status})`, response.status);
      }
      const result = await this.readJson(response) as PlytixResult<PlytixAuthResponse>;
      const data = result.data?.[0];
      if (!data?.access_token || typeof data.access_token !== 'string') throw new PlytixError('Invalid authentication response');
      const ttl = Number(data.expires_in ?? 900);
      if (!Number.isFinite(ttl) || ttl <= 0) throw new PlytixError('Invalid authentication expiry');
      this.token = { value: data.access_token, exp: Date.now() + Math.min(ttl, 900) * 1000 };
      return this.token.value;
    } catch (error) {
      if (error instanceof PlytixError) throw error;
      throw new PlytixError('Plytix authentication failed');
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }

  private retryDelay(headers: Headers): number | undefined {
    const raw = headers.get('retry-after');
    let delay = 1000;
    if (raw !== null) {
      delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now();
    } else if (headers.has('x-ratelimit-reset')) {
      delay = Number(headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    }
    if (!Number.isFinite(delay) || delay > 2000) return undefined;
    return Math.max(100, delay);
  }

  private async request<T = unknown>(
    endpoint: string, options: RequestInit = {}, retries = 1,
  ): Promise<PlytixResult<T>> {
    const method = (options.method ?? 'GET').toUpperCase();
    if (!/^\/api\/v[12]\//.test(endpoint) || /[?#\\]/.test(endpoint) || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(endpoint)) {
      throw new PlytixError('Invalid API path');
    }
    const readOnly = isReadRequest(endpoint, method);
    if (!readOnly && !this.config.allowWrites) throw new PlytixError('Writes are disabled');
    const token = await this.getToken();
    const timeoutMs = this.requestTimeout();
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}${endpoint}`.replace(/\/+$/, '');
    try {
      const response = await fetch(url, {
        ...options, method, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      // Only reads can be retried. A failed/ambiguous write requires user inspection.
      if (readOnly && retries > 0 && (response.status === 401 || response.status === 429)) {
        const delay = response.status === 429 ? this.retryDelay(response.headers) : 0;
        if (delay !== undefined) {
          await response.body?.cancel();
          clearTimeout(timeout);
          if (response.status === 401) this.token = undefined;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          return this.request<T>(endpoint, options, retries - 1);
        }
      }
      if (response.status === 204) return { data: [] } as PlytixResult<T>;
      if (!response.ok) {
        await response.body?.cancel();
        throw new PlytixError(`Plytix request failed (HTTP ${response.status})`, response.status);
      }
      return await this.readJson(response) as PlytixResult<T>;
    } catch (error) {
      if (error instanceof PlytixError) throw error;
      throw new PlytixError('Plytix request failed or timed out');
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }

  // ─────────────────────────────────────────────────────────────
  // Products (v2 API)
  // ─────────────────────────────────────────────────────────────

  async searchProducts(body: PlytixSearchBody): Promise<PlytixResult<PlytixProduct>> {
    // v2 allows up to 50 attributes
    if (body.attributes && body.attributes.length > 50) {
      console.warn(`Plytix v2 search limited to 50 attributes, got ${body.attributes.length}`);
      body = { ...body, attributes: body.attributes.slice(0, 50) };
    }

    return this.request<PlytixProduct>('/api/v2/products/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getProduct(id: string): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(id)}`);
  }

  async getProductAssets(productId: string): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>(`/api/v2/products/${encodeURIComponent(productId)}/assets`);
  }

  async getProductCategories(productId: string): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories`
    );
  }

  async getProductVariants(productId: string): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(productId)}/variants`);
  }

  // ─────────────────────────────────────────────────────────────
  // Families (v1 API)
  // ─────────────────────────────────────────────────────────────

  async searchFamilies(body?: PlytixSearchBody): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getFamily(familyId: string): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}`
    );
  }

  async createFamily(data: {
    name: string;
    parent_id?: string;
  }): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async linkFamilyAttributes(
    familyId: string,
    attributeLabels: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/link`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeLabels }),
      }
    );
  }

  async unlinkFamilyAttributes(
    familyId: string,
    attributeLabels: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/unlink`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeLabels }),
      }
    );
  }

  async getFamilyAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
    return this.request<PlytixFamilyAttribute>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes`
    );
  }

  async getFamilyAllAttributes(familyId: string): Promise<PlytixResult<PlytixFamilyAttribute>> {
    return this.request<PlytixFamilyAttribute>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/all_attributes`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Attributes & Filters
  // ─────────────────────────────────────────────────────────────

  async getAvailableFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/product');
  }

  async getAssetFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/asset');
  }

  async getRelationshipFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.request<PlytixFilterDefinition>('/api/v1/filters/relationships');
  }

  /**
   * Get all product attributes organized by type
   */
  async getProductAttributes(): Promise<{ system: string[]; custom: PlytixFilterDefinition[] }> {
    const filtersResult = await this.getAvailableFilters();
    const system: string[] = [];
    const custom: PlytixFilterDefinition[] = [];
    for (const filter of filtersResult.data ?? []) {
      const field = filter.key ?? filter.field;
      if (field) {
        if (field.startsWith('attributes.')) custom.push(filter);
        else system.push(field);
      }
    }
    return { system, custom };
  }

  /**
   * Search for attribute IDs. Returns minimal data (id + filter_type).
   * Use getAttribute() to get full details including options.
   */
  async searchAttributeIds(pageSize = 100): Promise<string[]> {
    const attrIds: string[] = [];
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new PlytixError('Invalid attribute page size');
    let page = 1;

    while (page <= 5) {
      const result = await this.request<{ id: string; filter_type?: string }>(
        '/api/v1/attributes/product/search',
        {
          method: 'POST',
          body: JSON.stringify({
            pagination: { page, page_size: pageSize },
          }),
        }
      );

      if (!result.data || result.data.length === 0) break;
      attrIds.push(...result.data.map((a) => a.id));
      if (result.data.length < pageSize) break;
      if (page === 5) throw new PlytixError('Attribute discovery exceeds the five-page limit');
      page++;
    }

    return attrIds;
  }

  /**
   * Get full attribute details by ID.
   * Use this to get options for dropdown/multiselect attributes.
   */
  async getAttributeById(attrId: string): Promise<PlytixAttributeDetail | null> {
    const result = await this.request<PlytixAttributeDetail>(
      `/api/v1/attributes/product/${encodeURIComponent(attrId)}`
    );
    return result.data?.[0] ?? null;
  }

  /**
   * Build attribute cache indexed by label. Fetches all attributes once,
   * then caches for 5 minutes to avoid N+1 queries on repeated lookups.
   */
  private async buildAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    const now = Date.now();
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

    // Return cached if still valid
    if (this.attributeCache && now < this.attributeCache.expires) {
      return this.attributeCache.byLabel;
    }

    if (this.attributeCacheRequest) return this.attributeCacheRequest;
    this.attributeCacheRequest = this.fetchAttributeCache();
    try { return await this.attributeCacheRequest; }
    finally { this.attributeCacheRequest = undefined; }
  }

  private async fetchAttributeCache(): Promise<Map<string, PlytixAttributeDetail>> {
    const attrIds = await this.searchAttributeIds();
    const byLabel = new Map<string, PlytixAttributeDetail>();
    // Bound fan-out; fail discovery rather than caching incomplete/unauthorized schema.
    for (let i = 0; i < attrIds.length; i += 4) {
      const results = await Promise.allSettled(attrIds.slice(i, i + 4).map(id => this.getAttributeById(id)));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        if (result.value?.label) byLabel.set(result.value.label, result.value);
      }
    }
    this.attributeCache = { byLabel, expires: Date.now() + 5 * 60 * 1000 };
    return byLabel;
  }

  /**
   * Get full attribute details by label (snake_case identifier like "head_material").
   * Uses cached attribute lookup to avoid N+1 queries.
   */
  async getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null> {
    const cache = await this.buildAttributeCache();
    return cache.get(label) ?? null;
  }

  /**
   * Get options for a dropdown/multiselect attribute by label.
   * Returns null if attribute not found, empty array if attribute exists but has no options.
   */
  async getAttributeOptions(label: string): Promise<string[] | null> {
    const attr = await this.getAttributeByLabel(label);
    if (!attr) return null;
    return attr.options ?? [];
  }

  // ─────────────────────────────────────────────────────────────
  // Assets (v1 API for account-level asset discovery and metadata)
  // ─────────────────────────────────────────────────────────────

  async searchAssets(body?: PlytixSearchBody): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>('/api/v1/assets/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getAsset(assetId: string): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`);
  }

  async updateAsset(
    assetId: string,
    data: { filename?: string; categories?: string[] }
  ): Promise<PlytixResult<PlytixAsset>> {
    const body: {
      filename?: string;
      categories?: Array<{ id: string }>;
    } = {};

    if (data.filename !== undefined) {
      body.filename = data.filename;
    }

    if (data.categories !== undefined) {
      body.categories = data.categories.map((id) => ({ id }));
    }

    return this.request<PlytixAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  // ─────────────────────────────────────────────────────────────
  // Products - Write Operations (v2 API)
  // ─────────────────────────────────────────────────────────────

  /**
   * Create a new product. Only `sku` is mandatory.
   * Cannot create new attributes, categories, or assets - must link existing ones.
   */
  async createProduct(data: {
    sku: string;
    label?: string;
    status?: string;
    attributes?: Record<string, unknown>;
    categories?: Array<{ id: string }>;
    assets?: Array<{ id: string }>;
  }): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>('/api/v2/products', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Update a product's attributes. Partial update - only specified fields are changed.
   * Set an attribute to null to clear it.
   */
  async updateProduct(
    productId: string,
    data: {
      label?: string;
      status?: string;
      attributes?: Record<string, unknown>;
    }
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(`/api/v2/products/${encodeURIComponent(productId)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  /**
   * Link an existing asset to a product.
   * Optionally attach it to a media attribute label.
   */
  async linkProductAsset(
    productId: string,
    assetId: string,
    attributeLabel?: string
  ): Promise<PlytixResult<PlytixAsset>> {
    const body: { id: string; attribute_label?: string } = { id: assetId };
    if (attributeLabel !== undefined) {
      body.attribute_label = attributeLabel;
    }

    return this.request<PlytixAsset>(`/api/v2/products/${encodeURIComponent(productId)}/assets`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Unlink an asset from a product. Asset is not deleted from the account.
   */
  async unlinkProductAsset(
    productId: string,
    assetId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/assets/${encodeURIComponent(assetId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Assign or unassign a family to a product.
   * Pass empty string to unassign.
   * Warning: Changing family may cause data loss. Cannot assign to variant products.
   */
  async assignProductFamily(
    productId: string,
    familyId: string
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/family`,
      {
        method: 'POST',
        body: JSON.stringify({ product_family_id: familyId }),
      }
    );
  }

  /**
   * Link an existing category to a product.
   */
  async linkProductCategory(
    productId: string,
    categoryId: string
  ): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories`,
      {
        method: 'POST',
        body: JSON.stringify({ id: categoryId }),
      }
    );
  }

  /**
   * Unlink a category from a product. Category is not deleted.
   */
  async unlinkProductCategory(
    productId: string,
    categoryId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/categories/${encodeURIComponent(categoryId)}`,
      { method: 'DELETE' }
    );
  }

  async searchCategories(body?: PlytixSearchBody): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>('/api/v1/categories/product/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  async getRelationship(
    relationshipId: string
  ): Promise<PlytixResult<PlytixRelationshipDefinition>> {
    return this.request<PlytixRelationshipDefinition>(
      `/api/v1/relationships/${encodeURIComponent(relationshipId)}`
    );
  }

  async searchRelationships(
    body?: PlytixSearchBody
  ): Promise<PlytixResult<PlytixRelationshipDefinition>> {
    return this.request<PlytixRelationshipDefinition>('/api/v1/relationships/search', {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Add related products to a relationship for a product.
   */
  async linkProductRelationship(
    productId: string,
    relationshipId: string,
    productRelationships: Array<{ product_id: string; quantity?: number }>
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          product_relationships: productRelationships,
        }),
      }
    );
  }

  /**
   * Remove related products from a relationship for a product.
   */
  async unlinkProductRelationship(
    productId: string,
    relationshipId: string,
    relatedProductIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'DELETE',
        body: JSON.stringify({
          product_relationships: relatedProductIds,
        }),
      }
    );
  }

  /**
   * Update relationship attributes for related products (e.g., quantity).
   */
  async updateProductRelationship(
    productId: string,
    relationshipId: string,
    productRelationships: Array<{ product_id: string; quantity?: number }>
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(productId)}/relationships/${encodeURIComponent(relationshipId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          product_relationships: productRelationships,
        }),
      }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Variants
  // ─────────────────────────────────────────────────────────────

  async createVariant(
    parentProductId: string,
    data: { sku: string; label?: string; attributes?: Record<string, unknown> }
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variants`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
  }

  async linkVariant(
    parentProductId: string,
    variantProductId: string
  ): Promise<PlytixResult<PlytixProduct>> {
    return this.request<PlytixProduct>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
      { method: 'POST' }
    );
  }

  async unlinkVariant(
    parentProductId: string,
    variantProductId: string
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variant/${encodeURIComponent(variantProductId)}`,
      { method: 'DELETE' }
    );
  }

  /**
   * Resync variant attributes to inherit values from the parent product.
   * Restores overwritten attributes on specified variants to use the parent's value instead.
   *
   * @param parentProductId - The parent product ID containing the variants
   * @param attributeLabels - List of attribute labels to reset (must be attributes at parent level)
   * @param variantIds - List of variant product IDs to resync (must be variants of the specified parent)
   */
  async resyncVariants(
    parentProductId: string,
    attributeLabels: string[],
    variantIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v2/products/${encodeURIComponent(parentProductId)}/variants/resync`,
      {
        method: 'POST',
        body: JSON.stringify({
          attribute_labels: attributeLabels,
          variant_ids: variantIds,
        }),
      }
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Generic Request (for custom endpoints)
  // ─────────────────────────────────────────────────────────────

  /**
   * Make a generic API request. Use for endpoints not covered by helper methods.
   */
  async call<T = unknown>(path: string, init: RequestInit = {}): Promise<PlytixResult<T>> {
    return this.request<T>(path, init);
  }
}
