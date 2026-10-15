// Supplier plugins: ready-made supplier profiles. Adding a supplier from one fills in the supplier's branches, the
// kind of list they work from, and tips for the request; everything can be changed afterwards, and each saved
// supplier is the business's own copy (companies/{company}/suppliers/{id}).
// To add a plugin, add an entry below. Branch details come from each supplier's own website (linked beside them),
// as checked in October 2026; a rep's own email and the account number aren't public, so the owner adds those.
//
//   id        saved on the supplier as `plugin`
//   listType  'parts' (part numbers), 'glass' (sizes) or 'general' (description and quantity)
//   kind      'quote' or 'order': what a new request starts as
//   branches  [{ city, label, address, phone }]; `city` goes in the email ("pick it up at your Orlando branch")
//   tip       shown on each new request to this supplier
//   common    lines to add with one click: { qty, unit, partNo, desc } (or { desc } for glass)

export const PLUGINS = [
  {
    id: 'trulite',
    name: 'Trulite Glass & Aluminum Solutions',
    short: 'Trulite',
    what: 'Storefront framing, entrance doors, glass and glazing accessories',
    website: 'https://www.trulite.com',
    listType: 'parts',
    kind: 'quote',
    delivery: 'site',
    // https://www.trulite.com/contact-us/find-a-location/ (it prints Plant City's ZIP as "333566"; Trulite's other
    // Plant City listing, on Rice Road too, is 33566)
    branches: [
      { city: 'Plant City', label: 'Plant City (Lakeland area)', address: '4106 Rice Road, Plant City, FL 33566', phone: '(863) 323-2548' },
      { city: 'Orlando', label: 'Orlando', address: '3320 Maggie Street, Orlando, FL 32811', phone: '(800) 367-7211' },
      { city: 'Bradenton', label: 'Bradenton', address: '3102 63rd Ave E, Bradenton, FL 34203', phone: '(941) 755-3622' },
    ],
    tip: 'Put each framing system as a heading (series, finish and infill, like "CG451 #04 clear anodized 1\" infill"), then its stock lengths and accessories by part number. For entrance doors, attach Trulite\'s door order form from the job\'s files.',
    // Accessories from Wes's own Trulite quote request for the Anchuca job (November 2025).
    common: [
      { qty: 1, unit: 'pkg', partNo: 'ED450-2', desc: 'End dam' },
      { qty: 1, unit: 'pkg', partNo: 'FAS 14-2', desc: 'Assembly screw' },
      { qty: 1, unit: 'pkg', partNo: 'RSB-3', desc: 'Setting block' },
      { qty: 1, unit: 'pkg', partNo: 'WD451-1', desc: 'Water deflector' },
      { qty: 1, unit: 'roll', partNo: 'RG-1', desc: 'Glazing gasket' },
    ],
  },
  {
    id: 'crl',
    name: 'C.R. Laurence (CRL)',
    short: 'CRL',
    what: 'Shower door hardware, railings, sealants, tools and glazing supplies',
    website: 'https://www.crlaurence.com',
    listType: 'parts',
    kind: 'quote',
    delivery: 'pickup',
    // Addresses: https://www.crlaurence.com/contactus?site=US. Orlando's phone:
    // https://azure.crlaurence.com/general/locations/US_locations/orlando.html. Tampa lists no phone of its own, so it
    // has CRL's toll-free number: https://azure.crlaurence.com/adv/contact-us/index_us.html
    branches: [
      { city: 'Tampa', label: 'Tampa', address: '8655 Elm Fair Blvd., Tampa, FL 33610', phone: '(800) 421-6144' },
      { city: 'Orlando', label: 'Orlando', address: '6950 Presidents Drive, Orlando, FL 32809-5668', phone: '(407) 857-7900' },
    ],
    tip: 'Use CRL part numbers and say the finish on every hardware line (brushed nickel, polished chrome, matte black).',
    common: [
      { qty: 1, unit: 'pr', partNo: '', desc: 'Shower door hinges, finish:' },
      { qty: 1, unit: 'ea', partNo: '', desc: 'Pull handle, finish:' },
      { qty: 1, unit: 'set', partNo: '', desc: 'Glass clamps, finish:' },
      { qty: 1, unit: 'ea', partNo: '', desc: 'Door sweep and bottom seal' },
      { qty: 1, unit: 'tube', partNo: '', desc: 'Clear silicone sealant' },
    ],
  },
  {
    id: 'fabricator',
    name: 'Glass fabricator',
    short: 'Glass shop',
    what: 'Cut-to-size glass: tempered, laminated and insulated units, mirrors',
    website: '',
    listType: 'glass',
    kind: 'quote',
    delivery: 'shop',
    branches: [],
    tip: 'Give every lite its width x height, the glass makeup, edgework and any holes or notches, and a mark to match the drawings. Tempered glass can\'t be cut or drilled afterwards.',
    common: [
      { desc: '1/4" clear tempered' },
      { desc: '3/8" clear tempered, polished edges' },
      { desc: '1/2" clear tempered, polished edges' },
      { desc: '1" clear low-E insulated, tempered' },
      { desc: '1" grey low-E insulated' },
    ],
  },
  {
    id: 'other',
    name: 'Other supplier',
    short: 'Supplier',
    what: 'Anyone else: hardware, sealants, metal, rentals',
    website: '',
    listType: 'general',
    kind: 'quote',
    delivery: 'site',
    branches: [],
    tip: '',
    common: [],
  },
];

export const pluginFor = (id) => PLUGINS.find((p) => p.id === id) || PLUGINS[PLUGINS.length - 1];
