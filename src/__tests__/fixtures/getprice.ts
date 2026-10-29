// Fixture bodies for POST /api/DickerData/GetPrice. Fake values only.
export const FAKE_AUTH = 'fake-auth-scheme fake-auth-value-123';

export const getPriceSuccess = {
  ResponseHeader: { Status: 'SUCCESS', ErrorDescription: '' },
  Out: [
    {
      PartNumber: 'XYZ999',
      UnitPrice: 299.0,
      SOH: 71,
      Height: 10,
      Length: 20,
      Width: 30,
      Weight: 1.5,
    },
  ],
};

export const getPriceUnauthorised = {
  ResponseHeader: { Status: 'UNAUTHORISED', ErrorDescription: 'Unauthorised' },
  Out: [],
};

export const getPriceMissingAuthorization401 = {
  ResponseHeader: { Status: 'FAILURE', ErrorDescription: 'Missing Request Header/Authorization. ' },
  Out: [],
};
