/**
 * Custom master server. The original client ships a static `gameServers` list
 * (all on *.mathstudyguides.com). We keep those entries, and add the extra
 * regions. Every entry is served by this process – the id selects a virtual
 * game-server instance behind /gs/<id>.
 */
export interface ServerEntry {
  id: string;
  name: string;
  url: string;
  region: string;
  gm: number;
}

/** [region label, id prefix, how many servers to *add*, first index] */
const EXTRA: [string, string, number, number][] = [
  ["New York, USA", "prod-lnd-us-ny", 3, 2],
  ["Los Angeles, USA", "prod-lnd-us-la", 1, 2],
  ["Sao Paulo, Brazil", "prod-lnd-br-sp", 1, 2],
  ["Frankfurt, Germany", "prod-ovh-de-ff", 2, 2],
  ["Paris, France", "prod-ovh-fr-pr", 1, 2],
  ["Stockholm, Sweden", "prod-lnd-sw-sh", 2, 2],
  ["Chicago, USA", "prod-lnd-us-ch", 4, 1],
  ["Seattle, USA", "prod-lnd-us-se", 2, 1],
  ["Amsterdam, Netherlands", "prod-ovh-nl-am", 4, 1],
  ["San Francisco, USA", "prod-lnd-us-sf", 3, 1],
  ["Tokyo, Japan", "prod-lnd-jp-tk", 1, 1],
  ["Roubaix, France", "prod-ovh-fr-rb", 3, 1],
  ["Moscow, Russia", "prod-lnd-ru-mw", 2, 1],
  ["Shanghai, China", "prod-lnd-cn-sh", 1, 1],
  ["Mumbai, India", "prod-lnd-in-mb", 1, 1],
];

export function buildServerList(base: { id: string; name: string; region: string; gm?: number }[]): ServerEntry[] {
  const list: ServerEntry[] = base.map((s) => ({ id: s.id, name: s.name, url: "", region: s.region, gm: s.gm ?? 0 }));
  for (const [region, prefix, count, first] of EXTRA) {
    const city = region.split(",")[0];
    for (let n = first; n < first + count; n++) {
      const id = `${prefix}-${n}`;
      if (!list.some((s) => s.id === id)) list.push({ id, name: `${city} ${n}`, url: "", region, gm: 0 });
    }
  }
  return list;
}

/** What the browser receives (url is filled in client-side by host). */
export function publicList(list: ServerEntry[], host: string): ServerEntry[] {
  return list.map((s) => ({ ...s, url: `${host}/gs/${s.id}` }));
}
