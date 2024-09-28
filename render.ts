import { stringify } from "jsr:@std/csv";
import * as colors from "jsr:@std/fmt@1.0.2/colors";
let contents = Deno.readTextFileSync("pubs.json");
let pubs = JSON.parse(contents);

type RawAuthor = { given: string; family: string };
type Author = { kind: "human"; given: string; family: string } | {
  kind: "consortium";
  name: string;
};

function formatGiven(given: string) {
  let initials = given.match(/[A-Z]/g);
  return initials?.join("") ?? "";
}

function formatAuthor(author: Author) {
  if (author.kind === "consortium") {
    return author.name;
  }
  let { given, family } = author;
  return `${formatGiven(given)} ${family}`;
}

function formatAuthors(authors: Array<RawAuthor>) {
  let fmt = processAuthors(authors).map(formatAuthor);
  if (fmt.length === 2) return fmt.join(" and ");
  return fmt.join(", ");
}

function isNetworkOrConsortium(author: RawAuthor) {
  let test = author.family.toLowerCase();
  return test.includes("network") || test.includes("consortium");
}

function processAuthors(authors: Array<RawAuthor>): Array<Author> {
  return authors.map((author) => {
    if (isNetworkOrConsortium(author)) {
      return { kind: "consortium", name: author.family };
    }
    return { ...author, kind: "human" };
  });
}

function formatCitation(
  c: {
    author: Array<{ given: string; family: string }>;
    title: string;
    "container-title": string;
    issued: { year: number };
    page: string;
    volume: string;
    issue: string;
    URL: string;
    DOI: string;
  },
) {
  let citation = `${formatAuthors(c.author)}, "${c.title}", `;
  if (c["container-title"]) {
    citation += `${c["container-title"]}, `;
    if (c.volume) citation += `${c.volume}`;
    if (c.issue) citation += `(${c.issue})`;
    if (c.page) citation += `${(c.issue || c.volume) ? ":" : ""}${c.page}`;
  } else {
    // some kind of preprint check url for arXiv, bioRxiv, medRxiv, or OSF
    let preprint: string | undefined;
    if (c.URL?.includes("arxiv")) {
      preprint = "arXiv";
    } else if (c.URL?.includes("biorxiv")) {
      preprint = "bioRxiv";
    } else if (c.URL?.includes("medrxiv")) {
      preprint = "medRxiv";
    } else if (c.URL?.includes("osf")) {
      preprint = "OSF Preprints";
    }
    if (preprint) citation += ` ${preprint}`;
  }
  return citation + ` (${c.issued.year}).`;
}

let rows = pubs.map(({ csljson: pub, pmid }) => ({
  Month: pub.issued?.month,
  Year: pub.issued?.year,
  Citation: formatCitation(pub),
  "PubMed ID": pmid,
  DOI: pub.DOI,
}));

let csv = stringify(rows, { columns: Object.keys(rows[0]) });
Deno.writeTextFileSync("pubs.csv", csv);
