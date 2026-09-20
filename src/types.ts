/**
 * Long-lived credentials issued out-of-band by Dicker Data (email
 * integration.support@dickerdata.com.au or services.sales@dickerdata.com.au
 * to request API access). These are what a Conduit customer enters as their
 * connector credentials, and are distinct from the short-lived AccessKey
 * exchanged at request time - see client.ts.
 */
export interface DickerDataCredentials {
  accountCode: string;
  accessToken: string;
}

/** Response body of POST /api/AccessKeyRequest. */
export interface AccessKeyResponse {
  TransactionID?: string;
  AccessKey?: string;
  CreationDateTime?: string;
  ExpireDateTime?: string;
  Status?: string;
  Message?: string;
}

/** A single product in a pricing/stock lookup result (PricingResponse.SearchResult). */
export interface PriceSearchProduct {
  Brand?: string;
  PartNumber?: string;
  AltPartNumber?: string;
  Description?: string;
  UnitPrice?: string;
  SOH?: string;
  RRPExTax?: string;
  BillingFreq?: string;
  Height?: string;
  Length?: string;
  Width?: string;
  Weight?: string;
}

/** Response body of GET/POST /api/PricingRequest. */
export interface PricingResponse {
  ResponseCreatedDateTime?: string;
  InstanceId?: string;
  Status?: string;
  ErrorDescription?: string;
  SearchResult?: PriceSearchProduct[];
}

export interface Contact {
  FirstName?: string;
  LastName?: string;
  Phone?: string;
  Fax?: string;
  Email?: string;
  Mobile?: string;
}

export interface Address {
  CompanyName?: string;
  Address01?: string;
  Address02?: string;
  Address03?: string;
  Suburb?: string;
  State?: string;
  Postcode?: string;
  Country?: string;
}

export interface OrderProduct {
  Brand?: string;
  PartNumber: string;
  Description?: string;
  UnitPrice?: string;
  Quantity: string;
  UseSystemPrice?: string;
  SerialNumbers?: string[];
  LineNumber?: string;
  UnitOfMeasure?: string;
}

export interface OrderItem {
  Product: OrderProduct;
  Notes?: string;
}

export interface OrderHeader {
  OrderNumber?: string;
  Notes?: string;
  BranchAccountCode?: string;
  CurrencyCode?: string;
  QuoteNumber?: string;
}

export interface OrderDelivery {
  DeliveryContact?: Contact;
  Attention?: string;
  DeliveryAddress?: Address;
  RequestedShippingDate?: string;
  ShippingInstructions?: string;
  PartShipped?: string;
  ShippingMethod?: string;
}

/**
 * NOTE: /api/Order/CreateOrder, /api/GetOrderDetails, /api/GetOrderDetailsList,
 * /api/GetOrderSerials, /api/Order/GetConsignmentStatus, /api/Account/Invoice
 * and /api/Account/InvoiceDetails all document their response as
 * `System.Object` in Dicker Data's own swagger spec - the vendor's API does
 * not publish a typed response shape for these. Tool handlers pass the raw
 * JSON straight through rather than fabricating a schema the vendor itself
 * doesn't document.
 */
export type UntypedVendorResponse = Record<string, unknown>;
