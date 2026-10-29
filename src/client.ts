import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from './utils/logger.js';
import type {
  AccessKeyResponse,
  DickerDataCredentials,
  GetPriceResponse,
  GetPriceResult,
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
  // JSON.stringify (not a colon-join) so a colon inside either credential
  // value can never collapse two distinct tenants onto the same cache key —
  // Dicker Data's API docs don't constrain the charset of AccountCode or
  // AccessToken, so that's a live possibility, not a hypothetical, on a
  // secret cache shared across tenants.
  return JSON.stringify([creds.accountCode, creds.accessToken]);
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
  const haystack = responseFields(body).join(' ').toLowerCase();
  return (
    (haystack.includes('accesskey') || haystack.includes('access key')) &&
    (haystack.includes('expired') || haystack.includes('invalid') ||
      haystack.includes('fail') || haystack.includes('unable to validate'))
  );
}

/**
 * Collects Dicker's diagnostic strings from a response body. POST endpoints
 * nest them under ResponseHeader (e.g. ResponseHeader.ErrorDescription);
 * GET endpoints put ErrorDescription at the top level.
 */
function responseFields(body: unknown, includeStatus = true): string[] {
  if (!body || typeof body !== 'object') return [];
  const rec = body as Record<string, unknown>;
  return [
    rec.ErrorDescription,
    rec.errorDescription,
    rec.Message,
    rec.message,
    ...(includeStatus ? [rec.Status, rec.status] : []),
    ...responseFields(rec.ResponseHeader, includeStatus),
    ...responseFields(rec.responseHeader, includeStatus),
  ]
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .map((value) => value.trim());
}

/** Preserve vendor diagnostics without exposing request credentials or query URLs. */
async function throwHttpAuthError(res: Response, path: string, secrets: string[]): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A non-JSON auth response still follows the normal refresh-and-retry path.
    logger.warn('Dicker Data auth response was not JSON', { path, status: res.status });
  }
  const description = responseFields(body, false)[0];
  let detail = description;
  if (detail) {
    detail = detail.replace(/https?:\/\/[^\s]+\?[^\s]*/gi, '[redacted URL]');
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
      detail = detail.split(secret).join('[redacted]');
    }
  }
  const message = detail
    ? `Dicker Data ${path} returned HTTP ${res.status}: ${detail}`
    : `Dicker Data rejected the AccessKey (HTTP ${res.status})`;
  if (description && /missing request header\/authorization/i.test(description)) {
    throw new DickerDataApiError(message, res.status);
  }
  throw new DickerDataAuthError(message);
}

async function doGet<T>(path: string, query: URLSearchParams): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    await throwHttpAuthError(res, path, [...query.entries()]
      .filter(([key]) => /token|accesskey/i.test(key)).map(([, value]) => value));
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

interface PostOptions {
  /** Extra HTTP headers (e.g. Authorization), merged over the defaults. */
  headers?: Record<string, string>;
  /** Extra secret values to redact from auth-error text. */
  secrets?: string[];
  /** Skip the body-level AccessKey-rejection heuristic (caller classifies the body itself). */
  skipAuthRejectionCheck?: boolean;
}

async function doPost<T>(path: string, body: unknown, opts: PostOptions = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    const header = (body as { RequestHeader?: RequestHeaderFields })?.RequestHeader;
    await throwHttpAuthError(res, path, [header?.Token ?? '', header?.AccessKey ?? '', ...(opts.secrets ?? [])]);
  }
  if (!res.ok) {
    throw new DickerDataApiError(`Dicker Data ${path} failed: HTTP ${res.status}`, res.status);
  }
  const data = (await res.json()) as T;
  if (!opts.skipAuthRejectionCheck && looksLikeAuthRejection(data)) {
    throw new DickerDataAuthError(`Dicker Data rejected the AccessKey for ${path}`);
  }
  return data;
}

// ---------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------

/**
 * GET /api/PricingRequest - product pricing/stock lookup by product code list.
 * This is Dicker's price-list (datafeed), which may lag the live account price
 * and stock.
 */
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

// TODO(WYREAI-592) BLOCKED: POST /api/DickerData/GetPrice requires an HTTP
// Authorization header, but Dicker's swagger does not document the scheme.
// Observed (dummy creds): no header -> HTTP 401 "Missing Request
// Header/Authorization."; a wrong value -> Status "UNAUTHORISED".
// Hypothesis: the swagger's POST /Token (form-urlencoded grant_type,
// client_id, client_secret) issues a Bearer token, but it is unknown whether
// client_id/secret are the AccountCode/AccessToken or separate Dicker-issued
// credentials. This MUST NOT be wired to customer credentials until Dicker
// (integration.support@dickerdata.com.au) confirms the scheme. Until then the
// default provider returns null, so getPrice() never calls GetPrice and always
// falls back to PricingRequest. The real implementation plugs in through
// setGetPriceAuthorizationProvider(); the returned string is sent verbatim as
// the Authorization header value (the provider decides the scheme).
export type GetPriceAuthorizationProvider = (creds: DickerDataCredentials) => Promise<string | null>;

const defaultGetPriceAuthorizationProvider: GetPriceAuthorizationProvider = async () => null;

