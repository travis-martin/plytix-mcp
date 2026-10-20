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

import { isReadRequest, isWriteRequestForTool, WRITE_TOOLS } from './policy.js';
import { stripAttributesPrefix } from './utils/attribute-labels.js';
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
  PlytixAttributeGroup,
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
  private responseBytes = 0;
  private cancelled = false;
  private readonly controllers = new Set<AbortController>();
  private readonly attributesByLabel = new Map<string, { value: PlytixAttributeDetail; expires: number }>();

  private activeOperation?: Promise<unknown>;
  private operationSignal?: AbortSignal;
  private operationTool?: string;
  private operationReads?: Map<string, Promise<PlytixResult<unknown>>>;
  runOperation<T>(work: () => Promise<T>, signal?: AbortSignal, toolName?: string): Promise<T> {
    if (this.activeOperation) return Promise.reject(new PlytixError('Another tool operation is in progress'));
    if (signal?.aborted || this.cancelled) return Promise.reject(new PlytixError('Plytix operation cancelled'));
    this.operationDeadline = Date.now() + 45_000;
    this.requestCount = 0;
    this.responseBytes = 0;
    this.operationSignal = signal;
    this.operationTool = toolName;
    this.operationReads = new Map();
    const abort = () => { for (const controller of this.controllers) controller.abort(); };
    signal?.addEventListener('abort', abort, { once: true });
    const pending = Promise.resolve().then(work).finally(() => {
      signal?.removeEventListener('abort', abort);
      this.operationSignal = undefined;
      this.operationTool = undefined;
      this.operationReads = undefined;
      this.activeOperation = undefined;
    });
    this.activeOperation = pending;
    return pending;
  }
  async waitForIdle(): Promise<void> {
    try { await this.activeOperation; } catch { /* The tool reports its own sanitized failure. */ }
  }

  beginApprovedWrite(): void {
    if (!this.activeOperation || !this.operationTool || !this.config.writeTools.has(this.operationTool)
      || !this.config.allowWrites || this.requestCount !== 0 || this.cancelled || this.operationSignal?.aborted) {
      throw new PlytixError('Cannot begin approved write execution');
    }
    // Human review consumes its own bounded 30-second window. Start the API
    // execution budget only after approval, before authentication or any fetch.
    this.operationDeadline = Date.now() + 45_000;
  }

  cancel(): void {
    this.cancelled = true;
    for (const controller of this.controllers) controller.abort();
  }

  private assertActive(): void {
    if (this.cancelled || this.operationSignal?.aborted || Date.now() >= this.operationDeadline) throw new PlytixError('Plytix operation cancelled or exceeded its 45 second budget');
  }

  private requestTimeout(): number {
    this.assertActive();
    if (++this.requestCount > 512) throw new PlytixError('Plytix operation exceeded its 512 request budget');
    return Math.min(this.config.timeoutMs, this.operationDeadline - Date.now());
  }
  private config: Required<PlytixClientConfig>;

  constructor(config?: Partial<PlytixClientConfig>) {
    this.config = {
      apiKey: config?.apiKey ?? process.env.PLYTIX_API_KEY ?? '',
      apiPassword: config?.apiPassword ?? process.env.PLYTIX_API_PASSWORD ?? '',
      baseUrl: config?.baseUrl ?? process.env.PLYTIX_API_BASE ?? DEFAULT_CONFIG.baseUrl,
      authUrl: config?.authUrl ?? process.env.PLYTIX_AUTH_URL ?? DEFAULT_CONFIG.authUrl,
      timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
      allowWrites: config?.allowWrites ?? false,
      writeTools: new Set(config?.writeTools ?? []),
    };
    for (const name of this.config.writeTools) {
      if (!WRITE_TOOLS.has(name)) throw new Error('Unknown write tool');
    }

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

  private async readJson(response: Response, allowEmpty = false): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
      if (allowEmpty) return { data: [] };
      throw new PlytixError('Empty upstream response');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      this.responseBytes += value.byteLength;
      if (this.responseBytes > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new PlytixError('Plytix operation exceeds aggregate response size limit');
      }
      if (total > 5 * 1024 * 1024) {
        await reader.cancel();
        throw new PlytixError('Upstream response exceeds size limit');
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (allowEmpty && !text.trim()) return { data: [] };
    return JSON.parse(text);
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
    this.assertActive();
    const readOnly = isReadRequest(endpoint, (options.method ?? 'GET').toUpperCase());
    // Reuse identical reads only inside one tool invocation. Never retain product
    // values across calls, and invalidate before a mutation so readback is fresh.
    if (!readOnly) this.operationReads?.clear();
    const reads = this.operationReads;
    if (!readOnly || !reads || (options.body !== undefined && typeof options.body !== 'string')) {
      return this.requestUncached<T>(endpoint, options, retries);
    }
    const key = JSON.stringify([options.method ?? 'GET', endpoint, options.body ?? null]);
    let pending = reads.get(key) as Promise<PlytixResult<T>> | undefined;
    if (!pending) {
      pending = this.requestUncached<T>(endpoint, options, retries);
      reads.set(key, pending);
      void pending.catch(() => { if (reads.get(key) === pending) reads.delete(key); });
    }
    // Callers can format their copy without changing another consumer's response.
    const result = await pending;
    this.assertActive();
    return structuredClone(result);
  }

  private async requestUncached<T = unknown>(
    endpoint: string, options: RequestInit = {}, retries = 1,
  ): Promise<PlytixResult<T>> {
    const method = (options.method ?? 'GET').toUpperCase();
    if (!/^\/api\/v[12]\//.test(endpoint) || /[?#\\]/.test(endpoint) || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(endpoint)) {
      throw new PlytixError('Invalid API path');
    }
    const readOnly = isReadRequest(endpoint, method);
    if (!readOnly && !this.config.allowWrites) throw new PlytixError('Writes are disabled');
    if (!readOnly && (!this.operationTool || !this.config.writeTools.has(this.operationTool)
      || !isWriteRequestForTool(this.operationTool, endpoint, method))) {
      throw new PlytixError('Write is not authorized for this tool operation');
    }
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
          return this.requestUncached<T>(endpoint, options, retries - 1);
        }
      }
      if (response.status === 204) return { data: [] } as PlytixResult<T>;
      if (!response.ok) {
        await response.body?.cancel();
        throw new PlytixError(`Plytix request failed (HTTP ${response.status})`, response.status);
      }
      const result = await this.readJson(response, !readOnly) as PlytixResult<T>;
      if (readOnly && (!result || !Array.isArray(result.data))) {
        throw new PlytixError('Invalid Plytix response envelope');
      }
      return result;
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
      throw new PlytixError('Product search supports at most 50 attributes; request another page of fields');
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
    return this.request<PlytixProduct>(`/api/v1/products/${encodeURIComponent(productId)}/variants`);
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
    try {
      return await this.request<PlytixFamily>(`/api/v1/product_families/${encodeURIComponent(familyId)}`);
    } catch (error) {
      if (!(error instanceof PlytixError) || error.status !== 403) throw error;
      // The same API role can read family metadata through documented search even
      // when direct detail is forbidden. Do not pretend this is a full detail read.
      const result = await this.searchFamilies({
        filters: [[{ field: 'id', operator: 'eq', value: familyId }]],
        attributes: ['name', 'total_products', 'total_attributes', 'total_models', '_created_at',
          'modified', 'created_user_audit', 'modified_user_audit'],
        pagination: { page: 1, page_size: 2 },
      });
      const family = result.data.find(row => row.id === familyId);
      // An empty or inconsistent search does not prove that the family is absent.
      if (!family) throw error;
      return {
        data: [family],
        meta: {
          source: 'family_search',
          complete: false,
          reason: 'Family metadata recovered by exact-ID search. The detail endpoint returned HTTP 403; additional detail fields may be unavailable.',
        },
      };
    }
  }

  async createFamily(data: {
    name: string;
  }): Promise<PlytixResult<PlytixFamily>> {
    return this.request<PlytixFamily>('/api/v1/product_families', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async linkFamilyAttributes(
    familyId: string,
    attributeIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/link`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeIds }),
      }
    );
  }

  async unlinkFamilyAttributes(
    familyId: string,
    attributeIds: string[]
  ): Promise<PlytixResult<void>> {
    return this.request<void>(
      `/api/v1/product_families/${encodeURIComponent(familyId)}/attributes/unlink`,
      {
        method: 'POST',
        body: JSON.stringify({ attributes: attributeIds }),
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

  private async getFilters(resource: string): Promise<PlytixResult<PlytixFilterDefinition>> {
    const result = await this.request<PlytixFilterDefinition & {
      attributes?: PlytixFilterDefinition[];
      properties?: PlytixFilterDefinition[];
    }>(`/api/v1/filters/${resource}`);
    return { ...result, data: result.data.flatMap(row =>
      Array.isArray(row.attributes) || Array.isArray(row.properties)
        ? [...(row.attributes ?? []), ...(row.properties ?? [])]
        : [row]) };
  }

  async getAvailableFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.getFilters('product');
  }

  async getAssetFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.getFilters('asset');
  }

  async getRelationshipFilters(): Promise<PlytixResult<PlytixFilterDefinition>> {
    return this.getFilters('relationships');
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
      const total = result.pagination?.count ?? result.pagination?.total ?? result.pagination?.total_count;
      if (total !== undefined && attrIds.length >= total) break;
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

  async searchAttributes(body: PlytixSearchBody = {}): Promise<PlytixResult<PlytixAttributeDetail>> {
    return this.request<PlytixAttributeDetail>('/api/v1/attributes/product/search', {
      method: 'POST',
      body: JSON.stringify({
        filters: [],
        attributes: ['name', 'label', 'type_class', 'groups', 'options', 'description', 'attributes'],
        ...body,
      }),
    });
  }

  async searchAttributeGroups(body: PlytixSearchBody = {}): Promise<PlytixResult<PlytixAttributeGroup>> {
    return this.request<PlytixAttributeGroup>('/api/v1/attribute-groups/product/search', {
      method: 'POST',
      body: JSON.stringify({ filters: [], attributes: ['name', 'order', 'attribute_labels'], ...body }),
    });
  }

  /**
   * Get full attribute details by label (snake_case identifier like "head_material").
   * Resolve exactly one label, then fetch its full definition. Never scan the entire
   * account (which may exceed the operation budget) to inspect one attribute.
   */
  async getAttributeByLabel(label: string): Promise<PlytixAttributeDetail | null> {
    const normalized = stripAttributesPrefix(label);
    if (!normalized) throw new PlytixError('Attribute label is required');
    const cached = this.attributesByLabel.get(normalized);
    if (cached && cached.expires > Date.now()) return cached.value;
    const matches = await this.searchAttributes({
      filters: [[{ field: 'label', operator: 'eq', value: normalized }]],
      attributes: ['label'], pagination: { page: 1, page_size: 2 },
    });
    const matching = matches.data.find(row => row.label === normalized);
    if (!matching) return null;
    const detail = await this.getAttributeById(matching.id);
    if (detail && detail.label !== normalized) throw new PlytixError('Attribute lookup returned an inconsistent label');
    if (detail) {
      if (this.attributesByLabel.size >= 500) this.attributesByLabel.clear();
      this.attributesByLabel.set(normalized, { value: detail, expires: Date.now() + 5 * 60_000 });
    }
    return detail;
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
      body: JSON.stringify({
        filters: [],
        attributes: ['filename', 'url', 'alt_text', 'categories', 'file_type', 'content_type', 'file_size', 'modified'],
        ...body,
      }),
    });
  }

  async getAsset(assetId: string): Promise<PlytixResult<PlytixAsset>> {
    return this.request<PlytixAsset>(`/api/v1/assets/${encodeURIComponent(assetId)}`);
  }

  async updateAsset(
    assetId: string,
    data: { filename?: string; categories?: string[]; alt_text?: string }
  ): Promise<PlytixResult<PlytixAsset>> {
    const body: {
      filename?: string;
      categories?: Array<{ id: string }>;
      alt_text?: string;
    } = {};

    if (data.filename !== undefined) {
      body.filename = data.filename;
    }
    if (data.alt_text !== undefined) {
      if (data.alt_text.length > 512) throw new PlytixError('Asset alt text must not exceed 512 characters');
      body.alt_text = data.alt_text;
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
   * Attach it to the required thumbnail or media attribute label.
   */
  async linkProductAsset(
    productId: string,
    assetId: string,
    attributeLabel: string
  ): Promise<PlytixResult<PlytixAsset>> {
    if (!attributeLabel?.trim()) throw new PlytixError('Asset destination attribute is required');
    const body = { id: assetId, attribute_label: attributeLabel };

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

  async searchAssetCategories(body: PlytixSearchBody = {}): Promise<PlytixResult<PlytixCategory>> {
    return this.request<PlytixCategory>('/api/v1/categories/file/search', {
      method: 'POST',
      body: JSON.stringify({ filters: [], attributes: ['name', 'path', 'parents_ids', 'n_children', 'order'], ...body }),
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
