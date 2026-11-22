import type { Read } from './values.js';

/**
 * ISO 3166-1 alpha-3 → alpha-2. The MVP stored flags as typed by users
 * ("USA", "IDN", "Indonesia", "ID"); v2 `vessels.flag` is ISO 3166-1 alpha-2
 * (`^[A-Z]{2}$`).
 */
const ALPHA3_TO_ALPHA2_TEXT =
  'AFG:AF ALA:AX ALB:AL DZA:DZ ASM:AS AND:AD AGO:AO AIA:AI ATA:AQ ATG:AG ARG:AR ARM:AM ' +
  'ABW:AW AUS:AU AUT:AT AZE:AZ BHS:BS BHR:BH BGD:BD BRB:BB BLR:BY BEL:BE BLZ:BZ BEN:BJ ' +
  'BMU:BM BTN:BT BOL:BO BES:BQ BIH:BA BWA:BW BVT:BV BRA:BR IOT:IO BRN:BN BGR:BG BFA:BF ' +
  'BDI:BI CPV:CV KHM:KH CMR:CM CAN:CA CYM:KY CAF:CF TCD:TD CHL:CL CHN:CN CXR:CX CCK:CC ' +
  'COL:CO COM:KM COG:CG COD:CD COK:CK CRI:CR CIV:CI HRV:HR CUB:CU CUW:CW CYP:CY CZE:CZ ' +
  'DNK:DK DJI:DJ DMA:DM DOM:DO ECU:EC EGY:EG SLV:SV GNQ:GQ ERI:ER EST:EE SWZ:SZ ETH:ET ' +
  'FLK:FK FRO:FO FJI:FJ FIN:FI FRA:FR GUF:GF PYF:PF ATF:TF GAB:GA GMB:GM GEO:GE DEU:DE ' +
  'GHA:GH GIB:GI GRC:GR GRL:GL GRD:GD GLP:GP GUM:GU GTM:GT GGY:GG GIN:GN GNB:GW GUY:GY ' +
  'HTI:HT HMD:HM VAT:VA HND:HN HKG:HK HUN:HU ISL:IS IND:IN IDN:ID IRN:IR IRQ:IQ IRL:IE ' +
  'IMN:IM ISR:IL ITA:IT JAM:JM JPN:JP JEY:JE JOR:JO KAZ:KZ KEN:KE KIR:KI PRK:KP KOR:KR ' +
  'KWT:KW KGZ:KG LAO:LA LVA:LV LBN:LB LSO:LS LBR:LR LBY:LY LIE:LI LTU:LT LUX:LU MAC:MO ' +
  'MDG:MG MWI:MW MYS:MY MDV:MV MLI:ML MLT:MT MHL:MH MTQ:MQ MRT:MR MUS:MU MYT:YT MEX:MX ' +
  'FSM:FM MDA:MD MCO:MC MNG:MN MNE:ME MSR:MS MAR:MA MOZ:MZ MMR:MM NAM:NA NRU:NR NPL:NP ' +
  'NLD:NL NCL:NC NZL:NZ NIC:NI NER:NE NGA:NG NIU:NU NFK:NF MKD:MK MNP:MP NOR:NO OMN:OM ' +
  'PAK:PK PLW:PW PSE:PS PAN:PA PNG:PG PRY:PY PER:PE PHL:PH PCN:PN POL:PL PRT:PT PRI:PR ' +
  'QAT:QA REU:RE ROU:RO RUS:RU RWA:RW BLM:BL SHN:SH KNA:KN LCA:LC MAF:MF SPM:PM VCT:VC ' +
  'WSM:WS SMR:SM STP:ST SAU:SA SEN:SN SRB:RS SYC:SC SLE:SL SGP:SG SXM:SX SVK:SK SVN:SI ' +
  'SLB:SB SOM:SO ZAF:ZA SGS:GS SSD:SS ESP:ES LKA:LK SDN:SD SUR:SR SJM:SJ SWE:SE CHE:CH ' +
  'SYR:SY TWN:TW TJK:TJ TZA:TZ THA:TH TLS:TL TGO:TG TKL:TK TON:TO TTO:TT TUN:TN TUR:TR ' +
  'TKM:TM TCA:TC TUV:TV UGA:UG UKR:UA ARE:AE GBR:GB USA:US UMI:UM URY:UY UZB:UZ VUT:VU ' +
  'VEN:VE VNM:VN VGB:VG VIR:VI WLF:WF ESH:EH YEM:YE ZMB:ZM ZWE:ZW';

export const ALPHA3_TO_ALPHA2: ReadonlyMap<string, string> = new Map(
  ALPHA3_TO_ALPHA2_TEXT.split(' ').map((pair) => {
    const [alpha3, alpha2] = pair.split(':') as [string, string];
    return [alpha3, alpha2];
  }),
);

const ALPHA2_CODES: ReadonlySet<string> = new Set(ALPHA3_TO_ALPHA2.values());

/** Common English names that differ from the CLDR display names. */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  usa: 'US',
  'united states of america': 'US',
  america: 'US',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  'south korea': 'KR',
  'republic of korea': 'KR',
  'north korea': 'KP',
  russia: 'RU',
  'russian federation': 'RU',
  vietnam: 'VN',
  'viet nam': 'VN',
  turkey: 'TR',
  holland: 'NL',
  'the netherlands': 'NL',
  burma: 'MM',
  'ivory coast': 'CI',
  'east timor': 'TL',
  'cape verde': 'CV',
  swaziland: 'SZ',
  'czech republic': 'CZ',
  'marshall islands': 'MH',
  'hong kong': 'HK',
  macau: 'MO',
  taiwan: 'TW',
  laos: 'LA',
  brunei: 'BN',
  'brunei darussalam': 'BN',
  'timor leste': 'TL',
};

function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let namesByLocale: ReadonlyMap<string, string> | undefined;

/** English and Indonesian CLDR region names → alpha-2 (built once). */
function countryNames(): ReadonlyMap<string, string> {
  if (namesByLocale !== undefined) return namesByLocale;
  const names = new Map<string, string>();
  for (const locale of ['en', 'id']) {
    const display = new Intl.DisplayNames([locale], {
      type: 'region',
      fallback: 'none',
    });
    for (const code of ALPHA2_CODES) {
      const name = display.of(code);
      if (name !== undefined) names.set(normalizeName(name), code);
    }
  }
  for (const [alias, code] of Object.entries(NAME_ALIASES))
    names.set(alias, code);
  namesByLocale = names;
  return names;
}

/**
 * The ISO 3166-1 alpha-2 flag of a legacy flag value: an alpha-2 code
 * (any case), an alpha-3 code ("USA" → "US", "IDN" → "ID") or an English or
 * Indonesian country name ("Indonesia", "Singapore", "Belanda"). `undefined`
 * when the value cannot be mapped.
 */
export function toFlagAlpha2(value: string): Read<string> | undefined {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && ALPHA2_CODES.has(upper))
    return { value: upper, adjusted: upper !== value };
  if (/^[A-Z]{3}$/.test(upper)) {
    const alpha2 = ALPHA3_TO_ALPHA2.get(upper);
    if (alpha2 !== undefined) return { value: alpha2, adjusted: true };
  }
  const byName = countryNames().get(normalizeName(trimmed));
  return byName === undefined ? undefined : { value: byName, adjusted: true };
}
