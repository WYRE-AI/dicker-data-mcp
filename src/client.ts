import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from './utils/logger.js';
import type {
  AccessKeyResponse,
  DickerDataCredentials,
  OrderItem,
  OrderDelivery,
  OrderHeader,
  PricingResponse,
  UntypedVendorResponse,
} from './types.js';

export const BASE_URL = 'https://b2b-api.dickerdata.com.au';

// Refresh the AccessKey this far ahead of its documented expiry so a
// slow downstream call never races a key that expires mid-request.
const REFRESH_SKEW_MS = 60_000;

// Request-scoped credential store. In gateway mode the HTTP layer runs each
// request inside runWithCredentials({accountCode, accessToken});
// getCredentials() reads from it. Falls back to process.env for
// stdio/single-tenant mode.
const credStore = new AsyncLocalStorage<DickerDataCredentials>();

export function runWithCredentials<T>(creds: DickerDataCredentials, fn: () => T): T {
  return credStore.run(creds, fn);
}

export function getCredentials(): DickerDataCredentials | null {
  const scoped = credStore.getStore();
  if (scoped?.accountCode && scoped?.accessToken) return scoped;
  const accountCode = process.env.DICKERDATA_ACCOUNT_CODE;
  const accessToken = process.env.DICKERDATA_ACCESS_TOKEN;
  if (!accountCode || !accessToken) {
    logger.warn('Missing credentials', { hasAccountCode: !!accountCode, hasAccessToken: !!accessToken });
    return null;
  }
  return { accountCode, accessToken };
}

/** Thrown when the vendor API rejects the current AccessKey - triggers exactly one refresh-and-retry in withAccessKey(). */
export class DickerDataAuthError extends Error {}

/** Thrown for any other non-2xx / unexpected vendor response. */
export class DickerDataApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface AccessKeyState {
  accessKey: string;
  expireAt: number; // epoch ms
}

// Keyed by accountCode+accessToken so multiple tenants sharing one gateway
// process (AsyncLocalStorage swaps credentials per request) never
// cross-pollinate cached AccessKeys.
const accessKeyCache = new Map<string, AccessKeyState>();

function cacheKeyFor(creds: DickerDataCredentials): string {
  return `${creds.accountCode}:${creds.accessToken}`;
}

/**
 * Exchange the long-lived AccountCode/AccessToken for a short-lived
 * AccessKey via POST /api/AccessKeyRequest. Dicker Data's swagger spec does
 * not document the exact values of the `Status` field on success/failure,
 * so this treats a 2xx response carrying a non-empty `AccessKey` as success
 * and anything else (non-2xx, or 2xx with no AccessKey) as invalid
 * credentials - `Message`/`Status`, when present, are surfaced in the error
 * for diagnostics.
 */