let getPriceAuthorizationProvider: GetPriceAuthorizationProvider = defaultGetPriceAuthorizationProvider;

/** Inject the GetPrice Authorization provider; null resets to the default (none). */
export function setGetPriceAuthorizationProvider(provider: GetPriceAuthorizationProvider | null): void {
  getPriceAuthorizationProvider = provider ?? defaultGetPriceAuthorizationProvider;
}

export type GetPriceUnavailableReason =
  | 'authorization-not-configured'
  | 'authorization-provider-error'
  | 'request-failed'
  | 'vendor-status'
  | 'malformed-response';

/** Thrown when live GetPrice cannot produce a usable result. Messages never contain the Authorization value. */
export class GetPriceUnavailableError extends Error {
  constructor(message: string, readonly reason: GetPriceUnavailableReason) {
    super(message);
  }
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * POST /api/DickerData/GetPrice - live price/stock for one product. Throws
 * GetPriceUnavailableError (without any network call if no Authorization
 * value is available) when a usable live result cannot be obtained. The
 * response is undocumented; success is HTTP 2xx, a SUCCESS/OK
 * ResponseHeader.Status (or no Status with a non-empty Out) and an array Out.
 */
export async function getLivePrice(
  creds: DickerDataCredentials,
  productCode: string
): Promise<Extract<GetPriceResult, { live: true }>> {
  let authorization: string | null;
  try {
    authorization = await getPriceAuthorizationProvider(creds);
  } catch {
    throw new GetPriceUnavailableError('GetPrice Authorization provider failed', 'authorization-provider-error');
  }
  if (!authorization) {
    throw new GetPriceUnavailableError(
      'GetPrice Authorization scheme is not configured (unconfirmed with Dicker)',
      'authorization-not-configured'
    );
  }
  const secrets = [authorization, creds.accessToken];

  let data: GetPriceResponse;
  try {
    data = await withAccessKey(creds, (header) =>
      doPost<GetPriceResponse>(
        '/api/DickerData/GetPrice',
        {
          RequestHeader: { TransactionID: header.TransactionID, Token: header.Token, AccessKey: header.AccessKey },
          Products: [productCode],
        },
        { headers: { Authorization: authorization }, secrets, skipAuthRejectionCheck: true }
      )
    );
  } catch (err) {
    const status = err instanceof DickerDataApiError && err.status ? ` (HTTP ${err.status})` : '';
    throw new GetPriceUnavailableError(
      `GetPrice request failed${status}: ${redact(errorMessage(err), secrets)}`,
      'request-failed'
    );
  }

  const raw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const header = (raw.ResponseHeader ?? raw.responseHeader) as GetPriceResponse['ResponseHeader'];
  const out = raw.Out ?? raw.out;
  if (!Array.isArray(out)) {
    throw new GetPriceUnavailableError('GetPrice response had no Out array', 'malformed-response');
  }
  const status = typeof header?.Status === 'string' ? header.Status.trim() : '';
  const ok = status ? /^(success|ok)$/i.test(status) : out.length > 0;
  if (!ok) {
    const detail = [status && `Status ${status}`, header?.ErrorDescription?.trim()].filter(Boolean).join(': ');
    throw new GetPriceUnavailableError(
      `GetPrice returned ${redact(detail || 'no success Status', secrets)}`,
      'vendor-status'
    );
  }
  return {
    source: 'GetPrice',
    live: true,
    productCode,
    ResponseHeader: header,
    Out: out as Record<string, unknown>[],
  };
}

/**
 * Single-product price/stock. Tries Dicker's live GetPrice first and falls
 * back to the PricingRequest price-list feed (which may lag the live account
 * price and stock) on any failure. Quantity is unsupported.
 */
export async function getPrice(creds: DickerDataCredentials, productCode: string): Promise<GetPriceResult> {
  let liveFailure: GetPriceUnavailableError;
  try {
    return await getLivePrice(creds, productCode);
  } catch (err) {
    liveFailure =
      err instanceof GetPriceUnavailableError
        ? err
        : new GetPriceUnavailableError('GetPrice failed unexpectedly', 'request-failed');
  }

  logger.warn('Live GetPrice unavailable, falling back to PricingRequest', { reason: liveFailure.reason });
  try {
    const pricing = await getPricing(creds, [productCode]);
    return {
      source: 'PricingRequest',
      live: false,
      productCode,
      warning:
        `Live GetPrice was unavailable (${liveFailure.message}); this price and stock-on-hand come from ` +
        `Dicker's PricingRequest price-list feed and may lag your live account price and stock.`,
      fallbackReason: liveFailure.reason,
      ...pricing,
    };
  } catch (err) {
    throw new Error(
      `Price lookup failed. Live GetPrice unavailable (${liveFailure.message}); ` +
        `PricingRequest fallback also failed (${errorMessage(err)}).`
    );
  }
}

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------

export interface CreateOrderInput {
  header?: OrderHeader;
  delivery?: OrderDelivery;
  items: OrderItem[];
}

/** POST /api/Order/CreateOrder. May return 401 "Missing Request Header/Authorization." until Dicker confirms the auth scheme (WYREAI-592). */
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
