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
