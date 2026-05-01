// =============================================================================
// MACABRE TEST — LOCATIONS
// =============================================================================
// 3 hardcoded Virginia Beach Sinister Sites for proof-of-concept testing.
// To add more locations as admin, just append to this array.
// Coordinates are approximate — verified against public records.
// =============================================================================

export interface SinisterSite {
  id: string;
  title: string;
  category: 'haunting' | 'crime' | 'film' | 'historical' | 'cult' | 'disaster';
  coords: { lat: number; lng: number };
  radiusMeters: number; // geofence radius for this site
  shortDescription: string; // shown in notification
  fullDescription: string; // shown in detail view
  imageUrl: string;
  imageCredit: string;
}

export const SINISTER_SITES: SinisterSite[] = [
  {
    id: 'cavalier-hotel',
    title: 'The Cavalier Hotel',
    category: 'haunting',
    coords: { lat: 36.8534, lng: -75.9760 },
    radiusMeters: 800, // ~0.5 miles
    shortDescription:
      'Adolph Coors fell to his death from a 6th-floor window in 1929. He never left.',
    fullDescription:
      'Built in 1927 as the crown jewel of the Virginia Beach oceanfront, The Cavalier Hotel hosted seven U.S. presidents and earned a reputation that long outlasted its golden age. In 1929, brewing magnate Adolph Coors fell to his death from a sixth-floor window under circumstances that were never satisfactorily explained — ruled a suicide by some accounts, whispered about as something darker by others.\n\nStaff and guests have reported the smell of cigar smoke drifting through unused floors, elevator buttons illuminating without being pressed, and the figure of a man in early-20th-century formal wear glimpsed in mirrors and corridors. Following its 2018 restoration, the Cavalier remains operational — and the reports continue.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Cavalier_Hotel_Virginia_Beach.jpg/1280px-Cavalier_Hotel_Virginia_Beach.jpg',
    imageCredit: 'Wikimedia Commons',
  },
  {
    id: 'ferry-plantation',
    title: 'Ferry Plantation House',
    category: 'haunting',
    coords: { lat: 36.892, lng: -76.11 },
    radiusMeters: 800,
    shortDescription:
      'Eleven distinct ghosts. The site of the Witch of Pungo trial.',
    fullDescription:
      'Ferry Plantation House sits on land that has witnessed nearly four centuries of Virginia history — and, by many accounts, refuses to let any of it go. Built in 1830 atop the foundations of earlier structures dating to 1642, the property has been the site of multiple drownings near the original ferry crossing and at least one murder.\n\nLocal paranormal investigators have catalogued eleven distinct apparitions reported by visitors and staff, including the "Lady in White," a former owner named Sarah, and a young boy who appears in upstairs windows. The site is also tied to one of the darkest chapters in Virginia colonial history: the 1706 trial of Grace Sherwood, the only person in the state ever convicted of witchcraft by water trial. Sherwood\'s ducking pond lies a short distance from the house.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Ferry_Plantation_House.jpg/1280px-Ferry_Plantation_House.jpg',
    imageCredit: 'Wikimedia Commons',
  },
  {
    id: 'cape-henry-lighthouse',
    title: 'Cape Henry Lighthouse',
    category: 'historical',
    coords: { lat: 36.9265, lng: -76.007 },
    radiusMeters: 800,
    shortDescription:
      'The first lighthouse authorized by the U.S. government. Its keeper never left his post.',
    fullDescription:
      'Commissioned by George Washington in 1789 and completed in 1792, Cape Henry Lighthouse was the first public works project authorized by the newly formed U.S. federal government. For nearly a century it guided ships into the Chesapeake Bay through some of the most treacherous waters on the Atlantic coast.\n\nThe original tower, now decommissioned, sits within the grounds of Fort Story military base. Visitors and military personnel have long reported the figure of a former lighthouse keeper still climbing the spiral stairs, particularly during storms. The surrounding Fort Story area carries its own weight of Civil War-era apparitions, and the dunes between the old and new lighthouses have been the site of multiple unexplained sightings over the decades.',
    imageUrl:
      'https://upload.wikimedia.org/wikipedia/commons/thumb/6/63/Cape_Henry_Lighthouse_2008.jpg/1024px-Cape_Henry_Lighthouse_2008.jpg',
    imageCredit: 'Wikimedia Commons',
  },
];
