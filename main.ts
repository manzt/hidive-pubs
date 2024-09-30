import * as p from "npm:@clack/prompts@0.7.0";
import { z } from "npm:zod@3.23.8";
import * as fs from "jsr:@std/fs@1.0.4";
import * as colors from "jsr:@std/fmt@1.0.2/colors";
import { stringify } from "jsr:@std/csv@1.0.3";

let HIDIVE_GROUP_ID = "5145258";
let HIDIVE_PUBLICATIONS_COLLECTION_ID = "YGTEVG73";
let HIDIVE_PREPRINTS_COLLECTION_ID = "AJKTPNSI";
let BASE_URL = new URL(`https://api.zotero.org/groups/${HIDIVE_GROUP_ID}/`);

type ZoteroItem = z.infer<typeof zoteroItemSchema>;
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

let zoteroItemSchema = z.object({
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
}).transform(({ data, csljson }) => ({
  ...data,
  date: csljson.issued,
}));

let ncbiIdConverterResponseSchema = z.object({
  records: z.object({ doi: z.string(), pmid: z.string().optional() }).array(),
});

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

function formatCitation(item: ZoteroItem) {
  let authors = formatAuthors(item.creators);
  let title = item.title;
  let info = formatJournalInfo(item);
  let year = item.date.year;
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

async function fetchAllCollectionItems(
  collectionId: string,
): Promise<ZoteroItem[]> {
  let itemsPerPage = 100;
  let items: ZoteroItem[] = [];
  let start = 0;

  while (true) {
    let url = new URL(`collections/${collectionId}/items`, BASE_URL);
    url.searchParams.set("format", "json");
    url.searchParams.set("include", "csljson,data");
    url.searchParams.set("itemType", "-attachment");
    url.searchParams.set("limit", itemsPerPage.toString());
    url.searchParams.set("start", start.toString());

    let response = await fetch(url);
    let json = await response.json();

    let newItems = zoteroItemSchema.array().parse(
      // deno-lint-ignore no-explicit-any
      json.filter((item: any) => item.data.itemType !== "note"),
    );

    items.push(...newItems);

    if (json.length < itemsPerPage) {
      break; // We've reached the end of the collection
    }
    start += itemsPerPage;
  }

  return items;
}

if (import.meta.main) {
  let items: Array<ZoteroItem> = [];
  let idMap: Record<string, string> = {};

  p.intro("hidive-pubs");
  {
    let spinner = p.spinner();
    spinner.start(
      colors.bold(`Fetching HIDIVE ${colors.cyan("publications")}`),
    );
    let pubs = await fetchAllCollectionItems(HIDIVE_PUBLICATIONS_COLLECTION_ID);
    spinner.stop(
      `Fetched ${colors.yellow(pubs.length.toString())} publications`,
    );
    items.push(...pubs);
  }

  {
    let spinner = p.spinner();
    spinner.start(colors.bold(`Fetching HIDIVE ${colors.cyan("preprints")}`));
    let preprints = await fetchAllCollectionItems(
      HIDIVE_PREPRINTS_COLLECTION_ID,
    );
    spinner.stop(
      `Fetched ${colors.yellow(preprints.length.toString())} preprints`,
    );
    items.push(...preprints);
  }

  {
    let dois = items.map((item) => item.DOI).filter((d) =>
      typeof d === "string"
    );
    let spinner = p.spinner();
    spinner.start(
      colors.bold(
        `Fetching PubMed IDs for ${
          colors.cyan(dois.length.toString())
        } DOIs...`,
      ),
    );
    idMap = await getPubMedIds(dois);
    spinner.stop(
      `Found ${colors.yellow(Object.keys(idMap).length.toString())} PubMed IDs`,
    );
  }

  let withPubMedIds = items
    .toSorted((a, b) => {
      let dateA = new Date(a.date.year, a.date.month ?? 0);
      let dateB = new Date(b.date.year, b.date.month ?? 0);
      return dateB.getTime() - dateA.getTime();
    })
    .map((item) => ({
      pmid: idMap[item.DOI as string],
      ...item,
    }));

  {
    let outDir = new URL("assets/", import.meta.url);
    let spinner = p.spinner();
    spinner.start("Exporting papers to disk");

    await fs.ensureDir(outDir);
    Deno.writeTextFileSync(
      new URL("papers.json", outDir),
      JSON.stringify(withPubMedIds, null, 2),
    );
    Deno.writeTextFileSync(
      new URL("pubs.csv", outDir),
      toCsv(withPubMedIds.filter((p) => p.itemType !== "preprint")),
    );
    Deno.writeTextFileSync(
      new URL("preprints.csv", outDir),
      toCsv(withPubMedIds.filter((p) => p.itemType === "preprint")),
    );

    spinner.stop(
      `Exported ${colors.yellow(items.length.toString())} papers to: ${
        colors.cyan(outDir.toString())
      }`,
    );
  }

  p.outro("Done!");
}
