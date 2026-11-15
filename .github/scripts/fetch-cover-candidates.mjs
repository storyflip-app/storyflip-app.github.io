#!/usr/bin/env node
/**
 * Runs on GitHub Actions (the dev container has no access to museum servers).
 * For every public-domain classic, searches two CC0 open-access collections for fitting public-domain
 * artwork and downloads 600px previews, so a human (or Claude) can pick a cover:
 *   - Art Institute of Chicago API (CC0 for works marked is_public_domain)
 *   - The Metropolitan Museum of Art Open Access API (CC0 for works marked isPublicDomain)
 * Output: cover-candidates/<bookId>/<source>-<id>.jpg + cover-candidates/candidates.json
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('cover-candidates');
const UA = 'StoryFlip-cover-fetch/1.0 (storyflip-app.github.io)';
const QUERIES = {
  'pride-and-prejudice': ['portrait young woman 1810', 'English country house landscape', 'regency lady portrait'],
  frankenstein: ['glacier mountains', 'Mont Blanc', 'stormy sea night'],
  'wizard-of-oz': ['prairie farm', 'Kansas landscape', 'cyclone storm plains'],
  'little-women': ['girls reading', 'sisters sewing', 'women reading by the fire'],
  'scandal-in-bohemia': ['London street', 'Victorian woman portrait', 'carriage night street'],
  'gift-of-the-magi': ['New York winter snow', 'woman brushing long hair', 'Christmas shop window'],
  'the-last-leaf': ['ivy leaves autumn', 'autumn leaves wall', 'Greenwich Village'],
  'telltale-heart': ['lantern night', 'old man portrait dark', 'candlelight interior night'],
  'the-open-window': ['open window garden', 'country house window', 'French window lawn'],
  'dream-of-an-hour': ['woman at window spring', 'spring blossom trees', 'woman looking out window'],
};

async function json(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function download(url, file, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

async function aic(q) {
  const params = new URLSearchParams({ q, limit: '6', fields: 'id,title,artist_display,date_display,image_id,is_public_domain,thumbnail' });
  params.set('query[term][is_public_domain]', 'true');
  const res = await json(`https://api.artic.edu/api/v1/artworks/search?${params}`, { 'AIC-User-Agent': UA });
  return res.data
    .filter((a) => a.is_public_domain && a.image_id)
    .slice(0, 3)
    .map((a) => ({
      source: 'aic',
      id: a.id,
      imageId: a.image_id,
      title: a.title,
      artist: a.artist_display,
      date: a.date_display,
      page: `https://www.artic.edu/artworks/${a.id}`,
      image: `https://www.artic.edu/iiif/2/${a.image_id}/full/600,/0/default.jpg`,
      license: 'CC0 (Art Institute of Chicago, public domain)',
    }));
}

async function met(q) {
  const res = await json(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const id of (res.objectIDs ?? []).slice(0, 20)) {
    if (out.length >= 2) break;
    try {
      const o = await json(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`);
      if (!o.isPublicDomain || !o.primaryImageSmall) continue;
      if (!/Paintings|Drawings|Prints|Photographs/i.test(o.department + ' ' + o.classification)) continue;
      out.push({
        source: 'met',
        id: o.objectID,
        title: o.title,
        artist: [o.artistDisplayName, o.artistDisplayBio].filter(Boolean).join(', '),
        date: o.objectDate,
        page: o.objectURL,
        image: o.primaryImageSmall,
        imageLarge: o.primaryImage,
        license: 'CC0 (The Metropolitan Museum of Art Open Access, public domain)',
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

const all = {};
for (const [bookId, queries] of Object.entries(QUERIES)) {
  const dir = path.join(OUT, bookId);
  fs.mkdirSync(dir, { recursive: true });
  const found = [];
  for (const q of queries) {
    for (const fn of [aic, met]) {
      try {
        for (const c of await fn(q)) if (!found.some((f) => f.source === c.source && f.id === c.id)) found.push({ ...c, query: q });
      } catch (e) {
        console.log(`  ${fn.name} "${q}": ${e.message}`);
      }
    }
  }
  const kept = [];
  for (const c of found.slice(0, 8)) {
    const file = path.join(dir, `${c.source}-${c.id}.jpg`);
    try {
      await download(c.image, file, c.source === 'aic' ? { 'AIC-User-Agent': UA } : {});
      kept.push({ ...c, file: path.relative(OUT, file) });
    } catch (e) {
      console.log(`  download ${c.source}-${c.id}: ${e.message}`);
    }
  }
  all[bookId] = kept;
  console.log(`${bookId}: ${kept.length} candidates`);
}
fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify(all, null, 2));
