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

export const logoHtml = (cls = '') => `<picture class="logo-pic ${cls}">
  <source srcset="img/logo-dark.png" media="(prefers-color-scheme: dark)">
  <img src="img/logo.png" alt="Stellar Glass" class="logo-img">
</picture>`;

export const websiteUrl = (w) => (w ? (/^https?:\/\//.test(w) ? w : `https://${w}`) : '');
