// Macrow · actualizador diario de noticias
// Lo ejecuta GitHub Actions una vez al día. Lee fuentes RSS y PubMed,
// puntúa cada noticia (más peso a Heavy Duty / alta intensidad y a la
// evidencia científica) y guarda el resultado en noticias.json.
// No usa claves ni servicios de pago. Requiere Node 18+ (fetch nativo).

import { readFile, writeFile } from 'node:fs/promises';

const OUT = process.env.NOTICIAS_OUT || 'noticias.json';
const KEEP_DAYS = 45;      // cuánto tiempo se guarda una noticia
const MAX_ITEMS = 120;
const UA = 'MacrowNews/1.0 (+https://github.com)';

/* ---------- fuentes ---------- */
// filtro: true = solo entra si habla de entreno o nutrición (fuentes generalistas)
const FEEDS = [
  { src: 'Stronger by Science', url: 'https://www.strongerbyscience.com/feed/', lang: 'en', filtro: false },
  { src: 'Menno Henselmans', url: 'https://mennohenselmans.com/feed/', lang: 'en', filtro: false },
  { src: 'ScienceDaily · Fitness', url: 'https://www.sciencedaily.com/rss/health_medicine/fitness.xml', lang: 'en', filtro: true },
  { src: 'ScienceDaily · Nutrición', url: 'https://www.sciencedaily.com/rss/health_medicine/nutrition.xml', lang: 'en', filtro: true },
  { src: 'ScienceDaily · Medicina deportiva', url: 'https://www.sciencedaily.com/rss/health_medicine/sports_medicine.xml', lang: 'en', filtro: true },
  { src: 'Vitónica', url: 'https://www.vitonica.com/index.xml', lang: 'es', filtro: true },
  { src: 'Fitness Revolucionario', url: 'https://www.fitnessrevolucionario.com/feed/', lang: 'es', filtro: true },
];

// Búsquedas en PubMed (estudios publicados en los últimos 120 días)
const PUBMED = [
  { q: '("resistance training"[tiab] OR "strength training"[tiab] OR "weight training"[tiab]) AND ' +
       '(failure[tiab] OR "single set"[tiab] OR "low volume"[tiab] OR "low-volume"[tiab] OR ' +
       '"high-intensity"[tiab] OR "training volume"[tiab] OR "rest-pause"[tiab] OR "drop set"[tiab])', n: 10 },
  { q: '(hypertrophy[tiab] OR "muscle mass"[tiab] OR "muscle strength"[tiab]) AND "resistance training"[tiab] AND ' +
       '(randomized[tiab] OR meta-analysis[pt] OR systematic review[pt])', n: 8 },
  { q: '("protein intake"[tiab] OR "protein supplementation"[tiab] OR creatine[tiab] OR "energy deficit"[tiab] OR ' +
       '"caloric restriction"[tiab]) AND ("resistance training"[tiab] OR "lean mass"[tiab] OR hypertrophy[tiab]) AND humans[mh]', n: 8 },
];

/* ---------- puntuación ---------- */
const KW = {
  hd: ['heavy duty', 'mentzer', 'high-intensity training', 'high intensity training', 'to failure', 'muscular failure',
       'momentary failure', 'training to failure', 'al fallo', 'fallo muscular', 'single set', 'one set', 'una serie',
       'una sola serie', 'low volume', 'low-volume', 'bajo volumen', 'volumen de entrenamiento', 'training volume',
       'rest-pause', 'rest pause', 'drop set', 'drop-set', 'negativas', 'negatives', 'proximity to failure', 'rir ',
       'intensity of effort', 'intensidad'],
  entreno: ['hypertrophy', 'hipertrofia', 'muscle growth', 'crecimiento muscular', 'strength', 'fuerza',
            'resistance training', 'entrenamiento de fuerza', 'weight training', 'gym', 'gimnasio', 'lifting',
            'pesas', 'squat', 'sentadilla', 'bench press', 'press banca', 'deadlift', 'peso muerto', 'recovery',
            'recuperación', 'workout', 'entrenamiento', 'exercise', 'ejercicio', 'muscle', 'músculo', 'muscular',
            'range of motion', 'rango de movimiento', 'lengthened', 'periodiz', 'sets', 'series'],
  nutri: ['protein', 'proteína', 'creatine', 'creatina', 'calorie', 'caloría', 'calórico', 'deficit', 'déficit',
          'diet', 'dieta', 'nutrition', 'nutrición', 'carbohydrate', 'carbohidrato', 'fat loss', 'pérdida de grasa',
          'bulking', 'volumen limpio', 'supplement', 'suplement', 'micronutri', 'vitamin', 'vitamina', 'fiber',
          'fibra', 'food', 'alimento', 'meal', 'comida', 'ayuno', 'fasting', 'macros', 'whey'],
  evid: ['meta-analysis', 'metaanálisis', 'meta-análisis', 'systematic review', 'revisión sistemática',
         'randomized', 'randomised', 'aleatorizado', 'controlled trial', 'ensayo', 'study', 'estudio',
         'researchers', 'investigadores', 'scientists', 'científicos'],
};
const count = (t, list) => list.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);

