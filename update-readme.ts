import { parse } from "jsr:@std/csv@1.0.3";
import { markdownTable } from "npm:markdown-table@3.0.3";

if (import.meta.main) {
  let readme = await Deno.readTextFile("README.md");

  let content = readme.split("## Papers").shift()! + "## Papers\n";

  let pubs = markdownTable(
    parse(await Deno.readTextFile("assets/pubs.csv")),
    { align: null },
  );
  content += `### Publications\n\n${pubs}\n`;

  let preprints = markdownTable(
    parse(await Deno.readTextFile("assets/preprints.csv")),
    { align: null },
  );
  content += `### Preprints\n\n${preprints}\n`;

  Deno.writeTextFile("README.md", content);
}
