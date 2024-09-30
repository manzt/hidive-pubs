import { z } from "npm:zod@3.23.8";
import he from "npm:he@1.2.0";
import ProgressBar from "jsr:@deno-library/progress@1.4.9";
import { assert } from "jsr:@std/assert@1.0.6";
import { stringify } from "jsr:@std/csv@1.0.3";

let HIDIVE_GROUP_ID = "5145258";
let HIDIVE_PUBLICATIONS_COLLECTION_ID = "YGTEVG73";
let HIDIVE_PREPRINTS_COLLECTION_ID = "AJKTPNSI";
let BASE_URL = new URL(`https://api.zotero.org/groups/${HIDIVE_GROUP_ID}/`);

type ZoteroItem = z.infer<typeof zoteroItemResponse>;
type Author = ZoteroItem["creators"][number];

let zoteroItemDataSchema = z.object({
  key: z.string(),
  version: z.number(),
  itemType: z.string(),
  title: z.string(),
  creators: z.union([
    z.object({
      creatorType: z.string(),
      name: z.string(),
    }),
    z.object({
      creatorType: z.string(),
      firstName: z.string(),
      lastName: z.string(),
    }),
  ]).array(),
  abstractNote: z.string().transform((value) =>
    value.replace(/^Abstract\s+/, "") // remove "Abstract" prefix
  ).optional(),
  publicationTitle: z.string().transform((v) => v === "" ? undefined : v)
    .optional(),
  volume: z.string().transform((v) => v === "" ? undefined : v).optional(),
  issue: z.string().transform((v) => v === "" ? undefined : v).optional(),
  pages: z.string().transform((v) => v === "" ? undefined : v).optional(),
  series: z.string().transform((v) => v === "" ? undefined : v).optional(),
  seriesTitle: z.string().transform((v) => v === "" ? undefined : v).optional(),
  seriesText: z.string().transform((v) => v === "" ? undefined : v).optional(),
  journalAbbreviation: z.string().transform((v) => v === "" ? undefined : v)
    .optional(),
  DOI: z.string().transform((v) => v === "" ? undefined : v).optional(),
  ISSN: z.string().transform((v) => v === "" ? undefined : v).optional(),
  shortTitle: z.string().transform((v) => v === "" ? undefined : v).optional(),
  url: z.string().transform((v) => v === "" ? undefined : v).optional(),
});

let zoteroItemResponse = z.object({
  bib: z.string().transform(parseBibEntry),
  data: zoteroItemDataSchema,
  csljson: z.object({
    issued: z.object({
      "date-parts": z.array(z.array(z.union([z.number(), z.string()]))),
    }).refine((value) => value["date-parts"].length === 1, {
      message: "Too many dates",
    }).transform((value) => {
      let parts = value["date-parts"][0].map(Number);
      return { year: parts[0], month: parts[1], day: parts[2] };
    }),
  }),
}).transform(({ bib, data, csljson }) => ({
  ...data,
  bib,
  date: csljson.issued,
}));

let ncbiIdConverterResponseSchema = z.object({
  records: z.object({ doi: z.string(), pmid: z.string().optional() }).array(),
});

function parseBibEntry(xml: string): string {
  let match = xml.match(/<div class="csl-right-inline"[^>]*>(.*?)<\/div>/);
  assert(match, "Could not find the bib entry");
  return he.decode(match[1].trim());
}

/**
 * Fetches the publications from the HiDive Zotero group.
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 * @returns A list of publications.
 */
export async function fetchHidiveZoteroItemKeys(
  collectionId: string,
): Promise<Set<string>> {
  let ids = new Set<string>();

  let url = new URL(
    `collections/${collectionId}/items`,
    BASE_URL,
  );
  url.searchParams.set("format", "keys");
  url.searchParams.set("itemType", `-attachment`);
  let response = await fetch(url);
  let text = await response.text();
  for (let id of text.trim().split("\n")) {
    ids.add(id);
  }

  // idk we want to filter out attachments and notes but I don't know how to do
  // that in a single request
  url.searchParams.set("itemType", "note");
  response = await fetch(url);
  text = await response.text();
  for (let id of text.trim().split("\n")) {
    ids.delete(id);
  }
  return ids;
}

async function getPubMedIds(
  dois: Array<string>,
  batchSize = 100,
): Promise<Record<string, string>> {
  let records: Record<string, string> = {};
  for (let i = 0; i < dois.length; i += batchSize) {
    let batch = dois.slice(i, i + batchSize);
    let url = new URL("https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/");
    url.searchParams.set("ids", batch.join(","));
    url.searchParams.set("format", "json");
    let response = await fetch(url);
    let data = await response.json();
    for (let record of ncbiIdConverterResponseSchema.parse(data).records) {
      if (record.pmid) records[record.doi] = record.pmid;
    }
  }
  return records;
}

