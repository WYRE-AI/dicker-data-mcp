# Dicker Data MCP Server

MCP server for [Dicker Data](https://www.dickerdata.com.au/)'s B2B partner/reseller REST API - pricing and stock lookup, order placement and tracking, and invoices, for AI assistants and the WYRE Conduit gateway.

## Authentication

Dicker Data does not offer self-serve API signup. Request access from `integration.support@dickerdata.com.au` or `services.sales@dickerdata.com.au` to receive a long-lived `AccountCode` + `AccessToken` pair.

Every real API call additionally requires a short-lived `AccessKey`, obtained by exchanging the `AccountCode`/`AccessToken` via `POST /api/AccessKeyRequest`. This server handles that exchange (and its refresh, on expiry) internally - callers only ever need to supply the long-lived credentials.

## Configuration

| Env var | Description |
|---|---|
| `DICKERDATA_ACCOUNT_CODE` | Long-lived account code issued by Dicker Data. |
| `DICKERDATA_ACCESS_TOKEN` | Long-lived access token issued by Dicker Data. |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `AUTH_MODE` | `env` (default, reads the vars above) or `gateway` (credentials arrive per-request via `X-DickerData-Account-Code` / `X-DickerData-Access-Token` headers, injected by the Conduit gateway). |
| `CONDUIT_S2S_SECRET` | When set, the HTTP transport requires a valid `X-Gateway-S2S` header (Conduit sidecar auth) on every `/mcp` request. |
| `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error`. |

## Tools

### Pricing
- `dickerdata_get_pricing` - live pricing + stock-on-hand for one or more product codes.
- `dickerdata_get_price` - detailed pricing for a single product code at a given quantity.

### Orders
- `dickerdata_create_order` - place a purchase order.
- `dickerdata_get_order_details` - look up a single order.
- `dickerdata_list_orders` - list orders matching account code / order / backorder / PO number.
- `dickerdata_get_order_serials` - shipped serial numbers for an order.
- `dickerdata_get_consignment_status` - shipping/tracking status for a consignment.

### Account
- `dickerdata_list_invoices` - invoices within a date range.
- `dickerdata_get_invoice_details` - line-item detail for a sales order/invoice.

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

```bash
docker build -t dicker-data-mcp .
docker run -p 8080:8080 -e DICKERDATA_ACCOUNT_CODE=... -e DICKERDATA_ACCESS_TOKEN=... dicker-data-mcp
```
