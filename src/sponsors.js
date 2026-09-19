/*
 * sponsors.js: the sponsors this board mints links for, and the only
 * vocabulary a `utm_source` can take.
 *
 * A SPONSOR LINK IS A SLUG, NOT A STRING SOMEBODY TYPED.
 *
 * The statistics page counts where its visitors came from, and the obvious
 * way to do that is to store whatever `utm_source` said. That is also the
 * way to let any stranger with curl add a row to a public page: a thousand
 * posts carrying a thousand invented sources is a thousand rows in a table
 * nobody can clean, each one printed under a heading that says "where
 * pilots came from". So a source is a slug on THIS list or it is `other`,
 * and `other` is one row however many strangers arrive.
 *
 * It is a list of sponsors, not a rule about them, for the same reason
 * src/admin.js is a list of addresses: a rule ("anything that looks like a
 * slug") is a rule somebody else can satisfy.
 *
 * WHAT A LINK IS. `{sim}/?utm_source=<slug>&utm_medium=sponsor`, minted by
 * the Admin panel and copied by whoever looks after the board. It points at
 * the simulator rather than the front door because a pilot arriving from a
 * sponsor should be flying in one click. `utm_medium` and `utm_campaign`
 * are for the sponsor's own reporting and are never read here.
 *
 * WHAT IT IS NOT. It is not a tracking identifier and it cannot become one.
 * The slug is stored in the visitor's own browser for thirty days and rides
 * on the events that browser sends as one of a handful of known words. It
 * says which poster somebody walked past, not who they are.
 *
 * This file is part of WebFPVLeaderboard.
 *
 * WebFPVLeaderboard is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at
 * your option) any later version.
 *
 * WebFPVLeaderboard is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY, without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with WebFPVLeaderboard. If not, see <https://www.gnu.org/licenses/>.
 */

/*
 * The shape of a slug, which is the same on both sides of the wire: the
 * simulator checks it before storing what it read out of a query, and this
 * file checks it again before believing anything that arrives. Lower case
 * so that a poster printed in capitals and a link typed in lower case are
 * one sponsor rather than two rows.
 */
export const SOURCE_RE = /^[a-z0-9-]{2,32}$/;

/*
 * The two keys that are not sponsors and are always in the table.
 *
 * `direct` is an arrival carrying no source at all, which is most of them.
 * `other` is an arrival carrying a source this board has never heard of,
 * folded into one row on purpose. Neither can be a sponsor slug, because
 * SOURCE_RE would accept both words: they are excluded below.
 */
export const SOURCE_DIRECT = 'direct';
export const SOURCE_OTHER = 'other';
const RESERVED = new Set([SOURCE_DIRECT, SOURCE_OTHER]);

/*
 * The built-in list, which is empty, and that is the right default.
 *
 * An empty list is a board with no sponsors: every arrival is `direct` or
 * `other`, the statistics page prints those two rows, and the Admin panel
 * says there is nobody to mint a link for. A made up example sponsor here
 * would ship a name that is not a sponsor onto a public page, and somebody
 * would have to notice it was fictional.
 *
 * BOARD_SPONSORS is how a host names its own, the same shape BOARD_ADMINS
 * uses and for the same reason: one entry per line or comma separated, and
 * setting it REPLACES this rather than adding to it.
 *
 *   BOARD_SPONSORS=rotorriot:Rotor Riot,fpvshop:The FPV Shop
 *
 * The slug is what travels in a link and must not change once a poster is
 * printed. The name is what the page prints and can.
 */
const DEFAULT_SPONSORS = [];

/* A display name is printed on a public page, so it is bounded and stripped
 * of control and format characters. It reaches the DOM through textContent
 * either way; this is so a name cannot be a paragraph or carry a direction
 * override. Letters of any alphabet stay: a sponsor called Café FPV is
 * called that. */
const NAME_MAX = 40;

function cleanName(raw) {
  return String(raw ?? '')
    .replace(/\p{C}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/*
 * Parse the environment's list, or the built-in one. Entries that do not
 * parse are DROPPED rather than throwing: a typo in one sponsor's row
 * should cost that sponsor its link, not take the whole board down on
 * boot. The count is what the Admin panel prints, so a dropped row is
 * visible to whoever set it.
 */
function parseSponsors(raw) {
  const text = String(raw ?? '').trim();
  const entries = text
    ? text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SPONSORS;
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const at = entry.indexOf(':');
    const slug = (at < 0 ? entry : entry.slice(0, at)).trim().toLowerCase();
    if (!SOURCE_RE.test(slug) || RESERVED.has(slug) || seen.has(slug)) {
      continue;
    }
    /* A row with no name at all is legal and prints its own slug, because a
     * sponsor whose link works and whose heading reads "rotorriot" is
     * better than a sponsor with no link. */
    const name = cleanName(at < 0 ? '' : entry.slice(at + 1)) || slug;
    seen.add(slug);
    out.push({ slug, name });
  }
  return out;
}

const SPONSORS = parseSponsors(process.env.BOARD_SPONSORS);
const BY_SLUG = new Map(SPONSORS.map((s) => [s.slug, s]));

/* Every sponsor, in the order the host wrote them. A copy, so a caller
 * cannot rearrange the list the rest of the process reads. */
export function sponsorList() {
  return SPONSORS.map((s) => ({ ...s }));
}

export function sponsorCount() {
  return SPONSORS.length;
}

export function isSponsorSlug(slug) {
  return BY_SLUG.has(String(slug ?? ''));
}

/*
 * What the page prints for a source key. A sponsor's name, or a sentence
 * for the two reserved keys. Never the raw key for something unknown,
 * because nothing unknown gets this far: see sourceKey.
 */
export function sponsorName(key) {
  const slug = String(key ?? '');
  if (slug === SOURCE_DIRECT) {
    return 'Direct';
  }
  if (slug === SOURCE_OTHER) {
    return 'Other';
  }
  const found = BY_SLUG.get(slug);
  return found ? found.name : slug;
}

/*
 * THE FOLD, and it is the whole security property of this file.
 *
 * Whatever arrives becomes exactly one of: a slug on the list, `direct`, or
 * `other`. Nothing else is ever stored, so the sources table has at most
 * two rows more than the host wrote down, whatever anybody posts.
 */
export function sourceKey(raw) {
  if (raw == null || raw === '') {
    return SOURCE_DIRECT;
  }
  const slug = String(raw).trim().toLowerCase();
  if (slug === SOURCE_DIRECT) {
    return SOURCE_DIRECT;
  }
  return isSponsorSlug(slug) ? slug : SOURCE_OTHER;
}

/*
 * The link a sponsor is given. Built here rather than in the page so that
 * the shape lives in one file, and taking the simulator's origin as an
 * argument because only the server knows it.
 */
export function sponsorLink(simOrigin, slug) {
  const base = String(simOrigin || '').replace(/\/+$/, '');
  return `${base}/?utm_source=${encodeURIComponent(slug)}&utm_medium=sponsor`;
}
