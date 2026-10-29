# Dicker Data MCP Server

MCP server for [Dicker Data](https://www.dickerdata.com.au/)'s B2B partner/reseller REST API - pricing and stock lookup, order placement and tracking, and invoices, for AI assistants and the WYRE Conduit gateway.

## Authentication

Dicker Data does not offer self-serve API signup. Request access from `integration.support@dickerdata.com.au` or `services.sales@dickerdata.com.au` to receive a long-lived `AccountCode` + `AccessToken` pair.

Every real API call additionally requires a short-lived `AccessKey`, obtained by exchanging the `AccountCode`/`AccessToken` via `POST /api/AccessKeyRequest`. This server handles that exchange (and its refresh, on expiry) internally - callers only ever need to supply the long-lived credentials.

## Configuration

Copy [`.env.example`](.env.example) and set the variables below.

| Variable | Required | Description |
|---|---|---|
| `DICKERDATA_ACCOUNT_CODE` | For stdio and `AUTH_MODE=env` | Long-lived account code issued by Dicker Data. Gateway mode does not read this. |
| `DICKERDATA_ACCESS_TOKEN` | For stdio and `AUTH_MODE=env` | Long-lived access token issued by Dicker Data. Gateway mode does not read this. |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose default) or `env`. Gateway mode requires `X-DickerData-Account-Code` and `X-DickerData-Access-Token` on each `/mcp` request and never falls back to `DICKERDATA_*`. `env` uses those variables after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder. Compose will not start without it. Never commit a real value. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` is overridden and logged. A placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a secret is configured. Unset means `0.0.0.0`. The container image sets `0.0.0.0`. Ignored in favor of `127.0.0.1` when the insecure-dev bypass is on. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `LOG_LEVEL` | No | `debug`, `info` (default), `warn`, or `error`. |

`/health` stays unauthenticated, does not require `X-Gateway-S2S`, and does not read vendor credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex hmac-sha256>`. The hex digest is HMAC-SHA256 over the exact ASCII string `t=<unix seconds>` (the same prefix that appears in the header), keyed with `CONDUIT_S2S_SECRET`, encoded as 64 lowercase hex characters. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401. The secret is never written to logs or the response.

```
X-Gateway-S2S: t=1710000000,v1=<64 lowercase hex chars>
```

Known placeholders are rejected at startup and do not count as a configured secret: `changeme`, `change-me`, `secret`, `example`, `placeholder`, `replace-me`, `your-secret`, `your-s2s-secret`, `s2s-secret`, `replace-with-a-real-secret`. Generate a value with `openssl rand -hex 32`.

In `AUTH_MODE=gateway`, `/mcp` also requires `X-DickerData-Account-Code` and `X-DickerData-Access-Token`. Those headers are the only Dicker Data credentials for that request. A request missing either returns 401 and does not fall back to `DICKERDATA_ACCOUNT_CODE` / `DICKERDATA_ACCESS_TOKEN`.

### Request limits

- HTTP request bodies are capped at 256 KiB (262144 bytes). After the `X-Gateway-S2S` check (and, in `AUTH_MODE=gateway`, the vendor credential header check) passes, a `Content-Length` above the cap returns 413 with a JSON-RPC error; bodies without `Content-Length` are capped by the MCP SDK transport. Unauthenticated requests still get 401 first.
- `tools/call` arguments are capped at 10,000 elements (every array item and object key at any depth). Larger inputs return an `isError` tool result and are never dispatched.

These limits address CVE-2026-111768 / GHSA-46jr-4wx8-v453 (memory exhaustion during validation) and GHSA-f897-62hf-6gxq (no request body / batch cap).

## Tools

### Pricing
- `dickerdata_get_pricing` - live pricing + stock-on-hand for one or more product codes.
- `dickerdata_get_price` - pricing + stock for a single product code (via PricingRequest; no quantity parameter).

### Orders
- `dickerdata_create_order` - place a purchase order.
- `dickerdata_get_order_details` - look up a single order.
- `dickerdata_list_orders` - list orders matching account code / order / backorder / PO number.
- `dickerdata_get_order_serials` - shipped serial numbers for an order.
- `dickerdata_get_consignment_status` - shipping/tracking status for a consignment.

### Account
- `dickerdata_list_invoices` - invoices within a date range.
- `dickerdata_get_invoice_details` - line-item detail for a sales order/invoice.

## Known issues

WYREAI-592: Dicker Data's POST `/api/DickerData/GetPrice` requires an undocumented HTTP Authorization header, so `dickerdata_get_price` now uses GET `/api/PricingRequest` (pricing and stock, no quantity-based pricing). `dickerdata_create_order` may hit the same "Missing Request Header/Authorization" 401 until Dicker confirms the auth scheme.

## Scope

This is a v1 / MVP surface covering the core distributor workflow (pricing, ordering, tracking, invoicing). Explicitly out of scope for now: Microsoft CSP/ESD subscription management, Autodesk subscriptions, and annuity-order endpoints - these are much larger, vendor-specific surfaces distinct from core distribution. They can be added as a follow-up if there's demand.

## Development

```bash
npm install
npm run build
npm test
npm run lint   # tsc --noEmit
```

## Docker

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode the account code and access token arrive on each request as `X-DickerData-Account-Code` and `X-DickerData-Access-Token`; they are not read from the environment.

```bash
docker build -t dicker-data-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -p 127.0.0.1:8080:8080 \
  dicker-data-mcp
```

Do not pass a known placeholder such as `your-s2s-secret` or `changeme`. Startup treats those as unset and exits. Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not pass `DICKERDATA_ACCOUNT_CODE` or `DICKERDATA_ACCESS_TOKEN`, and publishes `127.0.0.1:8080:8080`. A project `.env` is interpolation only — do not add `env_file` to the gateway service.

```bash
CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `DICKERDATA_ACCOUNT_CODE` and `DICKERDATA_ACCESS_TOKEN`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_MODE=env \
  -e DICKERDATA_ACCOUNT_CODE=your-account-code \
  -e DICKERDATA_ACCESS_TOKEN=your-access-token \
  -e MCP_HTTP_HOST=0.0.0.0 \
  -p 127.0.0.1:8080:8080 \
  dicker-data-mcp
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is overridden and that override is logged:

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

A signed gateway request:

```bash
curl -sS http://127.0.0.1:8080/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "x-gateway-s2s: $X_GATEWAY_S2S" \
  -H "x-dickerdata-account-code: $DICKERDATA_ACCOUNT_CODE" \
  -H "x-dickerdata-access-token: $DICKERDATA_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