function score(it) {
  const t = (' ' + it.t + ' ' + (it.pts || []).map(p => p.t).join(' ') + ' ').toLowerCase();
  const hd = count(t, KW.hd), en = count(t, KW.entreno), nu = count(t, KW.nutri), ev = count(t, KW.evid);
  let sc = Math.min(hd, 4) * 4 + Math.min(en, 4) * 1.5 + Math.min(nu, 4) * 1.5 + Math.min(ev, 3) * 1.5;
  if (it.tipo && /meta|sistem|aleatoriz/i.test(it.tipo)) sc += 4;
  if (it.est) sc += 2;
  const ageH = (Date.now() - new Date(it.d).getTime()) / 36e5;
  if (ageH < 48) sc += 3; else if (ageH < 24 * 7) sc += 1.5;
  return {
    sc: Math.round(sc * 10) / 10,
    hd: hd > 0,
    cat: nu >= en && nu > 0 ? 'nutricion' : 'entreno',
    est: it.est || /meta-analysis|systematic review|randomi[sz]ed|metaanálisis|ensayo/.test(t),
    rel: hd + en + nu,
  };
}

/* ---------- utilidades ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) return await r.text();
      console.warn('HTTP', r.status, url);
    } catch (e) { console.warn('Error', url, e.message); }
    await sleep(1500);
  }
  return null;
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', deg: '°' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n] ?? m);
}
function clean(html) {
  let s = String(html || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decode(s); // algunos feeds escapan el HTML dos veces
  s = s.replace(/<(script|style|figure|figcaption)[\s\S]*?<\/\1>/gi, ' ')
       .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n')
       .replace(/<[^>]+>/g, ' ');
  s = decode(s);
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}
// corta en final de frase, sin pasar de max caracteres
function cut(s, max) {
  s = s.replace(/\n+/g, ' ').trim();
  if (s.length <= max) return s;
  const part = s.slice(0, max);
  const end = Math.max(part.lastIndexOf('. '), part.lastIndexOf('? '), part.lastIndexOf('! '));
  return (end > max * 0.5 ? part.slice(0, end + 1) : part.replace(/\s+\S*$/, '') + '…').trim();
}
const tag = (xml, name) => {
  const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'));
  return m ? m[1] : '';
};
const idOf = url => 'n' + [...url].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);

/* ---------- RSS / Atom ---------- */
function parseFeed(xml, f) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const title = clean(tag(b, 'title'));
    let link = clean(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const date = clean(tag(b, 'pubDate') || tag(b, 'dc:date') || tag(b, 'published') || tag(b, 'updated'));
    const desc = clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'));
    const d = new Date(date);
    if (!title || !/^https?:\/\//.test(link)) return null;
    return { id: idOf(link), t: title, src: f.src, url: link, lang: f.lang,
      d: isNaN(d) ? new Date().toISOString() : d.toISOString(),
      pts: desc ? [{ h: 'Resumen', t: cut(desc, 700) }] : [], filtro: f.filtro };
  }).filter(Boolean);
}