async function fetchZoteroItem(itemKey: string): Promise<ZoteroItem> {
  let url = new URL(`items/${itemKey}`, BASE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("include", "csljson,bib,data");
  url.searchParams.set(
    "style",
    "https://gist.githubusercontent.com/manzt/743d185cc9e84fec0669aefb2d423d78/raw/d303835cf3bb82096e30a27be0f0225a42c65323/hidive.csl",
  );
  let response = await fetch(url);
  let data = await response.json();
  return zoteroItemResponse.parse(data);
}

function formatAuthors(authors: Array<Author>) {
  let formatted = authors.map((author) => {
    if ("name" in author) {
      return author.name;
    }
    let { firstName, lastName } = author;
    let initials = firstName.match(/[A-Z]/g); // get initials
    return `${initials?.join("") ?? ""} ${lastName}`;
  });
  if (formatted.length === 2) return formatted.join(" and ");
  return formatted.join(", ");
}

function formatJournalInfo(meta: ZoteroItem) {
  if (meta.itemType === "thesis") {
    return "Thesis";
  }
  if (meta.itemType === "preprint") {
    if (meta.url?.includes("arxiv")) return "arXiv";
    if (meta.url?.includes("biorxiv")) return "bioRxiv";
    if (meta.url?.includes("medrxiv")) return "medRxiv";
    if (meta.url?.includes("osf")) return "OSF Preprints";
    return "Preprint";
  }
  let { publicationTitle, volume, issue, pages } = meta;
  if (!publicationTitle) return "";
  let citation = publicationTitle;
  if (volume) citation += ` ${volume}`;
  if (issue) citation += `(${issue})`;
  if (pages) {
    citation += `${(issue || volume) ? ":" : " "}${pages}`;
  }
  return citation;
}

function formatCitation(meta: ZoteroItem) {
  let authors = formatAuthors(meta.creators);
  let title = meta.title;
  let info = formatJournalInfo(meta);
  let year = meta.date.year;
  return `${authors}, "${title}", ${info} (${year}).`;
}

function toCsv(pubs: Array<ZoteroItem & { pmid?: string }>) {
  let rows = pubs.map((pub) => ({
    Month: pub.date.month,
    Year: pub.date.year,
    Citation: formatCitation(pub),
    "PubMed ID": pub.pmid,
    DOI: pub.DOI,
  }));
  let csv = stringify(rows, { columns: Object.keys(rows[0]) });
  return csv;
}

async function main() {
  let [pubIds, preprintIds] = await Promise.all([
    fetchHidiveZoteroItemKeys(HIDIVE_PUBLICATIONS_COLLECTION_ID),
    fetchHidiveZoteroItemKeys(HIDIVE_PREPRINTS_COLLECTION_ID),
  ]);
  // make sure we don't have overlap between the two collections
  assert(
    pubIds.intersection(preprintIds).size === 0,
    "Overlap between collections",
  );
  let itemKeys = [...pubIds, ...preprintIds];

  let pb = new ProgressBar({
    title: "Fetching publications",
    total: itemKeys.length,
  });

  let items: Array<ZoteroItem> = [];
  let i = 0;
  for (let itemKey of itemKeys) {
    try {
      items.push(await fetchZoteroItem(itemKey));
    } catch (_) {
      try {
        items.push(await fetchZoteroItem(itemKey));
      } catch (error) {
        console.error(`Could not fetch item ${itemKey}: ${error}`);
      }
    }
    await pb.render(i++);
  }

  let idMap = await getPubMedIds(
    items
      .map((item) => item.DOI)
      .filter((d) => typeof d === "string"),
  );

  let final = items
    .toSorted((a, b) => {
      let dateA = new Date(a.date.year, a.date.month ?? 0);
      let dateB = new Date(b.date.year, b.date.month ?? 0);
      return dateB.getTime() - dateA.getTime();
    })
    .map((item) => ({
      pmid: idMap[item.DOI as string],
      ...item,
    }));

  Deno.writeTextFileSync("pubs.json", JSON.stringify(final, null, 2));
  Deno.writeTextFileSync(
    "pubs.csv",
    toCsv(final.filter((p) => p.itemType !== "preprint")),
  );
  Deno.writeTextFileSync(
    "preprints.csv",
    toCsv(final.filter((p) => p.itemType === "preprint")),
  );
}

if (import.meta.main) {
  main();
}
