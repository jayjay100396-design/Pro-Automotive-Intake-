// Stellar Glass business details. Used before sign-in (sign-in page) and to pre-fill the
// company profile at setup; after that, the profile in Settings is what prints on documents.
export const BRAND = {
  name: 'Stellar Glass LLC',
  contactName: 'Wesley Stel',
  contactTitle: 'President',
  address: '2850 Mine and Mill Road, Suite 4, Lakeland, FL 33801',
  phone: '(863) 255-5731',
  cell: '(586) 292-1732',
  email: 'wes@stellarglassllc.com',
  website: 'www.stellarglassllc.com',
};

// Both versions are in the page; the stylesheet shows the one that suits the background.
export const logoHtml = (cls = '') => `<span class="logo-pic ${cls}">
  <img src="img/logo.png" alt="Stellar Glass" class="logo-img on-light">
  <img src="img/logo-dark.png" alt="Stellar Glass" class="logo-img on-dark">
</span>`;

export const websiteUrl = (w) => (w ? (/^https?:\/\//.test(w) ? w : `https://${w}`) : '');

// The public quote page (quote.html) sends requests to the business connected to this site id
// (Firestore sites/{SITE_ID}); the owner connects it in Settings.
export const SITE_ID = 'stellar-glass';

// Choices on the quote request form. The keys are what's stored, and firestore.rules checks them.
export const REQUEST_SERVICES = [
  ['storefront', 'Commercial storefront or entrance'],
  ['interior', 'Office or interior glass walls'],
  ['shower', 'Frameless shower enclosure'],
  ['railing', 'Glass railing'],
  ['other', 'Something else'],
];
export const REQUEST_TIMELINES = [
  ['', 'Not sure yet'],
  ['asap', 'As soon as possible'],
  ['soon', 'In the next 1 to 3 months'],
  ['later', 'More than 3 months out'],
  ['pricing', 'Just getting prices or bidding'],
];
export const REQUEST_CONTACT = [['phone', 'Phone call'], ['text', 'Text message'], ['email', 'Email']];
