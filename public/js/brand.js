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

// Photos on the public page that the owner or an admin can replace (Website page in the app).
// [place, where it shows, the starter photo quote.html shows until one is uploaded]
export const SITE_PLACES = [
  ['hero', 'Top of the page', 'img/site/hero.jpg'],
  ['storefront', 'Storefronts and entrances', 'img/site/storefront-bank-2.jpg'],
  ['interior', 'Office and interior glass', 'img/site/conference-room.jpg'],
  ['shower', 'Frameless showers', 'img/site/shower-1.jpg'],
  ['railing', 'Glass railings', 'img/site/balcony-railing.jpg'],
];
// The gallery's starter photos, shown until the first gallery photo is uploaded.
export const SITE_STARTER_GALLERY = ['storefront-bank-1', 'storefront-bank-2', 'storefront-bank-5', 'office-glass', 'conference-room',
  'office-partitions', 'glass-office', 'balcony-railing', 'interior-railing', 'shower-1', 'shower-2', 'shower-3'].map((n) => `img/site/${n}.jpg`);
