import { z } from "npm:zod@3.23.8";
import he from "npm:he@1.2.0";
import ProgressBar from "jsr:@deno-library/progress@1.4.9";
import { assert } from "jsr:@std/assert@1.0.6";
import { stringify } from "jsr:@std/csv@1.0.3";

let HIDIVE_GROUP_ID = "5145258";
let HIDIVE_PUBLICATIONS_COLLECTION_ID = "K2GPFB99";
let BASE_URL = new URL(`https://api.zotero.org/groups/${HIDIVE_GROUP_ID}/`);

type Item = z.infer<typeof zoteroItemResponse>;
type CslJson = z.infer<typeof cslJsonSchema>;
type Author =
  | { kind: "human"; family: string; given: string }
  | { kind: "consortium"; name: string };

let authorSchema = z.object({
  family: z.string(),
  given: z.string(),
}).transform((author): Author => {
  if (isNetworkOrConsortium(author.family)) {
    return { kind: "consortium", name: author.family };
  }
  return { kind: "human", family: author.family, given: author.given };
});

let cslJsonSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  "container-title": z.string().optional(),
  page: z.string().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  URL: z.string().optional(),
  DOI: z.string().optional(),
  journalAbbreviation: z.string().optional(),
  author: z.array(authorSchema),
  issued: z.object({
    "date-parts": z.array(z.array(z.coerce.number()).min(1).max(3)),
  }).transform((value) => ({
    year: value["date-parts"][0][0],
    month: value["date-parts"][0][1] ?? undefined,
    day: value["date-parts"][0][2] ?? undefined,
  })).optional(),
});

let zoteroItemResponse = z.object({
  key: z.string(),
  version: z.number(),
  bib: z.string().transform(parseBibEntry),
  csljson: cslJsonSchema,
});

let ncbiIdConverterResponseSchema = z.object({
  records: z.object({ doi: z.string(), pmid: z.string().optional() }).array(),
});

function isNetworkOrConsortium(familyName: string) {
  familyName = familyName.toLowerCase();
  return familyName.includes("network") || familyName.includes("consortium");
}

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
async function fetchHidivePublications(): Promise<Array<string>> {
  let url = new URL(
    `collections/${HIDIVE_PUBLICATIONS_COLLECTION_ID}/items`,
    BASE_URL,
  );
  url.searchParams.set("format", "keys");
  url.searchParams.set("itemType", "-attachment");
  let response = await fetch(url);
  let text = await response.text();
  return text.trim().split("\n");
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

async function fetchZoteroItem(itemKey: string): Promise<Item> {
  let url = new URL(`items/${itemKey}`, BASE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("include", "csljson,bib");
  url.searchParams.set(
    "style",
    "https://gist.githubusercontent.com/manzt/743d185cc9e84fec0669aefb2d423d78/raw/d303835cf3bb82096e30a27be0f0225a42c65323/hidive.csl",
  );
  let response = await fetch(url);
  let data = await response.json();
  let item = zoteroItemResponse.parse(data);
  return item;
}

function formatAuthors(authors: Array<Author>) {
  let formatted = authors.map((author) => {
    if (author.kind === "consortium") {
      return author.name;
    }
    let { given, family } = author;
    let initials = given.match(/[A-Z]/g); // get initials
    return `${initials?.join("") ?? ""} ${family}`;
  });
  if (formatted.length === 2) return formatted.join(" and ");
  return formatted.join(", ");
}

function formatCitation(meta: CslJson) {
  let citation = `${formatAuthors(meta.author)}, "${meta.title}", `;
  if (meta["container-title"]) {
    citation += `${meta["container-title"]} `;
    if (meta.volume) citation += `${meta.volume}`;
    if (meta.issue) citation += `(${meta.issue})`;
    if (meta.page) {
      citation += `${(meta.issue || meta.volume) ? ":" : ""}${meta.page}`;
    }
  } else {
    // some kind of preprint check url for arXiv, bioRxiv, medRxiv, or OSF
    let preprint: string | undefined;
    if (meta.URL?.includes("arxiv")) {
      preprint = "arXiv";
    } else if (meta.URL?.includes("biorxiv")) {
      preprint = "bioRxiv";
    } else if (meta.URL?.includes("medrxiv")) {
      preprint = "medRxiv";
    } else if (meta.URL?.includes("osf")) {
      preprint = "OSF Preprints";
    }
    if (preprint) citation += ` ${preprint}`;
  }
  assert(meta.issued, "Missing year in publication");
  return citation + ` (${meta.issued.year}).`;
}

function toCsv(pubs: Array<Item & { pmid?: string }>) {
  let rows = pubs.map(({ csljson: pub, pmid }) => ({
    Month: pub.issued?.month,
    Year: pub.issued?.year,
    Citation: formatCitation(pub),
    "PubMed ID": pmid,
    DOI: pub.DOI,
  }));
  let csv = stringify(rows, { columns: Object.keys(rows[0]) });
  return csv;
}

if (import.meta.main) {
  let itemKeys = await fetchHidivePublications();
  let pb = new ProgressBar({
    title: "Fetching publications",
    total: itemKeys.length,
  });

  let items = [];
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
      .map((item) => item.csljson.DOI)
      .filter((d) => typeof d === "string"),
  );

  let final = items
    // filter out items without authors
    .filter((item) => item.csljson.author)
    // sort by date (newest first)
    .toSorted((a, b) => {
      let dateA = new Date(
        a.csljson.issued?.year ?? 0,
        a.csljson.issued?.month ?? 0,
      );
      let dateB = new Date(
        b.csljson.issued?.year ?? 0,
        b.csljson.issued?.month ?? 0,
      );
      return dateB.getTime() - dateA.getTime();
    })
    .map((item) => ({
      pmid: item.csljson.DOI ? idMap[item.csljson.DOI] : undefined,
      ...item,
    }));

  Deno.writeTextFileSync("pubs.json", JSON.stringify(final, null, 2));
  Deno.writeTextFileSync("pubs.csv", toCsv(final));
}
