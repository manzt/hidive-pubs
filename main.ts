import { z } from "npm:zod@3.23.8";
import he from "npm:he@1.2.0";
import ProgressBar from "jsr:@deno-library/progress@1.4.9";
import { assert } from "jsr:@std/assert@1.0.6";

const HIDIVE_GROUP_ID = "5145258";
const HIDIVE_PUBLICATIONS_COLLECTION_ID = "K2GPFB99";
const BASE_URL = new URL(`https://api.zotero.org/groups/${HIDIVE_GROUP_ID}/`);

const authorSchema = z.object({
  family: z.string(),
  given: z.string(),
});

const cslJsonSchema = z.object({
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
  author: z.array(authorSchema).optional(),
  issued: z.object({
    "date-parts": z.array(z.array(z.coerce.number()).min(1).max(3)),
  }).transform((value) => ({
    year: value["date-parts"][0][0],
    month: value["date-parts"][0][1] ?? undefined,
    day: value["date-parts"][0][2] ?? undefined,
  })).optional(),
});

function parseBibEntry(xml: string): string {
  const match = xml.match(/<div class="csl-right-inline"[^>]*>(.*?)<\/div>/);
  assert(match, "Could not find the bib entry");
  return he.decode(match[1].trim());
}

const zoteroItemResponse = z.object({
  key: z.string(),
  version: z.number(),
  bib: z.string().transform(parseBibEntry),
  csljson: cslJsonSchema,
});

/**
 * Fetches the publications from the HiDive Zotero group.
 * @see https://www.zotero.org/support/dev/web_api/v3/basics
 * @returns A list of publications.
 */
async function fetchHidivePublications(): Promise<Array<string>> {
  const url = new URL(
    `collections/${HIDIVE_PUBLICATIONS_COLLECTION_ID}/items`,
    BASE_URL,
  );
  url.searchParams.set("format", "keys");
  url.searchParams.set("itemType", "-attachment");
  const response = await fetch(url);
  const text = await response.text();
  return text.trim().split("\n");
}

type Item = z.infer<typeof zoteroItemResponse>;

async function fetchZoteroItem(itemKey: string): Promise<Item> {
  const url = new URL(`items/${itemKey}`, BASE_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("include", "csljson,bib");
  url.searchParams.set(
    "style",
    "https://gist.githubusercontent.com/manzt/743d185cc9e84fec0669aefb2d423d78/raw/d303835cf3bb82096e30a27be0f0225a42c65323/hidive.csl",
  );
  const response = await fetch(url);
  const data = await response.json();
  const item = zoteroItemResponse.parse(data);
  return item;
}

if (import.meta.main) {
  const itemKeys = await fetchHidivePublications();
  const pb = new ProgressBar({
    title: "Fetching publications",
    total: itemKeys.length,
  });

  const items = [];
  let i = 0;
  for (const itemKey of itemKeys) {
    try {
      items.push(await fetchZoteroItem(itemKey));
    } catch (error) {
      console.error(`Could not fetch item ${itemKey}: ${error}`);
    }
    await pb.render(i++);
  }

  const final = items
    // sort by date (newest first)
    .toSorted((a, b) => {
      const dateA = new Date(
        a.csljson.issued?.year ?? 0,
        a.csljson.issued?.month ?? 0,
      );
      const dateB = new Date(
        b.csljson.issued?.year ?? 0,
        b.csljson.issued?.month ?? 0,
      );
      return dateB.getTime() - dateA.getTime();
    });

  Deno.writeTextFileSync("pubs.json", JSON.stringify(final, null, 2));
}
