// Hardcoded test locations for v0.1 (Virginia Beach area).
// Real locations will come from SinisterServer's GET /sites endpoint in v1.0,
// at which point this file's contents are replaced with a server-fetched array.
//
// Each site has a `state` field used by the home-page state picker drilldown.
// On user submissions, this is auto-derived server-side via the US Census
// Geocoder (lat/lng -> state) so users don't have to pick it manually.

export type SinisterCategory =
  | 'crime'
  | 'film'
  | 'haunting'
  | 'cult'
  | 'disaster'
  | 'historical';

export type SinisterSite = {
  id: string;
  title: string;
  shortDescription: string;
  fullDescription: string;
  category: SinisterCategory;
  state: string; // full US state name (e.g. "Virginia"), set on submission
  coords: { lat: number; lng: number };
  imageUrl: string;
  imageCredit: string;
};

export const SINISTER_SITES: SinisterSite[] = [
  {
    id: 'cavalier',
    title: 'The Cavalier Hotel',
    shortDescription: 'Site of Adolph Coors III suicide and decades of reported hauntings.',
    fullDescription:
      'Built in 1927, the Cavalier Hotel hosted ten US presidents and an endless parade of celebrities. In 1929, Adolph Coors III leapt from a sixth-floor window in what was officially ruled a suicide.\n\nStaff and guests have reported apparitions, cold spots, and disembodied voices in the upper hallways for nearly a century. The hotel has been renovated multiple times, but the stories never stop.',
    category: 'haunting',
    state: 'Virginia',
    coords: { lat: 36.8534, lng: -75.9760 },
    imageUrl: 'https://images.unsplash.com/photo-1564013799919-ab600027ffc6?w=900&q=80',
    imageCredit: 'Unsplash',
  },
  {
    id: 'ferry-plantation',
    title: 'Ferry Plantation House',
    shortDescription: 'Witch of Pungo trial site — Grace Sherwood was convicted here in 1706.',
    fullDescription:
      'Ferry Plantation House sits on the banks of the Lynnhaven River, where in 1706 Grace Sherwood — the "Witch of Pungo" — was tried by water. Bound and tossed into the river, she floated, which the court took as proof of witchcraft.\n\nGrace served seven years in prison and lived to 80. She was officially exonerated by the governor of Virginia in 2006, three centuries after her conviction. The grounds are said to host her spirit and several others.',
    category: 'haunting',
    state: 'Virginia',
    coords: { lat: 36.8920, lng: -76.1100 },
    imageUrl: 'https://images.unsplash.com/photo-1518709268805-4e9042af2176?w=900&q=80',
    imageCredit: 'Unsplash',
  },
  {
    id: 'cape-henry',
    title: 'Cape Henry Lighthouse',
    shortDescription: 'First federal lighthouse, with a long history of unexplained phenomena.',
    fullDescription:
      'Authorized by George Washington and completed in 1792, Cape Henry Lighthouse was the first public works project of the new United States. It marks the entrance to the Chesapeake Bay.\n\nKeepers and visitors have reported footsteps on the iron staircase when no one else is in the tower, and a lantern that seems to light itself on foggy nights. The site is also tied to colonial history and the 1607 landing of the first Virginia settlers.',
    category: 'historical',
    state: 'Virginia',
    coords: { lat: 36.9265, lng: -76.0070 },
    imageUrl: 'https://images.unsplash.com/photo-1532274402911-5a369e4c4bb5?w=900&q=80',
    imageCredit: 'Unsplash',
  },
];