export async function requestAccessKey(creds: DickerDataCredentials): Promise<AccessKeyState> {
  const res = await fetch(`${BASE_URL}/api/AccessKeyRequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      TransactionID: randomUUID(),
      AccessToken: creds.accessToken,
      AccountCode: creds.accountCode,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new DickerDataApiError(`Dicker Data AccessKeyRequest failed: HTTP ${res.status}`, res.status);
  }

  const data = (await res.json()) as AccessKeyResponse;
  if (!data.AccessKey) {
    throw new DickerDataAuthError(
      `Dicker Data rejected credentials: ${data.Message || data.Status || 'no AccessKey returned'}`
    );
  }

  const expireAt = data.ExpireDateTime ? Date.parse(data.ExpireDateTime) : NaN;
  return {
    accessKey: data.AccessKey,
    // Fall back to a conservative 10-minute TTL if ExpireDateTime is missing
    // or unparseable, rather than caching an AccessKey with an unknown
    // lifetime indefinitely.
    expireAt: Number.isFinite(expireAt) ? expireAt : Date.now() + 10 * 60_000,
  };
}

async function getAccessKey(creds: DickerDataCredentials, forceRefresh = false): Promise<string> {
  const key = cacheKeyFor(creds);
  const cached = accessKeyCache.get(key);
  if (!forceRefresh && cached && cached.expireAt - REFRESH_SKEW_MS > Date.now()) {
    return cached.accessKey;
  }
  const fresh = await requestAccessKey(creds);
  accessKeyCache.set(key, fresh);
  return fresh.accessKey;
}

interface RequestHeaderFields {
  TransactionID: string;
  Token: string;
  AccessKey: string;
}

function buildRequestHeader(creds: DickerDataCredentials, accessKey: string): RequestHeaderFields {
  return {
    TransactionID: randomUUID(),
    Token: creds.accessToken,
    AccessKey: accessKey,
  };
}

/**
 * Dicker Data's POST JSON bodies use PascalCase requestHeader field names
 * (matching the APIRequestHeader/B2BRestAPIAccessKeyRequest swagger
 * definitions - TransactionID/Token/AccessKey), but its GET endpoints'
 * query-string parameters are documented in camelCase
 * (`request.requestHeader.transactionID`, `...token`, `...accessKey`).
 * This converts a RequestHeaderFields value to the camelCase shape for use
 * with buildQuery() on a GET call.
 */
function toQueryHeader(header: RequestHeaderFields): Record<string, string> {
  return {
    transactionID: header.TransactionID,
    token: header.Token,
    accessKey: header.AccessKey,
  };
}

/**
 * Runs `fn` with a fresh/cached AccessKey, and retries it exactly once with
 * a forced refresh if `fn` throws DickerDataAuthError (the vendor rejected
 * the AccessKey - expired or otherwise invalid). Every real API call in
 * this file goes through this wrapper so the refresh logic lives in one
 * place.
 */
async function withAccessKey<T>(
  creds: DickerDataCredentials,
  fn: (header: RequestHeaderFields) => Promise<T>
): Promise<T> {
  const accessKey = await getAccessKey(creds);
  try {
    return await fn(buildRequestHeader(creds, accessKey));
  } catch (err) {
    if (err instanceof DickerDataAuthError) {
      logger.warn('AccessKey rejected mid-call, refreshing and retrying once');
      const refreshed = await getAccessKey(creds, true);
      return await fn(buildRequestHeader(creds, refreshed));
    }
    throw err;
  }
}

/**
 * Flattens a nested object into dotted query-string keys, matching the
 * .NET model-binding convention Dicker Data's GET endpoints use (e.g.
 * `request.requestHeader.accessKey`, `request.in.orderNumber`). Arrays
 * become repeated keys (`?products=A&products=B`), matching the
 * `collectionFormat: multi` the swagger spec declares for array params.
 */
function buildQuery(params: Record<string, unknown>): URLSearchParams {
  const qs = new URLSearchParams();
  const walk = (obj: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = path ? `${path}.${k}` : k;
      if (Array.isArray(v)) {
        for (const item of v) qs.append(key, String(item));
      } else if (typeof v === 'object') {
        walk(v as Record<string, unknown>, key);
      } else {
        qs.append(key, String(v));
      }
    }
  };
  walk(params, '');
  return qs;
}

/**
 * Inspects a vendor JSON body for the auth-rejection shape (a `Status`
 * field indicating failure, mentioning the AccessKey). Dicker Data's
 * swagger spec doesn't document `Status` values, so this only recognizes
 * the case a `Status`/`Message` field explicitly complains about the key -
 * everything else is treated as a normal (possibly empty) result and
 * returned to the caller as-is.
 */
function looksLikeAuthRejection(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const rec = body as Record<string, unknown>;
  const status = typeof rec.Status === 'string' ? rec.Status.toLowerCase() : '';
  const message = typeof rec.Message === 'string' ? rec.Message.toLowerCase() : '';
  const err = typeof rec.ErrorDescription === 'string' ? rec.ErrorDescription.toLowerCase() : '';
  const haystack = `${status} ${message} ${err}`;
  return (
    (haystack.includes('accesskey') || haystack.includes('access key')) &&
    (haystack.includes('expired') || haystack.includes('invalid') || haystack.includes('fail'))
  );
}

async function doGet<T>(path: string, query: URLSearchParams): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new DickerDataAuthError(`Dicker Data rejected the AccessKey (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new DickerDataApiError(`Dicker Data ${path} failed: HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as T;
  if (looksLikeAuthRejection(data)) {
    throw new DickerDataAuthError(`Dicker Data rejected the AccessKey for ${path}`);
  }
  return data;
}

async function doPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new DickerDataAuthError(`Dicker Data rejected the AccessKey (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new DickerDataApiError(`Dicker Data ${path} failed: HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as T;
  if (looksLikeAuthRejection(data)) {
    throw new DickerDataAuthError(`Dicker Data rejected the AccessKey for ${path}`);
  }
  return data;
}

// ---------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------

/** GET /api/PricingRequest - product pricing/stock lookup by product code list. */
export async function getPricing(creds: DickerDataCredentials, products: string[]): Promise<PricingResponse> {
  return withAccessKey(creds, (header) =>
    doGet<PricingResponse>(
      '/api/PricingRequest',
      buildQuery({
        pricingRequest: {
          messageID: header.TransactionID,
          token: header.Token,
          accessKey: header.AccessKey,
          products,
        },
      })
    )
  );
}

/** POST /api/DickerData/GetPrice - detailed pricing for a single product/quantity. */
export async function getPrice(
  creds: DickerDataCredentials,
  productCode: string,
  quantity?: number
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doPost<UntypedVendorResponse>('/api/DickerData/GetPrice', {
      RequestHeader: { TransactionID: header.TransactionID, Token: header.Token, AccessKey: header.AccessKey },
      Products: [{ PartNumber: productCode, Quantity: quantity !== undefined ? String(quantity) : undefined }],
    })
  );
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------

export interface CreateOrderInput {
  header?: OrderHeader;
  delivery?: OrderDelivery;
  items: OrderItem[];
}

/** POST /api/Order/CreateOrder. */
export async function createOrder(
  creds: DickerDataCredentials,
  order: CreateOrderInput
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doPost<UntypedVendorResponse>('/api/Order/CreateOrder', {
      RequestHeader: { TransactionID: header.TransactionID, Token: header.Token, AccessKey: header.AccessKey },
      OrderIn: {
        Header: order.header,
        Delivery: order.delivery,
        Items: order.items,
      },
    })
  );
}

/** GET /api/GetOrderDetails - a single order by order number, account code, or customer PO reference. */
export async function getOrderDetails(
  creds: DickerDataCredentials,
  opts: { orderNumber?: string; accountCode?: string; customerPORef?: string }
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/GetOrderDetails',
      buildQuery({
        request: {
          requestHeader: toQueryHeader(header),
          in: {
            orderNumber: opts.orderNumber,
            accountCode: opts.accountCode,
            customerPORef: opts.customerPORef,
          },
        },
      })
    )
  );
}

/** GET /api/GetOrderDetailsList - orders matching account code / order / backorder / customer PO number. */
export async function getOrderDetailsList(
  creds: DickerDataCredentials,
  opts: { accountCode?: string; orderNumber?: string; backorderNumber?: string; customerPONumber?: string }
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/GetOrderDetailsList',
      buildQuery({
        request: {
          requestHeader: toQueryHeader(header),
          accountCode: opts.accountCode,
          orderNumber: opts.orderNumber,
          backorderNumber: opts.backorderNumber,
          customerPONumber: opts.customerPONumber,
        },
      })
    )
  );
}

/**
 * GET /api/GetOrderSerials - shipped serial numbers for an order.
 *
 * Dicker Data's swagger spec lists only `orderNumber`/`orderSuffix` as
 * parameters for this endpoint (unlike its sibling order-status endpoints,
 * it does not document a `requestHeader`). Since every other read in this
 * API requires the AccessKey exchange, the requestHeader fields are still
 * sent as extra query params on the assumption the vendor's model binder
 * ignores unrecognized ones - this could not be live-verified without real
 * credentials. If the live API 401s here despite a valid AccessKey, the
 * endpoint may genuinely take no auth params as documented.
 */
export async function getOrderSerials(
  creds: DickerDataCredentials,
  orderNumber: string,
  orderSuffix?: string
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/GetOrderSerials',
      buildQuery({
        orderNumber,
        orderSuffix,
        request: { requestHeader: toQueryHeader(header) },
      })
    )
  );
}

/** GET /api/Order/GetConsignmentStatus - shipping/tracking status for a consignment. */
export async function getConsignmentStatus(
  creds: DickerDataCredentials,
  consignmentNumber: string
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/Order/GetConsignmentStatus',
      buildQuery({
        request: { requestHeader: toQueryHeader(header), consignmentNumber },
      })
    )
  );
}

// ---------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------

/** GET /api/Account/Invoice - invoices within a date range. */
export async function listInvoices(
  creds: DickerDataCredentials,
  opts: { startDate?: string; endDate?: string }
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/Account/Invoice',
      buildQuery({
        request: { startDate: opts.startDate, endDate: opts.endDate, requestHeader: toQueryHeader(header) },
      })
    )
  );
}

/** GET /api/Account/InvoiceDetails - line-item detail for a sales order/invoice. */
export async function getInvoiceDetails(
  creds: DickerDataCredentials,
  opts: { salesOrderNumber: string; salesOrderNumberSuffix?: string; includeCustomerQualification?: boolean }
): Promise<UntypedVendorResponse> {
  return withAccessKey(creds, (header) =>
    doGet<UntypedVendorResponse>(
      '/api/Account/InvoiceDetails',
      buildQuery({
        request: {
          requestHeader: toQueryHeader(header),
          salesOrderNumber: opts.salesOrderNumber,
          salesOrderNumberSuffix: opts.salesOrderNumberSuffix,
          includeCustomerQualification:
            opts.includeCustomerQualification !== undefined ? String(opts.includeCustomerQualification) : undefined,
        },
      })
    )
  );
}
