# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release: MCP server for Dicker Data's B2B partner/reseller REST API.
- Pricing tools: `dickerdata_get_pricing`, `dickerdata_get_price`.
- Order tools: `dickerdata_create_order`, `dickerdata_get_order_details`, `dickerdata_list_orders`, `dickerdata_get_order_serials`, `dickerdata_get_consignment_status`.
- Account tools: `dickerdata_list_invoices`, `dickerdata_get_invoice_details`.
- Transparent AccessKey exchange and refresh (`POST /api/AccessKeyRequest`) wrapping every tool call.
