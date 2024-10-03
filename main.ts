import * as p from "npm:@clack/prompts@0.7.0";
import { z } from "npm:zod@3.23.8";
import * as fs from "jsr:@std/fs@1.0.4";
import * as path from "jsr:@std/path@1.0.6";
import * as colors from "jsr:@std/fmt@1.0.2/colors";
import { assert } from "jsr:@std/assert@1.0.6";
import { stringify } from "jsr:@std/csv@1.0.3";

let HIDIVE_GROUP_ID = "5145258" as const;
let HIDIVE_PUBLICATIONS_COLLECTION_ID = "YGTEVG73" as const;
let HIDIVE_PREPRINTS_COLLECTION_ID = "AJKTPNSI" as const;

type ZoteroItem = z.infer<typeof zoteroItemSchema>;
type Author = ZoteroItem["creators"][number];

/** An optional string that is transformed to undefined if it is an empty string. */
let maybeStringSchema = z
  .string()
  .transform((v) => v === "" ? undefined : v)
  .optional();

let zoteroItemSchema = z.object({
  data: z.object({
    key: z.string(),
    version: z.number(),
    itemType: z.string(),
    title: z.string(),
    creators: z.union([
      z.object({
        creatorType: z.enum(["author", "editor"]),
        name: z.string(),
      }),
      z.object({
        creatorType: z.enum(["author", "editor"]),
        firstName: z.string(),
        lastName: z.string(),
      }),
    ]).array(),
    abstractNote: z.string().transform((value) =>
      value.replace(/^Abstract\s+/, "") // remove "Abstract" prefix
    ),
    institution: maybeStringSchema,
    bookTitle: maybeStringSchema,
    proceedingsTitle: maybeStringSchema,
    publicationTitle: maybeStringSchema,
    volume: maybeStringSchema,
    issue: maybeStringSchema,
    pages: maybeStringSchema,
    series: maybeStringSchema,
    seriesTitle: maybeStringSchema,
    seriesText: maybeStringSchema,
    journalAbbreviation: maybeStringSchema,
    DOI: maybeStringSchema,
    ISSN: maybeStringSchema,
    shortTitle: maybeStringSchema,
    url: maybeStringSchema,
  }),
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
}).transform(({ data, csljson }) => ({ ...data, date: csljson.issued }));

let ncbiIdConverterResponseSchema = z.object({
  records: z.object({ doi: z.string(), pmid: z.string().optional() }).array(),
});

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

function formatAuthors(
  authors: Array<Author>,
  options: { rich?: boolean } = {},
) {
  let it = (text: string) => options.rich ? `*${text}*` : text;
  let formatted = authors
    .filter((author) => author.creatorType === "author")
    .map((author) => {
      if ("name" in author) {
        return it(author.name);
      }
      let { firstName, lastName } = author;
      // extract capital letters from first name as initials
      let initials = firstName.match(/[A-Z]/g);
      return `${initials?.join("") ?? ""} ${lastName}`;
    });
  if (formatted.length === 2) return formatted.join(" and ");
  return formatted.join(", ");
}

function formatJournalInfo(
  meta: ZoteroItem,
  options: { rich?: boolean } = {},
) {
  let it = (text: string) => options.rich ? `*${text}*` : text;
  let b = (text: string) => options.rich ? `**${text}**` : text;

  if (meta.itemType === "thesis") {
    return it("Thesis");
  }

  if (meta.itemType === "preprint") {
    if (meta.url?.includes("arxiv")) return it("arXiv");
    if (meta.url?.includes("biorxiv")) return it("bioRxiv");
    if (meta.url?.includes("medrxiv")) return it("medRxiv");
    if (meta.url?.includes("osf.io")) return it("OSF Preprints");
    if (meta.url?.includes("ssrn")) return it("SSRN Preprints");
    return it("Preprint");
  }

  if (meta.publicationTitle) {
    assert(meta.itemType === "journalArticle");
    let { publicationTitle, volume, issue, pages } = meta;
    let citation = it(publicationTitle);
    if (volume) citation += ` ${b(volume)}`;
    if (issue) citation += `(${issue})`;
    if (pages) {
      citation += `${(issue || volume) ? ":" : " "}${pages}`;
    }
    return citation;
  }

  if (meta.proceedingsTitle) {
    assert(meta.itemType === "conferencePaper");
    return it(meta.proceedingsTitle);
  }

  if (meta.bookTitle) {
    assert(meta.itemType === "bookSection");
    return `${it(meta.bookTitle)} (Book)`;
  }

  if (meta.institution) {
    assert(meta.itemType === "report");
    return `${it(meta.institution)}${meta.pages ? ` ${meta.pages}` : ""}`;
  }

  console.error("Unhandled item type", meta);

  return "";
}

export function formatZoteroItem(
  item: ZoteroItem,
  options: { rich?: boolean } = {},
): { title: string; authors: string; published: string; year: number } {
  return {
    title: item.title,
    authors: formatAuthors(item.creators, options),
    published: formatJournalInfo(item, options),
    year: item.date.year,
  };
}

function formatCitation(item: ZoteroItem) {
  let { authors, title, published, year } = formatZoteroItem(item);
  return `${authors}, "${title}", ${published} (${year}).`;
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

/**
 * Fetches all items in a Zotero collection.
 *
 * Uses the Zotero API to fetch all items in a collection. The API is paginated
 * so this function will make multiple requests to fetch all items.
 *
 * @param collectionId The ID of the collection to fetch items from.
 */
async function fetchZoteroCollection(
  groupId: string,
  collectionId: string,
): Promise<ZoteroItem[]> {
  let baseUrl = new URL(`https://api.zotero.org/groups/${groupId}/`);
  let itemsPerPage = 100;
  let items: ZoteroItem[] = [];
  let start = 0;

  while (true) {
    let url = new URL(`collections/${collectionId}/items`, baseUrl);
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

async function main() {
  let items: Array<ZoteroItem> = [];
  let idMap: Record<string, string> = {};

  p.intro("hidive-pubs");
  {
    let spinner = p.spinner();
    spinner.start(
      colors.bold(`Fetching HIDIVE ${colors.cyan("publications")}`),
    );
    let pubs = await fetchZoteroCollection(
      HIDIVE_GROUP_ID,
      HIDIVE_PUBLICATIONS_COLLECTION_ID,
    );
    spinner.stop(
      `Found ${colors.yellow(pubs.length.toString())} publications`,
    );
    items.push(...pubs);
  }

  {
    let spinner = p.spinner();
    spinner.start(colors.bold(`Fetching HIDIVE ${colors.cyan("preprints")}`));
    let preprints = await fetchZoteroCollection(
      HIDIVE_GROUP_ID,
      HIDIVE_PREPRINTS_COLLECTION_ID,
    );
    spinner.stop(
      `Found ${colors.yellow(preprints.length.toString())} preprints`,
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
    let outDir = Deno.args[0] ?? "./hidive-papers";
    let spinner = p.spinner();
    spinner.start(`Exporting papers to ${colors.cyan(outDir)}`);

    await fs.ensureDir(outDir);
    Deno.writeTextFileSync(
      path.join(outDir, "papers.json"),
      JSON.stringify(withPubMedIds, null, 2),
    );
    Deno.writeTextFileSync(
      path.join(outDir, "pubs.csv"),
      toCsv(withPubMedIds.filter((p) => p.itemType !== "preprint")),
    );
    Deno.writeTextFileSync(
      path.join(outDir, "preprints.csv"),
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

if (import.meta.main) {
  main();
}