/* ---------- PubMed (E-utilities oficiales del NCBI) ---------- */
const EU = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
async function pubmed() {
  const ids = new Set();
  for (const p of PUBMED) {
    const u = EU + 'esearch.fcgi?db=pubmed&retmode=json&sort=pub_date&reldate=120&datetype=pdat' +
      '&tool=macrow&retmax=' + p.n + '&term=' + encodeURIComponent(p.q);
    const txt = await get(u);
    try { JSON.parse(txt).esearchresult.idlist.forEach(i => ids.add(i)); } catch { console.warn('PubMed sin resultados'); }
    await sleep(500);
  }
  if (!ids.size) return [];
  const xml = await get(EU + 'efetch.fcgi?db=pubmed&retmode=xml&tool=macrow&id=' + [...ids].join(','));
  if (!xml) return [];
  const arts = xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) || [];
  const MES = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  return arts.map(a => {
    const pmid = clean(tag(a, 'PMID'));
    const title = clean(tag(a, 'ArticleTitle'));
    const journal = clean(tag(tag(a, 'Journal'), 'Title'));
    const types = (a.match(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g) || []).map(x => clean(x));
    const tipo = types.includes('Meta-Analysis') ? 'Metaanálisis'
      : types.includes('Systematic Review') ? 'Revisión sistemática'
      : types.includes('Randomized Controlled Trial') ? 'Ensayo aleatorizado'
      : types.includes('Review') ? 'Revisión' : 'Estudio';
    // fecha: ArticleDate (electrónica) o PubDate
    const ad = tag(a, 'ArticleDate') || tag(a, 'PubDate');
    const y = +clean(tag(ad, 'Year')) || new Date().getFullYear();
    const mRaw = clean(tag(ad, 'Month'));
    const m = isNaN(+mRaw) ? (MES[mRaw.slice(0, 3).toLowerCase()] ?? 0) : +mRaw - 1;
    const dd = +clean(tag(ad, 'Day')) || 1;
    // resumen: secciones etiquetadas; la conclusión va primero
    const parts = [...a.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(x => {
      const lab = (x[1].match(/Label="([^"]+)"/) || [])[1] || '';
      return { lab: lab.toUpperCase(), t: clean(x[2]) };
    }).filter(x => x.t);
    const H = { CONCLUSION: 'Conclusión', CONCLUSIONS: 'Conclusión', RESULTS: 'Resultados', OBJECTIVE: 'Objetivo',
      PURPOSE: 'Objetivo', BACKGROUND: 'Contexto', AIM: 'Objetivo', AIMS: 'Objetivo', METHODS: 'Métodos', INTRODUCTION: 'Contexto' };
    let pts;
    if (parts.length > 1 && parts.some(p => p.lab)) {
      const order = ['CONCLUSION', 'CONCLUSIONS', 'RESULTS', 'OBJECTIVE', 'PURPOSE', 'AIM', 'AIMS', 'BACKGROUND', 'INTRODUCTION'];
      pts = order.flatMap(l => parts.filter(p => p.lab === l)).slice(0, 3)
        .map(p => ({ h: H[p.lab] || 'Resumen', t: cut(p.t, 450) }));
    } else if (parts.length) {
      pts = [{ h: 'Resumen', t: cut(parts.map(p => p.t).join(' '), 800) }];
    } else pts = [];
    if (!pmid || !title) return null;
    const url = 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/';
    return { id: 'pm' + pmid, t: title, src: 'PubMed · ' + (journal || 'revista científica'), url, lang: 'en',
      d: new Date(Date.UTC(y, m, dd, 12)).toISOString(), pts, est: true, tipo };
  }).filter(Boolean);
}

/* ---------- principal ---------- */
export async function main() {
  let prev = { items: [] };
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const today = new Date().toISOString().slice(0, 10);

  const fresh = [];
  for (const f of FEEDS) {
    const xml = await get(f.url);
    if (!xml) continue;
    const items = parseFeed(xml, f);
    console.log(f.src + ':', items.length);
    fresh.push(...items);
  }
  const pm = await pubmed();
  console.log('PubMed:', pm.length);
  fresh.push(...pm);

  const byId = new Map((prev.items || []).map(i => [i.id, i]));
  const limit = Date.now() - KEEP_DAYS * 864e5;
  for (const it of fresh) {
    if (new Date(it.d).getTime() < limit) continue;
    const s = score(it);
    if (it.filtro && s.rel === 0) continue; // fuente generalista que no habla de esto
    delete it.filtro;
    const old = byId.get(it.id);
    byId.set(it.id, { ...it, ...s, fs: old ? old.fs : today });
  }
  // recalcula puntuaciones (la antigüedad cambia cada día) y limpia lo viejo
  let items = [...byId.values()].filter(i => new Date(i.d).getTime() >= limit)
    .map(i => ({ ...i, ...score(i) }));
  items.sort((a, b) => new Date(b.d) - new Date(a.d));
  items = items.slice(0, MAX_ITEMS);

  // destacados: los mejor puntuados de los últimos 10 días
  const recent = Date.now() - 10 * 864e5;
  const dest = items.filter(i => new Date(i.d).getTime() >= recent && i.sc >= 8)
    .sort((a, b) => b.sc - a.sc).slice(0, 5);
  const top = dest.length >= 3 ? dest : [...items].sort((a, b) => b.sc - a.sc).slice(0, 3);
  const destIds = new Set(top.map(i => i.id));
  items.forEach(i => { i.dest = destIds.has(i.id); delete i.rel; });

  const out = { updated: new Date().toISOString(), items };
  await writeFile(OUT, JSON.stringify(out, null, 1));
  console.log('Guardadas', items.length, 'noticias ·', destIds.size, 'destacadas');
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('noticias.mjs')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
